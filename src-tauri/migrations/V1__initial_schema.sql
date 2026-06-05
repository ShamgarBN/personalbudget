CREATE TABLE account (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('checking', 'credit', 'savings')),
    opening_balance NUMERIC NOT NULL DEFAULT 0,
    opening_date    TEXT NOT NULL,
    display_order   INTEGER NOT NULL DEFAULT 0,
    archived        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE category (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    parent_id       INTEGER NULL REFERENCES category(id),
    is_protected    INTEGER NOT NULL DEFAULT 0,
    is_income       INTEGER NOT NULL DEFAULT 0,
    color           TEXT NULL,
    archived        INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_category_name_parent ON category (COALESCE(parent_id, 0), name);

CREATE TABLE import_batch (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    imported_at     TEXT NOT NULL,
    account_id      INTEGER NOT NULL REFERENCES account(id),
    source_file     TEXT NOT NULL,
    row_count       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE txn (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      INTEGER NOT NULL REFERENCES account(id),
    date            TEXT NOT NULL,
    description     TEXT NOT NULL,
    title           TEXT NULL,
    category_id     INTEGER NULL REFERENCES category(id),
    amount          NUMERIC NOT NULL,
    memo            TEXT NULL,
    cleared         INTEGER NOT NULL DEFAULT 0,
    flagged         INTEGER NOT NULL DEFAULT 0,
    split_of_id     INTEGER NULL REFERENCES txn(id),
    import_batch_id INTEGER NULL REFERENCES import_batch(id) ON DELETE SET NULL,
    import_hash     TEXT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX idx_txn_account_date ON txn (account_id, date);
CREATE INDEX idx_txn_category_date ON txn (category_id, date);
CREATE INDEX idx_txn_import_hash ON txn (import_hash);
CREATE INDEX idx_txn_split_of ON txn (split_of_id);

CREATE TABLE pay_period_schedule (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    effective_from    TEXT NOT NULL,
    effective_to      TEXT NULL,
    cadence_kind      TEXT NOT NULL CHECK (cadence_kind IN ('weekly','biweekly','semimonthly','monthly','custom_dates')),
    anchor_date       TEXT NULL,
    day_of_month_1    INTEGER NULL,
    day_of_month_2    INTEGER NULL,
    day_of_month      INTEGER NULL,
    custom_dates_json TEXT NULL
);
CREATE INDEX idx_pps_effective_from ON pay_period_schedule (effective_from);

CREATE TABLE budget_allocation (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id     INTEGER NOT NULL REFERENCES category(id),
    amount          NUMERIC NOT NULL,
    effective_from  TEXT NOT NULL,
    effective_to    TEXT NULL
);

CREATE TABLE recurring_bill (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    amount          NUMERIC NOT NULL,
    account_id      INTEGER NOT NULL REFERENCES account(id),
    category_id     INTEGER NULL REFERENCES category(id),
    cadence_kind    TEXT NOT NULL CHECK (cadence_kind IN ('weekly','biweekly','monthly','quarterly','semiannual','annual')),
    day_of_month    INTEGER NULL,
    anchor_date     TEXT NULL,
    active          INTEGER NOT NULL DEFAULT 1,
    last_seen_date  TEXT NULL,
    notes           TEXT NULL
);

CREATE TABLE goal (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    target_amount   NUMERIC NOT NULL,
    target_date     TEXT NULL,
    account_id      INTEGER NULL REFERENCES account(id),
    category_id     INTEGER NULL REFERENCES category(id),
    current_amount  NUMERIC NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
);

CREATE TABLE merchant_map (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern         TEXT NOT NULL,
    category_id     INTEGER NOT NULL REFERENCES category(id),
    purchased_by    TEXT NULL,
    hits            INTEGER NOT NULL DEFAULT 1,
    last_used_at    TEXT NOT NULL
);
CREATE INDEX idx_merchant_pattern ON merchant_map (pattern);
