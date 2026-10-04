import "dotenv/config";
import { resolve } from "node:path";
import { createApp } from "./app.js";
import { createDatabase, migrate } from "./db.js";
import { ProviderError } from "./errors.js";
import { getOddsApiConfig, TheOddsApiFeed } from "./odds-api.js";

const production = process.env.NODE_ENV === "production";
if (production && process.env.REQUIRE_LIVE_PROVIDER === "1" && !process.env.ODDS_API_KEY) {
  throw new ProviderError("Configure ODDS_API_KEY before starting in production.");
}

const database = createDatabase();
await migrate(database);

const feed = process.env.ODDS_API_KEY
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

const staticDirectory = resolve(process.cwd(), "dist");
const app = createApp({ database, feed, staticDirectory });
const port = Number(process.env.PORT ?? 8000);
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Oddline Node server listening on 0.0.0.0:${port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down.`);
  server.close(async (error) => {
    if (error) {
      console.error("HTTP server shutdown failed.", error);
      process.exitCode = 1;
    }
    await database.end();
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
