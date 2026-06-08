use tauri::State;

use crate::error::{AppError, AppResult};
use crate::models::Category;
use crate::AppState;

#[tauri::command]
pub fn list_categories(state: State<AppState>) -> AppResult<Vec<Category>> {
    let conn = state.conn.lock();
    let mut stmt = conn.prepare(
        "SELECT id, name, parent_id, is_protected, is_income, color, archived, is_budgeted, budget_basis \
         FROM category ORDER BY COALESCE(parent_id, 0), name",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Category {
                id: r.get(0)?,
                name: r.get(1)?,
                parent_id: r.get(2)?,
                is_protected: r.get::<_, i64>(3)? != 0,
                is_income: r.get::<_, i64>(4)? != 0,
                color: r.get(5)?,
                archived: r.get::<_, i64>(6)? != 0,
                is_budgeted: r.get::<_, i64>(7)? != 0,
                budget_basis: r.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub fn create_category(
    state: State<AppState>,
    name: String,
    parent_id: Option<i64>,
    color: Option<String>,
    is_income: Option<bool>,
) -> AppResult<i64> {
    let conn = state.conn.lock();
    conn.execute(
        "INSERT INTO category (name, parent_id, is_protected, is_income, color) VALUES (?, ?, 0, ?, ?)",
        rusqlite::params![name, parent_id, is_income.unwrap_or(false) as i64, color],
    )?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn update_category(
    state: State<AppState>,
    id: i64,
    name: Option<String>,
    parent_id: Option<Option<i64>>,
    color: Option<String>,
    archived: Option<bool>,
    is_budgeted: Option<bool>,
    budget_basis: Option<String>,
) -> AppResult<()> {
    let conn = state.conn.lock();
    let is_protected: i64 = conn.query_row(
        "SELECT is_protected FROM category WHERE id=?",
        rusqlite::params![id],
        |r| r.get(0),
    )?;
    if is_protected != 0 {
        if name.is_some() || parent_id.is_some() {
            return Err(AppError::Invalid("cannot rename or reparent protected category".into()));
        }
    }
    if let Some(n) = name {
        conn.execute("UPDATE category SET name=? WHERE id=?", rusqlite::params![n, id])?;
    }
    if let Some(p) = parent_id {
        conn.execute("UPDATE category SET parent_id=? WHERE id=?", rusqlite::params![p, id])?;
    }
    if let Some(c) = color {
        conn.execute("UPDATE category SET color=? WHERE id=?", rusqlite::params![c, id])?;
    }
    if let Some(a) = archived {
        conn.execute("UPDATE category SET archived=? WHERE id=?", rusqlite::params![a as i64, id])?;
    }
    if let Some(b) = is_budgeted {
        conn.execute("UPDATE category SET is_budgeted=? WHERE id=?", rusqlite::params![b as i64, id])?;
    }
    if let Some(basis) = budget_basis {
        if basis != "monthly" && basis != "per_pay_period" {
            return Err(AppError::Invalid(format!("invalid budget_basis: {basis}")));
        }
        conn.execute("UPDATE category SET budget_basis=? WHERE id=?", rusqlite::params![basis, id])?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_category(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = state.conn.lock();
    let is_protected: i64 = conn.query_row(
        "SELECT is_protected FROM category WHERE id=?",
        rusqlite::params![id],
        |r| r.get(0),
    )?;
    if is_protected != 0 {
        return Err(AppError::Invalid("cannot delete protected category".into()));
    }
    let usage: i64 = conn.query_row(
        "SELECT COUNT(*) FROM txn WHERE category_id=?",
        rusqlite::params![id],
        |r| r.get(0),
    )?;
    if usage > 0 {
        return Err(AppError::Invalid(format!(
            "category in use by {usage} transactions; archive it instead"
        )));
    }
    conn.execute("DELETE FROM category WHERE id=?", rusqlite::params![id])?;
    Ok(())
}
