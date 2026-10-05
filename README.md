# Oddline Sports Data Workspace

TypeScript + React/Vite frontend, Node/Express API, and PostgreSQL persistence. Oddline reads football and NBA schedules/statuses from API-Sports and pre-match moneyline, totals, and spread prices from The Odds API. Fixtures are only shown as selectable when a schedule entry matches a real priced event; no sample fixtures or odds are generated.

## Important product status

- **Live feed:** API-Sports football/NBA fixtures and status, joined to The Odds API pre-match head-to-head, totals, and spreads markets by teams and kickoff time. Both provider keys are required for priced selections. The interface only shows “Feed online” after a successful response; without a key it shows a clear connection error instead of sample data.
- **Slip generation:** user chooses a sport, Daily or Weekend, and target odds; the server builds a reviewable slip from current provider markets. Daily covers today only and caps combined odds at 50. Weekend covers Friday through Sunday and caps combined odds at 200; when generated on Sunday, it targets the immediately upcoming Friday–Sunday instead of the remaining hours of the current weekend. One selection is chosen per fixture while the generator balances across available leagues and match-result/moneyline, totals, and spreads options, approaching the target without exceeding the period cap. Users review and explicitly save; the server checks that every chosen price is still active and inside the chosen sport and date window before persisting.
- **Independent predictions:** not enabled. Automatic selections follow a documented market-odds rule; they are not an independent Oddline forecast, recommendation, or guarantee.
- **Results:** API-Sports fixture/game statuses update saved history to scheduled/live/finished. Final scores and ticket settlement are not displayed or calculated.
- **No accounts:** as requested, the app has no sign-in. Tickets and history are shared by anyone who can access the deployment; restrict access at the hosting/network layer if that is not intended.

Do not describe the current product as a forecasting service or use it to imply a predicted winner. To enable predictions/settlement, implement and validate a separate model from licensed historical results/team statistics, and connect the relevant data products.

## Credentials and local run

Set `API_SPORTS_KEY` and `ODDS_API_KEY` on the server; do not expose either in browser code or commit them. API-Sports supplies Football fixtures by date across its available leagues and NBA games/statuses for the current season; The Odds API supplies bookmaker prices. Current-season NBA access depends on the API-Sports subscription. If NBA is denied, Football can still load and the interface displays the provider restriction; if Football and NBA both fail, the feed reports an error. `ODDS_API_SPORT_KEYS` defaults to EPL, MLS, UEFA Champions League, and NBA. Each configured sport key requests head-to-head, totals, and spreads: usage cost varies by region and market availability. Add or remove league keys to match your plan and desired coverage. Prices are joined to the API-Sports schedule by sport, team names, and kickoff time, and unmatched games are omitted. The Odds API does not currently supply soccer shots/fouls/corners or first-19-minute draw markets in its standard odds response, so Oddline will not fabricate those prices.

1. Copy `.env.example` to `.env`, set a strong PostgreSQL password, and add private `API_SPORTS_KEY` and `ODDS_API_KEY` values. Keep `.env` private and uncommitted.
2. This workspace's project-local PostgreSQL is already configured in `.env` on port 5433; Docker is not required for local development. For a fresh checkout, set `DATABASE_URL` to an installed PostgreSQL database, or optionally start the Compose database with `docker compose up -d postgres`.

3. Install dependencies and start API and UI in separate terminals:

```sh
npm install
npm run dev:server
npm run dev
```

Vite serves the frontend on <http://localhost:5173> and proxies `/api` to the API on port 8000. The Node service applies SQL migrations at startup. API-Sports football schedules are requested once per UTC date from three days in the past through `ODDS_API_DAYS_AHEAD` days ahead (1–13); current-season NBA schedule access depends on the API-Sports subscription. Configure `ODDS_API_SPORT_KEYS`, `ODDS_API_REGIONS`, and the in-memory feed cache duration with `SPORTS_FEED_CACHE_SECONDS` (defaults to five minutes). Saved fixture statuses are refreshed from API-Sports schedules, independently of bookmaker prices, so an odds-provider outage does not prevent status updates when API-Sports is available. Weekend picks use the upcoming Friday–Sunday window when generated on Sunday.

Validate changes with `npm test` and `npm run build`.

If `/api/fixtures` reports an API-Sports error, verify `API_SPORTS_KEY` has access to the Football and NBA APIs and has remaining quota. If The Odds API reports HTTP 401 or 403, verify `ODDS_API_KEY` and your plan in [The Odds API dashboard](https://the-odds-api.com/account/). If either service reports HTTP 429, review that service's remaining credits and refresh frequency.

The backend requests football/NBA fixtures and statuses from API-Sports and current prices from The Odds API, joining only matching scheduled events. It normalizes supported 1X2/moneyline, totals (over/under), and spreads markets into one odds board. The fixture board can be searched by team or competition and filtered by sport. Slip generation is a separate preview endpoint and does not save anything until the user confirms; it uses at most one outcome per fixture, balances selections across available market families, and reports when the available schedule cannot reach the target. Best prices are presented alongside no-vig market probabilities from the lowest-overround complete book.

## Docker deployment

1. Configure `.env` with a unique long database password and a private Odds API key. Do not commit it.
2. Run `docker compose up --build -d`.
3. Visit <http://localhost:8000>. Put a TLS-enabled reverse proxy or hosting ingress in front of the app before public launch.

The container runs Node as a non-root user; Docker Compose provides persistent PostgreSQL storage. Health is at `/api/health`; fixture/price retrieval is `/api/fixtures`; saved slips are at `/api/history`. For managed hosting, deploy the Node container, attach managed PostgreSQL, and configure `DATABASE_URL`, `API_SPORTS_KEY`, `ODDS_API_KEY`, `ODDS_API_SPORT_KEYS`, and `REQUIRE_LIVE_PROVIDER=1` through the host's secret/environment settings. Set `DATABASE_SSL=true` if the managed PostgreSQL service requires TLS.

## Vercel deployment

Vercel serves the Vite frontend from its static CDN and routes `/api/*` through the catch-all `api/[...route].ts` function into the Express app in `vercel-app.ts`. The Vercel build command publishes the Vite build into `public/` for CDN delivery; the function config explicitly bundles the SQL migrations needed during cold-start initialization. Database migrations are tracked and protected by a database lock, so concurrent serverless cold starts do not reapply schema changes. The serverless PostgreSQL pool defaults to three connections per warm instance.

1. Push this project to a Git provider and import that repository in Vercel. Use the Other framework preset, Node.js 20 or newer, and `npm run build:vercel` as the build command. Leave the output directory unset so `/api/*` requests reach the serverless function.
2. Provision hosted PostgreSQL separately. Use its pooled connection URL for `DATABASE_URL`; the deployment filesystem is not persistent and must not be used for the database. Enable `DATABASE_SSL=true` only when required by the database provider.
3. Add these Vercel environment variables for Production (and Preview if you want preview deployments to use live data):
   - `DATABASE_URL` — pooled PostgreSQL connection string.
   - `API_SPORTS_KEY` — private API-Sports key for Football and NBA fixtures/statuses.
   - `ODDS_API_KEY` — private The Odds API key for bookmaker prices; never add this to a `VITE_*` variable.
   - `ODDS_API_SPORT_KEYS` — defaults to EPL, MLS, UEFA Champions League, and NBA.
   - `ODDS_API_REGIONS` — defaults to `us`.
   - `ODDS_API_DAYS_AHEAD` — defaults to `13`.
   - `DATABASE_POOL_SIZE` — defaults to `3`; keep small for serverless instances.
   - `REQUIRE_LIVE_PROVIDER` — set to `1` so production startup requires the Odds API key.
   - `DATABASE_SSL` — set to `true` if required by your hosted database.
4. Deploy and verify `/api/health`, `/api/fixtures`, and a preview/save flow. Health reports database, API-Sports, and Odds API configuration; `/api/fixtures` verifies the upstream credentials, schedule matching, and market coverage.

Ticket history is shared across visitors because the product deliberately has no login. Anyone with access to the public site can view and create tickets; add access control before deploying if that is not desired. The Vercel deployment configuration is prepared in this project, but deployment still requires connecting a Git repository, configuring production environment variables, and provisioning hosted PostgreSQL in your Vercel/provider accounts.

## Source

- `server/` – Express API, API-Sports and The Odds API clients, PostgreSQL repository, migrations
- `src/` – TypeScript React frontend
- `web/styles.css` – shared UI styles
- `Dockerfile`, `compose.yaml` – Node/PostgreSQL deployment
