-- Recurring transactions gain:
--   * a custom "every N days" cadence (interval_days)
--   * signed amounts (negative = expense, positive = income)
-- and lose the cadence_kind CHECK constraint so new cadence values are allowed.
-- SQLite can't drop a CHECK in place, so recreate the table.
CREATE TABLE recurring_bill_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    amount          NUMERIC NOT NULL,
    account_id      INTEGER NOT NULL REFERENCES account(id),
    category_id     INTEGER NULL REFERENCES category(id),
    cadence_kind    TEXT NOT NULL,
    day_of_month    INTEGER NULL,
    anchor_date     TEXT NULL,
    interval_days   INTEGER NULL,
    active          INTEGER NOT NULL DEFAULT 1,
    last_seen_date  TEXT NULL,
    notes           TEXT NULL,
    start_date      TEXT NULL,
    end_date        TEXT NULL
);

INSERT INTO recurring_bill_new
    (id, name, amount, account_id, category_id, cadence_kind, day_of_month,
     anchor_date, active, last_seen_date, notes, start_date, end_date)
SELECT
    id, name, amount, account_id, category_id, cadence_kind, day_of_month,
    anchor_date, active, last_seen_date, notes, start_date, end_date
FROM recurring_bill;

DROP TABLE recurring_bill;
ALTER TABLE recurring_bill_new RENAME TO recurring_bill;

-- Existing rows predate the income/expense distinction — they were all
-- expenses stored as positive magnitudes. Make them negative so the new
-- signed-amount semantics keep treating them as outflows.
UPDATE recurring_bill SET amount = -ABS(amount);
