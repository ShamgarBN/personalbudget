-- Per-transaction override for the ledger Amount cell's text color.
-- NULL -> the category's color (or the default red/green when uncategorized).
ALTER TABLE txn ADD COLUMN amount_color TEXT NULL;
