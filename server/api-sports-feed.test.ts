import assert from "node:assert/strict";
import test from "node:test";
import { ApiSportsFootballFeed, createApiSportsConfig, normalizeApiSportsMarkets } from "./api-sports-feed.js";
import { ProviderError } from "./errors.js";

const now = new Date("2026-10-05T12:00:00.000Z");

test("requires API-Sports configuration and defaults to the upcoming week", () => {
  assert.throws(() => createApiSportsConfig({}), /API_SPORTS_KEY/);
  assert.deepEqual(
    createApiSportsConfig({ API_SPORTS_KEY: " private-key " }),
    { apiKey: "private-key", daysAhead: 7 },
  );
  assert.throws(
    () => createApiSportsConfig({ API_SPORTS_KEY: "private-key", API_SPORTS_DAYS_AHEAD: "14" }),
    /between 1 and 13/,
  );
});

test("normalizes API-Sports result, totals, corners and both-teams-score markets", () => {
  const selections = normalizeApiSportsMarkets([
    {
      name: "Book A",
      bets: [
        { name: "Match Winner", values: [
          { value: "Home", odd: "2.1" },
          { value: "Draw", odd: "3.2" },
          { value: "Away", odd: "3.5" },
        ] },
        { name: "Goals Over/Under", values: [
          { value: "Over 2.5", odd: "1.9" },
          { value: "Under 2.5", odd: "1.95" },
        ] },
        { name: "Total - Corners", values: [
          { value: "Over 9.5", odd: "2.0" },
          { value: "Under 9.5", odd: "1.8" },
        ] },
        { name: "Both Teams Score", values: [
          { value: "Yes", odd: "1.75" },
          { value: "No", odd: "2.05" },
        ] },
      ],
    },
    {
      name: "Book B",
      bets: [{ name: "Match Winner", values: [
        { value: "Home", odd: "2.2" },
        { value: "Draw", odd: "3.1" },
        { value: "Away", odd: "3.4" },
      ] }],
    },
  ], "Home FC", "Away FC", now.toISOString());

  assert.equal(selections.find(({ market, selection }) => market === "h2h" && selection === "home")?.odds, 2.2);
  assert.ok(selections.some(({ market, selection }) => market === "totals:2.5" && selection === "over"));
  assert.ok(selections.some(({ market, selection }) => market === "corners:9.5" && selection === "under"));
  assert.ok(selections.some(({ market, selection }) => market === "btts" && selection === "yes"));
  assert.ok(selections.every(({ marketProbability }) => marketProbability > 0 && marketProbability < 1));
});

test("loads API-Sports Football fixtures and every odds page, matched by provider fixture ID", async () => {
  const requests: Array<{ url: URL; key: string | null }> = [];
  const feed = new ApiSportsFootballFeed(
    { apiKey: "private-test-key", daysAhead: 1 },
    async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, key: new Headers(init?.headers).get("x-apisports-key") });
      if (url.pathname.endsWith("/fixtures")) {
        const date = url.searchParams.get("date");
        const fixtureId = date === "2026-10-05" ? 700 : 800;
        return Response.json({
          response: [{
            fixture: { id: fixtureId, date: `${date}T18:00:00Z`, status: { short: "NS" } },
            teams: { home: { name: "Home FC" }, away: { name: "Away FC" } },
            league: { name: date === "2026-10-05" ? "Premier League" : "MLS" },
          }],
          paging: { current: 1, total: 1 },
          errors: [],
        });
      }
      const page = Number(url.searchParams.get("page"));
      const date = url.searchParams.get("date");
      const fixtureId = date === "2026-10-05" ? (page === 1 ? 700 : 701) : 800;
      return Response.json({
        response: [{
          fixture: { id: fixtureId },
          bookmakers: [{
            name: "Provider Book",
            bets: [{ name: "Match Winner", values: [
              { value: "Home", odd: "2.0" },
              { value: "Draw", odd: "3.0" },
              { value: "Away", odd: "4.0" },
            ] }],
          }],
        }],
        paging: { current: page, total: date === "2026-10-05" ? 2 : 1 },
        errors: [],
      });
    },
    () => now,
    3600,
  );

  const fixtures = await feed.getFixtures();
  assert.deepEqual(fixtures.map(({ id, league }) => [id, league]), [
    ["api-sports:football:700", "Premier League"],
    ["api-sports:football:800", "MLS"],
  ]);
  assert.equal(fixtures[0]?.source, "api-sports");
  assert.equal(fixtures[0]?.selections.find(({ selection }) => selection === "home")?.bookmaker, "Provider Book");
  assert.ok(requests.some(({ url }) => url.pathname.endsWith("/odds") && url.searchParams.get("page") === "2"));
  assert.ok(requests.every(({ key }) => key === "private-test-key"));
  assert.ok(feed.getWarnings().some((warning) => warning.startsWith("NBA is unavailable:")));
});

test("respects API-Sports Free plan three-page limit and keeps odds from accessible pages", async () => {
  const oddsPages = new Map<string, number[]>();
  const feed = new ApiSportsFootballFeed(
    { apiKey: "private-test-key", daysAhead: 1 },
    async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/fixtures")) {
        return Response.json({
          response: [700, 701, 702].map((id) => ({
            fixture: { id, date: "2026-10-05T18:00:00Z", status: { short: "NS" } },
            teams: { home: { name: `Home ${id}` }, away: { name: `Away ${id}` } },
            league: { name: "Premier League" },
          })),
          errors: [],
        });
      }
      const page = Number(url.searchParams.get("page"));
      const date = url.searchParams.get("date")!;
      const pages = oddsPages.get(date) ?? [];
      pages.push(page);
      oddsPages.set(date, pages);
      return Response.json({
        response: [{
          fixture: { id: 699 + page },
          bookmakers: [{
            name: "Provider Book",
            bets: [{ name: "Match Winner", values: [
              { value: "Home", odd: "2.0" },
              { value: "Draw", odd: "3.0" },
              { value: "Away", odd: "4.0" },
            ] }],
          }],
        }],
        paging: { current: page, total: 8 },
        errors: [],
      });
    },
    () => now,
    3600,
  );

  const fixtures = await feed.getFixtures();
  assert.ok(oddsPages.size >= 1);
  for (const pages of oddsPages.values()) assert.deepEqual(pages.sort(), [1, 2, 3]);
  assert.deepEqual(fixtures.map(({ id }) => id), [
    "api-sports:football:700",
    "api-sports:football:701",
    "api-sports:football:702",
  ]);
  assert.ok(feed.getWarnings().some((warning) => warning.includes("first 3 pages")));
});

test("refreshes recent saved Football statuses independently of odds", async () => {
  const feed = new ApiSportsFootballFeed(
    { apiKey: "private-test-key", daysAhead: 1 },
    async (input) => {
      const url = new URL(String(input));
      assert.ok(url.pathname.endsWith("/fixtures"));
      return Response.json({
        response: [{
          fixture: { id: 700, date: "2026-10-05T18:00:00Z", status: { short: "FT", long: "Match Finished" } },
          teams: { home: { name: "Home FC" }, away: { name: "Away FC" } },
          league: { name: "Premier League" },
        }],
        errors: [],
      });
    },
    () => now,
    3600,
  );
  const tracked = {
    id: "api-sports:football:700",
    sport: "football" as const,
    homeTeam: "Home FC",
    awayTeam: "Away FC",
    league: "Premier League",
    startsAt: "2026-10-05T18:00:00Z",
    status: "scheduled" as const,
    selections: [],
    source: "api-sports" as const,
    oddsUpdatedAt: now.toISOString(),
  };

  const updates = await feed.getStatuses([tracked]);
  assert.equal(updates[0]?.status, "finished");
  assert.deepEqual(updates[0]?.selections, []);
});

test("reports exhausted API-Sports quota and never fabricates fallback odds", async () => {
  const feed = new ApiSportsFootballFeed(
    { apiKey: "private-test-key", daysAhead: 1 },
    async () => Response.json({ response: [], errors: { requests: "Limit reached." } }),
    () => now,
    3600,
  );
  await assert.rejects(feed.getFixtures(), (error: unknown) =>
    error instanceof ProviderError
    && error.message.includes("API-Sports Football feed is unavailable")
    && error.message.includes("request quota"),
  );
});
