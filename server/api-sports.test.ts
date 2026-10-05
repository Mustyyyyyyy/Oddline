import assert from "node:assert/strict";
import test from "node:test";
import { ApiSportsSchedule, getApiSportsConfig, getPricedApiSportsFixtures, joinScheduleStatuses, normalizeBasketballGame, normalizeFootballFixture } from "./api-sports.js";
import { ProviderError } from "./errors.js";
import type { Fixture } from "./types.js";

const now = new Date("2026-10-05T12:00:00.000Z");

test("API-Sports config requires the backend key and bounds schedule range", () => {
  assert.throws(() => getApiSportsConfig({}), /API_SPORTS_KEY/);
  assert.deepEqual(
    getApiSportsConfig({ API_SPORTS_KEY: "  private-test-key  ", ODDS_API_DAYS_AHEAD: "10" }),
    { apiKey: "private-test-key", daysAhead: 10 },
  );
  assert.throws(() => getApiSportsConfig({ API_SPORTS_KEY: "test", ODDS_API_DAYS_AHEAD: "14" }), /between 1 and 13/);
});

test("normalizes Football fixtures and NBA games with provider-reported statuses", () => {
  const football = normalizeFootballFixture({
    fixture: { date: "2026-10-05T18:00:00Z", status: { short: "FT", long: "Match Finished" } },
    teams: { home: { name: "Home FC" }, away: { name: "Away FC" } },
    league: { name: "Premier League" },
  });
  assert.equal(football?.sport, "football");
  assert.equal(football?.status, "finished");
  assert.equal(football?.league, "Premier League");

  const basketball = normalizeBasketballGame({
    date: { start: "2026-10-06T01:30:00Z" },
    status: { short: "NS", long: "Not Started" },
    teams: { home: { name: "Los Angeles Lakers" }, visitors: { name: "Boston Celtics" } },
    league: { name: "NBA" },
  });
  assert.equal(basketball?.sport, "basketball");
  assert.equal(basketball?.status, "scheduled");
  assert.equal(normalizeBasketballGame({ date: {}, teams: {} }), undefined);
});

test("fetches the Football date range and current NBA season with the API-Sports header", async () => {
  const requests: Array<{ url: URL; key: string | null }> = [];
  const schedule = new ApiSportsSchedule(
    { apiKey: "private-test-key", daysAhead: 13 },
    async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, key: new Headers(init?.headers).get("x-apisports-key") });
      const response = url.hostname === "v3.football.api-sports.io"
        ? (url.searchParams.get("date") === "2026-10-05" ? [{
            fixture: { date: "2026-10-05T18:00:00Z", status: { short: "NS" } },
            teams: { home: { name: "Home FC" }, away: { name: "Away FC" } },
            league: { name: "Premier League" },
          }] : [])
        : [{
            date: { start: "2026-10-06T01:30:00Z" },
            status: { short: "NS" },
            teams: { home: { name: "Los Angeles Lakers" }, visitors: { name: "Boston Celtics" } },
            league: { name: "NBA" },
          }];
      return Response.json({ response, errors: [] });
    },
    () => now,
  );

  const fixtures = await schedule.getFixtures(true);
  assert.equal(fixtures.length, 2);
  assert.equal(requests.filter(({ url }) => url.hostname === "v3.football.api-sports.io").length, 17);
  assert.ok(requests.some(({ url }) =>
    url.hostname === "v3.football.api-sports.io"
    && url.pathname === "/fixtures"
    && url.searchParams.get("date") === "2026-10-05"));
  assert.ok(requests.some(({ url }) =>
    url.hostname === "v2.nba.api-sports.io"
    && url.pathname === "/games"
    && url.searchParams.get("league") === "standard"
    && url.searchParams.get("season") === "2026"));
  assert.ok(requests.every(({ key }) => key === "private-test-key"));
});

test("joins real schedules to priced fixtures by teams and kickoff time; unmatched prices are omitted", async () => {
  const schedule = new ApiSportsSchedule(
    { apiKey: "private-test-key", daysAhead: 13 },
    async (input) => {
      const football = new URL(String(input)).hostname === "v3.football.api-sports.io";
      const response = football
        ? (new URL(String(input)).searchParams.get("date") === "2026-10-05" ? [{
            fixture: { date: "2026-10-05T18:05:00Z", status: { short: "NS" } },
            teams: { home: { name: "Home FC" }, away: { name: "Away FC" } },
            league: { name: "Premier League" },
          }] : [])
        : [{
            date: { start: "2026-10-06T01:30:00Z" },
            status: { short: "NS" },
            teams: { home: { name: "LA Lakers" }, visitors: { name: "Boston Celtics" } },
            league: { name: "NBA" },
          }];
      return Response.json({ response, errors: [] });
    },
    () => now,
  );
  const pricedFixtures: Fixture[] = [
    {
      id: "odds-api:football-1",
      sport: "football",
      homeTeam: "Home FC",
      awayTeam: "Away FC",
      league: "EPL",
      startsAt: "2026-10-05T18:00:00Z",
      status: "scheduled",
      selections: [{
        id: "home",
        market: "h2h",
        selection: "home",
        odds: 2.1,
        bookmaker: "Book",
        marketBookmaker: "Book",
        marketProbability: 0.5,
        updatedAt: now.toISOString(),
      }],
      source: "the-odds-api",
      oddsUpdatedAt: now.toISOString(),
    },
    {
      id: "odds-api:nba-1",
      sport: "basketball",
      homeTeam: "Los Angeles Lakers",
      awayTeam: "Boston Celtics",
      league: "NBA",
      startsAt: "2026-10-06T01:30:00Z",
      status: "scheduled",
      selections: [],
      source: "the-odds-api",
      oddsUpdatedAt: now.toISOString(),
    },
    {
      id: "odds-api:unmatched",
      sport: "football",
      homeTeam: "Unlisted FC",
      awayTeam: "Other FC",
      league: "Unknown",
      startsAt: "2026-10-05T18:00:00Z",
      status: "scheduled",
      selections: [],
      source: "the-odds-api",
      oddsUpdatedAt: now.toISOString(),
    },
  ];
  const fixtures = await getPricedApiSportsFixtures(schedule, {
    getFixtures: async () => pricedFixtures,
  }, true);

  assert.equal(fixtures.length, 2);
  assert.deepEqual(fixtures.map(({ league }) => league), ["Premier League", "NBA"]);
  assert.equal(fixtures[0]?.id, "odds-api:football-1", "provider price identity remains stable for saved tickets");
  assert.equal(fixtures[0]?.startsAt, "2026-10-05T18:05:00.000Z");
  assert.equal(fixtures[0]?.selections[0]?.odds, 2.1);
  assert.equal(fixtures[1]?.status, "scheduled");
});

test("updates saved fixture statuses from API-Sports schedules without requiring odds", () => {
  const tracked: Fixture = {
    id: "odds-api:football-1",
    sport: "football",
    homeTeam: "Home FC",
    awayTeam: "Away FC",
    league: "EPL",
    startsAt: "2026-10-05T18:00:00Z",
    status: "scheduled",
    selections: [],
    source: "the-odds-api",
    oddsUpdatedAt: now.toISOString(),
  };
  const updates = joinScheduleStatuses([{
    sport: "football",
    homeTeam: "Home",
    awayTeam: "Away",
    league: "Premier League",
    startsAt: "2026-10-05T18:05:00Z",
    status: "finished",
  }], [tracked]);

  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.id, tracked.id);
  assert.equal(updates[0]?.status, "finished");
  assert.deepEqual(updates[0]?.selections, []);
});

test("API-Sports key errors are reported without exposing credentials", async () => {
  const schedule = new ApiSportsSchedule(
    { apiKey: "do-not-print-this", daysAhead: 13 },
    async () => Response.json({ response: [], errors: { token: "invalid key" } }),
    () => now,
  );
  await assert.rejects(schedule.getFixtures(true), (error: unknown) =>
    error instanceof ProviderError
    && /token: invalid key/.test(error.message)
    && !error.message.includes("do-not-print-this"));

  const reflectedCredential = new ApiSportsSchedule(
    { apiKey: "do-not-print-this", daysAhead: 13 },
    async () => Response.json({ response: [], errors: { token: "do-not-print-this" } }),
    () => now,
  );
  await assert.rejects(reflectedCredential.getFixtures(true), (error: unknown) =>
    error instanceof ProviderError
    && error.message.includes("[redacted]")
    && !error.message.includes("do-not-print-this"));
});

test("keeps Football available and surfaces the NBA current-season plan restriction", async () => {
  const schedule = new ApiSportsSchedule(
    { apiKey: "private-test-key", daysAhead: 13 },
    async (input) => {
      const url = new URL(String(input));
      const football = url.hostname === "v3.football.api-sports.io";
      return football
        ? Response.json({
            response: url.searchParams.get("date") === "2026-10-05" ? [{
              fixture: { date: "2026-10-05T18:00:00Z", status: { short: "NS" } },
              teams: { home: { name: "Home FC" }, away: { name: "Away FC" } },
              league: { name: "Premier League" },
            }] : [],
            errors: [],
          })
        : Response.json({
            response: [],
            errors: { plan: "Free plans do not have access to this season, try from 2022 to 2024." },
          });
    },
    () => now,
  );

  const fixtures = await schedule.getFixtures(true);
  assert.ok(fixtures.length > 0);
  assert.equal(fixtures[0]?.sport, "football");
  assert.ok(schedule.getWarnings().some((warning) => warning.startsWith("NBA schedule unavailable:")));
});

test("fails clearly if both API-Sports schedules are unavailable", async () => {
  const schedule = new ApiSportsSchedule(
    { apiKey: "private-test-key", daysAhead: 13 },
    async () => Response.json({ response: [], errors: { plan: "Access denied." } }),
    () => now,
  );
  await assert.rejects(schedule.getFixtures(true), /API-Sports schedules unavailable.*Football schedules unavailable for all requested dates.*NBA schedule unavailable/);
});
