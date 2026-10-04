import assert from "node:assert/strict";
import test from "node:test";
import { generateSlip } from "./generator.js";
import type { Fixture, MarketSelection, Sport } from "./types.js";

function makeFixture(
  id: string,
  sport: Sport,
  startsInMinutes: number,
  homeOdds: number,
  awayOdds: number,
): Fixture {
  const updatedAt = new Date().toISOString();
  const selection = (
    outcome: "home" | "away",
    odds: number,
    marketProbability: number,
  ): MarketSelection => ({
    id: `${id}-${outcome}`,
    market: sport === "football" ? "3way" : "2way",
    selection: outcome,
    odds,
    bookmaker: "Licensed book",
    marketBookmaker: "Market consensus",
    marketProbability,
    updatedAt,
  });
  return {
    id,
    sport,
    homeTeam: `${id} Home`,
    awayTeam: `${id} Away`,
    league: "Test competition",
    startsAt: new Date(Date.now() + startsInMinutes * 60_000).toISOString(),
    status: "scheduled",
    source: "the-odds-api",
    oddsUpdatedAt: updatedAt,
    selections: [
      selection("home", homeOdds, 0.65),
      selection("away", awayOdds, 0.35),
    ],
  };
}

test("generates a target-reaching daily slip from market favorites in the selected sport", () => {
  const fixtures = [
    makeFixture("football-1", "football", 20, 1.9, 3.8),
    makeFixture("basketball-1", "basketball", 30, 2.1, 4.2),
    makeFixture("football-2", "football", 40, 2.2, 3.5),
  ];

  const now = new Date("2026-10-04T12:00:00.000Z");
  fixtures[0]!.startsAt = "2026-10-04T13:00:00.000Z";
  fixtures[1]!.startsAt = "2026-10-04T14:00:00.000Z";
  fixtures[2]!.startsAt = "2026-10-04T15:00:00.000Z";
  const slip = generateSlip(fixtures, "football", "daily", 4, "UTC", now);

  assert.equal(slip.targetReached, true);
  assert.equal(Number(slip.combinedOdds), 4.18);
  assert.deepEqual(slip.picks.map(({ fixture, selection }) => [fixture.id, selection.selection]), [
    ["football-1", "home"],
    ["football-2", "home"],
  ]);
});

test("reports when the available sport markets cannot reach the target", () => {
  const slip = generateSlip([
    makeFixture("football-1", "football", 20, 1.9, 3.8),
    makeFixture("basketball-1", "basketball", 30, 2.1, 4.2),
  ], "basketball", "daily", 10, "UTC");

  assert.equal(slip.targetReached, false);
  assert.equal(slip.picks.length, 1);
  assert.equal(slip.picks[0]?.fixture.sport, "basketball");
});

test("varies market families while keeping one selection per game", () => {
  const fixtures = ["match-1", "match-2", "match-3", "match-4"].map((id, index) => {
    const fixture = makeFixture(id, "football", 20 + index * 10, 2.1, 3.8);
    fixture.selections.push({
      id: `${id}-totals`,
      market: "totals:2.5",
      selection: "under",
      odds: 1.9,
      bookmaker: "Licensed book",
      marketBookmaker: "Market consensus",
      marketProbability: 0.6,
      updatedAt: fixture.oddsUpdatedAt,
    }, {
      id: `${id}-spreads`,
      market: "spreads:1.5",
      selection: "home:-1.5",
      odds: 2.2,
      bookmaker: "Licensed book",
      marketBookmaker: "Market consensus",
      marketProbability: 0.55,
      updatedAt: fixture.oddsUpdatedAt,
    });
    fixture.startsAt = new Date(Date.UTC(2026, 9, 4, 13 + index)).toISOString();
    return fixture;
  });
  const slip = generateSlip(fixtures, "football", "daily", 20, "UTC", new Date("2026-10-04T12:00:00.000Z"));
  const families = new Set(slip.picks.map(({ selection }) => selection.market.split(":")[0]));
  assert.ok(families.size > 1);
  assert.equal(new Set(slip.picks.map(({ fixture }) => fixture.id)).size, slip.picks.length);
});

test("returns no picks instead of fabricating fixtures", () => {
  assert.deepEqual(generateSlip([], "all", "daily", 5, "UTC").picks, []);
});

test("daily period includes only today's fixtures in the user's time zone", () => {
  const fixture = makeFixture("daily-late", "football", 600, 1.9, 3.8);
  fixture.startsAt = "2026-10-05T07:30:00.000Z";
  const now = new Date("2026-10-04T12:00:00.000Z");
  const slip = generateSlip([fixture], "all", "daily", 2, "America/Los_Angeles", now);
  assert.equal(slip.picks.length, 0);
  assert.equal(slip.window.startsAt, "2026-10-04T07:00:00.000Z");
  assert.equal(slip.window.endsAt, "2026-10-05T07:00:00.000Z");
});

test("weekend period selects the upcoming Friday through Sunday when generated on Sunday", () => {
  const fixtures = [
    makeFixture("current-sunday", "football", 60, 2, 3),
    makeFixture("next-friday", "football", 61, 2, 3),
    makeFixture("next-sunday", "football", 62, 2, 3),
    makeFixture("monday", "football", 61, 2, 3),
  ];
  fixtures[0]!.startsAt = "2026-10-04T20:00:00.000Z";
  fixtures[1]!.startsAt = "2026-10-09T15:00:00.000Z";
  fixtures[2]!.startsAt = "2026-10-11T20:00:00.000Z";
  fixtures[3]!.startsAt = "2026-10-05T15:00:00.000Z";
  const sunday = new Date("2026-10-04T12:00:00.000Z");
  const upcomingWeekend = generateSlip(fixtures, "all", "weekend", 2, "America/Los_Angeles", sunday);
  assert.deepEqual(upcomingWeekend.picks.map(({ fixture }) => fixture.id), ["next-friday"]);
  assert.equal(upcomingWeekend.window.startsAt, "2026-10-09T07:00:00.000Z");
  assert.equal(upcomingWeekend.window.endsAt, "2026-10-12T07:00:00.000Z");

  const monday = generateSlip(fixtures, "all", "weekend", 2, "America/Los_Angeles", new Date("2026-10-05T12:00:00.000Z"));
  assert.equal(monday.window.startsAt, "2026-10-09T07:00:00.000Z");
  assert.equal(monday.window.endsAt, "2026-10-12T07:00:00.000Z");
});

test("calculates the next weekend across a daylight-saving clock change", () => {
  const fixture = makeFixture("next-weekend", "football", 90, 2, 3.8);
  fixture.startsAt = "2026-11-06T15:00:00.000Z";
  const sundayAfternoon = new Date("2026-11-01T21:00:00.000Z");
  const slip = generateSlip([fixture], "all", "weekend", 2, "America/Los_Angeles", sundayAfternoon);
  assert.equal(slip.picks[0]?.fixture.id, "next-weekend");
  assert.equal(slip.window.startsAt, "2026-11-06T08:00:00.000Z");
  assert.equal(slip.window.endsAt, "2026-11-09T08:00:00.000Z");
});

test("balances weekend picks across available leagues", () => {
  const fixtures = [
    makeFixture("league-a-1", "football", 60, 1.9, 3.8),
    makeFixture("league-a-2", "football", 90, 2.1, 3.8),
    makeFixture("league-b-1", "football", 120, 2.2, 3.8),
    makeFixture("league-b-2", "football", 150, 2.3, 3.8),
  ];
  for (const [index, fixture] of fixtures.entries()) {
    fixture.league = index < 2 ? "League A" : "League B";
    fixture.startsAt = new Date(Date.UTC(2026, 9, 9, 13 + index)).toISOString();
  }
  const slip = generateSlip(fixtures, "football", "weekend", 15, "UTC", new Date("2026-10-05T12:00:00.000Z"));
  const leagueCounts = new Map<string, number>();
  for (const { fixture } of slip.picks) leagueCounts.set(fixture.league, (leagueCounts.get(fixture.league) ?? 0) + 1);
  assert.ok(leagueCounts.size > 1);
  assert.ok(Math.max(...leagueCounts.values()) - Math.min(...leagueCounts.values()) <= 1);
});

test("weekend target permits 200 while period caps are enforced by the API", () => {
  const fixture = makeFixture("weekend-odds", "football", 60, 1.9, 3.8);
  fixture.startsAt = "2026-10-02T15:00:00.000Z";
  const slip = generateSlip(
    [fixture],
    "football",
    "weekend",
    200,
    "America/Los_Angeles",
    new Date("2026-10-02T06:00:00.000Z"),
  );
  assert.equal(slip.targetOdds, 200);
  assert.equal(slip.picks.length, 1);
});

test("generated combined odds never exceed the daily or weekend cap", () => {
  const daily = makeFixture("daily-cap", "football", 60, 60, 80);
  const weekend = [
    makeFixture("weekend-cap-a", "football", 60, 190, 250),
    makeFixture("weekend-cap-b", "football", 80, 2, 4),
  ];
  daily.startsAt = "2026-10-04T13:00:00.000Z";
  weekend[0]!.startsAt = "2026-10-09T13:00:00.000Z";
  weekend[1]!.startsAt = "2026-10-10T14:00:00.000Z";
  const now = new Date("2026-10-04T12:00:00.000Z");

  const dailySlip = generateSlip([daily], "football", "daily", 50, "UTC", now);
  const weekendSlip = generateSlip(weekend, "football", "weekend", 200, "UTC", now);

  assert.equal(dailySlip.picks.length, 0);
  assert.equal(Number(dailySlip.combinedOdds), 1);
  assert.equal(Number(weekendSlip.combinedOdds), 190);
  assert.ok(Number(weekendSlip.combinedOdds) <= 200);
});
