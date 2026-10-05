import { ApiSportsSchedule, getApiSportsConfig, getPricedApiSportsFixtures, joinScheduleStatuses } from "./api-sports.js";
import type { OddsFeed } from "./app.js";
import { ProviderError } from "./errors.js";
import { getOddsApiConfig, TheOddsApiFeed } from "./odds-api.js";

export function createCombinedFeed(env: NodeJS.ProcessEnv = process.env): OddsFeed {
  const oddsFeed = env.ODDS_API_KEY?.trim()
    ? new TheOddsApiFeed(getOddsApiConfig(env))
    : undefined;
  const schedule = env.API_SPORTS_KEY?.trim()
    ? new ApiSportsSchedule(getApiSportsConfig(env))
    : undefined;
  const source = "API-Sports + The Odds API";

  if (!oddsFeed || !schedule) {
    const missingCredential = !schedule
      ? "API_SPORTS_KEY is not configured."
      : "ODDS_API_KEY is not configured for live bookmaker prices.";
    return {
      source,
      getFixtures: async () => {
        throw new ProviderError(missingCredential);
      },
      getStatuses: async () => {
        throw new ProviderError(missingCredential);
      },
    };
  }

  return {
    source,
    getFixtures: (forceRefresh) => getPricedApiSportsFixtures(schedule, oddsFeed, forceRefresh),
    getStatuses: async (trackedFixtures = []) => trackedFixtures.length
      ? joinScheduleStatuses(await schedule.getFixtures(), trackedFixtures)
      : [],
    getWarnings: () => schedule.getWarnings(),
  };
}
