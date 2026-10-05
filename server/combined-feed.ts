import { ApiSportsFootballFeed, createApiSportsConfig } from "./api-sports-feed.js";
import type { OddsFeed } from "./app.js";
import { ProviderError } from "./errors.js";

export function createCombinedFeed(env: NodeJS.ProcessEnv = process.env): OddsFeed {
  const source = "api-sports";

  if (!env.API_SPORTS_KEY?.trim()) {
    return {
      source,
      getFixtures: async () => {
        throw new ProviderError("API_SPORTS_KEY is not configured.");
      },
      getStatuses: async () => {
        throw new ProviderError("API_SPORTS_KEY is not configured.");
      },
    };
  }

  const feed = new ApiSportsFootballFeed(createApiSportsConfig(env));
  return {
    source,
    getFixtures: (forceRefresh) => feed.getFixtures(forceRefresh),
    getStatuses: (trackedFixtures = []) => feed.getStatuses(trackedFixtures),
    getWarnings: () => feed.getWarnings(),
  };
}
