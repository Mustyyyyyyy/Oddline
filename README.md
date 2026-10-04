# Oddline Sports Data Workspace

TypeScript + React/Vite frontend, Node/Express API, and PostgreSQL persistence. Oddline reads real fixtures and pre-match moneyline, totals, and spread prices from The Odds API. There are no generated sample fixtures or fallback data: missing credentials, unsupported sports, and provider errors are reported instead.

## Important product status

- **Live feed:** The Odds API pre-match head-to-head, totals, and spreads markets. The interface only shows “Feed online” after a successful API response; without a key it shows a clear connection error instead of sample data.
- **Slip generation:** user chooses a sport, Daily or Weekend, and target odds; the server builds a reviewable slip from current provider markets. Daily covers today only and caps combined odds at 50. Weekend covers Friday through Sunday and caps combined odds at 200; when generated on Sunday, it targets the immediately upcoming Friday–Sunday instead of the remaining hours of the current weekend. One selection is chosen per fixture while the generator balances across available leagues and match-result/moneyline, totals, and spreads options, approaching the target without exceeding the period cap. Users review and explicitly save; the server checks that every chosen price is still active and inside the chosen sport and date window before persisting.
- **Independent predictions:** not enabled. Automatic selections follow a documented market-odds rule; they are not an independent Oddline forecast, recommendation, or guarantee.
- **Results:** The Odds API scores endpoint updates saved history to scheduled/live/finished. Final scores and ticket settlement are not displayed or calculated.
- **No accounts:** as requested, the app has no sign-in. Tickets and history are shared by anyone who can access the deployment; restrict access at the hosting/network layer if that is not intended.

Do not describe the current product as a forecasting service or use it to imply a predicted winner. To enable predictions/settlement, implement and validate a separate model from licensed historical results/team statistics, and connect the relevant data products.

## Credentials and local run

Use a The Odds API key and keep it on the server; do not expose it to browser code or commit it. `ODDS_API_SPORT_KEYS` defaults to EPL, MLS, UEFA Champions League, NBA, and EuroLeague. Each configured sport key requests head-to-head, totals, and spreads: usage cost varies by region and market availability (one credit per region per market on standard markets). Scores are requested separately when the history page refreshes. Add or remove league keys to match your plan and desired coverage. The feed only returns markets The Odds API actually offers for that league and subscription; it does not currently supply soccer shots/fouls/corners or first-19-minute draw markets in the standard odds response, so Oddline will not fabricate those prices.

1. In this workspace, `.env` is already created with a generated PostgreSQL password and `ODDS_API_KEY` configured. On a fresh checkout, copy `.env.example` to `.env`, set a strong PostgreSQL password, and add your Odds API key. Keep `.env` private and uncommitted.
2. This workspace's project-local PostgreSQL is already configured in `.env` on port 5433; Docker is not required for local development. For a fresh checkout, set `DATABASE_URL` to an installed PostgreSQL database, or optionally start the Compose database with `docker compose up -d postgres`.

3. Install dependencies and start API and UI in separate terminals:

```sh
npm install
npm run dev:server
npm run dev
```

Vite serves the frontend on <http://localhost:5173> and proxies `/api` to the API on port 8000. The Node service applies SQL migrations at startup. Fixtures are requested through 13 days ahead so local-time weekend windows remain covered; configure `ODDS_API_SPORT_KEYS`, `ODDS_API_REGIONS`, `ODDS_API_DAYS_AHEAD` (1–13), and the in-memory odds cache duration with `SPORTS_FEED_CACHE_SECONDS` (defaults to five minutes). Recent game statuses are refreshed from the scores endpoint and cached for at least five minutes. Weekend picks use the upcoming Friday–Sunday window when generated on Sunday.

Validate changes with `npm test` and `npm run build`.

If `/api/fixtures` reports HTTP 401 or 403, verify `ODDS_API_KEY` and your plan in [The Odds API dashboard](https://the-odds-api.com/account/). If it reports HTTP 429, review the plan's remaining credits and reduce the number of configured sport keys or refresh frequency.

The backend requests The Odds API's [sports odds](https://the-odds-api.com/liveapi/guides/v4/#get-odds) endpoint for each configured sport key and its [scores](https://the-odds-api.com/liveapi/guides/v4/#get-scores) endpoint for recent status updates. It normalizes supported 1X2/moneyline, totals (over/under), and spreads markets into one odds board. The fixture board can be searched by team or competition and filtered by sport. Slip generation is a separate preview endpoint and does not save anything until the user confirms; it uses at most one outcome per fixture, balances selections across available market families, and reports when the available schedule cannot reach the target. Best prices are presented alongside no-vig market probabilities from the lowest-overround complete book.

## Docker deployment

1. Configure `.env` with a unique long database password and a private Odds API key. Do not commit it.
2. Run `docker compose up --build -d`.
3. Visit <http://localhost:8000>. Put a TLS-enabled reverse proxy or hosting ingress in front of the app before public launch.

The container runs Node as a non-root user; Docker Compose provides persistent PostgreSQL storage. Health is at `/api/health`; fixture/price retrieval is `/api/fixtures`; saved slips are at `/api/history`. For managed hosting, deploy the Node container, attach managed PostgreSQL, and configure `DATABASE_URL`, `ODDS_API_KEY`, `ODDS_API_SPORT_KEYS`, and `REQUIRE_LIVE_PROVIDER=1` through the host's secret/environment settings. Set `DATABASE_SSL=true` if the managed PostgreSQL service requires TLS.

## Vercel deployment

The root `app.ts` exports the Express application for Vercel's Node.js runtime. Express serves the Vite production build and handles the API routes on the same origin. `vercel.json` includes the generated `dist` assets and SQL migrations in the function bundle. Database migrations are tracked and protected by a database lock, so concurrent serverless cold starts do not reapply schema changes. The serverless PostgreSQL pool defaults to three connections per warm instance.

1. Push this project to a Git provider and import that repository in Vercel. Use the Express framework preset, Node.js 20 or newer, `npm run build` as the build command, and leave the output directory unset.
2. Provision hosted PostgreSQL separately. Use its pooled connection URL for `DATABASE_URL`; the deployment filesystem is not persistent and must not be used for the database. Enable `DATABASE_SSL=true` only when required by the database provider.
3. Add these Vercel environment variables for Production (and Preview if you want preview deployments to use live data):
   - `DATABASE_URL` — pooled PostgreSQL connection string.
   - `ODDS_API_KEY` — private The Odds API key; never add this to a `VITE_*` variable.
   - `ODDS_API_SPORT_KEYS` — defaults to EPL, MLS, UEFA Champions League, NBA, and EuroLeague.
   - `ODDS_API_REGIONS` — defaults to `us`.
   - `ODDS_API_DAYS_AHEAD` — defaults to `13`.
   - `DATABASE_POOL_SIZE` — defaults to `3`; keep small for serverless instances.
   - `REQUIRE_LIVE_PROVIDER` — set to `1` so production startup requires the Odds API key.
   - `DATABASE_SSL` — set to `true` if required by your hosted database.
4. Deploy and verify `/api/health`, `/api/fixtures`, and a preview/save flow. A successful health response confirms PostgreSQL connectivity and that the provider key is configured; `/api/fixtures` verifies the upstream Odds API credentials and market coverage.

Ticket history is shared across visitors because the product deliberately has no login. Anyone with access to the public site can view and create tickets; add access control before deploying if that is not desired. The Vercel deployment configuration is prepared in this project, but deployment still requires connecting a Git repository, configuring production environment variables, and provisioning hosted PostgreSQL in your Vercel/provider accounts.

## Source

- `server/` – Express API, The Odds API client, PostgreSQL repository, migrations
- `src/` – TypeScript React frontend
- `web/styles.css` – shared UI styles
- `Dockerfile`, `compose.yaml` – Node/PostgreSQL deployment
