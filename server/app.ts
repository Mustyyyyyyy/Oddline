import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { ProviderError } from "./errors.js";
import { isSupportedTimeZone } from "./generation-window.js";
import { generateSlip } from "./generator.js";
import { databaseIsReady, listFixtures, listHistory, listTrackedFixtures, saveTicket, syncFixtureStatuses, syncFixtures } from "./repository.js";
import type { Fixture, Database } from "./types.js";

export interface OddsFeed {
  source?: string;
  getFixtures(forceRefresh?: boolean): Promise<Fixture[]>;
  getStatuses?(trackedFixtures?: Fixture[]): Promise<Fixture[]>;
  getWarnings?(): string[];
}

const generationRequest = z.object({
  targetOdds: z.number().finite().gt(1).max(200),
  selections: z.array(z.string().min(1).max(512)).min(1).max(12),
  period: z.enum(["daily", "weekend"]),
  sport: z.enum(["all", "football", "basketball"]),
  timeZone: z.string().min(1).max(64).refine(isSupportedTimeZone, "Choose a valid time zone."),
}).strict();
const generateSlipRequest = z.object({
  targetOdds: z.number().finite().gt(1).max(200),
  period: z.enum(["daily", "weekend"]),
  sport: z.enum(["all", "football", "basketball"]),
  timeZone: z.string().min(1).max(64).refine(isSupportedTimeZone, "Choose a valid time zone."),
}).strict();

export interface AppDependencies {
  database: Database;
  feed: OddsFeed;
  staticDirectory?: string;
  ready?: () => Promise<void>;
}

export function createApp({ database, feed, staticDirectory, ready }: AppDependencies): express.Express {
  const provider = feed.source ?? "the-odds-api";
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", process.env.TRUST_PROXY === "1" || process.env.VERCEL === "1" ? 1 : false);
  app.use(helmet());
  app.use(express.json({ limit: "10kb", strict: true }));
  if (ready) {
    app.use((_request, _response, next) => {
      void ready().then(() => next(), next);
    });
  }
  app.use("/api", rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }));

  app.get("/api/fixtures", asyncRoute(async (request, response) => {
    const snapshot = await getFixtureSnapshot(database, feed, request.query.refresh === "1");
    response.json({
      fixtures: snapshot.fixtures,
      source: provider,
      stale: snapshot.stale,
      warnings: [...(feed.getWarnings?.() ?? []), ...(snapshot.warning ? [snapshot.warning] : [])],
    });
  }));

  app.get("/api/history", asyncRoute(async (_request, response) => {
    let providerStale = false;
    try {
      if (feed.getStatuses) {
        const trackedFixtures = await listTrackedFixtures(database);
        await syncFixtureStatuses(database, await feed.getStatuses(trackedFixtures));
      } else {
        const fixtures = await feed.getFixtures();
        await syncFixtures(database, fixtures);
      }
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      response.setHeader("X-Provider-Status", "stale");
      response.setHeader("Warning", `110 - "${provider} status refresh failed; history shows last known status."`);
      providerStale = true;
    }
    response.json({
      tickets: await listHistory(database),
      source: "postgresql",
      feedError: providerStale ? `${provider} status refresh failed; showing the last status received.` : null,
    });
  }));

  app.post("/api/generate-selections", asyncRoute(async (request, response) => {
    const parsed = generateSlipRequest.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.issues.map((issue) => issue.message).join(" ") });
      return;
    }
    const maximum = parsed.data.period === "daily" ? 50 : 200;
    if (parsed.data.targetOdds > maximum) {
      response.status(400).json({ error: `${parsed.data.period === "daily" ? "Daily" : "Weekend"} target odds cannot exceed ${maximum}.` });
      return;
    }
    const snapshot = await getFixtureSnapshot(database, feed, false);
    const slip = generateSlip(
      snapshot.fixtures,
      parsed.data.sport,
      parsed.data.period,
      parsed.data.targetOdds,
      parsed.data.timeZone,
    );
    if (!slip.picks.length) {
      response.status(422).json({ error: "No upcoming fixtures with supported odds are available for that sport." });
      return;
    }
    response.json({
      ...slip,
      source: provider,
      stale: snapshot.stale,
      warning: snapshot.warning,
      method: "One selection per game, balanced across available leagues and match-result, totals, and spread markets; market-implied odds are not independent forecasts.",
    });
  }));

  app.post("/api/generate", asyncRoute(async (request, response) => {
    const parsed = generationRequest.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.issues.map((issue) => issue.message).join(" ") });
      return;
    }
    const maximum = parsed.data.period === "daily" ? 50 : 200;
    if (parsed.data.targetOdds > maximum) {
      response.status(400).json({ error: `${parsed.data.period === "daily" ? "Daily" : "Weekend"} target odds cannot exceed ${maximum}.` });
      return;
    }
    const snapshot = await getFixtureSnapshot(database, feed, false);
    if (snapshot.stale) {
      response.status(503).json({
        error: snapshot.warning ?? "Live prices are unavailable; this saved snapshot is preview-only.",
        source: provider,
      });
      return;
    }
    try {
      const ticket = await saveTicket(
        database,
        parsed.data.targetOdds,
        parsed.data.selections,
        parsed.data.period,
        parsed.data.sport,
        parsed.data.timeZone,
      );
      response.status(201).json({
        ...ticket,
        targetReached: Number(ticket.combinedOdds) >= ticket.targetOdds,
        predictionStatus: "not_available",
        message: Number(ticket.combinedOdds) >= ticket.targetOdds
          ? "Your selected outcomes reached the target."
          : `Your selections total ${Number(ticket.combinedOdds).toFixed(2)}; no extra outcomes were added to force the target.`,
      });
    } catch (error) {
      if (error instanceof Error && /no more than one|no longer available|Only scheduled|selected date window|chosen sport|target odds cannot exceed|combined odds cannot exceed/i.test(error.message)) {
        response.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
  }));

  app.get("/api/health", asyncRoute(async (_request, response) => {
    await databaseIsReady(database);
    response.json({
      ok: true,
      database: "available",
      provider: process.env.API_SPORTS_KEY ? "configured" : "not-configured",
      providerName: "Oddline REST API: API-Sports Football fixtures and bookmaker odds",
      supportedSports: ["football"],
      unavailableSports: ["basketball"],
    });
  }));

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "API route not found." });
  });

  if (staticDirectory) {
    app.use(express.static(staticDirectory, {
      index: "index.html",
      maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
      etag: true,
    }));
    app.get("/{*path}", (_request, response, next) => {
      response.sendFile("index.html", { root: staticDirectory }, (error) => {
        if (error) next(error);
      });
    });
  }

  const errorHandler: ErrorRequestHandler = (error: unknown, _request: Request, response: Response, _next) => {
    if (error instanceof ProviderError) {
      response.status(503).json({ error: error.message, source: provider });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: "Request body must be valid JSON." });
      return;
    }
    console.error("Unhandled request error", error);
    response.status(500).json({ error: "An internal server error occurred." });
  };
  app.use(errorHandler);
  return app;
}

const staleFixtureMaxAgeMs = 24 * 60 * 60 * 1000;

async function getFixtureSnapshot(
  database: Database,
  feed: OddsFeed,
  forceRefresh: boolean,
): Promise<{ fixtures: Fixture[]; stale: boolean; warning?: string }> {
  const cachedFixtures = (await listFixtures(database, new Date(Date.now() - sharedFixtureCacheMaxAgeMs())))
    .filter((fixture) => fixture.source === (feed.source ?? "the-odds-api"));
  if (!forceRefresh && cachedFixtures.length) {
    return { fixtures: cachedFixtures, stale: false };
  }

  try {
    const fixtures = await feed.getFixtures(forceRefresh);
    await syncFixtures(database, fixtures);
    return {
      fixtures: (await listFixtures(database))
        .filter((fixture) => fixture.source === (feed.source ?? "the-odds-api")),
      stale: false,
    };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    const fallbackFixtures = (await listFixtures(database, new Date(Date.now() - staleFixtureMaxAgeMs)))
      .filter((fixture) => fixture.source === (feed.source ?? "the-odds-api"));
    if (!fallbackFixtures.length) throw error;
    return {
      fixtures: fallbackFixtures,
      stale: true,
      warning: `Live ${feed.source ?? "sports"} prices are unavailable. Showing saved provider data from the last 24 hours for preview only; saving is disabled until live prices return. ${error.message}`,
    };
  }
}

function sharedFixtureCacheMaxAgeMs(): number {
  const cacheSeconds = Number(process.env.SPORTS_FEED_CACHE_SECONDS ?? 21_600);
  return Math.max(300, Number.isFinite(cacheSeconds) ? cacheSeconds : 21_600) * 1000;
}

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>,
): express.RequestHandler {
  return (request, response, next) => {
    void handler(request, response).catch(next);
  };
}
