use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::State;

use crate::error::AppResult;
use crate::AppState;

#[derive(Debug, Serialize)]
pub struct ExportResult {
    pub path: String,
    pub tables: Vec<String>,
}

#[tauri::command]
pub fn export_json(state: State<AppState>, path: String) -> AppResult<ExportResult> {
    let conn = state.conn.lock();
    let tables = [
        "account",
        "category",
        "txn",
        "pay_period_schedule",
        "budget_allocation",
        "recurring_bill",
        "goal",
        "merchant_map",
        "import_batch",
    ];
    let mut payload = Map::new();
    payload.insert("schema_version".into(), json!(1));
    payload.insert("exported_at".into(), json!(chrono::Utc::now().to_rfc3339()));
    for t in &tables {
        let rows = dump_table(&conn, t)?;
        payload.insert((*t).to_string(), Value::Array(rows));
    }
    let json_str = serde_json::to_string_pretty(&Value::Object(payload))?;
    std::fs::write(&path, json_str)?;
    Ok(ExportResult {
        path,
        tables: tables.iter().map(|s| s.to_string()).collect(),
    })
}

fn dump_table(conn: &rusqlite::Connection, table: &str) -> AppResult<Vec<Value>> {
    let sql = format!("SELECT * FROM {table}");
    let mut stmt = conn.prepare(&sql)?;
    let col_names: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();
    let mut out: Vec<Value> = Vec::new();
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let mut obj = Map::new();
        for (i, name) in col_names.iter().enumerate() {
            let val: rusqlite::types::Value = row.get(i)?;
            obj.insert(name.clone(), sqlite_to_json(val));
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}

fn sqlite_to_json(v: rusqlite::types::Value) -> Value {
    match v {
        rusqlite::types::Value::Null => Value::Null,
        rusqlite::types::Value::Integer(i) => json!(i),
        rusqlite::types::Value::Real(f) => json!(f),
        rusqlite::types::Value::Text(s) => Value::String(s),
        rusqlite::types::Value::Blob(b) => json!(hex::encode(b)),
    }
}
