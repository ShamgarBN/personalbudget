use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::merchant;
use crate::models::{ImportBatch, ImportPreview, ImportPreviewRow};
use crate::parsers;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct PreviewArgs {
    pub file_name: String,
    pub content: String,
    pub account_id: Option<i64>,
}

#[tauri::command]
pub fn preview_import(state: State<AppState>, args: PreviewArgs) -> AppResult<ImportPreview> {
    let parsed = parsers::detect_and_parse(&args.content)
        .map_err(|e| AppError::Invalid(e.to_string()))?;
    let conn = state.conn.lock();

    let (account_id, account_name) = if let Some(id) = args.account_id {
        let name: String = conn.query_row(
            "SELECT name FROM account WHERE id=?",
            rusqlite::params![id],
            |r| r.get(0),
        )?;
        (id, name)
    } else {
        // Match account_hint against existing accounts.
        let hint = parsed.account_hint.clone();
        let row = conn.query_row(
            "SELECT id, name FROM account WHERE LOWER(name) = LOWER(?) LIMIT 1",
            rusqlite::params![hint],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        );
        match row {
            Ok(x) => x,
            Err(_) => {
                return Err(AppError::Invalid(format!(
                    "no account named '{hint}' — pick one explicitly"
                )))
            }
        }
    };

    let transfer_cat_id: i64 = conn.query_row(
        "SELECT id FROM category WHERE name='Transfer' AND is_protected=1",
        [],
        |r| r.get(0),
    )?;
    let income_cat_id: i64 = conn.query_row(
        "SELECT id FROM category WHERE name='Income' AND is_protected=1",
        [],
        |r| r.get(0),
    )?;

    let mut rows: Vec<ImportPreviewRow> = Vec::with_capacity(parsed.rows.len());
    for r in &parsed.rows {
        let hash = hash_row(account_id, &r.date, r.amount, &r.description);
        let dup_exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM txn WHERE import_hash=?",
            rusqlite::params![hash],
            |row| row.get(0),
        )?;

        let mut suggested_cat = if r.is_transfer {
            Some(transfer_cat_id)
        } else {
            merchant::match_category(&conn, &r.description)?
        };
        // Apple Card hint category — try to find a same-named category in our taxonomy.
        if suggested_cat.is_none() {
            if let Some(hint) = &r.hint_category {
                if let Ok(cid) = conn.query_row(
                    "SELECT id FROM category WHERE LOWER(name) = LOWER(?)",
                    rusqlite::params![hint],
                    |row| row.get::<_, i64>(0),
                ) {
                    suggested_cat = Some(cid);
                }
            }
        }
        if suggested_cat.is_none() && r.amount > 0.0 && !r.is_transfer {
            suggested_cat = Some(income_cat_id);
        }
        let suggested_name = if let Some(cid) = suggested_cat {
            conn.query_row(
                "SELECT name FROM category WHERE id=?",
                rusqlite::params![cid],
                |row| row.get::<_, String>(0),
            )
            .ok()
        } else {
            None
        };

        rows.push(ImportPreviewRow {
            date: r.date.clone(),
            description: r.description.clone(),
            amount: r.amount,
            suggested_category_id: suggested_cat,
            suggested_category_name: suggested_name,
            is_transfer: r.is_transfer,
            is_duplicate: dup_exists > 0,
            import_hash: hash,
        });
    }

    Ok(ImportPreview {
        account_id,
        account_name,
        source_file: args.file_name,
        format: parsed.format,
        beginning_balance: parsed.beginning_balance,
        beginning_balance_date: parsed.beginning_balance_date,
        rows,
    })
}

#[derive(Debug, Deserialize)]
pub struct CommitRow {
    pub date: String,
    pub description: String,
    pub amount: f64,
    pub category_id: Option<i64>,
    pub import_hash: String,
    pub skip: bool,
    /// True if the category was auto-suggested and the user accepted it
    /// without changing. Those rows land as needs_review = true so the user
    /// can do a follow-up sanity check in the Ledger.
    #[serde(default)]
    pub auto_categorized: bool,
}

#[derive(Debug, Deserialize)]
pub struct CommitArgs {
    pub account_id: i64,
    pub source_file: String,
    pub rows: Vec<CommitRow>,
    pub beginning_balance: Option<f64>,
    pub beginning_balance_date: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CommitResult {
    pub batch_id: i64,
    pub inserted: i64,
    pub skipped: i64,
}

#[tauri::command]
pub fn commit_import(state: State<AppState>, args: CommitArgs) -> AppResult<CommitResult> {
    let mut conn = state.conn.lock();
    let tx = conn.transaction()?;

    let imported_at = chrono::Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO import_batch (imported_at, account_id, source_file, row_count) VALUES (?, ?, ?, 0)",
        rusqlite::params![imported_at, args.account_id, args.source_file],
    )?;
    let batch_id = tx.last_insert_rowid();

    // Seed opening balance if applicable.
    if let (Some(b), Some(d)) = (args.beginning_balance, args.beginning_balance_date.as_ref()) {
        let prior: i64 = tx.query_row(
            "SELECT COUNT(*) FROM txn WHERE account_id=? AND date <= ?",
            rusqlite::params![args.account_id, d],
            |r| r.get(0),
        )?;
        if prior == 0 {
            tx.execute(
                "UPDATE account SET opening_balance=?, opening_date=? WHERE id=?",
                rusqlite::params![b, d, args.account_id],
            )?;
        }
    }

    let mut inserted = 0i64;
    let mut skipped = 0i64;
    for row in &args.rows {
        if row.skip {
            skipped += 1;
            continue;
        }
        let now = chrono::Utc::now().to_rfc3339();
        let needs_review = row.auto_categorized && row.category_id.is_some();
        tx.execute(
            "INSERT INTO txn (account_id, date, description, category_id, amount, import_batch_id, import_hash, needs_review, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                args.account_id,
                row.date,
                row.description,
                row.category_id,
                row.amount,
                batch_id,
                row.import_hash,
                needs_review as i64,
                now,
                now,
            ],
        )?;
        if let Some(cid) = row.category_id {
            // record merchant -> category memory
            let _ = merchant::record(&tx, &row.description, cid);
        }
        inserted += 1;
    }
    tx.execute(
        "UPDATE import_batch SET row_count=? WHERE id=?",
        rusqlite::params![inserted, batch_id],
    )?;
    tx.commit()?;
    Ok(CommitResult { batch_id, inserted, skipped })
}

#[tauri::command]
pub fn list_import_batches(state: State<AppState>) -> AppResult<Vec<ImportBatch>> {
    let conn = state.conn.lock();
    let mut stmt = conn.prepare(
        "SELECT id, imported_at, account_id, source_file, row_count FROM import_batch ORDER BY imported_at DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ImportBatch {
                id: r.get(0)?,
                imported_at: r.get(1)?,
                account_id: r.get(2)?,
                source_file: r.get(3)?,
                row_count: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[tauri::command]
pub fn undo_import_batch(state: State<AppState>, batch_id: i64) -> AppResult<i64> {
    let conn = state.conn.lock();
    let deleted = conn.execute(
        "DELETE FROM txn WHERE import_batch_id=?",
        rusqlite::params![batch_id],
    )?;
    conn.execute(
        "DELETE FROM import_batch WHERE id=?",
        rusqlite::params![batch_id],
    )?;
    Ok(deleted as i64)
}

fn hash_row(account_id: i64, date: &str, amount: f64, description: &str) -> String {
    let desc_clip: String = description.chars().take(40).collect();
    let payload = format!("{account_id}|{date}|{:.2}|{desc_clip}", amount);
    let mut hasher = Sha1::new();
    hasher.update(payload.as_bytes());
    hex::encode(hasher.finalize())
}
