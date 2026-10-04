import { multiplyDecimalOdds } from "./repository.js";
import { getGenerationWindow, getNextWeekendWindow, isSundayInTimeZone, type GenerationPeriod } from "./generation-window.js";
import type { Fixture, MarketSelection, Sport } from "./types.js";

const MAX_SELECTIONS = 12;
const MAX_ODDS_BY_PERIOD = { daily: 50, weekend: 200 } as const;

export interface GeneratedPick {
  fixture: Fixture;
  selection: MarketSelection;
}

export interface GeneratedSlip {
  picks: GeneratedPick[];
  combinedOdds: string;
  targetOdds: number;
  targetReached: boolean;
  period: GenerationPeriod;
  window: { startsAt: string; endsAt: string };
}

export function generateSlip(
  fixtures: Fixture[],
  sport: Sport | "all",
  period: GenerationPeriod,
  targetOdds: number,
  timeZone: string,
  now = new Date(),
): GeneratedSlip {
  const window = period === "weekend" && isSundayInTimeZone(now, timeZone)
    ? getNextWeekendWindow(timeZone, now)
    : getGenerationWindow(period, timeZone, now);
  const getCandidates = (startsAt: Date, endsAt: Date): GeneratedPick[] => fixtures
    .filter((fixture) =>
      fixture.status === "scheduled"
      && (sport === "all" || fixture.sport === sport)
      && new Date(fixture.startsAt) >= startsAt
      && new Date(fixture.startsAt) < endsAt
      && new Date(fixture.startsAt) > now,
    )
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt))
    .flatMap((fixture) => {
      const bestByMarket = new Map<string, MarketSelection>();
      for (const selection of fixture.selections) {
        if (!Number.isFinite(selection.marketProbability)
          || selection.marketProbability <= 0
          || !Number.isFinite(selection.odds)
          || selection.odds <= 1
          || selection.odds > 1000) continue;
        const marketType = selection.market.split(":")[0]!;
        const best = bestByMarket.get(marketType);
        if (!best || selection.marketProbability > best.marketProbability) bestByMarket.set(marketType, selection);
      }
      return [...bestByMarket.values()].map((selection) => ({ fixture, selection }));
    });
  const candidates = getCandidates(window.startsAt, window.endsAt);

  let available = [...candidates];
  const picks: GeneratedPick[] = [];
  const marketCounts = new Map<string, number>();
  const leagueCounts = new Map<string, number>();
  let combinedOdds = 1;
  const maximumOdds = MAX_ODDS_BY_PERIOD[period];

  while (available.length && picks.length < MAX_SELECTIONS && combinedOdds < targetOdds) {
    const remainingOdds = targetOdds / combinedOdds;
    const underTarget = available.filter((candidate) => candidate.selection.odds <= remainingOdds);
    const pool = underTarget.length
      ? underTarget
      : available.filter((candidate) =>
        Number(multiplyDecimalOdds([
          ...picks.map(({ selection }) => selection.odds.toFixed(4)),
          candidate.selection.odds.toFixed(4),
        ])) <= maximumOdds,
      );
    if (!pool.length) break;

    pool.sort((left, right) => {
      const leftLeagueCount = leagueCounts.get(left.fixture.league) ?? 0;
      const rightLeagueCount = leagueCounts.get(right.fixture.league) ?? 0;
      const leftMarket = marketFamily(left.selection.market);
      const rightMarket = marketFamily(right.selection.market);
      const leftCount = marketCounts.get(leftMarket) ?? 0;
      const rightCount = marketCounts.get(rightMarket) ?? 0;
      return leftLeagueCount - rightLeagueCount
        || leftCount - rightCount
        || (underTarget.length ? right.selection.odds - left.selection.odds : left.selection.odds - right.selection.odds)
        || left.fixture.startsAt.localeCompare(right.fixture.startsAt);
    });
    const next = pool[0];
    if (!next) break;

    picks.push(next);
    const family = marketFamily(next.selection.market);
    marketCounts.set(family, (marketCounts.get(family) ?? 0) + 1);
    leagueCounts.set(next.fixture.league, (leagueCounts.get(next.fixture.league) ?? 0) + 1);
    available = available.filter((candidate) => candidate.fixture.id !== next.fixture.id);
    combinedOdds = Number(multiplyDecimalOdds(picks.map(({ selection }) => selection.odds.toFixed(4))));
  }

  picks.sort((left, right) => left.fixture.startsAt.localeCompare(right.fixture.startsAt));
  const exactCombinedOdds = picks.length
    ? multiplyDecimalOdds(picks.map(({ selection }) => selection.odds.toFixed(4)))
    : "1";
  return {
    picks,
    combinedOdds: exactCombinedOdds,
    targetOdds,
    targetReached: Number(exactCombinedOdds) >= targetOdds,
    period,
    window: { startsAt: window.startsAt.toISOString(), endsAt: window.endsAt.toISOString() },
  };
}

function marketFamily(market: string): string {
  return market.split(":")[0] ?? market;
}
