import { invoke } from "@tauri-apps/api/core";
import type {
  Account,
  BackupFile,
  BudgetAllocation,
  BudgetSummary,
  CategoryDrift,
  Category,
  CommitArgs,
  CommitResult,
  DashboardSummary,
  ForecastOverlay,
  ForecastResult,
  Goal,
  ImportBatch,
  ImportPreview,
  LegacyImportPreview,
  LegacyImportResult,
  MonthlyCashFlow,
  MonthlyNetWorth,
  NewTransaction,
  PayPeriod,
  Transaction,
  PayPeriodSchedule,
  RecurringBill,
  SplitChild,
  TxnFilter,
  TxnPage,
  TxnWithChildren,
} from "./types";

export const api = {
  listAccounts: () => invoke<Account[]>("list_accounts"),
  createAccount: (args: {
    name: string;
    kind: string;
    openingBalance: number;
    openingDate: string;
  }) =>
    invoke<number>("create_account", {
      name: args.name,
      kind: args.kind,
      openingBalance: args.openingBalance,
      openingDate: args.openingDate,
    }),
  updateAccount: (args: {
    id: number;
    name?: string;
    openingBalance?: number;
    openingDate?: string;
    archived?: boolean;
  }) => invoke<void>("update_account", args),
  accountBalanceAsOf: (accountId: number, asOfDate: string) =>
    invoke<number>("account_balance_as_of", { accountId, asOfDate }),

  listCategories: () => invoke<Category[]>("list_categories"),
  createCategory: (args: {
    name: string;
    parentId?: number | null;
    color?: string | null;
    isIncome?: boolean;
  }) =>
    invoke<number>("create_category", {
      name: args.name,
      parentId: args.parentId ?? null,
      color: args.color ?? null,
      isIncome: args.isIncome ?? false,
    }),
  updateCategory: (args: {
    id: number;
    name?: string;
    parentId?: number | null;
    color?: string;
    archived?: boolean;
    isBudgeted?: boolean;
    budgetBasis?: "monthly" | "per_pay_period";
  }) => invoke<void>("update_category", args),
  deleteCategory: (id: number) => invoke<void>("delete_category", { id }),

  listTransactions: (filter?: TxnFilter) =>
    invoke<TxnPage>("list_transactions", { filter }),
  createTransaction: (txn: NewTransaction) =>
    invoke<number>("create_transaction", { txn }),
  updateTransaction: (args: {
    id: number;
    date?: string;
    description?: string;
    title?: string | null;
    categoryId?: number | null;
    amount?: number;
    memo?: string | null;
    cleared?: boolean;
    flagged?: boolean;
    needsReview?: boolean;
    sourceOverride?: string | null;
    amountColor?: string | null;
    ccPaymentId?: number | null;
  }) => {
    // The Rust handler can't distinguish a missing field from a null one over
    // JSON, so it uses sentinels: "" clears a nullable string, 0 clears a
    // nullable id. Translate here so callers can pass natural `null` values.
    const wire: Record<string, unknown> = { id: args.id };
    if (args.date !== undefined) wire.date = args.date;
    if (args.description !== undefined) wire.description = args.description;
    if (args.title !== undefined) wire.title = args.title ?? "";
    if (args.categoryId !== undefined) wire.categoryId = args.categoryId ?? 0;
    if (args.amount !== undefined) wire.amount = args.amount;
    if (args.memo !== undefined) wire.memo = args.memo ?? "";
    if (args.cleared !== undefined) wire.cleared = args.cleared;
    if (args.flagged !== undefined) wire.flagged = args.flagged;
    if (args.needsReview !== undefined) wire.needsReview = args.needsReview;
    if (args.sourceOverride !== undefined) wire.sourceOverride = args.sourceOverride ?? "";
    if (args.amountColor !== undefined) wire.amountColor = args.amountColor ?? "";
    if (args.ccPaymentId !== undefined) wire.ccPaymentId = args.ccPaymentId ?? 0;
    return invoke<void>("update_transaction", wire);
  },
  deleteTransaction: (id: number) =>
    invoke<void>("delete_transaction", { id }),
  restoreTransactions: (txns: Transaction[]) =>
    invoke<number[]>("restore_transactions", {
      txns: txns.map((t) => ({
        account_id: t.account_id,
        date: t.date,
        description: t.description,
        title: t.title,
        category_id: t.category_id,
        amount: t.amount,
        memo: t.memo,
        cleared: t.cleared,
        flagged: t.flagged,
        needs_review: t.needs_review,
        from_bill_id: t.from_bill_id,
        from_budget_key: t.from_budget_key,
        import_batch_id: t.import_batch_id,
        source_override: t.source_override,
        amount_color: t.amount_color,
        cc_payment_id: t.cc_payment_id,
      })),
    }),
  markReviewed: (ids: number[]) =>
    invoke<number>("mark_reviewed", { ids }),
  simplifyDescriptions: () =>
    invoke<number>("simplify_descriptions"),
  splitTransaction: (parentId: number, children: SplitChild[]) =>
    invoke<void>("split_transaction", { parentId, children }),
  unsplitTransaction: (parentId: number) =>
    invoke<void>("unsplit_transaction", { parentId }),
  getTransaction: (id: number) =>
    invoke<TxnWithChildren>("get_transaction", { id }),
  materializeOccurrence: (args: {
    billId: number;
    date: string;
    amount: number;
    cleared: boolean;
  }) => invoke<number>("materialize_occurrence", args),
  materializeBudgetItem: (args: {
    accountId: number;
    categoryId: number | null;
    date: string;
    amount: number;
    description: string;
    cleared: boolean;
    budgetKey: string;
  }) => invoke<number>("materialize_budget_item", args),

  listPayPeriodSchedules: () =>
    invoke<PayPeriodSchedule[]>("list_pay_period_schedules"),
  upsertPayPeriodSchedule: (schedule: PayPeriodSchedule) =>
    invoke<number>("upsert_pay_period_schedule", { schedule }),
  deletePayPeriodSchedule: (id: number) =>
    invoke<void>("delete_pay_period_schedule", { id }),
  generatePayPeriods: (from: string, to: string) =>
    invoke<PayPeriod[]>("generate_pay_periods", { from, to }),

  previewImport: (args: {
    fileName: string;
    content: string;
    accountId: number | null;
  }) =>
    invoke<ImportPreview>("preview_import", {
      args: {
        file_name: args.fileName,
        content: args.content,
        account_id: args.accountId,
      },
    }),
  commitImport: (args: CommitArgs) =>
    invoke<CommitResult>("commit_import", { args }),
  listImportBatches: () => invoke<ImportBatch[]>("list_import_batches"),
  undoImportBatch: (batchId: number) =>
    invoke<number>("undo_import_batch", { batchId }),

  previewLegacyImport: (args: { fileName: string; content: string }) =>
    invoke<LegacyImportPreview>("preview_legacy_import", {
      args: { file_name: args.fileName, content: args.content },
    }),
  commitLegacyImport: (args: { fileName: string; content: string }) =>
    invoke<LegacyImportResult>("commit_legacy_import", {
      args: { file_name: args.fileName, content: args.content },
    }),

  dashboardSummary: (from: string, to: string) =>
    invoke<DashboardSummary>("dashboard_summary", { from, to }),
  cashFlowMonthly: (months: number) =>
    invoke<MonthlyCashFlow[]>("cash_flow_monthly", { months }),
  netWorthMonthly: (months: number) =>
    invoke<MonthlyNetWorth[]>("net_worth_monthly", { months }),
  categoryDrift: (periodStart: string, periodEnd: string, trailingPeriods: number) =>
    invoke<CategoryDrift[]>("category_drift", {
      periodStart,
      periodEnd,
      trailingPeriods,
    }),

  createBackup: () => invoke<string>("create_backup"),
  listBackups: () => invoke<BackupFile[]>("list_backups"),
  restoreBackup: (sourcePath: string) =>
    invoke<void>("restore_backup", { sourcePath }),

  exportJson: (path: string) =>
    invoke<{ path: string; tables: string[] }>("export_json", { path }),

  listBudgetAllocations: () =>
    invoke<BudgetAllocation[]>("list_budget_allocations"),
  upsertBudgetAllocation: (allocation: BudgetAllocation) =>
    invoke<number>("upsert_budget_allocation", { allocation }),
  deleteBudgetAllocation: (id: number) =>
    invoke<void>("delete_budget_allocation", { id }),
  budgetSummary: (start: string, end: string, monthStart: string, monthEnd: string) =>
    invoke<BudgetSummary>("budget_summary", { start, end, monthStart, monthEnd }),

  listRecurringBills: () => invoke<RecurringBill[]>("list_recurring_bills"),
  upsertRecurringBill: (bill: RecurringBill) =>
    invoke<number>("upsert_recurring_bill", { bill }),
  deleteRecurringBill: (id: number) =>
    invoke<void>("delete_recurring_bill", { id }),

  listGoals: () => invoke<Goal[]>("list_goals"),
  upsertGoal: (goal: Goal) => invoke<number>("upsert_goal", { goal }),
  deleteGoal: (id: number) => invoke<void>("delete_goal", { id }),

  runForecast: (args: { horizon_days: number; overlays?: ForecastOverlay[] }) =>
    invoke<ForecastResult>("run_forecast", { args }),
} as const;

export type Api = typeof api;
