use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppResult;
use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecurringBill {
    pub id: i64,
    pub name: String,
    pub amount: f64,
    pub account_id: i64,
    pub category_id: Option<i64>,
    pub cadence_kind: String,
    pub day_of_month: Option<i64>,
    pub anchor_date: Option<String>,
    /// For the "custom_days" cadence: repeat every N days from start_date.
    pub interval_days: Option<i64>,
    pub active: bool,
    pub last_seen_date: Option<String>,
    pub notes: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

#[tauri::command]
pub fn list_recurring_bills(state: State<AppState>) -> AppResult<Vec<RecurringBill>> {
    let conn = state.conn.lock();
    let mut stmt = conn.prepare(
        "SELECT id, name, amount, account_id, category_id, cadence_kind, day_of_month, anchor_date, interval_days, active, last_seen_date, notes, start_date, end_date \
         FROM recurring_bill ORDER BY active DESC, name",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(RecurringBill {
                id: r.get(0)?,
                name: r.get(1)?,
                amount: r.get(2)?,
                account_id: r.get(3)?,
                category_id: r.get(4)?,
                cadence_kind: r.get(5)?,
                day_of_month: r.get(6)?,
                anchor_date: r.get(7)?,
                interval_days: r.get(8)?,
                active: r.get::<_, i64>(9)? != 0,
                last_seen_date: r.get(10)?,
                notes: r.get(11)?,
                start_date: r.get(12)?,
                end_date: r.get(13)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub fn upsert_recurring_bill(state: State<AppState>, bill: RecurringBill) -> AppResult<i64> {
    let conn = state.conn.lock();
    if bill.id == 0 {
        conn.execute(
            "INSERT INTO recurring_bill (name, amount, account_id, category_id, cadence_kind, day_of_month, anchor_date, interval_days, active, last_seen_date, notes, start_date, end_date) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                bill.name, bill.amount, bill.account_id, bill.category_id, bill.cadence_kind,
                bill.day_of_month, bill.anchor_date, bill.interval_days, bill.active as i64, bill.last_seen_date, bill.notes,
                bill.start_date, bill.end_date,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    } else {
        conn.execute(
            "UPDATE recurring_bill \
                SET name=?, amount=?, account_id=?, category_id=?, cadence_kind=?, day_of_month=?, anchor_date=?, interval_days=?, active=?, last_seen_date=?, notes=?, start_date=?, end_date=? \
              WHERE id=?",
            rusqlite::params![
                bill.name, bill.amount, bill.account_id, bill.category_id, bill.cadence_kind,
                bill.day_of_month, bill.anchor_date, bill.interval_days, bill.active as i64, bill.last_seen_date, bill.notes,
                bill.start_date, bill.end_date,
                bill.id,
            ],
        )?;
        Ok(bill.id)
    }
}

#[tauri::command]
pub fn delete_recurring_bill(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = state.conn.lock();
    conn.execute("DELETE FROM recurring_bill WHERE id=?", rusqlite::params![id])?;
    Ok(())
}
