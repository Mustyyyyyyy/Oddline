import { z } from "zod";
import { ProviderError } from "./errors.js";
import type { Fixture, MarketSelection, OutcomeName, Sport } from "./types.js";

const apiRoot = "https://api.the-odds-api.com/v4";
const cacheSeconds = Math.max(15, Number(process.env.SPORTS_FEED_CACHE_SECONDS ?? 300));
const defaultSportKeys = [
  "soccer_epl",
  "soccer_usa_mls",
  "soccer_uefa_champs_league",
  "basketball_nba",
  "basketball_euroleague",
];

interface OddsApiConfig {
  apiKey: string;
  sportKeys: string[];
  region: string;
  daysAhead: number;
}

interface OddsOutcome {
  name?: unknown;
  price?: unknown;
  point?: unknown;
}

interface OddsMarket {
  key?: unknown;
  outcomes?: unknown;
}

interface OddsBookmaker {
  title?: unknown;
  markets?: unknown;
}

interface OddsEvent {
  id?: unknown;
  sport_key?: unknown;
  sport_title?: unknown;
  commence_time?: unknown;
  home_team?: unknown;
  away_team?: unknown;
  bookmakers?: unknown;
}

interface ScoreEvent extends OddsEvent {
  completed?: unknown;
}

let oddsCache: { expiresAt: number; fixtures: Fixture[] } | undefined;
let oddsRefresh: Promise<Fixture[]> | undefined;
let statusCache: { expiresAt: number; fixtures: Fixture[] } | undefined;
let statusRefresh: Promise<Fixture[]> | undefined;

export function getOddsApiConfig(env: NodeJS.ProcessEnv = process.env): OddsApiConfig {
  const apiKey = env.ODDS_API_KEY?.trim();
  if (!apiKey) throw new ProviderError("ODDS_API_KEY is not configured.");
  const sportKeys = (env.ODDS_API_SPORT_KEYS ?? defaultSportKeys.join(","))
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  if (!sportKeys.length || sportKeys.some((key) => !/^(soccer|basketball)_[a-z0-9_]+$/.test(key))) {
    throw new ProviderError("ODDS_API_SPORT_KEYS must contain valid soccer_* or basketball_* sport keys.");
  }
  if (new Set(sportKeys).size !== sportKeys.length) {
    throw new ProviderError("ODDS_API_SPORT_KEYS must not contain duplicate sport keys.");
  }
  const daysAhead = Number(env.ODDS_API_DAYS_AHEAD ?? 13);
  if (!Number.isInteger(daysAhead) || daysAhead < 1 || daysAhead > 13) {
    throw new ProviderError("ODDS_API_DAYS_AHEAD must be between 1 and 13.");
  }
  const region = env.ODDS_API_REGIONS ?? "us";
  if (!/^[a-z0-9_]+(?:,[a-z0-9_]+)*$/.test(region)) {
    throw new ProviderError("ODDS_API_REGIONS must be a comma-separated list of valid region codes.");
  }
  return { apiKey, sportKeys, region, daysAhead };
}

export class TheOddsApiFeed {
  readonly source = "the-odds-api";

  constructor(
    private readonly config: OddsApiConfig,
    private readonly request: typeof fetch = fetch,
  ) {}

  async getFixtures(forceRefresh = false): Promise<Fixture[]> {
    if (!forceRefresh && oddsCache && oddsCache.expiresAt > Date.now()) return oddsCache.fixtures;
    if (!oddsRefresh) {
      oddsRefresh = this.fetchOdds().then((fixtures) => {
        oddsCache = { fixtures, expiresAt: Date.now() + cacheSeconds * 1000 };
        return fixtures;
      }).finally(() => {
        oddsRefresh = undefined;
      });
    }
    return oddsRefresh;
  }

  async getStatuses(forceRefresh = false): Promise<Fixture[]> {
    if (!forceRefresh && statusCache && statusCache.expiresAt > Date.now()) return statusCache.fixtures;
    if (!statusRefresh) {
      statusRefresh = this.fetchStatuses().then((fixtures) => {
        statusCache = { fixtures, expiresAt: Date.now() + Math.max(cacheSeconds, 300) * 1000 };
        return fixtures;
      }).finally(() => {
        statusRefresh = undefined;
      });
    }
    return statusRefresh;
  }

  private async fetchOdds(): Promise<Fixture[]> {
    const now = new Date();
    const end = new Date(now.getTime() + this.config.daysAhead * 24 * 60 * 60 * 1000);
    const results = await mapConcurrent(this.config.sportKeys, 3, async (sportKey) => {
      const query = new URLSearchParams({
        apiKey: this.config.apiKey,
        regions: this.config.region,
        markets: "h2h,totals,spreads",
        oddsFormat: "decimal",
        dateFormat: "iso",
        commenceTimeFrom: formatProviderDate(now),
        commenceTimeTo: formatProviderDate(end),
      });
      const data = await this.requestJson(`/sports/${encodeURIComponent(sportKey)}/odds?${query}`);
      const parsed = z.array(z.unknown()).safeParse(data);
      if (!parsed.success) throw new ProviderError(`The Odds API returned an invalid odds list for ${sportKey}.`);
      return parsed.data
        .map((event) => normalizeOddsEvent(event, this.config.region))
        .filter((fixture): fixture is Fixture => fixture !== undefined);
    });
    return [...new Map(results.flat().map((fixture) => [fixture.id, fixture])).values()]
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  }

  private async fetchStatuses(): Promise<Fixture[]> {
    const results = await mapConcurrent(this.config.sportKeys, 3, async (sportKey) => {
      const query = new URLSearchParams({
        apiKey: this.config.apiKey,
        daysFrom: "3",
        dateFormat: "iso",
      });
      const data = await this.requestJson(`/sports/${encodeURIComponent(sportKey)}/scores?${query}`);
      const parsed = z.array(z.unknown()).safeParse(data);
      if (!parsed.success) throw new ProviderError(`The Odds API returned an invalid scores list for ${sportKey}.`);
      return parsed.data
        .map((event) => normalizeScoreEvent(event))
        .filter((fixture): fixture is Fixture => fixture !== undefined);
    });
    return [...new Map(results.flat().map((fixture) => [fixture.id, fixture])).values()];
  }

  private async requestJson(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(`${apiRoot}${path}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "request timed out" : "network error";
      throw new ProviderError(`The Odds API ${reason}.`);
    }
    if (!response.ok) {
      if (response.status === 401) {
        throw new ProviderError("The Odds API rejected ODDS_API_KEY (HTTP 401). Use an active API key from your account, without quotes or extra spaces, and redeploy.");
      }
      if (response.status === 403) {
        throw new ProviderError("The Odds API denied access (HTTP 403). Check your account permissions and subscription access for the requested markets.");
      }
      if (response.status === 429) {
        throw new ProviderError("The Odds API request limit was reached. Check your remaining monthly credits and plan.");
      }
      if (response.status === 422) {
        let message: unknown;
        try {
          const body: unknown = await response.json();
          if (isRecord(body)) message = body.message;
        } catch {
          message = undefined;
        }
        throw new ProviderError(
          typeof message === "string" ? `The Odds API rejected the request: ${message}` : "The Odds API rejected the request parameters (HTTP 422).",
        );
      }
      throw new ProviderError(`The Odds API request failed with HTTP ${response.status}.`);
    }
    try {
      return await response.json();
    } catch {
      throw new ProviderError("The Odds API returned invalid JSON.");
    }
  }
}

function formatProviderDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function normalizeOddsEvent(value: unknown, _region = "us", updatedAt = new Date().toISOString()): Fixture | undefined {
  if (!isRecord(value)) return undefined;
  const event = value as OddsEvent;
  if (
    typeof event.id !== "string" ||
    typeof event.sport_key !== "string" ||
    typeof event.commence_time !== "string" ||
    typeof event.home_team !== "string" ||
    typeof event.away_team !== "string"
  ) return undefined;
  const start = new Date(event.commence_time);
  const sport = sportFromKey(event.sport_key);
  if (!sport || !Number.isFinite(start.getTime())) return undefined;
  const selections = normalizeOddsMarkets(sport, event.bookmakers, event.home_team, event.away_team, updatedAt);
  if (!selections.length) return undefined;
  return {
    id: `odds-api:${event.id}`,
    sport,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    league: typeof event.sport_title === "string" ? event.sport_title : leagueFromKey(event.sport_key),
    startsAt: start.toISOString(),
    status: "scheduled",
    selections,
    source: "the-odds-api",
    oddsUpdatedAt: updatedAt,
  };
}

export function normalizeScoreEvent(value: unknown, now = new Date()): Fixture | undefined {
  if (!isRecord(value)) return undefined;
  const event = value as ScoreEvent;
  if (
    typeof event.id !== "string" ||
    typeof event.sport_key !== "string" ||
    typeof event.commence_time !== "string" ||
    typeof event.home_team !== "string" ||
    typeof event.away_team !== "string"
  ) return undefined;
  const start = new Date(event.commence_time);
  const sport = sportFromKey(event.sport_key);
  if (!sport || !Number.isFinite(start.getTime())) return undefined;
  const status = event.completed === true
    ? "finished"
    : start.getTime() <= now.getTime()
      ? "live"
      : "scheduled";
  return {
    id: `odds-api:${event.id}`,
    sport,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    league: typeof event.sport_title === "string" ? event.sport_title : leagueFromKey(event.sport_key),
    startsAt: start.toISOString(),
    status,
    selections: [],
    source: "the-odds-api",
    oddsUpdatedAt: now.toISOString(),
  };
}

function normalizeOddsMarkets(
  sport: Sport,
  value: unknown,
  homeTeam: string,
  awayTeam: string,
  updatedAt: string,
): MarketSelection[] {
  if (!Array.isArray(value)) return [];
  const bestByMarket = new Map<string, Map<OutcomeName, Omit<MarketSelection, "marketProbability">>>();
  const benchmarks = new Map<string, { bookmaker: string; probabilities: Map<OutcomeName, number>; overround: number }>();
  for (const rawBookmaker of value) {
    if (!isRecord(rawBookmaker)) continue;
    const bookmaker = rawBookmaker as OddsBookmaker;
    const title = typeof bookmaker.title === "string" ? bookmaker.title : "Bookmaker";
    const markets = Array.isArray(bookmaker.markets) ? bookmaker.markets : [];
    for (const rawMarket of markets) {
      if (!isRecord(rawMarket) || !["h2h", "totals", "spreads"].includes(String(rawMarket.key))) continue;
      const market = rawMarket as OddsMarket;
      if (!Array.isArray(market.outcomes)) continue;
      const byMarket = new Map<string, Map<OutcomeName, number>>();
      for (const rawOutcome of market.outcomes) {
        if (!isRecord(rawOutcome)) continue;
        const outcome = rawOutcome as OddsOutcome;
        const odds = Number(outcome.price);
        if (!Number.isFinite(odds) || odds <= 1 || odds > 1000) continue;
        const descriptor = describeOutcome(String(market.key), sport, outcome, homeTeam, awayTeam);
        if (!descriptor) continue;
        const prices = byMarket.get(descriptor.market) ?? new Map<OutcomeName, number>();
        prices.set(descriptor.selection, odds);
        byMarket.set(descriptor.market, prices);
      }
      for (const [marketName, prices] of byMarket) {
        const requiredCount = marketName === "h2h" && sport === "football" ? 3 : 2;
        if (prices.size !== requiredCount) continue;
        const overround = [...prices.values()].reduce((sum, odds) => sum + 1 / odds, 0);
        const oldBenchmark = benchmarks.get(marketName);
        if (!oldBenchmark || overround < oldBenchmark.overround) {
          benchmarks.set(marketName, {
            bookmaker: title,
            overround,
            probabilities: new Map([...prices].map(([selection, odds]) => [selection, (1 / odds) / overround])),
          });
        }
        const best = bestByMarket.get(marketName) ?? new Map<OutcomeName, Omit<MarketSelection, "marketProbability">>();
        for (const [selection, odds] of prices) {
          if (!best.has(selection) || odds > best.get(selection)!.odds) {
            best.set(selection, {
              id: `${marketName}:${selection}`,
              market: marketName,
              selection,
              odds,
              bookmaker: title,
              marketBookmaker: title,
              updatedAt,
            });
          }
        }
        bestByMarket.set(marketName, best);
      }
    }
  }
  const selections: MarketSelection[] = [];
  for (const [market, best] of bestByMarket) {
    const benchmark = benchmarks.get(market);
    if (!benchmark) continue;
    for (const [selection, quote] of best) {
      const probability = benchmark.probabilities.get(selection);
      if (probability === undefined) continue;
      selections.push({
        ...quote,
        marketBookmaker: benchmark.bookmaker,
        marketProbability: probability,
      });
    }
  }
  return selections;
}

function describeOutcome(
  market: string,
  sport: Sport,
  outcome: OddsOutcome,
  homeTeam: string,
  awayTeam: string,
): { market: string; selection: OutcomeName } | undefined {
  const name = outcome.name;
  const point = outcome.point === undefined ? undefined : Number(outcome.point);
  if (market === "h2h") {
    const selection = selectionFromName(sport, name, homeTeam, awayTeam);
    return selection ? { market, selection } : undefined;
  }
  if (typeof point !== "number" || !Number.isFinite(point)) return undefined;
  if (market === "totals" && typeof name === "string") {
    const side = name.toLowerCase();
    if (side !== "over" && side !== "under") return undefined;
    return { market: `totals:${point}`, selection: side };
  }
  if (market === "spreads" && typeof name === "string") {
    if (name === homeTeam) return { market: `spreads:${Math.abs(point)}`, selection: `home:${formatPoint(point)}` };
    if (name === awayTeam) return { market: `spreads:${Math.abs(point)}`, selection: `away:${formatPoint(point)}` };
  }
  return undefined;
}

function formatPoint(point: number): string {
  return point.toFixed(2).replace(/\.?0+$/, "");
}

function selectionFromName(sport: Sport, name: unknown, homeTeam: string, awayTeam: string): OutcomeName | undefined {
  if (typeof name !== "string") return undefined;
  if (name === homeTeam) return "home";
  if (name === awayTeam) return "away";
  if (sport === "football" && name.toLowerCase() === "draw") return "draw";
  return undefined;
}

function sportFromKey(key: string): Sport | undefined {
  if (key.startsWith("soccer_")) return "football";
  if (key.startsWith("basketball_")) return "basketball";
  return undefined;
}

function leagueFromKey(key: string): string {
  return key.replace(/^(soccer|basketball)_/, "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  callback: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await callback(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
