import type { Database, EventStatus, Fixture, MarketSelection, SavedSelection, Ticket } from "./types.js";
import { getGenerationWindow, getNextWeekendWindow, isSundayInTimeZone, type GenerationPeriod } from "./generation-window.js";

interface FixtureRow {
  id: string;
  source: Fixture["source"];
  sport: Fixture["sport"];
  home_team: string;
  away_team: string;
  league: string;
  starts_at: Date;
  status: EventStatus;
  updated_at: Date;
}

interface MarketRow {
  id: string;
  fixture_id: string;
  market: string;
  selection: MarketSelection["selection"];
  odds: string | number;
  bookmaker: string;
  market_bookmaker: string;
  market_probability: string | number;
  updated_at: Date;
}

interface HistoryRow {
  ticket_id: string;
  target_odds: string | number;
  combined_odds: string | number;
  created_at: Date;
  source: string;
  generation_period: GenerationPeriod;
  fixture_id: string;
  market_selection_id: string;
  sport: Fixture["sport"];
  home_team: string;
  away_team: string;
  league: string;
  starts_at: Date;
  status: EventStatus;
  market: string;
  selection: MarketSelection["selection"];
  odds: string | number;
  bookmaker: string;
  market_bookmaker: string;
  market_probability: string | number;
}

export async function syncFixtures(database: Database, fixtures: Fixture[]): Promise<void> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE market_selections SET active = FALSE");
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    await client.query(
      `UPDATE fixtures
       SET status = 'unknown'
       WHERE source IN ('sportradar', 'the-odds-api', 'api-sports') AND starts_at < $1
         AND status NOT IN ('finished', 'postponed', 'cancelled', 'abandoned')`,
      [todayUtc],
    );
    for (const fixture of fixtures) {
      await client.query(
        `INSERT INTO fixtures
          (id, sport, home_team, away_team, league, starts_at, status, source, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (id) DO UPDATE SET
           sport = EXCLUDED.sport,
           home_team = EXCLUDED.home_team,
           away_team = EXCLUDED.away_team,
           league = EXCLUDED.league,
           starts_at = EXCLUDED.starts_at,
           status = EXCLUDED.status,
           source = EXCLUDED.source,
           updated_at = NOW()`,
        [fixture.id, fixture.sport, fixture.homeTeam, fixture.awayTeam, fixture.league, fixture.startsAt, fixture.status, fixture.source],
      );
      for (const selection of fixture.selections) {
        await client.query(
          `INSERT INTO market_selections
            (id, fixture_id, market, selection, odds, bookmaker, market_bookmaker, market_probability, updated_at, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
           ON CONFLICT (id) DO UPDATE SET
             odds = EXCLUDED.odds,
             bookmaker = EXCLUDED.bookmaker,
             market_bookmaker = EXCLUDED.market_bookmaker,
             market_probability = EXCLUDED.market_probability,
             updated_at = EXCLUDED.updated_at,
             active = TRUE`,
          [
            `${fixture.id}|${selection.id}`,
            fixture.id,
            selection.market,
            selection.selection,
            selection.odds,
            selection.bookmaker,
            selection.marketBookmaker,
            selection.marketProbability,
            selection.updatedAt,
          ],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listFixtures(database: Database, updatedSince?: Date): Promise<Fixture[]> {
  const freshnessFilter = updatedSince ? "AND ms.updated_at >= $1" : "";
  const { rows: fixtures } = await database.query<FixtureRow>(
    `SELECT DISTINCT f.id, f.source, f.sport, f.home_team, f.away_team, f.league, f.starts_at, f.status, f.updated_at
     FROM fixtures f
     JOIN market_selections ms ON ms.fixture_id = f.id AND ms.active = TRUE
     WHERE f.source IN ('sportradar', 'the-odds-api', 'api-sports')
       AND f.starts_at >= NOW() - INTERVAL '48 hours'
       ${freshnessFilter}
     ORDER BY f.starts_at`,
    updatedSince ? [updatedSince] : [],
  );
  const result: Fixture[] = [];
  for (const row of fixtures) {
    const { rows: markets } = await database.query<MarketRow>(
      `SELECT id, fixture_id, market, selection, odds, bookmaker,
              market_bookmaker, market_probability, updated_at
       FROM market_selections
       WHERE fixture_id = $1 AND active = TRUE
         ${updatedSince ? "AND updated_at >= $2" : ""}
       ORDER BY selection`,
      updatedSince ? [row.id, updatedSince] : [row.id],
    );
    result.push({
      id: row.id,
      sport: row.sport,
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      league: row.league,
      startsAt: new Date(row.starts_at).toISOString(),
      status: row.status,
      selections: markets.map(mapMarket),
      source: row.source,
      oddsUpdatedAt: new Date(row.updated_at).toISOString(),
    });
  }

  return result;
}

export async function listTrackedFixtures(database: Database): Promise<Fixture[]> {
  const { rows } = await database.query<FixtureRow>(
    `SELECT DISTINCT f.id, f.source, f.sport, f.home_team, f.away_team, f.league, f.starts_at, f.status, f.updated_at
     FROM fixtures f
     JOIN ticket_selections ts ON ts.fixture_id = f.id
     ORDER BY f.starts_at`,
  );
  return rows.map((row) => ({
    id: row.id,
    sport: row.sport,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    league: row.league,
    startsAt: new Date(row.starts_at).toISOString(),
    status: row.status,
    selections: [],
    source: row.source,
    oddsUpdatedAt: new Date(row.updated_at).toISOString(),
  }));
}

function mapMarket(row: MarketRow): MarketSelection {
  return {
    id: row.id,
    market: row.market,
    selection: row.selection,
    odds: Number(row.odds),
    bookmaker: row.bookmaker,
    marketBookmaker: row.market_bookmaker,
    marketProbability: Number(row.market_probability),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function saveTicket(
  database: Database,
  targetOdds: number,
  selectionIds: string[],
  period: GenerationPeriod,
  sport: Fixture["sport"] | "all",
  timeZone: string,
): Promise<Ticket> {
  const maximum = period === "daily" ? 50 : 200;
  if (targetOdds > maximum) throw new Error(`${period === "daily" ? "Daily" : "Weekend"} target odds cannot exceed ${maximum}.`);
  const now = new Date();
  const window = period === "weekend" && isSundayInTimeZone(now, timeZone)
    ? getNextWeekendWindow(timeZone, now)
    : getGenerationWindow(period, timeZone, now);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const selectionPlaceholders = selectionIds.map((_, index) => `$${index + 1}`).join(", ");
    const { rows } = await client.query<MarketRow & {
      sport: Fixture["sport"];
      home_team: string;
      away_team: string;
      league: string;
      starts_at: Date;
      status: EventStatus;
      fixture_source: Fixture["source"];
    }>(
      `SELECT ms.id, ms.fixture_id, ms.market, ms.selection, ms.odds, ms.bookmaker,
              ms.market_bookmaker, ms.market_probability, ms.updated_at,
              f.sport, f.home_team, f.away_team, f.league, f.starts_at, f.status, f.source AS fixture_source
       FROM market_selections ms
       JOIN fixtures f ON f.id = ms.fixture_id
       WHERE ms.id IN (${selectionPlaceholders}) AND ms.active = TRUE
       FOR UPDATE`,
      selectionIds,
    );
    if (rows.length !== selectionIds.length) throw new Error("One or more prices are no longer available. Refresh the board.");
    if (new Set(rows.map((row) => row.fixture_id)).size !== rows.length) {
      throw new Error("Select no more than one outcome per game.");
    }
    if (rows.some((row) => row.status !== "scheduled")) {
      throw new Error("Only scheduled games can be added to a new ticket.");
    }
    if (rows.some((row) => sport !== "all" && row.sport !== sport)) {
      throw new Error("Every selection must use the chosen sport.");
    }
    if (rows.some((row) => {
      const startsAt = new Date(row.starts_at);
      return startsAt < window.startsAt || startsAt >= window.endsAt;
    })) {
      throw new Error("Every selection must be in the selected date window.");
    }
    const combinedOdds = multiplyDecimalOdds(rows.map((row) => String(row.odds)));
    if (Number(combinedOdds) > maximum) {
      throw new Error(`Generated combined odds cannot exceed ${maximum} for a ${period} slip.`);
    }
    const { rows: ticketRows } = await client.query<{
      id: string;
      target_odds: string | number;
      combined_odds: string | number;
      created_at: Date;
    }>(
      `INSERT INTO tickets (target_odds, combined_odds, generation_period, source)
       VALUES ($1, $2, $3, $4) RETURNING id, target_odds, combined_odds, created_at`,
      [targetOdds, combinedOdds, period, rows[0]!.fixture_source],
    );
    const ticket = ticketRows[0];
    const selections: SavedSelection[] = [];
    for (const row of rows) {
      await client.query(
        `INSERT INTO ticket_selections
          (ticket_id, fixture_id, market_selection_id, market, selection, odds,
           bookmaker, market_bookmaker, market_probability)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          ticket.id, row.fixture_id, row.id, row.market, row.selection,
          row.odds, row.bookmaker, row.market_bookmaker, row.market_probability,
        ],
      );
      selections.push({
        id: row.id,
        fixtureId: row.fixture_id,
        sport: row.sport,
        homeTeam: row.home_team,
        awayTeam: row.away_team,
        league: row.league,
        startsAt: new Date(row.starts_at).toISOString(),
        status: row.status,
        market: row.market,
        selection: row.selection,
        odds: Number(row.odds),
        bookmaker: row.bookmaker,
        marketBookmaker: row.market_bookmaker,
        marketProbability: Number(row.market_probability),
        updatedAt: new Date(row.updated_at).toISOString(),
      });
    }
    await client.query("COMMIT");
    return {
      id: Number(ticket.id),
      targetOdds: Number(ticket.target_odds),
      combinedOdds: String(ticket.combined_odds),
      createdAt: new Date(ticket.created_at).toISOString(),
      status: "open",
      source: rows[0]!.fixture_source,
      period,
      selections,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function syncFixtureStatuses(database: Database, fixtures: Fixture[]): Promise<void> {
  for (const fixture of fixtures) {
    await database.query(
      `UPDATE fixtures
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND source = $3`,
      [fixture.status, fixture.id, fixture.source],
    );
  }
}

export async function listHistory(database: Database): Promise<Ticket[]> {
  const { rows } = await database.query<HistoryRow>(
    `SELECT t.id AS ticket_id, t.target_odds, t.combined_odds, t.created_at, t.source, t.generation_period,
            f.id AS fixture_id, f.sport, f.home_team, f.away_team, f.league,
            f.starts_at, f.status, ts.market_selection_id, ts.market, ts.selection, ts.odds,
            ts.bookmaker, ts.market_bookmaker, ts.market_probability
     FROM tickets t
     JOIN ticket_selections ts ON ts.ticket_id = t.id
     JOIN fixtures f ON f.id = ts.fixture_id
     ORDER BY t.created_at DESC, f.starts_at`,
  );
  const tickets = new Map<number, Ticket>();
  for (const row of rows) {
    const id = Number(row.ticket_id);
    let ticket = tickets.get(id);
    if (!ticket) {
      ticket = {
        id,
        targetOdds: Number(row.target_odds),
        combinedOdds: String(row.combined_odds),
        createdAt: new Date(row.created_at).toISOString(),
        status: "open",
        source: row.source,
        period: row.generation_period,
        selections: [],
      };
      tickets.set(id, ticket);
    }
    ticket.selections.push({
      id: row.market_selection_id,
      fixtureId: row.fixture_id,
      sport: row.sport,
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      league: row.league,
      startsAt: new Date(row.starts_at).toISOString(),
      status: row.status,
      market: row.market,
      selection: row.selection,
      odds: Number(row.odds),
      bookmaker: row.bookmaker,
      marketBookmaker: row.market_bookmaker,
      marketProbability: Number(row.market_probability),
      updatedAt: new Date(row.created_at).toISOString(),
    });
  }
  for (const ticket of tickets.values()) {
    ticket.status = ticket.selections.every((selection) => selection.status === "finished")
      ? "finished"
      : ticket.selections.some((selection) => selection.status === "live")
        ? "live"
        : "open";
  }
  return [...tickets.values()];
}

export async function databaseIsReady(database: Database): Promise<void> {
  await database.query("SELECT 1");
}

export function multiplyDecimalOdds(odds: string[]): string {
  if (!odds.length) throw new Error("Choose at least one outcome.");
  let product = 1n;
  for (const value of odds) {
    if (!/^\d+(?:\.\d{1,4})?$/.test(value) || Number(value) <= 1 || Number(value) > 1000) {
      throw new Error("Odds contain an invalid decimal price.");
    }
    const [whole, fraction = ""] = value.split(".");
    product *= BigInt(`${whole}${fraction.padEnd(4, "0")}`);
  }
  const decimalPlaces = odds.length * 4;
  const digits = product.toString().padStart(decimalPlaces + 1, "0");
  const whole = digits.slice(0, -decimalPlaces);
  const fraction = digits.slice(-decimalPlaces).replace(/0+$/, "");
  return `${whole}.${fraction || "0"}`;
}
