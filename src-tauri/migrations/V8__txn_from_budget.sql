-- Links a transaction to the budget projection it was locked in from, keyed
-- "<categoryId>:<periodStart>". Lets the Bank Account ledger dedupe a projected
-- budget "ghost" once the user checks it in, and undo it by deleting the row.
ALTER TABLE txn ADD COLUMN from_budget_key TEXT NULL;
CREATE INDEX idx_txn_from_budget ON txn (from_budget_key) WHERE from_budget_key IS NOT NULL;
