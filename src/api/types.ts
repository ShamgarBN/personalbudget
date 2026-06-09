export interface Account {
  id: number;
  name: string;
  kind: "checking" | "credit" | "savings";
  opening_balance: number;
  opening_date: string;
  display_order: number;
  archived: boolean;
  current_balance: number;
}

export interface Category {
  id: number;
  name: string;
  parent_id: number | null;
  is_protected: boolean;
  is_income: boolean;
  color: string | null;
  archived: boolean;
  is_budgeted: boolean;
  budget_basis: "monthly" | "per_pay_period";
}

export interface Transaction {
  id: number;
  account_id: number;
  date: string;
  description: string;
  title: string | null;
  category_id: number | null;
  category_name: string | null;
  amount: number;
  memo: string | null;
  cleared: boolean;
  flagged: boolean;
  needs_review: boolean;
  split_of_id: number | null;
  from_bill_id: number | null;
  from_budget_key: string | null;
  running_balance: number | null;
}

export interface NewTransaction {
  account_id: number;
  date: string;
  description: string;
  title?: string | null;
  category_id?: number | null;
  amount: number;
  memo?: string | null;
  cleared?: boolean;
  flagged?: boolean;
}

export interface TxnFilter {
  account_id?: number;
  category_id?: number;
  date_from?: string;
  date_to?: string;
  search?: string;
  cleared?: boolean;
  flagged?: boolean;
  needs_review?: boolean;
  limit?: number;
  offset?: number;
}

export interface TxnPage {
  rows: Transaction[];
  total: number;
}

export interface PayPeriodSchedule {
  id: number;
  effective_from: string;
  effective_to: string | null;
  cadence_kind:
    | "weekly"
    | "biweekly"
    | "semimonthly"
    | "monthly"
    | "custom_dates";
  anchor_date: string | null;
  day_of_month_1: number | null;
  day_of_month_2: number | null;
  day_of_month: number | null;
  custom_dates_json: string | null;
}

export interface PayPeriod {
  start: string;
  end: string;
  label: string;
}

export interface ImportPreviewRow {
  date: string;
  description: string;
  amount: number;
  suggested_category_id: number | null;
  suggested_category_name: string | null;
  is_transfer: boolean;
  is_duplicate: boolean;
  import_hash: string;
}

export interface ImportPreview {
  account_id: number;
  account_name: string;
  source_file: string;
  format: string;
  beginning_balance: number | null;
  beginning_balance_date: string | null;
  rows: ImportPreviewRow[];
}

export interface CommitRow {
  date: string;
  description: string;
  amount: number;
  category_id: number | null;
  import_hash: string;
  skip: boolean;
  auto_categorized: boolean;
}

export interface CommitArgs {
  account_id: number;
  source_file: string;
  rows: CommitRow[];
  beginning_balance: number | null;
  beginning_balance_date: string | null;
}

export interface CommitResult {
  batch_id: number;
  inserted: number;
  skipped: number;
}

export interface ImportBatch {
  id: number;
  imported_at: string;
  account_id: number;
  source_file: string;
  row_count: number;
}

export interface AccountCard {
  id: number;
  name: string;
  kind: string;
  current_balance: number;
}

export interface CategoryBreakdown {
  category_id: number | null;
  category_name: string;
  spent: number;
}

export interface DashboardSummary {
  accounts: AccountCard[];
  net_worth: number;
  month_to_date_spent: number;
  month_to_date_income: number;
  categories: CategoryBreakdown[];
}

export interface MonthlyCashFlow {
  month: string; // YYYY-MM
  income: number;
  expense: number; // positive magnitude
}

export interface MonthlyNetWorth {
  month: string; // YYYY-MM
  total: number;
  checking: number;
  savings: number;
  credit: number; // negative when there's a balance owed
}

export interface CategoryDrift {
  category_id: number;
  category_name: string;
  current: number;
  trailing_avg: number;
  delta_abs: number;
  delta_pct: number | null;
}

export interface BackupFile {
  path: string;
  size: number;
  modified: string;
}

export interface BudgetAllocation {
  id: number;
  category_id: number;
  amount: number;
  effective_from: string;
  effective_to: string | null;
}

export interface BudgetSummaryRow {
  category_id: number;
  category_name: string;
  parent_id: number | null;
  parent_name: string | null;
  budget_basis: "monthly" | "per_pay_period";
  allocated: number;
  spent: number;
  available: number;
}

export interface BudgetSummary {
  start: string;
  end: string;
  rows: BudgetSummaryRow[];
}

export interface RecurringBill {
  id: number;
  name: string;
  amount: number;
  account_id: number;
  category_id: number | null;
  cadence_kind:
    | "weekly"
    | "biweekly"
    | "monthly"
    | "quarterly"
    | "semiannual"
    | "annual"
    | "custom_days";
  day_of_month: number | null;
  anchor_date: string | null;
  interval_days: number | null;
  active: boolean;
  last_seen_date: string | null;
  notes: string | null;
  start_date: string | null;
  end_date: string | null;
}

export interface Goal {
  id: number;
  name: string;
  target_amount: number;
  target_date: string | null;
  account_id: number | null;
  category_id: number | null;
  current_amount: number;
  created_at: string;
}

export interface ForecastOverlay {
  label: string;
  date: string;
  amount: number;
  account_id: number;
}

export interface DailyBalance {
  date: string;
  account_balances: Record<string, number>;
  net_worth: number;
}

export interface PayPeriodProjection {
  start: string;
  end: string;
  label: string;
  projected_income: number;
  projected_bills: number;
  projected_discretionary: number;
  projected_leftover: number;
}

export interface CategoryTrajectory {
  category_id: number | null;
  category_name: string;
  spent_to_date: number;
  projected_period_total: number;
  allocated: number | null;
  over_under: number | null;
}

export interface ForecastResult {
  start_date: string;
  end_date: string;
  daily: DailyBalance[];
  pay_periods: PayPeriodProjection[];
  categories: CategoryTrajectory[];
}

export interface SplitChild {
  category_id: number | null;
  amount: number;
  description: string | null;
}

export interface TxnWithChildren {
  parent: Transaction;
  children: Transaction[];
}

export interface LegacyAccountSummary {
  account: string;
  count: number;
}

export interface LegacyImportPreview {
  total_rows: number;
  by_account: LegacyAccountSummary[];
  categories_to_create: string[];
  subcategories_to_create: string[];
  split_groups: number;
  accounts_missing: string[];
}

export interface LegacyImportResult {
  batch_id: number;
  inserted: number;
  categories_created: number;
  splits_reconstructed: number;
}
