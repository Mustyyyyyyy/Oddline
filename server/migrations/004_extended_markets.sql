ALTER TABLE market_selections
  DROP CONSTRAINT IF EXISTS market_selections_selection_check;

ALTER TABLE market_selections
  ADD CONSTRAINT market_selections_selection_check
  CHECK (selection <> '');

ALTER TABLE ticket_selections
  DROP CONSTRAINT IF EXISTS ticket_selections_selection_check;

ALTER TABLE ticket_selections
  ADD CONSTRAINT ticket_selections_selection_check
  CHECK (selection <> '');
