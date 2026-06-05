use std::path::PathBuf;

use serde::Serialize;
use tauri::{Manager, State};

use crate::error::{AppError, AppResult};
use crate::AppState;

#[derive(Debug, Serialize)]
pub struct BackupFile {
    pub path: String,
    pub size: u64,
    pub modified: String,
}

fn default_backup_dir() -> AppResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("no home dir".into()))?;
    let p = home
        .join("Library")
        .join("Mobile Documents")
        .join("com~apple~CloudDocs")
        .join("family-budget-backups");
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

#[tauri::command]
pub fn create_backup(app: tauri::AppHandle, state: State<AppState>) -> AppResult<String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(e.to_string()))?;
    let live = app_data_dir.join("budget.sqlite3");
    if !live.exists() {
        return Err(AppError::Invalid("live db missing".into()));
    }
    let stamp = chrono::Local::now().format("%Y-%m-%d-%H-%M-%S");
    let backup_dir = default_backup_dir()?;
    let dest = backup_dir.join(format!("budget-{stamp}.sqlite3"));

    let conn = state.conn.lock();
    conn.execute("VACUUM INTO ?", rusqlite::params![dest.to_string_lossy()])?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn list_backups() -> AppResult<Vec<BackupFile>> {
    let dir = default_backup_dir()?;
    let mut out: Vec<BackupFile> = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("sqlite3") {
            continue;
        }
        let meta = entry.metadata()?;
        let modified = meta.modified()?;
        let dt: chrono::DateTime<chrono::Local> = modified.into();
        out.push(BackupFile {
            path: path.to_string_lossy().into_owned(),
            size: meta.len(),
            modified: dt.to_rfc3339(),
        });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

/// Stage a backup file as the new live DB on next launch.
/// We don't replace the file in place because the connection is open;
/// instead we copy it to `app_data_dir/restore.pending` and the app
/// detects this on startup, swaps it in, and removes the marker.
#[tauri::command]
pub fn restore_backup(app: tauri::AppHandle, source_path: String) -> AppResult<()> {
    validate_sqlite_file(&source_path)?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(e.to_string()))?;
    std::fs::create_dir_all(&app_data_dir)?;
    let staged = app_data_dir.join("restore.pending.sqlite3");
    std::fs::copy(&source_path, &staged)?;
    Ok(())
}

/// Sanity-check that the file the user picked actually looks like a SQLite database
/// before we stage it for next launch — otherwise the app would refuse to open and
/// leave the user stranded. This isn't bulletproof (it can't tell a foreign SQLite
/// file from one of ours), but it catches the common "wrong file" case.
fn validate_sqlite_file(path: &str) -> AppResult<()> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| {
        AppError::Invalid(format!("couldn't open file: {e}"))
    })?;
    let mut header = [0u8; 16];
    f.read_exact(&mut header).map_err(|_| {
        AppError::Invalid("file is too short to be a SQLite database".into())
    })?;
    const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";
    if &header != SQLITE_MAGIC {
        return Err(AppError::Invalid(
            "this doesn't look like a SQLite database file — pick a .sqlite3 backup".into(),
        ));
    }
    Ok(())
}
