import "dotenv/config";
import { createApp, type OddsFeed } from "./server/app.js";
import { createDatabase, migrate } from "./server/db.js";
import { ProviderError } from "./server/errors.js";
import { getOddsApiConfig, TheOddsApiFeed } from "./server/odds-api.js";

const database = createDatabase();
let migrationPromise: Promise<void> | undefined;

if (process.env.NODE_ENV === "production" && process.env.REQUIRE_LIVE_PROVIDER === "1" && !process.env.ODDS_API_KEY) {
  throw new ProviderError("Configure ODDS_API_KEY before deploying the production app.");
}

const ready = (): Promise<void> => {
  if (!migrationPromise) {
    migrationPromise = migrate(database).catch((error: unknown) => {
      migrationPromise = undefined;
      throw error;
    });
  }
  return migrationPromise;
};

const feed: OddsFeed = process.env.ODDS_API_KEY
  ? new TheOddsApiFeed(getOddsApiConfig())
  : {
      source: "the-odds-api",
      getFixtures: async () => {
        throw new ProviderError("ODDS_API_KEY is not configured.");
      },
      getStatuses: async () => {
        throw new ProviderError("ODDS_API_KEY is not configured.");
      },
    };

const app = createApp({
  database,
  feed,
  ready,
});

export default app;
