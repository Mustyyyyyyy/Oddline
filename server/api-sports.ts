import type { Fixture } from "./types.js";

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

interface ScheduledFootballFixture {
  sport: "football";
  homeTeam: string;
  awayTeam: string;
  league: string;
  startsAt: string;
  status: Fixture["status"];
}

export function normalizeFootballFixture(value: unknown): ScheduledFootballFixture | undefined {
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
