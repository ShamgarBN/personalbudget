use tauri::State;

use crate::error::AppResult;
use crate::models::Account;
use crate::AppState;

#[tauri::command]
pub fn list_accounts(state: State<AppState>) -> AppResult<Vec<Account>> {
    let conn = state.conn.lock();
    let mut stmt = conn.prepare(
        "SELECT a.id, a.name, a.kind, a.opening_balance, a.opening_date, a.display_order, a.archived, \
                COALESCE(SUM(t.amount), 0) AS sum_amount \
         FROM account a \
         LEFT JOIN txn t ON t.account_id = a.id AND t.split_of_id IS NULL \
         GROUP BY a.id \
         ORDER BY a.display_order",
    )?;
    let rows = stmt
        .query_map([], |r| {
            let opening: f64 = r.get(3)?;
            let sum: f64 = r.get(7)?;
            Ok(Account {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                opening_balance: opening,
                opening_date: r.get(4)?,
                display_order: r.get(5)?,
                archived: r.get::<_, i64>(6)? != 0,
                current_balance: opening + sum,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub fn create_account(
    state: State<AppState>,
    name: String,
    kind: String,
    opening_balance: f64,
    opening_date: String,
) -> AppResult<i64> {
    let conn = state.conn.lock();
    conn.execute(
        "INSERT INTO account (name, kind, opening_balance, opening_date, display_order) \
         VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(display_order),0)+1 FROM account))",
        rusqlite::params![name, kind, opening_balance, opening_date],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Returns the account's running balance as of the end of `as_of_date`
/// inclusive — i.e., opening_balance plus every non-split transaction
/// dated <= as_of_date.
#[tauri::command]
pub fn account_balance_as_of(
    state: State<AppState>,
    account_id: i64,
    as_of_date: String,
) -> AppResult<f64> {
    let conn = state.conn.lock();
    let bal: f64 = conn.query_row(
        "SELECT a.opening_balance + COALESCE(SUM(t.amount), 0) \
         FROM account a \
         LEFT JOIN txn t ON t.account_id = a.id AND t.split_of_id IS NULL AND t.date <= ? \
         WHERE a.id = ?",
        rusqlite::params![as_of_date, account_id],
        |r| r.get(0),
    )?;
    Ok(bal)
}

#[tauri::command]
pub fn update_account(
    state: State<AppState>,
    id: i64,
    name: Option<String>,
    opening_balance: Option<f64>,
    opening_date: Option<String>,
    archived: Option<bool>,
) -> AppResult<()> {
    let conn = state.conn.lock();
    if let Some(n) = name {
        conn.execute("UPDATE account SET name=? WHERE id=?", rusqlite::params![n, id])?;
    }
    if let Some(b) = opening_balance {
        conn.execute("UPDATE account SET opening_balance=? WHERE id=?", rusqlite::params![b, id])?;
    }
    if let Some(d) = opening_date {
        conn.execute("UPDATE account SET opening_date=? WHERE id=?", rusqlite::params![d, id])?;
    }
    if let Some(a) = archived {
        conn.execute("UPDATE account SET archived=? WHERE id=?", rusqlite::params![a as i64, id])?;
    }
    Ok(())
}
