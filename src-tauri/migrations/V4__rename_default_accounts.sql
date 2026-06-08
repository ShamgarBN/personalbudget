-- Rename the default seeded accounts to the app's updated vocabulary.
-- Keyed on the exact legacy names so a user who already customized their
-- account names is left untouched. On a fresh install these run against an
-- empty account table (migrations run before seeding) and are no-ops; the
-- seed then inserts the new names directly.
UPDATE account SET name = 'Bank Account' WHERE name = 'Joint Checking';
UPDATE account SET name = 'Credit Card'  WHERE name = 'Apple Card';
