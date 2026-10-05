import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { newDb } from "pg-mem";
import { createApp } from "./app.js";
import { migrate } from "./db.js";
import { ProviderError } from "./errors.js";
import type { Fixture } from "./types.js";

test("API reads real-feed-shaped fixtures, saves selected prices and tracks provider status", async () => {
  const memory = newDb();
  const PgPool = memory.adapters.createPg().Pool;
  const database = new PgPool();
  await migrate(database);
  await migrate(database);

  let fixture: Fixture = {
    id: "sr:sport_event:api-test",
    sport: "football",
    homeTeam: "Home FC",
    awayTeam: "Away FC",
    league: "Test League",
    startsAt: new Date(Date.now() + 3_600_000).toISOString(),
    status: "scheduled",
    source: "the-odds-api",
    oddsUpdatedAt: new Date().toISOString(),
    selections: [
      {
        id: "sr:market:1:home",
        market: "3way",
        selection: "home",
        odds: 2.15,
        bookmaker: "Book A",
        marketBookmaker: "Book B",
        marketProbability: 0.45,
        updatedAt: new Date().toISOString(),
      },
      {
        id: "sr:market:1:draw",
        market: "3way",
        selection: "draw",
        odds: 3.1,
        bookmaker: "Book A",
        marketBookmaker: "Book B",
        marketProbability: 0.3,
        updatedAt: new Date().toISOString(),
      },
      {
        id: "sr:market:1:away",
        market: "3way",
        selection: "away",
        odds: 3.8,
        bookmaker: "Book A",
        marketBookmaker: "Book B",
        marketProbability: 0.25,
        updatedAt: new Date().toISOString(),
      },
      {
        id: "totals:2.5:over",
        market: "totals:2.5",
        selection: "over",
        odds: 1.95,
        bookmaker: "Book A",
        marketBookmaker: "Book B",
        marketProbability: 0.2,
        updatedAt: new Date().toISOString(),
      },
    ],
  };
  let providerOffline = false;
  let fixtureRequests = 0;
  const feed = {
    source: "the-odds-api",
    getFixtures: async () => {
      fixtureRequests += 1;
      if (providerOffline) throw new ProviderError("Provider request quota was reached.");
      return [fixture];
    },
    getStatuses: async () => [{ ...fixture, selections: [] }],
  };
  const staticDirectory = resolve(process.cwd(), "dist");
  const servesProductionBuild = existsSync(resolve(staticDirectory, "index.html"));
  const server = createApp({
    database,
    feed,
    ...(servesProductionBuild ? { staticDirectory } : {}),
  }).listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    if (servesProductionBuild) {
      const pageResponse = await fetch(baseUrl);
      assert.equal(pageResponse.status, 200);
      assert.match(await pageResponse.text(), /assets\/index-/);
    }

    const fixturesResponse = await fetch(`${baseUrl}/api/fixtures`);
    assert.equal(fixturesResponse.status, 200);
    const fixturePayload = await fixturesResponse.json() as { fixtures: Fixture[] };
    assert.equal(fixturePayload.source, "the-odds-api");
    assert.equal(fixturePayload.fixtures[0]?.selections.length, 4);

    for (const requestBody of [
      { targetOdds: 50.01, sport: "football", period: "daily", timeZone: "UTC" },
      { targetOdds: 200.01, sport: "football", period: "weekend", timeZone: "UTC" },
    ]) {
      const rejected = await fetch(`${baseUrl}/api/generate-selections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      assert.equal(rejected.status, 400);
    }

    const previewResponse = await fetch(`${baseUrl}/api/generate-selections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetOdds: 5, sport: "football", period: "daily", timeZone: "UTC" }),
    });
    const preview = await previewResponse.json() as {
      picks: Array<{ fixture: Fixture; selection: Fixture["selections"][number] }>;
      combinedOdds: string;
      targetReached: boolean;
    };
    assert.equal(previewResponse.status, 200);
    assert.equal(preview.picks.length, 1);
    assert.equal(preview.picks[0]?.selection.selection, "home");
    assert.equal(Number(preview.combinedOdds), 2.15);
    assert.equal(preview.targetReached, false);
    assert.equal(preview.period, "daily");
    assert.equal(preview.picks[0]?.fixture.startsAt.slice(0, 10), preview.window.startsAt.slice(0, 10));
    assert.equal(fixtureRequests, 1, "generation reuses the shared recent provider snapshot");
    const previewHistoryResponse = await fetch(`${baseUrl}/api/history`);
    const previewHistory = await previewHistoryResponse.json() as { tickets: unknown[] };
    assert.equal(previewHistory.tickets.length, 0, "a preview must not save history before confirmation");

    providerOffline = true;
    const cachedFixturesResponse = await fetch(`${baseUrl}/api/fixtures?refresh=1`);
    const cachedFixtures = await cachedFixturesResponse.json() as {
      fixtures: Fixture[];
      stale: boolean;
      warnings: string[];
    };
    assert.equal(cachedFixturesResponse.status, 200);
    assert.equal(cachedFixtures.stale, true);
    assert.equal(cachedFixtures.fixtures.length, 1);
    assert.ok(cachedFixtures.warnings.some((warning) => warning.includes("preview only")));

    await database.query("UPDATE market_selections SET updated_at = $1", [new Date(Date.now() - 7 * 60 * 60 * 1000)]);
    const cachedPreviewResponse = await fetch(`${baseUrl}/api/generate-selections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetOdds: 5, sport: "football", period: "daily", timeZone: "UTC" }),
    });
    const cachedPreview = await cachedPreviewResponse.json() as {
      picks: Array<{ fixture: Fixture }>;
      stale: boolean;
      warning: string;
    };
    assert.equal(cachedPreviewResponse.status, 200);
    assert.equal(cachedPreview.stale, true);
    assert.equal(cachedPreview.picks.length, 1);
    assert.match(cachedPreview.warning, /saving is disabled/i);
    const staleSaveResponse = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetOdds: 5,
        selections: [`${fixture.id}|${fixture.selections[0]!.id}`],
        period: "daily",
        sport: "football",
        timeZone: "UTC",
      }),
    });
    assert.equal(staleSaveResponse.status, 503, "stale selections must not be saved as live prices");
    providerOffline = false;

    const homeMarket = fixture.selections.find((selection) => selection.selection === "home");
    assert.ok(homeMarket);
    const wrongSportSave = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetOdds: 5,
        selections: [`${fixture.id}|${homeMarket.id}`],
        period: "daily",
        sport: "basketball",
        timeZone: "UTC",
      }),
    });
    assert.equal(wrongSportSave.status, 409);

    const createdResponse = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetOdds: 5,
        selections: [`${fixture.id}|${homeMarket.id}`],
        period: "daily",
        sport: "football",
        timeZone: "UTC",
      }),
    });
    const createdBody = await createdResponse.json() as {
      combinedOdds?: number;
      predictionStatus?: string;
      error?: string;
      period?: string;
      source?: string;
    };
    assert.equal(createdResponse.status, 201, createdBody.error);
    const created = createdBody as { combinedOdds: string; predictionStatus: string };
    assert.equal(Number(created.combinedOdds), 2.15);
    assert.equal(created.predictionStatus, "not_available");
    assert.equal(createdBody.period, "daily");
    assert.equal(createdBody.source, "the-odds-api");

    const totalsSaveResponse = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetOdds: 5,
        selections: [`${fixture.id}|totals:2.5:over`],
        period: "daily",
        sport: "football",
        timeZone: "UTC",
      }),
    });
    const savedTotals = await totalsSaveResponse.json() as {
      error?: string;
      selections?: Array<{ market: string; selection: string }>;
    };
    assert.equal(totalsSaveResponse.status, 201, savedTotals.error);
    assert.equal(savedTotals.selections?.[0]?.market, "totals:2.5");
    assert.equal(savedTotals.selections?.[0]?.selection, "over");

    fixture = { ...fixture, status: "finished" };
    const historyResponse = await fetch(`${baseUrl}/api/history`);
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json() as {
      tickets: Array<{ status: string; period: string; selections: Array<{ status: string }> }>;
    };
    assert.equal(history.tickets.length, 2, "confirmed slips persist in history");
    const finishedTicket = history.tickets.find((ticket) => ticket.selections[0]?.status === "finished");
    assert.equal(finishedTicket?.status, "finished");
    assert.equal(finishedTicket?.period, "daily");
    const savedTotalsTicket = history.tickets.find((ticket) => ticket.selections[0]?.market === "totals:2.5");
    assert.equal(savedTotalsTicket?.selections[0]?.selection, "over");

    providerOffline = true;
    await database.query("UPDATE market_selections SET updated_at = $1", [new Date(Date.now() - 25 * 60 * 60 * 1000)]);
    const expiredCacheResponse = await fetch(`${baseUrl}/api/fixtures?refresh=1`);
    assert.equal(expiredCacheResponse.status, 503, "prices older than 24 hours must not be offered as a preview");
  } finally {
    server.close();
    await once(server, "close");
    await database.end();
  }
});

test("feed failures return a service-unavailable response without fake fixtures", async () => {
  const memory = newDb();
  const PgPool = memory.adapters.createPg().Pool;
  const database = new PgPool();
  await migrate(database);
  const feed = {
    source: "the-odds-api",
    getFixtures: async () => {
      throw new ProviderError("ODDS_API_KEY is not configured.");
    },
  };
  const server = createApp({ database, feed }).listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/fixtures`);
    assert.equal(response.status, 503);
    const body = await response.json() as { source: string; error: string };
    assert.equal(body.source, "the-odds-api");
    assert.match(body.error, /ODDS_API_KEY/);
  } finally {
    server.close();
    await once(server, "close");
    await database.end();
  }
});
