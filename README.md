# Oddline Sports Data Workspace

TypeScript + React/Vite frontend, Node/Express REST API, and PostgreSQL persistence. The site’s `/api/*` endpoints are the client-facing Oddline REST API. The backend uses API-Sports for Football schedules and the bookmaker odds it makes available. NBA is explicitly unavailable until the account can access current-season games and a genuine NBA odds source is configured. No sample fixtures or odds are generated.

## Important product status

- **Live feed:** API-Sports Football schedules and odds are joined by API-Sports fixture ID, with odds pagination followed so matches on later pages are not silently dropped. Supported complete bookmaker markets include match result, goals, corners, cards, both-teams-to-score, and handicap when returned by the account. The interface shows provider warnings and never substitutes demo odds.
- **Slip generation:** user chooses a sport, Daily or Weekend, and target odds; the server builds a reviewable slip from current provider markets. Daily covers today only and caps combined odds at 50. Weekend covers Friday through Sunday and caps combined odds at 200; when generated on Sunday, it targets the immediately upcoming Friday–Sunday instead of the remaining hours of the current weekend. One selection is chosen per fixture while the generator balances across available leagues and match-result/moneyline, totals, and spreads options, approaching the target without exceeding the period cap. Users review and explicitly save; the server checks that every chosen price is still active and inside the chosen sport and date window before persisting.
- **Independent predictions:** not enabled. Automatic selections follow a documented market-odds rule; they are not an independent Oddline forecast, recommendation, or guarantee.
- **Results:** API-Sports fixture statuses update saved Football history to scheduled/live/finished. NBA is disabled and no NBA markets are generated. Final scores and ticket settlement are not displayed or calculated.
- **Provider outages:** recent provider snapshots are shared through PostgreSQL for the configured six-hour cache window, avoiding repeated API calls on Vercel cold starts. If API-Sports is unavailable, fixtures and a generation preview can use actual saved prices from the previous 24 hours, clearly marked as stale; saving is disabled until live prices return. Older prices are never offered as a fallback.
- **No accounts:** as requested, the app has no sign-in. Tickets and history are shared by anyone who can access the deployment; restrict access at the hosting/network layer if that is not intended.

Do not describe the current product as a forecasting service or use it to imply a predicted winner. To enable predictions/settlement, implement and validate a separate model from licensed historical results/team statistics, and connect the relevant data products.

## Credentials and local run

Set `API_SPORTS_KEY` on the server; do not expose it in browser code or commit it. API-Sports provides Football schedules by date and bookmaker odds where available on the account’s plan. Its odds endpoint is paginated; Oddline loads each page up to a safety limit and joins prices to actual fixtures by provider ID. NBA is disabled because the configured plan cannot access the current season and the API-Sports NBA endpoint used here does not provide bookmaker odds. Keep NBA disabled until both requirements are met. Markets absent from the provider response are not fabricated.

1. Copy `.env.example` to `.env`, set a strong PostgreSQL password, and add the private `API_SPORTS_KEY`. Keep `.env` private and uncommitted. `ODDS_API_KEY` is no longer used by this Football feed.
2. This workspace's project-local PostgreSQL is already configured in `.env` on port 5433; Docker is not required for local development. For a fresh checkout, set `DATABASE_URL` to an installed PostgreSQL database, or optionally start the Compose database with `docker compose up -d postgres`.

3. Install dependencies and start API and UI in separate terminals:

```sh
npm install
npm run dev:server
npm run dev
```

Vite serves the frontend on <http://localhost:5173> and proxies `/api` to the API on port 8000. The Node service applies SQL migrations at startup. API-Sports requests cover today through `API_SPORTS_DAYS_AHEAD` days ahead (1–13; defaults to 7), across the leagues and odds supported by the account. Fixture and odds results are cached for six hours by default to limit provider quota use; change `SPORTS_FEED_CACHE_SECONDS` if the plan permits more frequent refresh. Saved statuses are refreshed from the API-Sports fixtures endpoint independently of prices. Weekend picks use the upcoming Friday–Sunday window when generated on Sunday.

Validate changes with `npm test` and `npm run build`.

If `/api/fixtures` reports an API-Sports error, verify `API_SPORTS_KEY` has access to Football fixtures and odds and has remaining quota. HTTP 429 indicates the API-Sports request limit was reached; wait for quota to reset or review the plan before lowering the cache interval.

The backend’s REST API returns Football fixtures only when API-Sports supplies both the fixture and complete prices for supported markets. It normalizes 1X2, goals/corners/cards over-under, both-teams-to-score, and handicap markets where available. The fixture board can be searched by team or competition; NBA is visibly disabled. Slip generation is a separate preview endpoint and does not save anything until the user confirms; it uses at most one outcome per fixture, balances selections across available market families, and reports when available events cannot reach the target. Best available prices are shown with no-vig market probabilities calculated from a complete bookmaker market.

## Docker deployment

1. Configure `.env` with a unique long database password and a private API-Sports key. Do not commit it.
2. Run `docker compose up --build -d`.
3. Visit <http://localhost:8000>. Put a TLS-enabled reverse proxy or hosting ingress in front of the app before public launch.

The container runs Node as a non-root user; Docker Compose provides persistent PostgreSQL storage. Health is at `/api/health`; fixture/price retrieval is `/api/fixtures`; saved slips are at `/api/history`. For managed hosting, deploy the Node container, attach managed PostgreSQL, and configure `DATABASE_URL`, `API_SPORTS_KEY`, and `REQUIRE_LIVE_PROVIDER=1` through the host's secret/environment settings. Set `DATABASE_SSL=true` if the managed PostgreSQL service requires TLS.

## Vercel deployment

Vercel serves the Vite frontend from its static CDN and routes `/api/*` through the catch-all `api/[...route].ts` function into the Express app in `vercel-app.ts`. The Vercel build command publishes the Vite build into `public/` for CDN delivery; the function config explicitly bundles the SQL migrations needed during cold-start initialization. Database migrations are tracked and protected by a database lock, so concurrent serverless cold starts do not reapply schema changes. The serverless PostgreSQL pool defaults to three connections per warm instance.

1. Push this project to a Git provider and import that repository in Vercel. Use the Other framework preset, Node.js 20 or newer, and `npm run build:vercel` as the build command. Leave the output directory unset so `/api/*` requests reach the serverless function.
2. Provision hosted PostgreSQL separately. Use its pooled connection URL for `DATABASE_URL`; the deployment filesystem is not persistent and must not be used for the database. Enable `DATABASE_SSL=true` only when required by the database provider.
3. Add these Vercel environment variables for Production (and Preview if you want preview deployments to use live data):
   - `DATABASE_URL` — pooled PostgreSQL connection string.
   - `API_SPORTS_KEY` — private API-Sports key for Football fixtures and available bookmaker odds.
   - `API_SPORTS_DAYS_AHEAD` — defaults to `7` (maximum `13`).
   - `SPORTS_FEED_CACHE_SECONDS` — defaults to `21600` seconds to conserve upstream quota.
   - `DATABASE_POOL_SIZE` — defaults to `3`; keep small for serverless instances.
   - `REQUIRE_LIVE_PROVIDER` — set to `1` so production startup requires `API_SPORTS_KEY`.
   - `DATABASE_SSL` — set to `true` if required by your hosted database.
4. Deploy and verify `/api/health`, `/api/fixtures`, and a preview/save flow. Health reports database and API-Sports configuration; `/api/fixtures` verifies upstream access, schedule/odds matching, and market availability.

Ticket history is shared across visitors because the product deliberately has no login. Anyone with access to the public site can view and create tickets; add access control before deploying if that is not desired. The Vercel deployment configuration is prepared in this project, but deployment still requires connecting a Git repository, configuring production environment variables, and provisioning hosted PostgreSQL in your Vercel/provider accounts.

## Source

- `server/` – Express REST API, API-Sports Football client, PostgreSQL repository, migrations
- `src/` – TypeScript React frontend
- `web/styles.css` – shared UI styles
- `Dockerfile`, `compose.yaml` – Node/PostgreSQL deployment
