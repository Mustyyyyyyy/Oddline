import type { QueryResult, QueryResultRow } from "pg";
import type { GenerationPeriod } from "./generation-window.js";

export type Sport = "football" | "basketball";
export type EventStatus =
  | "scheduled"
  | "live"
  | "finished"
  | "postponed"
  | "cancelled"
  | "abandoned"
  | "unknown";
export type OutcomeName = string;

export interface MarketSelection {
  id: string;
  market: string;
  selection: OutcomeName;
  odds: number;
  bookmaker: string;
  marketBookmaker: string;
  marketProbability: number;
  updatedAt: string;
}

export interface Fixture {
  id: string;
  sport: Sport;
  homeTeam: string;
  awayTeam: string;
  league: string;
  startsAt: string;
  status: EventStatus;
  selections: MarketSelection[];
  source: "the-odds-api" | "api-sports";
  oddsUpdatedAt: string;
}

export interface SavedSelection extends MarketSelection {
  fixtureId: string;
  sport: Sport;
  homeTeam: string;
  awayTeam: string;
  league: string;
  startsAt: string;
  status: EventStatus;
}

export interface Ticket {
  id: number;
  targetOdds: number;
  combinedOdds: string;
  createdAt: string;
  status: "open" | "live" | "finished" | "legacy";
  source: string;
  period: GenerationPeriod;
  selections: SavedSelection[];
}

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    parameters?: unknown[],
  ): Promise<QueryResult<T>>;
}

export interface Database extends Queryable {
  connect(): Promise<DatabaseClient>;
}

export interface DatabaseClient extends Queryable {
  release(): void;
}
