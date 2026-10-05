import "dotenv/config";
import { createApp } from "./server/app.js";
import { createCombinedFeed } from "./server/combined-feed.js";
import { createDatabase, migrate } from "./server/db.js";
import { ProviderError } from "./server/errors.js";

const database = createDatabase();
let migrationPromise: Promise<void> | undefined;

if (process.env.NODE_ENV === "production" && process.env.REQUIRE_LIVE_PROVIDER === "1" && !process.env.API_SPORTS_KEY) {
  throw new ProviderError("Configure API_SPORTS_KEY before deploying the production app.");
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

const app = createApp({
  database,
  feed: createCombinedFeed(),
  ready,
});

export default app;
