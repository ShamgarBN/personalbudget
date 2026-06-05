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
    pub allocated: f64,
    pub spent: f64,
    pub rollover_in: f64,
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
pub fn budget_summary(state: State<AppState>, start: String, end: String) -> AppResult<BudgetSummary> {
    let conn = state.conn.lock();
    // Sort parents (parent_id NULL) before their children, then alphabetically within each level.
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, c.parent_id, p.name AS parent_name, \
                COALESCE((SELECT SUM(amount) FROM budget_allocation \
                          WHERE category_id=c.id AND effective_from <= ? \
                            AND (effective_to IS NULL OR effective_to > ?)), 0) AS allocated, \
                COALESCE((SELECT SUM(ABS(amount)) FROM txn \
                          WHERE category_id=c.id AND split_of_id IS NULL \
                            AND date >= ? AND date < ? AND amount < 0), 0) AS spent \
         FROM category c \
         LEFT JOIN category p ON p.id = c.parent_id \
         WHERE c.archived = 0 AND c.is_protected = 0 AND c.is_income = 0 \
         ORDER BY COALESCE(p.name, c.name), (c.parent_id IS NOT NULL), c.name",
    )?;
    let rows: Vec<BudgetSummaryRow> = stmt
        .query_map(rusqlite::params![start, start, start, end], |r| {
            Ok(BudgetSummaryRow {
                category_id: r.get(0)?,
                category_name: r.get(1)?,
                parent_id: r.get(2)?,
                parent_name: r.get(3)?,
                allocated: r.get(4)?,
                spent: r.get(5)?,
                rollover_in: 0.0,
                available: 0.0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    let mut filled: Vec<BudgetSummaryRow> = Vec::with_capacity(rows.len());
    for mut row in rows {
        // Rollover_in: net (allocated - spent) over all completed previous periods since allocation began.
        // Simple approximation: sum across prior allocations on this category minus prior spend.
        let prior_alloc: f64 = conn.query_row(
            "SELECT COALESCE(SUM(amount),0) FROM budget_allocation \
             WHERE category_id=? AND effective_from < ?",
            rusqlite::params![row.category_id, start],
            |r| r.get(0),
        )?;
        let prior_spent: f64 = conn.query_row(
            "SELECT COALESCE(SUM(ABS(amount)),0) FROM txn \
             WHERE category_id=? AND split_of_id IS NULL AND date < ? AND amount < 0",
            rusqlite::params![row.category_id, start],
            |r| r.get(0),
        )?;
        row.rollover_in = prior_alloc - prior_spent;
        row.available = row.allocated + row.rollover_in - row.spent;
        filled.push(row);
    }
    Ok(BudgetSummary {
        start,
        end,
        rows: filled,
    })
}
