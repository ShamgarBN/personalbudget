use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppResult;
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetAllocation {
    pub id: i64,
    pub category_id: i64,
    pub amount: f64,
    pub effective_from: String,
    pub effective_to: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BudgetSummaryRow {
    pub category_id: i64,
    pub category_name: String,
    pub parent_id: Option<i64>,
    pub parent_name: Option<String>,
    /// "monthly" or "per_pay_period" — which window `spent` was measured over.
    pub budget_basis: String,
    pub allocated: f64,
    pub spent: f64,
    pub available: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BudgetSummary {
    pub start: String,
    pub end: String,
    pub rows: Vec<BudgetSummaryRow>,
}

#[tauri::command]
pub fn list_budget_allocations(state: State<AppState>) -> AppResult<Vec<BudgetAllocation>> {
    let conn = state.conn.lock();
    let mut stmt = conn.prepare(
        "SELECT id, category_id, amount, effective_from, effective_to \
         FROM budget_allocation ORDER BY category_id, effective_from",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(BudgetAllocation {
                id: r.get(0)?,
                category_id: r.get(1)?,
                amount: r.get(2)?,
                effective_from: r.get(3)?,
                effective_to: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub fn upsert_budget_allocation(
    state: State<AppState>,
    allocation: BudgetAllocation,
) -> AppResult<i64> {
    let conn = state.conn.lock();
    if allocation.id == 0 {
        // Cap any open allocation for the same category at the new effective_from.
        conn.execute(
            "UPDATE budget_allocation SET effective_to = ? \
             WHERE category_id=? AND effective_to IS NULL AND effective_from < ?",
            rusqlite::params![allocation.effective_from, allocation.category_id, allocation.effective_from],
        )?;
        conn.execute(
            "INSERT INTO budget_allocation (category_id, amount, effective_from, effective_to) \
             VALUES (?, ?, ?, ?)",
            rusqlite::params![
                allocation.category_id,
                allocation.amount,
                allocation.effective_from,
                allocation.effective_to
            ],
        )?;
        Ok(conn.last_insert_rowid())
    } else {
        conn.execute(
            "UPDATE budget_allocation SET category_id=?, amount=?, effective_from=?, effective_to=? WHERE id=?",
            rusqlite::params![
                allocation.category_id,
                allocation.amount,
                allocation.effective_from,
                allocation.effective_to,
                allocation.id
            ],
        )?;
        Ok(allocation.id)
    }
}

#[tauri::command]
pub fn delete_budget_allocation(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = state.conn.lock();
    conn.execute("DELETE FROM budget_allocation WHERE id=?", rusqlite::params![id])?;
    Ok(())
}

#[tauri::command]
pub fn budget_summary(
    state: State<AppState>,
    start: String,
    end: String,
    month_start: String,
    month_end: String,
) -> AppResult<BudgetSummary> {
    let conn = state.conn.lock();
    // Only budgeted, non-protected, non-income, non-archived categories appear.
    // Spend is measured per category over the window matching its basis:
    //   per_pay_period -> [start, end)              (the selected pay period)
    //   monthly        -> [month_start, month_end)  (the calendar month it sits in)
    // No rollover: available is simply allocated - spent each period.
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, c.parent_id, p.name AS parent_name, c.budget_basis, \
                COALESCE((SELECT SUM(amount) FROM budget_allocation \
                          WHERE category_id=c.id AND effective_from <= ?1 \
                            AND (effective_to IS NULL OR effective_to > ?1)), 0) AS allocated, \
                COALESCE((SELECT SUM(ABS(amount)) FROM txn \
                          WHERE category_id=c.id AND split_of_id IS NULL \
                            AND date >= ?2 AND date < ?3 AND amount < 0), 0) AS period_spent, \
                COALESCE((SELECT SUM(ABS(amount)) FROM txn \
                          WHERE category_id=c.id AND split_of_id IS NULL \
                            AND date >= ?4 AND date < ?5 AND amount < 0), 0) AS month_spent \
         FROM category c \
         LEFT JOIN category p ON p.id = c.parent_id \
         WHERE c.archived = 0 AND c.is_protected = 0 AND c.is_income = 0 AND c.is_budgeted = 1 \
         ORDER BY COALESCE(p.name, c.name), (c.parent_id IS NOT NULL), c.name",
    )?;
    let rows: Vec<BudgetSummaryRow> = stmt
        .query_map(
            rusqlite::params![start, start, end, month_start, month_end],
            |r| {
                let basis: String = r.get(4)?;
                let allocated: f64 = r.get(5)?;
                let period_spent: f64 = r.get(6)?;
                let month_spent: f64 = r.get(7)?;
                let spent = if basis == "monthly" { month_spent } else { period_spent };
                Ok(BudgetSummaryRow {
                    category_id: r.get(0)?,
                    category_name: r.get(1)?,
                    parent_id: r.get(2)?,
                    parent_name: r.get(3)?,
                    budget_basis: basis,
                    allocated,
                    spent,
                    available: allocated - spent,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(BudgetSummary {
        start,
        end,
        rows,
    })
}
