-- Manual override for the ledger's Source column. When NULL the source is
-- derived: from_bill_id -> recurring, from_budget_key -> budgeted,
-- import_batch_id -> imported, else manual.
ALTER TABLE txn ADD COLUMN source_override TEXT NULL;
