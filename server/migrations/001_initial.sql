CREATE TABLE IF NOT EXISTS fixtures (
  id TEXT PRIMARY KEY,
  sport TEXT NOT NULL CHECK (sport IN ('football', 'basketball')),
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  league TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  source TEXT NOT NULL DEFAULT 'the-odds-api',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_selections (
  id TEXT PRIMARY KEY,
  fixture_id TEXT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  market TEXT NOT NULL,
  selection TEXT NOT NULL,
  odds NUMERIC(12, 4) NOT NULL CHECK (odds > 1),
  bookmaker TEXT NOT NULL,
  market_bookmaker TEXT NOT NULL,
  market_probability NUMERIC(8, 7) NOT NULL CHECK (market_probability > 0 AND market_probability < 1),
  updated_at TIMESTAMPTZ NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS market_selections_active_idx
  ON market_selections (fixture_id, active);
CREATE INDEX IF NOT EXISTS fixtures_starts_at_idx
  ON fixtures (starts_at);

CREATE TABLE IF NOT EXISTS tickets (
  id BIGSERIAL PRIMARY KEY,
  target_odds NUMERIC(12, 4) NOT NULL CHECK (target_odds >= 1 AND target_odds <= 200),
  combined_odds NUMERIC(84, 48) NOT NULL CHECK (combined_odds > 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'the-odds-api',
  generation_period TEXT NOT NULL DEFAULT 'daily' CHECK (generation_period IN ('daily', 'weekend'))
);

CREATE TABLE IF NOT EXISTS ticket_selections (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  fixture_id TEXT NOT NULL REFERENCES fixtures(id),
  market_selection_id TEXT NOT NULL,
  market TEXT NOT NULL,
  selection TEXT NOT NULL,
  odds NUMERIC(12, 4) NOT NULL CHECK (odds > 1),
  bookmaker TEXT NOT NULL,
  market_bookmaker TEXT NOT NULL,
  market_probability NUMERIC(8, 7) NOT NULL CHECK (market_probability > 0 AND market_probability < 1),
  UNIQUE (ticket_id, fixture_id)
);

CREATE INDEX IF NOT EXISTS ticket_selections_ticket_idx
  ON ticket_selections (ticket_id);
