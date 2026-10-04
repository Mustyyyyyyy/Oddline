ALTER TABLE tickets
  DROP CONSTRAINT IF EXISTS tickets_target_odds_check;

ALTER TABLE tickets
  ADD CONSTRAINT tickets_target_odds_check
  CHECK (target_odds >= 1 AND target_odds <= 200);

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS generation_period TEXT NOT NULL DEFAULT 'daily';

ALTER TABLE tickets
  DROP CONSTRAINT IF EXISTS tickets_generation_period_check;

ALTER TABLE tickets
  ADD CONSTRAINT tickets_generation_period_check
  CHECK (generation_period IN ('daily', 'weekend'));
