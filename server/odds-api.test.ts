import assert from "node:assert/strict";
import test from "node:test";
import { ProviderError } from "./errors.js";
import { getOddsApiConfig, normalizeOddsEvent, normalizeScoreEvent, TheOddsApiFeed } from "./odds-api.js";

const oddsEvent = {
  id: "event-123",
  sport_key: "soccer_epl",
  sport_title: "EPL",
  commence_time: "2026-10-05T12:00:00Z",
  home_team: "Home FC",
  away_team: "Away FC",
  bookmakers: [
    {
      title: "Best price",
      markets: [{
        key: "h2h",
        outcomes: [
          { name: "Home FC", price: 2.1 },
          { name: "Away FC", price: 3.5 },
          { name: "Draw", price: 3.2 },
        ],
      }, {
        key: "totals",
        outcomes: [
          { name: "Over", point: 2.5, price: 1.9 },
          { name: "Under", point: 2.5, price: 1.95 },
        ],
      }, {
        key: "spreads",
        outcomes: [
          { name: "Home FC", point: -1.25, price: 2.1 },
          { name: "Away FC", point: 1.25, price: 1.8 },
        ],
      }],
    },
    {
      title: "Lowest margin",
      markets: [{
        key: "h2h",
        outcomes: [
          { name: "Home FC", price: 2.2 },
          { name: "Away FC", price: 3.6 },
          { name: "Draw", price: 3.5 },
        ],
      }, {
        key: "totals",
        outcomes: [
          { name: "Over", point: 2.5, price: 2.0 },
          { name: "Under", point: 2.5, price: 2.0 },
        ],
      }, {
        key: "spreads",
        outcomes: [
          { name: "Home FC", point: -1.25, price: 2.2 },
          { name: "Away FC", point: 1.25, price: 1.9 },
        ],
      }],
    },
  ],
};

test("Odds API config requires a key and accepts configured soccer and basketball leagues", () => {
  assert.throws(() => getOddsApiConfig({}), /ODDS_API_KEY/);
  const config = getOddsApiConfig({
    ODDS_API_KEY: "test-key",
    ODDS_API_SPORT_KEYS: "soccer_epl,basketball_nba",
  });
  assert.deepEqual(config.sportKeys, ["soccer_epl", "basketball_nba"]);
  assert.throws(
    () => getOddsApiConfig({ ODDS_API_KEY: "test-key", ODDS_API_SPORT_KEYS: "tennis_atp" }),
    /valid soccer_\* or basketball_\*/,
  );
});

test("normalizes current head-to-head odds and the lowest-overround market probabilities", () => {
  const fixture = normalizeOddsEvent(oddsEvent, "us", "2026-10-04T00:00:00.000Z");
  assert.ok(fixture);
  assert.equal(fixture.source, "the-odds-api");
  assert.equal(fixture.id, "odds-api:event-123");
  assert.equal(fixture.homeTeam, "Home FC");
  assert.equal(fixture.league, "EPL");
  assert.deepEqual(
    fixture.selections.filter((selection) => selection.market === "h2h").map((selection) => selection.selection).sort(),
    ["home", "draw", "away"].sort(),
  );
  assert.equal(fixture.selections.find((selection) => selection.selection === "home")?.odds, 2.2);
  assert.equal(fixture.selections.find((selection) => selection.selection === "home")?.marketBookmaker, "Lowest margin");
  assert.equal(fixture.selections.find((selection) => selection.market === "totals:2.5" && selection.selection === "over")?.odds, 2);
  assert.equal(fixture.selections.find((selection) => selection.market === "spreads:1.25" && selection.selection === "home:-1.25")?.odds, 2.2);
});

test("normalizes basketball moneyline, rejects incomplete odds, and maps completed scores", () => {
  const basketball = normalizeOddsEvent({
    ...oddsEvent,
    sport_key: "basketball_nba",
    bookmakers: [{
      title: "NBA Book",
      markets: [{
        key: "h2h",
        outcomes: [{ name: "Home FC", price: 1.8 }, { name: "Away FC", price: 2.1 }],
      }, {
        key: "totals",
        outcomes: [{ name: "Over", point: 220.5, price: 1.9 }, { name: "Under", point: 220.5, price: 1.9 }],
      }, {
        key: "spreads",
        outcomes: [{ name: "Home FC", point: -4.5, price: 1.91 }, { name: "Away FC", point: 4.5, price: 1.91 }],
      }],
    }],
  });
  assert.ok(basketball);
  assert.ok(basketball.selections.some((selection) => selection.market === "totals:220.5" && selection.selection === "over"));
  assert.ok(basketball.selections.some((selection) => selection.market === "spreads:4.5" && selection.selection === "home:-4.5"));
  assert.equal(normalizeOddsEvent({
    ...oddsEvent,
    bookmakers: [{ title: "Incomplete", markets: [{ key: "h2h", outcomes: [{ name: "Home FC", price: 2 }] }] }],
  }), undefined);
  const finished = normalizeScoreEvent({ ...oddsEvent, completed: true });
  assert.equal(finished?.status, "finished");
  assert.deepEqual(finished?.selections, []);
});

test("fetches odds and scores from the configured API with status caching", async () => {
  const requests: string[] = [];
  const feed = new TheOddsApiFeed({
    apiKey: "private-test-key",
    sportKeys: ["soccer_epl"],
    region: "us",
    daysAhead: 13,
  }, async (input) => {
    const url = new URL(String(input));
    requests.push(url.href);
    const payload = url.pathname.endsWith("/scores") ? [{ ...oddsEvent, completed: true }] : [oddsEvent];
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  const fixtures = await feed.getFixtures(true);
  assert.equal(fixtures.length, 1);
  assert.equal(fixtures[0]?.source, "the-odds-api");
  const statuses = await feed.getStatuses(true);
  assert.equal(statuses[0]?.status, "finished");
  assert.ok(requests.some((url) => url.includes("/sports/soccer_epl/odds?")));
  assert.ok(requests.some((url) => url.includes("/sports/soccer_epl/scores?") && url.includes("daysFrom=3")));
  assert.ok(requests.every((url) => url.includes("apiKey=private-test-key")));
  const oddsUrl = new URL(requests.find((url) => url.includes("/odds?"))!);
  assert.equal(oddsUrl.searchParams.get("markets"), "h2h,totals,spreads");
  assert.match(oddsUrl.searchParams.get("commenceTimeFrom")!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("reports rejected API keys and quota exhaustion without substituting data", async () => {
  const feed = new TheOddsApiFeed({
    apiKey: "private-test-key",
    sportKeys: ["basketball_nba"],
    region: "us",
    daysAhead: 13,
  }, async () => new Response("unauthorized", { status: 401 }));
  await assert.rejects(feed.getFixtures(true), (error: unknown) =>
    error instanceof ProviderError && /ODDS_API_KEY/.test(error.message));

  const invalidRequest = new TheOddsApiFeed({
    apiKey: "private-test-key",
    sportKeys: ["basketball_nba"],
    region: "us",
    daysAhead: 13,
  }, async () => new Response(JSON.stringify({ message: "Invalid date range." }), {
    status: 422,
    headers: { "Content-Type": "application/json" },
  }));
  await assert.rejects(invalidRequest.getFixtures(true), /Invalid date range/);
});
