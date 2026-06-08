use serde::{Deserialize, Serialize};
use tauri::State;
use crate::error::AppError;

use crate::error::AppResult;
use crate::merchant;
use crate::models::{NewTransaction, Transaction};
use crate::AppState;

#[derive(Debug, Default, Deserialize)]
pub struct TxnFilter {
    pub account_id: Option<i64>,
    pub category_id: Option<i64>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub search: Option<String>,
    pub cleared: Option<bool>,
    pub flagged: Option<bool>,
    pub needs_review: Option<bool>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct TxnPage {
    pub rows: Vec<Transaction>,
    pub total: i64,
}

#[tauri::command]
pub fn list_transactions(state: State<AppState>, filter: Option<TxnFilter>) -> AppResult<TxnPage> {
    let f = filter.unwrap_or_default();
    let conn = state.conn.lock();

    // CTE computes running balance per account over ALL non-split history.
    // Joined after filtering so the balance reflects true cumulative state
    // even when the user has narrowed the visible rows.
    let mut sql = String::from(
        "WITH running AS ( \
           SELECT t.id, \
             a.opening_balance + SUM(t.amount) OVER ( \
               PARTITION BY t.account_id \
               ORDER BY t.date ASC, t.id ASC \
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW \
             ) AS bal \
           FROM txn t \
           JOIN account a ON a.id = t.account_id \
           WHERE t.split_of_id IS NULL \
         ) \
         SELECT t.id, t.account_id, t.date, t.description, t.title, t.category_id, c.name, \
                t.amount, t.memo, t.cleared, t.flagged, t.needs_review, t.split_of_id, t.from_bill_id, r.bal \
         FROM txn t \
         LEFT JOIN category c ON c.id = t.category_id \
         LEFT JOIN running r ON r.id = t.id \
         WHERE 1=1",
    );
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(a) = f.account_id {
        sql.push_str(" AND t.account_id = ?");
        params.push(Box::new(a));
    }
    if let Some(c) = f.category_id {
        sql.push_str(" AND t.category_id = ?");
        params.push(Box::new(c));
    }
    if let Some(d) = &f.date_from {
        sql.push_str(" AND t.date >= ?");
        params.push(Box::new(d.clone()));
    }
    if let Some(d) = &f.date_to {
        sql.push_str(" AND t.date <= ?");
        params.push(Box::new(d.clone()));
    }
    if let Some(s) = &f.search {
        sql.push_str(" AND (t.description LIKE ? OR COALESCE(t.title,'') LIKE ? OR COALESCE(t.memo,'') LIKE ?)");
        let pat = format!("%{s}%");
        params.push(Box::new(pat.clone()));
        params.push(Box::new(pat.clone()));
        params.push(Box::new(pat));
    }
    if let Some(c) = f.cleared {
        sql.push_str(" AND t.cleared = ?");
        params.push(Box::new(c as i64));
    }
    if let Some(c) = f.flagged {
        sql.push_str(" AND t.flagged = ?");
        params.push(Box::new(c as i64));
    }
    if let Some(c) = f.needs_review {
        sql.push_str(" AND t.needs_review = ?");
        params.push(Box::new(c as i64));
    }

    let count_sql = format!("SELECT COUNT(*) FROM ({sql})");
    let total: i64 = conn.query_row(
        &count_sql,
        rusqlite::params_from_iter(params.iter().map(|b| b.as_ref())),
        |r| r.get(0),
    )?;

    sql.push_str(" ORDER BY t.date DESC, t.id DESC");
    let limit = f.limit.unwrap_or(500);
    let offset = f.offset.unwrap_or(0);
    sql.push_str(" LIMIT ? OFFSET ?");
    params.push(Box::new(limit));
    params.push(Box::new(offset));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(
            rusqlite::params_from_iter(params.iter().map(|b| b.as_ref())),
            |r| {
                Ok(Transaction {
                    id: r.get(0)?,
                    account_id: r.get(1)?,
                    date: r.get(2)?,
                    description: r.get(3)?,
                    title: r.get(4)?,
                    category_id: r.get(5)?,
                    category_name: r.get(6)?,
                    amount: r.get(7)?,
                    memo: r.get(8)?,
                    cleared: r.get::<_, i64>(9)? != 0,
                    flagged: r.get::<_, i64>(10)? != 0,
                    needs_review: r.get::<_, i64>(11)? != 0,
                    split_of_id: r.get(12)?,
                    from_bill_id: r.get(13)?,
                    running_balance: r.get(14)?,
                })
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(TxnPage { rows, total })
}

#[tauri::command]
pub fn create_transaction(state: State<AppState>, txn: NewTransaction) -> AppResult<i64> {
    let conn = state.conn.lock();
    let now = chrono::Utc::now().to_rfc3339();
    // If the caller didn't supply a category, try to auto-suggest one from merchant memory.
    // Auto-suggested categories land as needs_review=true so the user can confirm in the Ledger.
    let (final_cat, needs_review) = if let Some(cid) = txn.category_id {
        (Some(cid), false)
    } else if let Ok(Some(cid)) = merchant::match_category(&conn, &txn.description) {
        (Some(cid), true)
    } else {
        (None, false)
    };
    conn.execute(
        "INSERT INTO txn (account_id, date, description, title, category_id, amount, memo, cleared, flagged, needs_review, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            txn.account_id,
            txn.date,
            txn.description,
            txn.title,
            final_cat,
            txn.amount,
            txn.memo,
            txn.cleared.unwrap_or(false) as i64,
            txn.flagged.unwrap_or(false) as i64,
            needs_review as i64,
            now,
            now,
        ],
    )?;
    let id = conn.last_insert_rowid();
    // Only record the merchant -> category mapping for explicit user choices, not
    // for auto-suggestions (those came from the map and shouldn't reinforce themselves).
    if let Some(cat) = txn.category_id {
        let _ = merchant::record(&conn, &txn.description, cat);
    }
    Ok(id)
}

/// Sentinel-string deserializer notes:
/// JSON `null` arriving at a Tauri command arg of type `Option<T>` collapses
/// to `None`, which is indistinguishable from "field missing". So we can't use
/// `Option<Option<String>>` here — we instead let the caller send an empty
/// string ("") to mean "clear this field to NULL", and a non-empty string to
/// mean "set to this value". `category_id` uses 0 as the equivalent sentinel
/// since 0 is never a valid generated id.
#[tauri::command]
pub fn update_transaction(
    state: State<AppState>,
    id: i64,
    date: Option<String>,
    description: Option<String>,
    title: Option<String>,
    category_id: Option<i64>,
    amount: Option<f64>,
    memo: Option<String>,
    cleared: Option<bool>,
    flagged: Option<bool>,
) -> AppResult<()> {
    let conn = state.conn.lock();
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(v) = date {
        conn.execute("UPDATE txn SET date=?, updated_at=? WHERE id=?", rusqlite::params![v, now, id])?;
    }
    if let Some(v) = description {
        conn.execute("UPDATE txn SET description=?, updated_at=? WHERE id=?", rusqlite::params![v, now, id])?;
    }
    if let Some(v) = title {
        let store: Option<String> = if v.is_empty() { None } else { Some(v) };
        conn.execute("UPDATE txn SET title=?, updated_at=? WHERE id=?", rusqlite::params![store, now, id])?;
    }
    if let Some(v) = category_id {
        // 0 → clear category, non-zero → assign. Manual edit counts as review.
        let store: Option<i64> = if v == 0 { None } else { Some(v) };
        conn.execute(
            "UPDATE txn SET category_id=?, needs_review=0, updated_at=? WHERE id=?",
            rusqlite::params![store, now, id],
        )?;
        if let Some(cat) = store {
            let desc: String = conn.query_row(
                "SELECT description FROM txn WHERE id=?",
                rusqlite::params![id],
                |r| r.get(0),
            )?;
            let _ = merchant::record(&conn, &desc, cat);
        }
    }
    if let Some(v) = amount {
        conn.execute("UPDATE txn SET amount=?, updated_at=? WHERE id=?", rusqlite::params![v, now, id])?;
    }
    if let Some(v) = memo {
        let store: Option<String> = if v.is_empty() { None } else { Some(v) };
        conn.execute("UPDATE txn SET memo=?, updated_at=? WHERE id=?", rusqlite::params![store, now, id])?;
    }
    if let Some(v) = cleared {
        conn.execute("UPDATE txn SET cleared=?, updated_at=? WHERE id=?", rusqlite::params![v as i64, now, id])?;
    }
    if let Some(v) = flagged {
        conn.execute("UPDATE txn SET flagged=?, updated_at=? WHERE id=?", rusqlite::params![v as i64, now, id])?;
    }
    Ok(())
}

#[tauri::command]
pub fn mark_reviewed(state: State<AppState>, ids: Vec<i64>) -> AppResult<i64> {
    let mut conn = state.conn.lock();
    let tx = conn.transaction()?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut count = 0i64;
    for id in ids {
        tx.execute(
            "UPDATE txn SET needs_review = 0, updated_at = ? WHERE id = ?",
            rusqlite::params![now, id],
        )?;
        count += 1;
    }
    tx.commit()?;
    Ok(count)
}

/// One-shot maintenance action: walk every transaction and trim cluttered
/// import-era descriptions ("Texas Roadhouse | TEXAS ROADHOUSE #2294 11440 …"
/// → "Texas Roadhouse", "JPMorgan Chase DES:Ext Trnsfr …" → "JPMorgan Chase").
/// Returns the number of rows updated.
#[tauri::command]
pub fn simplify_descriptions(state: State<AppState>) -> AppResult<i64> {
    let mut conn = state.conn.lock();
    let tx = conn.transaction()?;
    let mut stmt = tx.prepare("SELECT id, description FROM txn")?;
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    let mut changed = 0i64;
    for (id, desc) in rows {
        let cleaned = simplify_one(&desc);
        if cleaned != desc {
            tx.execute(
                "UPDATE txn SET description = ? WHERE id = ?",
                rusqlite::params![cleaned, id],
            )?;
            changed += 1;
        }
    }
    tx.commit()?;
    Ok(changed)
}

fn simplify_one(raw: &str) -> String {
    // Apple Card-style: "Merchant | RAW BLAH BLAH" → "Merchant"
    if let Some(idx) = raw.find(" | ") {
        return raw[..idx].trim().to_string();
    }
    // BoA-style machine markers
    crate::parsers::bofa_checking::simplify_bofa(raw)
}

#[tauri::command]
pub fn delete_transaction(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = state.conn.lock();
    conn.execute("DELETE FROM txn WHERE split_of_id=?", rusqlite::params![id])?;
    conn.execute("DELETE FROM txn WHERE id=?", rusqlite::params![id])?;
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct SplitChild {
    pub category_id: Option<i64>,
    pub amount: f64,
    pub description: Option<String>,
}

/// Split a transaction into N child rows. The parent's amount is zeroed
/// (so it doesn't double-count) and child rows reference it via split_of_id.
/// Sum of child amounts must equal the parent's pre-split amount.
#[tauri::command]
pub fn split_transaction(
    state: State<AppState>,
    parent_id: i64,
    children: Vec<SplitChild>,
) -> AppResult<()> {
    let mut conn = state.conn.lock();
    let tx = conn.transaction()?;

    let (account_id, date, parent_amount, parent_desc): (i64, String, f64, String) = tx.query_row(
        "SELECT account_id, date, amount, description FROM txn WHERE id=? AND split_of_id IS NULL",
        rusqlite::params![parent_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;

    let child_sum: f64 = children.iter().map(|c| c.amount).sum();
    if (child_sum - parent_amount).abs() > 0.005 {
        return Err(AppError::Invalid(format!(
            "split children sum {child_sum:.2} != parent amount {parent_amount:.2}"
        )));
    }

    // First, clear any prior split children (idempotent re-split).
    tx.execute("DELETE FROM txn WHERE split_of_id=?", rusqlite::params![parent_id])?;

    let now = chrono::Utc::now().to_rfc3339();
    for c in &children {
        let desc = c.description.clone().unwrap_or_else(|| parent_desc.clone());
        tx.execute(
            "INSERT INTO txn (account_id, date, description, category_id, amount, split_of_id, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![account_id, date, desc, c.category_id, c.amount, parent_id, now, now],
        )?;
    }
    // Zero the parent so balance math through txn aggregates remains correct
    // (children carry the actual amounts; parent is the umbrella row).
    tx.execute(
        "UPDATE txn SET amount = 0, updated_at = ? WHERE id = ?",
        rusqlite::params![now, parent_id],
    )?;

    tx.commit()?;
    Ok(())
}

/// Undo a split: deletes all children and restores parent's amount from their sum.
#[tauri::command]
pub fn unsplit_transaction(state: State<AppState>, parent_id: i64) -> AppResult<()> {
    let mut conn = state.conn.lock();
    let tx = conn.transaction()?;
    let restored: f64 = tx.query_row(
        "SELECT COALESCE(SUM(amount),0) FROM txn WHERE split_of_id=?",
        rusqlite::params![parent_id],
        |r| r.get(0),
    )?;
    tx.execute("DELETE FROM txn WHERE split_of_id=?", rusqlite::params![parent_id])?;
    tx.execute(
        "UPDATE txn SET amount=? WHERE id=?",
        rusqlite::params![restored, parent_id],
    )?;
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct TxnWithChildren {
    pub parent: Transaction,
    pub children: Vec<Transaction>,
}

fn row_to_txn(r: &rusqlite::Row) -> rusqlite::Result<Transaction> {
    Ok(Transaction {
        id: r.get(0)?,
        account_id: r.get(1)?,
        date: r.get(2)?,
        description: r.get(3)?,
        title: r.get(4)?,
        category_id: r.get(5)?,
        category_name: r.get(6)?,
        amount: r.get(7)?,
        memo: r.get(8)?,
        cleared: r.get::<_, i64>(9)? != 0,
        flagged: r.get::<_, i64>(10)? != 0,
        needs_review: r.get::<_, i64>(11)? != 0,
        split_of_id: r.get(12)?,
        from_bill_id: r.get(13)?,
        running_balance: None,
    })
}

#[tauri::command]
pub fn get_transaction(state: State<AppState>, id: i64) -> AppResult<TxnWithChildren> {
    let conn = state.conn.lock();
    let parent = conn.query_row(
        "SELECT t.id, t.account_id, t.date, t.description, t.title, t.category_id, c.name, \
                t.amount, t.memo, t.cleared, t.flagged, t.needs_review, t.split_of_id, t.from_bill_id \
         FROM txn t LEFT JOIN category c ON c.id=t.category_id WHERE t.id=?",
        rusqlite::params![id],
        row_to_txn,
    )?;
    let mut stmt = conn.prepare(
        "SELECT t.id, t.account_id, t.date, t.description, t.title, t.category_id, c.name, \
                t.amount, t.memo, t.cleared, t.flagged, t.needs_review, t.split_of_id, t.from_bill_id \
         FROM txn t LEFT JOIN category c ON c.id=t.category_id \
         WHERE t.split_of_id=? ORDER BY t.id",
    )?;
    let children: Vec<Transaction> = stmt
        .query_map(rusqlite::params![id], row_to_txn)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(TxnWithChildren { parent, children })
}

/// Turn a projected recurring occurrence into a real transaction for a single
/// date. The recurring template is untouched; future projections continue. The
/// new row is tagged with `from_bill_id` so the ledger stops projecting a ghost
/// for that occurrence. `amount` is signed (negative = expense).
#[tauri::command]
pub fn materialize_occurrence(
    state: State<AppState>,
    bill_id: i64,
    date: String,
    amount: f64,
    cleared: bool,
) -> AppResult<i64> {
    let conn = state.conn.lock();
    let (name, account_id, category_id): (String, i64, Option<i64>) = conn.query_row(
        "SELECT name, account_id, category_id FROM recurring_bill WHERE id=?",
        rusqlite::params![bill_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    // Guard against a double-materialize of the same occurrence.
    let existing: i64 = conn.query_row(
        "SELECT COUNT(*) FROM txn WHERE from_bill_id=? AND date=?",
        rusqlite::params![bill_id, date],
        |r| r.get(0),
    )?;
    if existing > 0 {
        return Err(AppError::Invalid("occurrence already recorded".into()));
    }
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO txn (account_id, date, description, title, category_id, amount, memo, cleared, flagged, needs_review, from_bill_id, created_at, updated_at) \
         VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, 0, 0, ?, ?, ?)",
        rusqlite::params![account_id, date, name, category_id, amount, cleared as i64, bill_id, now, now],
    )?;
    Ok(conn.last_insert_rowid())
}
