import { z } from "zod";
import { ProviderError } from "./errors.js";
import type { Fixture, Sport } from "./types.js";

const footballApiRoot = "https://v3.football.api-sports.io";
const basketballApiRoot = "https://v2.nba.api-sports.io";
const responseSchema = z.object({
  response: z.array(z.unknown()),
  errors: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
});

interface ScheduledFixture {
  sport: Sport;
  homeTeam: string;
  awayTeam: string;
  league: string;
  startsAt: string;
  status: Fixture["status"];
}

interface FootballFixtureResponse {
  fixture?: {
    date?: unknown;
    status?: { short?: unknown; long?: unknown };
  };
  teams?: {
    home?: { name?: unknown };
    away?: { name?: unknown };
  };
  league?: { name?: unknown };
}

interface BasketballGameResponse {
  date?: { start?: unknown };
  status?: { short?: unknown; long?: unknown };
  teams?: {
    home?: { name?: unknown };
    visitors?: { name?: unknown };
  };
  league?: { name?: unknown };
}

export function getApiSportsConfig(env: NodeJS.ProcessEnv = process.env): {
  apiKey: string;
  daysAhead: number;
} {
  const apiKey = env.API_SPORTS_KEY?.trim();
  if (!apiKey) throw new ProviderError("API_SPORTS_KEY is not configured.");
  const daysAhead = Number(env.ODDS_API_DAYS_AHEAD ?? 13);
  if (!Number.isInteger(daysAhead) || daysAhead < 1 || daysAhead > 13) {
    throw new ProviderError("ODDS_API_DAYS_AHEAD must be between 1 and 13.");
  }
  return { apiKey, daysAhead };
}

export class ApiSportsSchedule {
  private cache?: { expiresAt: number; fixtures: ScheduledFixture[] };
  private refresh?: Promise<ScheduledFixture[]>;
  private warnings: string[] = [];

  constructor(
    private readonly config: ReturnType<typeof getApiSportsConfig>,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getFixtures(_forceRefresh = false): Promise<ScheduledFixture[]> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.fixtures;
    if (!this.refresh) {
      this.refresh = this.fetchFixtures().then((fixtures) => {
        this.cache = { fixtures, expiresAt: Date.now() + cacheDurationSeconds() * 1000 };
        return fixtures;
      }).finally(() => {
        this.refresh = undefined;
      });
    }
    return this.refresh;
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  private async fetchFixtures(): Promise<ScheduledFixture[]> {
    const now = this.now();
    const start = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(now.getTime() + this.config.daysAhead * 24 * 60 * 60 * 1000);
    const footballDates: string[] = [];
    for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
      footballDates.push(dateOnly(date));
    }
    const footballResults = await mapConcurrent(footballDates, 4, async (date) => {
      const footballParams = new URLSearchParams({ date });
      return this.requestJson(`${footballApiRoot}/fixtures?${footballParams}`)
        .then((fixtures) => fixtures.map(normalizeFootballFixture)
          .filter((fixture): fixture is ScheduledFixture => fixture !== undefined));
    });
    const basketballParams = new URLSearchParams({ league: "standard", season: String(now.getUTCFullYear()) });
    const basketballResult = await this.requestJson(`${basketballApiRoot}/games?${basketballParams}`)
      .then((games) => games.map(normalizeBasketballGame)
        .filter((fixture): fixture is ScheduledFixture => fixture !== undefined))
      .then((fixtures) => ({ status: "fulfilled" as const, value: fixtures }))
      .catch((reason: unknown) => ({ status: "rejected" as const, reason }));
    this.warnings = [];
    const failedFootballDates = footballResults
      .flatMap((result, index) => result.status === "rejected" ? [{ date: footballDates[index]!, reason: result.reason }] : []);
    const footballFixtures = footballResults.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (failedFootballDates.length) {
      const firstFailure = failedFootballDates[0]!;
      const dateSummary = failedFootballDates.length === footballDates.length
        ? "all requested dates"
        : `${failedFootballDates.length} of ${footballDates.length} dates`;
      this.warnings.push(
        `Football schedules unavailable for ${dateSummary} (including ${firstFailure.date}): ${providerErrorMessage(firstFailure.reason)}`,
      );
    }
    if (basketballResult.status === "rejected") {
      this.warnings.push(`NBA schedule unavailable: ${providerErrorMessage(basketballResult.reason)}`);
    }
    if (!footballResults.some((result) => result.status === "fulfilled") && basketballResult.status === "rejected") {
      throw new ProviderError(`API-Sports schedules unavailable. ${this.warnings.join(" ")}`);
    }
    return [
      ...footballFixtures,
      ...(basketballResult.status === "fulfilled" ? basketballResult.value : []),
    ];
  }

  private async requestJson(url: string): Promise<unknown[]> {
    let response: Response;
    try {
      response = await this.request(url, {
        headers: { "x-apisports-key": this.config.apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "request timed out" : "network error";
      throw new ProviderError(`API-Sports ${reason}.`);
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError(`API-Sports rejected API_SPORTS_KEY or denied endpoint access (HTTP ${response.status}).`);
      }
      if (response.status === 429) throw new ProviderError("API-Sports request quota was reached.");
      throw new ProviderError(`API-Sports request failed with HTTP ${response.status}.`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError("API-Sports returned invalid JSON.");
    }
    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) throw new ProviderError("API-Sports returned an invalid fixtures response.");
    const errors = parsed.data.errors;
    if (errors && (Array.isArray(errors) ? errors.length > 0 : Object.keys(errors).length > 0)) {
      const details = (Array.isArray(errors)
        ? errors.map((error) => String(error))
        : Object.entries(errors).map(([name, detail]) => `${name}: ${String(detail)}`))
        .join("; ")
        .replaceAll(this.config.apiKey, "[redacted]")
        .slice(0, 300);
      throw new ProviderError(`API-Sports returned an API error: ${details}`);
    }
    return parsed.data.response;
  }
}

function providerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown API-Sports error.";
}

export async function getPricedApiSportsFixtures(
  schedule: ApiSportsSchedule,
  oddsFeed: { getFixtures(forceRefresh?: boolean): Promise<Fixture[]> },
  forceRefresh = false,
): Promise<Fixture[]> {
  const [scheduledFixtures, pricedFixtures] = await Promise.all([
    schedule.getFixtures(forceRefresh),
    oddsFeed.getFixtures(forceRefresh),
  ]);
  return joinSchedulesAndPrices(scheduledFixtures, pricedFixtures);
}

export function joinSchedulesAndPrices(
  scheduledFixtures: ScheduledFixture[],
  pricedFixtures: Fixture[],
): Fixture[] {
  return pricedFixtures.flatMap((priced) => {
    const match = scheduledFixtures
      .filter((scheduled) =>
        scheduled.sport === priced.sport
        && teamKey(scheduled.homeTeam) === teamKey(priced.homeTeam)
        && teamKey(scheduled.awayTeam) === teamKey(priced.awayTeam),
      )
      .map((scheduled) => ({
        scheduled,
        distance: Math.abs(Date.parse(scheduled.startsAt) - Date.parse(priced.startsAt)),
      }))
      .filter(({ distance }) => distance <= 6 * 60 * 60 * 1000)
      .sort((left, right) => left.distance - right.distance)[0]?.scheduled;
    if (!match) return [];
    return [{
      ...priced,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      league: match.league,
      startsAt: match.startsAt,
      status: match.status,
    }];
  });
}

export function joinScheduleStatuses(
  scheduledFixtures: ScheduledFixture[],
  trackedFixtures: Fixture[],
): Fixture[] {
  return trackedFixtures.flatMap((tracked) => {
    const match = scheduledFixtures
      .filter((scheduled) =>
        scheduled.sport === tracked.sport
        && teamKey(scheduled.homeTeam) === teamKey(tracked.homeTeam)
        && teamKey(scheduled.awayTeam) === teamKey(tracked.awayTeam),
      )
      .map((scheduled) => ({
        scheduled,
        distance: Math.abs(Date.parse(scheduled.startsAt) - Date.parse(tracked.startsAt)),
      }))
      .filter(({ distance }) => distance <= 6 * 60 * 60 * 1000)
      .sort((left, right) => left.distance - right.distance)[0]?.scheduled;
    return match ? [{ ...tracked, status: match.status, startsAt: match.startsAt, league: match.league, selections: [] }] : [];
  });
}

export function normalizeFootballFixture(value: unknown): ScheduledFixture | undefined {
  if (!isRecord(value)) return undefined;
  const fixture = value as FootballFixtureResponse;
  const startsAt = parseDate(fixture.fixture?.date);
  const homeTeam = stringValue(fixture.teams?.home?.name);
  const awayTeam = stringValue(fixture.teams?.away?.name);
  if (!startsAt || !homeTeam || !awayTeam) return undefined;
  return {
    sport: "football",
    homeTeam,
    awayTeam,
    league: stringValue(fixture.league?.name) ?? "Football",
    startsAt,
    status: eventStatus(fixture.fixture?.status?.short, fixture.fixture?.status?.long),
  };
}

export function normalizeBasketballGame(value: unknown): ScheduledFixture | undefined {
  if (!isRecord(value)) return undefined;
  const game = value as BasketballGameResponse;
  const startsAt = parseDate(game.date?.start);
  const homeTeam = stringValue(game.teams?.home?.name);
  const awayTeam = stringValue(game.teams?.visitors?.name);
  if (!startsAt || !homeTeam || !awayTeam) return undefined;
  return {
    sport: "basketball",
    homeTeam,
    awayTeam,
    league: stringValue(game.league?.name) ?? "NBA",
    startsAt,
    status: eventStatus(game.status?.short, game.status?.long),
  };
}

function eventStatus(shortValue: unknown, longValue: unknown): Fixture["status"] {
  const short = typeof shortValue === "string" ? shortValue.trim().toUpperCase() : "";
  const long = typeof longValue === "string" ? longValue.trim().toLowerCase() : "";
  if (["FT", "AET", "PEN", "AOT"].includes(short) || long.includes("finished")) return "finished";
  if (["PST", "POST"].includes(short) || long.includes("postpon")) return "postponed";
  if (["CANC"].includes(short) || long.includes("cancel")) return "cancelled";
  if (["ABD", "AWD", "WO"].includes(short) || long.includes("abandon")) return "abandoned";
  if (["NS", "TBD"].includes(short) || long.includes("not started")) return "scheduled";
  if (["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE", "1Q", "2Q", "3Q", "4Q", "OT"].includes(short)
    || long.includes("in play")
    || long.includes("live")) return "live";
  return "unknown";
}

function teamKey(name: string): string {
  return name.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/\b(fc|cf|afc|sc|club)\b/g, "")
    .replace(/\bla\b/g, "los angeles")
    .replace(/[^a-z0-9]/g, "");
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cacheDurationSeconds(): number {
  const value = Number(process.env.SPORTS_FEED_CACHE_SECONDS ?? 300);
  return Number.isFinite(value) ? Math.max(15, value) : 300;
}

async function mapConcurrent<T, Result>(
  values: T[],
  concurrency: number,
  map: (value: T) => Promise<Result>,
): Promise<PromiseSettledResult<Result>[]> {
  const results: PromiseSettledResult<Result>[] = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: "fulfilled", value: await map(values[index]!) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
