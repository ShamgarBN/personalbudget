use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppResult;
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Goal {
    pub id: i64,
    pub name: String,
    pub target_amount: f64,
    pub target_date: Option<String>,
    pub account_id: Option<i64>,
    pub category_id: Option<i64>,
    pub current_amount: f64,
    pub created_at: String,
}

#[tauri::command]
pub fn list_goals(state: State<AppState>) -> AppResult<Vec<Goal>> {
    let conn = state.conn.lock();
    let mut stmt = conn.prepare(
        "SELECT id, name, target_amount, target_date, account_id, category_id, current_amount, created_at \
         FROM goal ORDER BY COALESCE(target_date, '9999-12-31'), name",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Goal {
                id: r.get(0)?,
                name: r.get(1)?,
                target_amount: r.get(2)?,
                target_date: r.get(3)?,
                account_id: r.get(4)?,
                category_id: r.get(5)?,
                current_amount: r.get(6)?,
                created_at: r.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub fn upsert_goal(state: State<AppState>, goal: Goal) -> AppResult<i64> {
    let conn = state.conn.lock();
    if goal.id == 0 {
        let created_at = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO goal (name, target_amount, target_date, account_id, category_id, current_amount, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![goal.name, goal.target_amount, goal.target_date, goal.account_id, goal.category_id, goal.current_amount, created_at],
        )?;
        Ok(conn.last_insert_rowid())
    } else {
        conn.execute(
            "UPDATE goal SET name=?, target_amount=?, target_date=?, account_id=?, category_id=?, current_amount=? WHERE id=?",
            rusqlite::params![goal.name, goal.target_amount, goal.target_date, goal.account_id, goal.category_id, goal.current_amount, goal.id],
        )?;
        Ok(goal.id)
    }
}

#[tauri::command]
pub fn delete_goal(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = state.conn.lock();
    conn.execute("DELETE FROM goal WHERE id=?", rusqlite::params![id])?;
    Ok(())
}
