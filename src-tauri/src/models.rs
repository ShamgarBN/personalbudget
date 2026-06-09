use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub opening_balance: f64,
    pub opening_date: String,
    pub display_order: i64,
    pub archived: bool,
    pub current_balance: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub is_protected: bool,
    pub is_income: bool,
    pub color: Option<String>,
    pub archived: bool,
    /// Whether this category participates in the Budgets tab. Categories not
    /// flagged as budgeted are excluded from budget allocation and summaries.
    pub is_budgeted: bool,
    /// "monthly" or "per_pay_period" — the window a budgeted category's
    /// allocation is measured against.
    pub budget_basis: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transaction {
    pub id: i64,
    pub account_id: i64,
    pub date: String,
    pub description: String,
    pub title: Option<String>,
    pub category_id: Option<i64>,
    pub category_name: Option<String>,
    pub amount: f64,
    pub memo: Option<String>,
    pub cleared: bool,
    pub flagged: bool,
    pub needs_review: bool,
    pub split_of_id: Option<i64>,
    /// The recurring transaction this row was materialized from, if any.
    pub from_bill_id: Option<i64>,
    /// The budget projection this row was locked in from ("<catId>:<periodStart>").
    pub from_budget_key: Option<String>,
    /// Account balance immediately after this transaction posted, computed
    /// over the full history for this account regardless of any active filter.
    /// Null for split children (their amounts roll up under the parent).
    pub running_balance: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewTransaction {
    pub account_id: i64,
    pub date: String,
    pub description: String,
    pub title: Option<String>,
    pub category_id: Option<i64>,
    pub amount: f64,
    pub memo: Option<String>,
    pub cleared: Option<bool>,
    pub flagged: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PayPeriodSchedule {
    pub id: i64,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub cadence_kind: String,
    pub anchor_date: Option<String>,
    pub day_of_month_1: Option<i64>,
    pub day_of_month_2: Option<i64>,
    pub day_of_month: Option<i64>,
    pub custom_dates_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PayPeriod {
    pub start: String,
    pub end: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportBatch {
    pub id: i64,
    pub imported_at: String,
    pub account_id: i64,
    pub source_file: String,
    pub row_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportPreviewRow {
    pub date: String,
    pub description: String,
    pub amount: f64,
    pub suggested_category_id: Option<i64>,
    pub suggested_category_name: Option<String>,
    pub is_transfer: bool,
    pub is_duplicate: bool,
    pub import_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportPreview {
    pub account_id: i64,
    pub account_name: String,
    pub source_file: String,
    pub format: String,
    pub beginning_balance: Option<f64>,
    pub beginning_balance_date: Option<String>,
    pub rows: Vec<ImportPreviewRow>,
}
