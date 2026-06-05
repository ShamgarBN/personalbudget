-- Flag transactions that were auto-categorized at import and haven't been
-- manually reviewed yet. Surfaces in the Ledger as a "Needs review" badge.
ALTER TABLE txn ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_txn_needs_review ON txn (needs_review) WHERE needs_review = 1;

-- Recurring bills get a start date (when they began hitting the account)
-- and an optional end date (when they stop, e.g., a paid-off loan).
-- Existing rows: leave start_date NULL meaning "no lower bound" so behavior
-- is unchanged until the user edits the bill.
ALTER TABLE recurring_bill ADD COLUMN start_date TEXT NULL;
ALTER TABLE recurring_bill ADD COLUMN end_date TEXT NULL;
