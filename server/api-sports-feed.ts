import { z } from "zod";
import { ProviderError } from "./errors.js";
import { normalizeFootballFixture } from "./api-sports.js";
import type { OddsFeed } from "./app.js";
import type { Fixture, MarketSelection } from "./types.js";

const apiRoot = "https://v3.football.api-sports.io";
const apiResponseSchema = z.object({
  response: z.array(z.unknown()),
  errors: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
  paging: z.object({ current: z.number().optional(), total: z.number().optional() }).optional(),
});
const maxOddsPagesPerDate = 3;

interface ApiFootballFixture {
  fixture?: { id?: unknown; date?: unknown; status?: { short?: unknown; long?: unknown } };
  teams?: { home?: { name?: unknown }; away?: { name?: unknown } };
  league?: { name?: unknown };
}

interface ApiFootballOdds {
  fixture?: { id?: unknown };
  bookmakers?: unknown;
}

interface OddsQuote {
  market: string;
  selection: string;
  odds: number;
  bookmaker: string;
}

export function createApiSportsConfig(env: NodeJS.ProcessEnv = process.env): {
  apiKey: string;
  daysAhead: number;
} {
  const apiKey = env.API_SPORTS_KEY?.trim();
  if (!apiKey) throw new ProviderError("API_SPORTS_KEY is not configured.");
  const daysAhead = Number(env.API_SPORTS_DAYS_AHEAD ?? 7);
  if (!Number.isInteger(daysAhead) || daysAhead < 1 || daysAhead > 13) {
    throw new ProviderError("API_SPORTS_DAYS_AHEAD must be between 1 and 13.");
  }
  return { apiKey, daysAhead };
}

export class ApiSportsFootballFeed implements OddsFeed {
  readonly source = "api-sports" as const;
  private fixturesCache?: { expiresAt: number; fixtures: Fixture[] };
  private fixturesRefresh?: Promise<Fixture[]>;
  private readonly dateCache = new Map<string, { expiresAt: number; fixtures: Fixture[] }>();
  private readonly dateRefreshes = new Map<string, Promise<Fixture[]>>();
  private readonly oddsTruncatedDates = new Set<string>();
  private warnings = [
    "NBA is unavailable: the configured API-Sports plan cannot access the current season, and NBA bookmaker odds are not available from the current API-Sports NBA endpoint.",
  ];

  constructor(
    private readonly config: ReturnType<typeof createApiSportsConfig>,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly cacheSeconds = providerCacheSeconds(),
  ) {}

  async getFixtures(forceRefresh = false): Promise<Fixture[]> {
    if (!forceRefresh && this.fixturesCache && this.fixturesCache.expiresAt > Date.now()) return this.fixturesCache.fixtures;
    if (!this.fixturesRefresh) {
      this.fixturesRefresh = this.fetchFixtureRange(forceRefresh)
        .then((fixtures) => {
          this.fixturesCache = { fixtures, expiresAt: Date.now() + this.cacheSeconds * 1000 };
          return fixtures;
        })
        .finally(() => {
          this.fixturesRefresh = undefined;
        });
    }
    return this.fixturesRefresh;
  }

  async getStatuses(trackedFixtures: Fixture[] = []): Promise<Fixture[]> {
    const statusRefreshCutoff = this.now().getTime() - 3 * 24 * 60 * 60 * 1000;
    const dates = [...new Set(trackedFixtures
      .filter((fixture) => fixture.sport === "football" && fixture.source === this.source)
      .filter((fixture) =>
        !["finished", "postponed", "cancelled", "abandoned"].includes(fixture.status)
        && Date.parse(fixture.startsAt) >= statusRefreshCutoff,
      )
      .map((fixture) => dateOnly(new Date(fixture.startsAt))))];
    const schedules = await mapConcurrent(dates, 2, (date) => this.getDateFixtures(date, true));
    const byId = new Map(schedules.flat().map((fixture) => [fixture.id, fixture]));
    return trackedFixtures.flatMap((tracked) => {
      if (tracked.source !== this.source || tracked.sport !== "football") return [];
      const schedule = byId.get(tracked.id);
      return schedule
        ? [{ ...tracked, status: schedule.status, startsAt: schedule.startsAt, league: schedule.league, selections: [] }]
        : [];
    });
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  private async fetchFixtureRange(forceRefresh = false): Promise<Fixture[]> {
    const dates = dateRange(this.now(), this.config.daysAhead);
    this.oddsTruncatedDates.clear();
    const results = await mapConcurrent(dates, 2, async (date) => {
      try {
        const [schedules, odds] = await Promise.all([
          this.getDateFixtures(date, forceRefresh),
          this.getDateOdds(date),
        ]);
        const schedulesById = new Map(schedules.map((fixture) => [fixture.id, fixture]));
        return odds.flatMap((rawOdds) => {
          const odds = asRecord(rawOdds) as ApiFootballOdds | undefined;
          const fixtureId = typeof odds?.fixture?.id === "number" || typeof odds?.fixture?.id === "string"
            ? String(odds.fixture.id)
            : undefined;
          const schedule = fixtureId ? schedulesById.get(`api-sports:football:${fixtureId}`) : undefined;
          if (!schedule) return [];
          const selections = normalizeApiSportsMarkets(odds?.bookmakers, schedule.homeTeam, schedule.awayTeam, this.now().toISOString());
          return selections.length ? [{ ...schedule, selections, source: this.source, oddsUpdatedAt: this.now().toISOString() }] : [];
        });
      } catch (error) {
        return { date, error };
      }
    });

    const fixtures: Fixture[] = [];
    const failures: Array<{ date: string; error: unknown }> = [];
    for (const result of results) {
      if (Array.isArray(result)) fixtures.push(...result);
      else failures.push(result);
    }
    this.warnings = [
      "NBA is unavailable: the configured API-Sports plan cannot access the current season, and NBA bookmaker odds are not available from the current API-Sports NBA endpoint.",
    ];
    if (failures.length) {
      const first = failures[0]!;
      this.warnings.push(
        `Football fixtures or odds could not be loaded for ${failures.length} of ${dates.length} dates (including ${first.date}): ${providerErrorMessage(first.error)}`,
      );
    }
    if (this.oddsTruncatedDates.size) {
      this.warnings.push(
        `API-Sports returned more than ${maxOddsPagesPerDate} odds pages for ${this.oddsTruncatedDates.size} date(s); loaded the first ${maxOddsPagesPerDate} pages to stay within the Free plan limit.`,
      );
    }
    if (!fixtures.length && failures.length === dates.length) {
      throw new ProviderError(`API-Sports Football feed is unavailable. ${this.warnings[1]}`);
    }
    return [...new Map(fixtures.map((fixture) => [fixture.id, fixture])).values()]
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  }

  private async getDateFixtures(date: string, forceRefresh = false): Promise<Fixture[]> {
    const cached = this.dateCache.get(date);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.fixtures;
    const pending = this.dateRefreshes.get(date);
    if (pending) return pending;
    const refresh = this.requestJson(`/fixtures?${new URLSearchParams({ date })}`)
      .then(({ response }) => response
        .map(normalizeFootballFixtureWithId)
        .filter((fixture): fixture is Fixture => fixture !== undefined))
      .then((fixtures) => {
        this.dateCache.set(date, { fixtures, expiresAt: Date.now() + this.cacheSeconds * 1000 });
        return fixtures;
      })
      .finally(() => this.dateRefreshes.delete(date));
    this.dateRefreshes.set(date, refresh);
    return refresh;
  }

  private async getDateOdds(date: string): Promise<unknown[]> {
    const firstPage = await this.requestJson(`/odds?${new URLSearchParams({ date, page: "1" })}`);
    const totalPages = firstPage.paging?.total ?? 1;
    if (totalPages > maxOddsPagesPerDate) this.oddsTruncatedDates.add(date);
    const pagesToLoad = Math.min(totalPages, maxOddsPagesPerDate);
    const pages = await mapConcurrent(
      Array.from({ length: pagesToLoad - 1 }, (_, index) => index + 2),
      2,
      (page) => this.requestJson(`/odds?${new URLSearchParams({ date, page: String(page) })}`),
    );
    return [...firstPage.response, ...pages.flatMap(({ response }) => response)];
  }

  private async requestJson(path: string): Promise<z.infer<typeof apiResponseSchema>> {
    let response: Response;
    try {
      response = await this.request(`${apiRoot}${path}`, {
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
    const parsed = apiResponseSchema.safeParse(payload);
    if (!parsed.success) throw new ProviderError("API-Sports returned an invalid Football response.");
    const errors = parsed.data.errors;
    if (errors && (Array.isArray(errors) ? errors.length > 0 : Object.keys(errors).length > 0)) {
      const apiErrorText = JSON.stringify(errors).toLowerCase();
      if (apiErrorText.includes("limit reached") || apiErrorText.includes("request limit")) {
        throw new ProviderError("API-Sports request quota was reached.");
      }
      const details = (Array.isArray(errors)
        ? errors.map((error) => String(error))
        : Object.entries(errors).map(([name, detail]) => `${name}: ${String(detail)}`))
        .join("; ")
        .replaceAll(this.config.apiKey, "[redacted]")
        .slice(0, 300);
      throw new ProviderError(`API-Sports returned an API error: ${details}`);
    }
    return parsed.data;
  }
}

function normalizeFootballFixtureWithId(value: unknown): Fixture | undefined {
  const record = asRecord(value) as ApiFootballFixture | undefined;
  const id = record?.fixture?.id;
  if (typeof id !== "number" && typeof id !== "string") return undefined;
  const normalized = normalizeFootballFixture(value);
  if (!normalized) return undefined;
  return {
    ...normalized,
    id: `api-sports:football:${id}`,
    selections: [],
    source: "api-sports",
    oddsUpdatedAt: new Date().toISOString(),
  };
}

export function normalizeApiSportsMarkets(
  bookmakersValue: unknown,
  homeTeam: string,
  awayTeam: string,
  updatedAt = new Date().toISOString(),
): MarketSelection[] {
  if (!Array.isArray(bookmakersValue)) return [];
  const oddsByMarket = new Map<string, Map<string, { odds: number; bookmaker: string }>>();
  const benchmarks = new Map<string, { bookmaker: string; overround: number; probabilities: Map<string, number> }>();

  for (const rawBookmaker of bookmakersValue) {
    const bookmaker = asRecord(rawBookmaker);
    const bookmakerName = stringValue(bookmaker?.name) ?? "Bookmaker";
    if (!Array.isArray(bookmaker?.bets)) continue;
    for (const rawBet of bookmaker.bets) {
      const bet = asRecord(rawBet);
      const marketName = stringValue(bet?.name);
      if (!marketName || !Array.isArray(bet?.values)) continue;
      const marketOutcomes = new Map<string, number>();
      for (const rawValue of bet.values) {
        const value = asRecord(rawValue);
        const quote = parseApiSportsOutcome(marketName, stringValue(value?.value), value?.odd, homeTeam, awayTeam);
        if (quote) marketOutcomes.set(`${quote.market}|${quote.selection}`, quote.odds);
      }
      const grouped = groupMarketOutcomes(marketOutcomes);
      for (const [market, outcomes] of grouped) {
        const required = market === "h2h" || market.endsWith("result") ? 3 : 2;
        if (outcomes.size !== required) continue;
        const overround = [...outcomes.values()].reduce((sum, odds) => sum + 1 / odds, 0);
        const current = benchmarks.get(market);
        if (!current || overround < current.overround) {
          benchmarks.set(market, {
            bookmaker: bookmakerName,
            overround,
            probabilities: new Map([...outcomes].map(([selection, odds]) => [selection, (1 / odds) / overround])),
          });
        }
        const best = oddsByMarket.get(market) ?? new Map<string, { odds: number; bookmaker: string }>();
        for (const [selection, odds] of outcomes) {
          if (!best.has(selection) || odds > best.get(selection)!.odds) best.set(selection, { odds, bookmaker: bookmakerName });
        }
        oddsByMarket.set(market, best);
      }
    }
  }

  const selections: MarketSelection[] = [];
  for (const [market, best] of oddsByMarket) {
    const benchmark = benchmarks.get(market);
    if (!benchmark) continue;
    for (const [selection, quote] of best) {
      const probability = benchmark.probabilities.get(selection);
      if (probability === undefined) continue;
      selections.push({
        id: `${market}:${selection}`,
        market,
        selection,
        odds: quote.odds,
        bookmaker: quote.bookmaker,
        marketBookmaker: benchmark.bookmaker,
        marketProbability: probability,
        updatedAt,
      });
    }
  }
  return selections;
}

function parseApiSportsOutcome(
  marketName: string,
  value: string | undefined,
  oddValue: unknown,
  homeTeam: string,
  awayTeam: string,
): OddsQuote | undefined {
  if (!value) return undefined;
  const odds = Number(oddValue);
  if (!Number.isFinite(odds) || odds <= 1 || odds > 1000) return undefined;
  const market = marketName.trim().toLowerCase();
  if (["match winner", "1x2", "fulltime result", "full time result"].includes(market)) {
    const selection = sideFromLabel(value, homeTeam, awayTeam);
    return selection ? { market: "h2h", selection, odds, bookmaker: "" } : undefined;
  }
  if (market.includes("both teams score") || market === "btts") {
    const side = yesNo(value);
    return side ? { market: "btts", selection: side, odds, bookmaker: "" } : undefined;
  }
  const totalGroup = market.includes("corner")
    ? "corners"
    : market.includes("card")
      ? "cards"
      : market.includes("goal")
        ? "totals"
        : undefined;
  const totalMatch = /^(over|under)\s+(-?\d+(?:\.\d+)?)$/i.exec(value.trim());
  if (totalGroup && totalMatch) {
    const line = formatPoint(Number(totalMatch[2]));
    return { market: `${totalGroup}:${line}`, selection: totalMatch[1]!.toLowerCase(), odds, bookmaker: "" };
  }
  if (market.includes("asian handicap") || market === "handicap") {
    const handicap = /^(home|away)\s+([+-]?\d+(?:\.\d+)?)$/i.exec(value.trim());
    if (!handicap) return undefined;
    const side = handicap[1]!.toLowerCase();
    const point = Number(handicap[2]);
    const selection = `${side}:${formatPoint(point)}`;
    return { market: `spreads:${formatPoint(Math.abs(point))}`, selection, odds, bookmaker: "" };
  }
  if (market.includes("first half") && (market.includes("winner") || market.includes("result"))) {
    const selection = sideFromLabel(value, homeTeam, awayTeam);
    return selection ? { market: "first-half-result", selection, odds, bookmaker: "" } : undefined;
  }
  return undefined;
}

function groupMarketOutcomes(outcomes: Map<string, number>): Map<string, Map<string, number>> {
  const grouped = new Map<string, Map<string, number>>();
  for (const [key, odds] of outcomes) {
    const separator = key.indexOf("|");
    const market = key.slice(0, separator);
    const selection = key.slice(separator + 1);
    const selections = grouped.get(market) ?? new Map<string, number>();
    selections.set(selection, odds);
    grouped.set(market, selections);
  }
  return grouped;
}

function sideFromLabel(value: string, homeTeam: string, awayTeam: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "home" || teamKey(normalized) === teamKey(homeTeam)) return "home";
  if (normalized === "away" || teamKey(normalized) === teamKey(awayTeam)) return "away";
  if (normalized === "draw" || normalized === "tie") return "draw";
  return undefined;
}

function yesNo(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "yes") return "yes";
  if (normalized === "no") return "no";
  return undefined;
}

function teamKey(name: string): string {
  return name.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/\b(fc|cf|afc|sc|club)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function formatPoint(point: number): string {
  return point.toFixed(2).replace(/\.?0+$/, "");
}

function dateRange(now: Date, daysAhead: number): string[] {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + daysAhead);
  const dates: string[] = [];
  for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    dates.push(dateOnly(date));
  }
  return dates;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function providerCacheSeconds(): number {
  const value = Number(process.env.SPORTS_FEED_CACHE_SECONDS ?? 21_600);
  return Number.isFinite(value) ? Math.max(300, value) : 21_600;
}

function providerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown API-Sports error.";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function mapConcurrent<T, Result>(
  values: T[],
  concurrency: number,
  map: (value: T) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await map(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
