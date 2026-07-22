-- Explicit membership of a credit-card charge in a payment's dropdown.
-- App-managed (no FK so the sentinel fits):
--   NULL -> automatic FIFO attribution
--   >0   -> assigned to the payment transaction with that id
--   -1   -> held for the projected payoff (excluded from FIFO)
ALTER TABLE txn ADD COLUMN cc_payment_id INTEGER NULL;
CREATE INDEX idx_txn_cc_payment ON txn (cc_payment_id) WHERE cc_payment_id IS NOT NULL;
