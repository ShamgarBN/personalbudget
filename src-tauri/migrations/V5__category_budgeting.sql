-- Categories can now opt into the Budgets tab and declare the window their
-- allocation is measured against. Default: not budgeted, per-pay-period basis.
ALTER TABLE category ADD COLUMN is_budgeted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE category ADD COLUMN budget_basis TEXT NOT NULL DEFAULT 'per_pay_period';

-- Preserve existing budgets: any category that already has an allocation is
-- treated as budgeted so the Budgets tab doesn't suddenly empty out.
UPDATE category SET is_budgeted = 1
WHERE id IN (SELECT DISTINCT category_id FROM budget_allocation);
