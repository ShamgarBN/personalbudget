use std::path::Path;

use rusqlite::Connection;

use crate::error::AppResult;

mod embedded {
    refinery::embed_migrations!("./migrations");
}

pub fn open(path: &Path) -> AppResult<Connection> {
    // Honor a staged restore from the backup feature: if a `restore.pending.sqlite3`
    // sits next to the live DB, swap it in before opening.
    //
    // CRITICAL: SQLite in WAL mode keeps two sidecar files next to the main DB —
    //   <name>-wal  (write-ahead log of pending pages)
    //   <name>-shm  (shared-memory index for the WAL)
    // Those sidecars are tied to the live DB by header salt. If we replace the
    // main file but leave the sidecars behind, the next process to open the DB
    // sees a salt mismatch and behaves undefined-ly (in practice: appears empty,
    // can corrupt). So whenever we swap the main file we MUST also remove the
    // old WAL/SHM sidecars and the SAME for the file we're promoting in.
    if let Some(parent) = path.parent() {
        let staged = parent.join("restore.pending.sqlite3");
        if staged.exists() {
            log::info!("restoring database from {}", staged.display());
            // Best-effort: archive the current DB first so the user can recover from a bad restore.
            if path.exists() {
                let archived = parent.join(format!(
                    "budget.pre-restore-{}.sqlite3",
                    chrono::Local::now().format("%Y%m%d-%H%M%S")
                ));
                let _ = std::fs::rename(path, &archived);
            }
            // Remove the WAL/SHM sidecars of the (now-archived) live DB — they're
            // tied to its header and would mismatch the file we're about to swap in.
            let wal = sidecar(path, "-wal");
            let shm = sidecar(path, "-shm");
            let _ = std::fs::remove_file(&wal);
            let _ = std::fs::remove_file(&shm);
            // Also clear any sidecars that might have been written next to the
            // staged file (the file the user picked is generally a clean
            // VACUUM INTO snapshot with no WAL, but be defensive).
            let staged_wal = sidecar(&staged, "-wal");
            let staged_shm = sidecar(&staged, "-shm");
            let _ = std::fs::remove_file(&staged_wal);
            let _ = std::fs::remove_file(&staged_shm);
            // Promote the staged file to be the new live DB.
            std::fs::rename(&staged, path)?;
        }
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(conn)
}

fn sidecar(path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    std::path::PathBuf::from(s)
}

pub fn run_migrations(conn: &mut Connection) -> AppResult<()> {
    embedded::migrations::runner().run(conn)?;
    Ok(())
}

pub fn seed_if_empty(conn: &Connection) -> AppResult<()> {
    let cat_count: i64 = conn.query_row("SELECT COUNT(*) FROM category", [], |r| r.get(0))?;
    if cat_count == 0 {
        seed_categories(conn)?;
    }
    let acc_count: i64 = conn.query_row("SELECT COUNT(*) FROM account", [], |r| r.get(0))?;
    if acc_count == 0 {
        seed_accounts(conn)?;
    }
    let sched_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM pay_period_schedule", [], |r| r.get(0))?;
    if sched_count == 0 {
        seed_pay_period_schedule(conn)?;
    }
    Ok(())
}

fn seed_categories(conn: &Connection) -> AppResult<()> {
    // Protected: Transfer and Income. Anything categorized "Transfer" is excluded
    // from spending dashboards and forecasts. "Income" is the default for inbound
    // money during CSV import when no rule matches.
    conn.execute(
        "INSERT INTO category (name, parent_id, is_protected, is_income, color) VALUES (?, NULL, 1, 0, ?)",
        rusqlite::params!["Transfer", "#888888"],
    )?;
    conn.execute(
        "INSERT INTO category (name, parent_id, is_protected, is_income, color) VALUES (?, NULL, 1, 1, ?)",
        rusqlite::params!["Income", "#34c759"],
    )?;

    // Seeded from Ben's prior app taxonomy. Fully editable later.
    let parents: &[(&str, bool, &str)] = &[
        ("Bills", false, "#ff9500"),
        ("Groceries", false, "#30d158"),
        ("Restaurants", false, "#ff453a"),
        ("Gas", false, "#5e5ce6"),
        ("Giving", false, "#bf5af2"),
        ("Ben Spending", false, "#0a84ff"),
        ("Sarah Spending", false, "#ff375f"),
        ("Rhys", false, "#ff9f0a"),
        ("Sophia", false, "#64d2ff"),
        ("Medical", false, "#ff6b6b"),
        ("Shopping", false, "#a78bfa"),
        ("Insurance", false, "#94a3b8"),
        ("Auto", false, "#f97316"),
        ("Other", false, "#9ca3af"),
    ];
    for (name, _is_income, color) in parents {
        conn.execute(
            "INSERT INTO category (name, parent_id, is_protected, is_income, color) VALUES (?, NULL, 0, 0, ?)",
            rusqlite::params![name, color],
        )?;
    }

    let bills_id: i64 =
        conn.query_row("SELECT id FROM category WHERE name = 'Bills'", [], |r| r.get(0))?;
    let bills_subs = [
        "AT&T / Phone",
        "Electricity",
        "Internet",
        "Water",
        "Streaming",
        "Mortgage / Rent",
    ];
    for s in bills_subs {
        conn.execute(
            "INSERT INTO category (name, parent_id, is_protected, is_income, color) VALUES (?, ?, 0, 0, NULL)",
            rusqlite::params![s, bills_id],
        )?;
    }
    Ok(())
}

fn seed_accounts(conn: &Connection) -> AppResult<()> {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let rows: &[(&str, &str)] = &[
        ("Bank Account", "checking"),
        ("Credit Card", "credit"),
        ("Savings", "savings"),
    ];
    for (i, (name, kind)) in rows.iter().enumerate() {
        conn.execute(
            "INSERT INTO account (name, kind, opening_balance, opening_date, display_order) VALUES (?, ?, 0, ?, ?)",
            rusqlite::params![name, kind, today, i as i64],
        )?;
    }
    Ok(())
}

fn seed_pay_period_schedule(conn: &Connection) -> AppResult<()> {
    // Default: semimonthly on 15th and last day of month. We backdate effective_from
    // to a far-past sentinel so historical reporting and budget lookups for any past
    // date "just work" — the pay-period math doesn't change under a backdated start.
    conn.execute(
        "INSERT INTO pay_period_schedule (effective_from, effective_to, cadence_kind, anchor_date, day_of_month_1, day_of_month_2, day_of_month, custom_dates_json) \
         VALUES ('2000-01-01', NULL, 'semimonthly', NULL, 15, -1, NULL, NULL)",
        [],
    )?;
    Ok(())
}
