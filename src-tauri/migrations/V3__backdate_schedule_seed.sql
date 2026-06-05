-- The initial seed gave the default pay-period schedule effective_from = today,
-- which makes the Budgets view fail to compute pay periods for any date before
-- install day. Backdate any pre-existing schedules whose effective_from is in
-- the recent past — they were almost certainly seeds, and the math is identical
-- under a backdated start.
UPDATE pay_period_schedule
SET effective_from = '2000-01-01'
WHERE effective_from >= date('now', '-1 year')
  AND effective_to IS NULL;
