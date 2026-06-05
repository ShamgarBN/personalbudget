use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::parsers::legacy_app;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct LegacyImportArgs {
    pub file_name: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct LegacyImportPreview {
    pub total_rows: i64,
    pub by_account: Vec<AccountSummary>,
    pub categories_to_create: Vec<String>,
    pub subcategories_to_create: Vec<String>,
    pub split_groups: i64,
    pub accounts_missing: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct AccountSummary {
    pub account: String,
    pub count: i64,
}

/// Inspect a legacy-app CSV without writing anything. Reports what would
/// happen on import: row counts by account, categories that would be
/// created, accounts that would need to be auto-mapped.
#[tauri::command]
pub fn preview_legacy_import(
    state: State<AppState>,
    args: LegacyImportArgs,
) -> AppResult<LegacyImportPreview> {
    let parsed = legacy_app::parse(&args.content).map_err(|e| AppError::Invalid(e.to_string()))?;
    let conn = state.conn.lock();

    let mut by_account: HashMap<String, i64> = HashMap::new();
    let mut split_uuids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for r in &parsed.rows {
        *by_account.entry(r.account.clone()).or_insert(0) += 1;
        if !r.split_of.is_empty() {
            split_uuids.insert(r.split_of.clone());
        }
    }

    // Categories / subcategories that don't yet exist (case-insensitive name match).
    let mut existing_top: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut existing_sub: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut stmt = conn.prepare("SELECT name, parent_id FROM category")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    for (name, parent) in rows {
        if parent.is_none() {
            existing_top.insert(name.to_lowercase());
        } else {
            existing_sub.insert(name.to_lowercase());
        }
    }

    let mut new_cats: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut new_subs: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for r in &parsed.rows {
        if !r.category.is_empty() && !existing_top.contains(&r.category.to_lowercase()) {
            new_cats.insert(r.category.clone());
        }
        if !r.subcategory.is_empty() && !existing_sub.contains(&r.subcategory.to_lowercase()) {
            new_subs.insert(r.subcategory.clone());
        }
    }

    // Account mapping check.
    let mut accounts_missing: Vec<String> = Vec::new();
    for acct in by_account.keys() {
        if resolve_account_id(&conn, acct)?.is_none() {
            accounts_missing.push(acct.clone());
        }
    }

    let summary: Vec<AccountSummary> = by_account
        .into_iter()
        .map(|(a, c)| AccountSummary { account: a, count: c })
        .collect();

    Ok(LegacyImportPreview {
        total_rows: parsed.rows.len() as i64,
        by_account: summary,
        categories_to_create: new_cats.into_iter().collect(),
        subcategories_to_create: new_subs.into_iter().collect(),
        split_groups: split_uuids.len() as i64,
        accounts_missing,
    })
}

#[derive(Debug, Serialize)]
pub struct LegacyImportResult {
    pub batch_id: i64,
    pub inserted: i64,
    pub categories_created: i64,
    pub splits_reconstructed: i64,
}

#[tauri::command]
pub fn commit_legacy_import(
    state: State<AppState>,
    args: LegacyImportArgs,
) -> AppResult<LegacyImportResult> {
    let parsed = legacy_app::parse(&args.content).map_err(|e| AppError::Invalid(e.to_string()))?;
    let mut conn = state.conn.lock();
    let tx = conn.transaction()?;

    // Use the first account that has any rows as the import_batch.account_id reference.
    // (Batches only carry one account_id; for a multi-account legacy import this is just for display.)
    let first_account_name = parsed
        .rows
        .first()
        .map(|r| r.account.clone())
        .unwrap_or_else(|| "Bank Account".into());
    let primary_account_id = resolve_or_create_account(&tx, &first_account_name)?;

    let imported_at = chrono::Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO import_batch (imported_at, account_id, source_file, row_count) VALUES (?, ?, ?, 0)",
        rusqlite::params![imported_at, primary_account_id, args.file_name],
    )?;
    let batch_id = tx.last_insert_rowid();

    let mut categories_created = 0i64;
    let mut category_cache: HashMap<(String, Option<i64>), i64> = HashMap::new();
    // Preload existing categories for fast lookup.
    {
        let mut stmt = tx.prepare("SELECT id, name, parent_id FROM category")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (id, name, parent) in rows {
            category_cache.insert((name.to_lowercase(), parent), id);
        }
    }

    // Pass 1: insert every row, recording (uuid → list of inserted txn ids in source order).
    let mut split_groups: HashMap<String, Vec<(i64, f64, bool)>> = HashMap::new(); // uuid -> Vec<(txn_id, amount, is_child)>
    let mut inserted_count = 0i64;
    let now = chrono::Utc::now().to_rfc3339();

    for r in &parsed.rows {
        let account_id = resolve_or_create_account(&tx, &r.account)?;
        let category_id = if r.category.is_empty() {
            None
        } else {
            let key = (r.category.to_lowercase(), None);
            let id = if let Some(&id) = category_cache.get(&key) {
                id
            } else {
                tx.execute(
                    "INSERT INTO category (name, parent_id, is_protected, is_income, color) VALUES (?, NULL, 0, ?, NULL)",
                    rusqlite::params![r.category, if r.type_.eq_ignore_ascii_case("income") { 1 } else { 0 }],
                )?;
                let id = tx.last_insert_rowid();
                category_cache.insert(key, id);
                categories_created += 1;
                id
            };
            // Subcategory if present
            if !r.subcategory.is_empty() {
                let sub_key = (r.subcategory.to_lowercase(), Some(id));
                let sub_id = if let Some(&sid) = category_cache.get(&sub_key) {
                    sid
                } else {
                    tx.execute(
                        "INSERT INTO category (name, parent_id, is_protected, is_income, color) VALUES (?, ?, 0, 0, NULL)",
                        rusqlite::params![r.subcategory, id],
                    )?;
                    let sid = tx.last_insert_rowid();
                    category_cache.insert(sub_key, sid);
                    categories_created += 1;
                    sid
                };
                Some(sub_id)
            } else {
                Some(id)
            }
        };

        let memo = if r.memo.is_empty() { None } else { Some(&r.memo) };
        tx.execute(
            "INSERT INTO txn (account_id, date, description, title, category_id, amount, memo, cleared, flagged, import_batch_id, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                account_id,
                r.date,
                r.title,
                Option::<String>::None,
                category_id,
                r.amount,
                memo,
                r.cleared as i64,
                r.flagged as i64,
                batch_id,
                now,
                now,
            ],
        )?;
        let txn_id = tx.last_insert_rowid();
        inserted_count += 1;

        if !r.split_of.is_empty() {
            split_groups
                .entry(r.split_of.clone())
                .or_default()
                .push((txn_id, r.amount, r.is_split_child));
        }
    }

    // Pass 2: reconstruct splits — for each group with at least one child, set split_of_id on the
    // child rows to the parent's id, and zero the parent's amount (children carry the breakdown).
    let mut splits_reconstructed = 0i64;
    for (_uuid, group) in split_groups.iter() {
        let parents: Vec<i64> = group
            .iter()
            .filter(|(_, _, is_child)| !is_child)
            .map(|(id, _, _)| *id)
            .collect();
        let children: Vec<i64> = group
            .iter()
            .filter(|(_, _, is_child)| *is_child)
            .map(|(id, _, _)| *id)
            .collect();
        if children.is_empty() {
            continue;
        }
        // Pick the first parent if there is one; otherwise the first row in the group is treated as parent.
        let parent_id = parents.first().copied().unwrap_or(group[0].0);
        for &cid in &children {
            tx.execute(
                "UPDATE txn SET split_of_id = ? WHERE id = ?",
                rusqlite::params![parent_id, cid],
            )?;
        }
        // Zero the parent so totals aren't double-counted.
        tx.execute(
            "UPDATE txn SET amount = 0 WHERE id = ?",
            rusqlite::params![parent_id],
        )?;
        splits_reconstructed += 1;
    }

    tx.execute(
        "UPDATE import_batch SET row_count = ? WHERE id = ?",
        rusqlite::params![inserted_count, batch_id],
    )?;
    tx.commit()?;

    Ok(LegacyImportResult {
        batch_id,
        inserted: inserted_count,
        categories_created,
        splits_reconstructed,
    })
}

/// Look up the account by name. Accepts legacy names ("Bank Account",
/// "Credit Card") as aliases for the seeded names.
fn resolve_account_id(conn: &rusqlite::Connection, legacy_name: &str) -> AppResult<Option<i64>> {
    let candidates = candidate_names(legacy_name);
    for name in candidates {
        if let Ok(id) = conn.query_row(
            "SELECT id FROM account WHERE LOWER(name) = LOWER(?) LIMIT 1",
            rusqlite::params![name],
            |r| r.get::<_, i64>(0),
        ) {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

fn resolve_or_create_account(conn: &rusqlite::Connection, legacy_name: &str) -> AppResult<i64> {
    if let Some(id) = resolve_account_id(conn, legacy_name)? {
        return Ok(id);
    }
    // Fall back: create with the legacy name and a reasonable kind guess.
    let kind = match legacy_name {
        "Credit Card" => "credit",
        "Savings" => "savings",
        _ => "checking",
    };
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    conn.execute(
        "INSERT INTO account (name, kind, opening_balance, opening_date, display_order) \
         VALUES (?, ?, 0, ?, (SELECT COALESCE(MAX(display_order),0)+1 FROM account))",
        rusqlite::params![legacy_name, kind, today],
    )?;
    Ok(conn.last_insert_rowid())
}

fn candidate_names(legacy_name: &str) -> Vec<&'static str> {
    match legacy_name {
        "Bank Account" => vec!["Bank Account", "Joint Checking", "Checking"],
        "Credit Card" => vec!["Credit Card", "Apple Card"],
        "Savings" => vec!["Savings", "Capital One Savings"],
        _ => vec![],
    }
}
