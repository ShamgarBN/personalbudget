use chrono::NaiveDate;
use tauri::State;

use crate::error::AppResult;
use crate::models::{PayPeriod, PayPeriodSchedule};
use crate::pay_period;
use crate::AppState;

#[tauri::command]
pub fn list_pay_period_schedules(state: State<AppState>) -> AppResult<Vec<PayPeriodSchedule>> {
    let conn = state.conn.lock();
    let mut stmt = conn.prepare(
        "SELECT id, effective_from, effective_to, cadence_kind, anchor_date, day_of_month_1, day_of_month_2, day_of_month, custom_dates_json \
         FROM pay_period_schedule ORDER BY effective_from",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PayPeriodSchedule {
                id: r.get(0)?,
                effective_from: r.get(1)?,
                effective_to: r.get(2)?,
                cadence_kind: r.get(3)?,
                anchor_date: r.get(4)?,
                day_of_month_1: r.get(5)?,
                day_of_month_2: r.get(6)?,
                day_of_month: r.get(7)?,
                custom_dates_json: r.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub fn upsert_pay_period_schedule(
    state: State<AppState>,
    schedule: PayPeriodSchedule,
) -> AppResult<i64> {
    let conn = state.conn.lock();
    if schedule.id == 0 {
        // Only auto-cap an existing ongoing schedule when this new one is also
        // ongoing (i.e., effective_to is NULL). A user inserting a historical
        // bounded schedule shouldn't disturb the current one.
        if schedule.effective_to.is_none() {
            conn.execute(
                "UPDATE pay_period_schedule SET effective_to = ? \
                 WHERE effective_to IS NULL AND effective_from < ?",
                rusqlite::params![schedule.effective_from, schedule.effective_from],
            )?;
        }
        conn.execute(
            "INSERT INTO pay_period_schedule (effective_from, effective_to, cadence_kind, anchor_date, day_of_month_1, day_of_month_2, day_of_month, custom_dates_json) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                schedule.effective_from,
                schedule.effective_to,
                schedule.cadence_kind,
                schedule.anchor_date,
                schedule.day_of_month_1,
                schedule.day_of_month_2,
                schedule.day_of_month,
                schedule.custom_dates_json,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    } else {
        conn.execute(
            "UPDATE pay_period_schedule \
                SET effective_from=?, effective_to=?, cadence_kind=?, anchor_date=?, day_of_month_1=?, day_of_month_2=?, day_of_month=?, custom_dates_json=? \
              WHERE id=?",
            rusqlite::params![
                schedule.effective_from,
                schedule.effective_to,
                schedule.cadence_kind,
                schedule.anchor_date,
                schedule.day_of_month_1,
                schedule.day_of_month_2,
                schedule.day_of_month,
                schedule.custom_dates_json,
                schedule.id,
            ],
        )?;
        Ok(schedule.id)
    }
}

#[tauri::command]
pub fn delete_pay_period_schedule(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = state.conn.lock();
    conn.execute("DELETE FROM pay_period_schedule WHERE id=?", rusqlite::params![id])?;
    Ok(())
}

#[tauri::command]
pub fn generate_pay_periods(state: State<AppState>, from: String, to: String) -> AppResult<Vec<PayPeriod>> {
    let conn = state.conn.lock();
    let mut stmt = conn.prepare(
        "SELECT id, effective_from, effective_to, cadence_kind, anchor_date, day_of_month_1, day_of_month_2, day_of_month, custom_dates_json \
         FROM pay_period_schedule ORDER BY effective_from",
    )?;
    let schedules: Vec<PayPeriodSchedule> = stmt
        .query_map([], |r| {
            Ok(PayPeriodSchedule {
                id: r.get(0)?,
                effective_from: r.get(1)?,
                effective_to: r.get(2)?,
                cadence_kind: r.get(3)?,
                anchor_date: r.get(4)?,
                day_of_month_1: r.get(5)?,
                day_of_month_2: r.get(6)?,
                day_of_month: r.get(7)?,
                custom_dates_json: r.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    let from_d = NaiveDate::parse_from_str(&from, "%Y-%m-%d")?;
    let to_d = NaiveDate::parse_from_str(&to, "%Y-%m-%d")?;
    pay_period::generate(&schedules, from_d, to_d)
}
