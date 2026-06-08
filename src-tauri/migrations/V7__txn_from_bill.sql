-- Links a transaction back to the recurring transaction it was materialized
-- from. Lets the Bank Account ledger dedupe a projected "ghost" occurrence
-- once the user locks it in (edits the amount or clicks cleared).
ALTER TABLE txn ADD COLUMN from_bill_id INTEGER NULL REFERENCES recurring_bill(id);
CREATE INDEX idx_txn_from_bill ON txn (from_bill_id) WHERE from_bill_id IS NOT NULL;
