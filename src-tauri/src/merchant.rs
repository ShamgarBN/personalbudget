use rusqlite::Connection;

use crate::error::AppResult;

/// Normalize a merchant string for matching. Uppercases, removes digits,
/// collapses whitespace, strips common location/store-number suffixes.
pub fn normalize(raw: &str) -> String {
    let upper = raw.to_uppercase();
    let mut buf = String::with_capacity(upper.len());
    let mut prev_space = false;
    for ch in upper.chars() {
        if ch.is_ascii_digit() || ch == '#' || ch == '*' {
            if !prev_space {
                buf.push(' ');
                prev_space = true;
            }
            continue;
        }
        if ch.is_alphabetic() {
            buf.push(ch);
            prev_space = false;
        } else if ch.is_whitespace() || ch == '/' || ch == '\\' || ch == '-' || ch == '.' || ch == ',' {
            if !prev_space {
                buf.push(' ');
                prev_space = true;
            }
        }
    }
    let trimmed = buf.trim().to_string();
    // Keep at most the first few tokens — bank descriptions trail location info.
    let tokens: Vec<&str> = trimmed.split_whitespace().take(4).collect();
    tokens.join(" ")
}

/// Try to find a category for a merchant-like description. We match by
/// longest pattern that the normalized description starts with.
pub fn match_category(conn: &Connection, description: &str) -> AppResult<Option<i64>> {
    let normalized = normalize(description);
    if normalized.is_empty() {
        return Ok(None);
    }
    let mut stmt = conn.prepare_cached(
        "SELECT pattern, category_id FROM merchant_map ORDER BY length(pattern) DESC, hits DESC",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let pattern: String = row.get(0)?;
        if normalized.starts_with(&pattern) {
            return Ok(Some(row.get(1)?));
        }
    }
    Ok(None)
}

/// Record a merchant -> category association (or bump usage).
pub fn record(conn: &Connection, description: &str, category_id: i64) -> AppResult<()> {
    let pattern = normalize(description);
    if pattern.is_empty() {
        return Ok(());
    }
    let now = chrono::Utc::now().to_rfc3339();
    let updated = conn.execute(
        "UPDATE merchant_map SET hits = hits + 1, category_id = ?, last_used_at = ? WHERE pattern = ?",
        rusqlite::params![category_id, now, pattern],
    )?;
    if updated == 0 {
        conn.execute(
            "INSERT INTO merchant_map (pattern, category_id, hits, last_used_at) VALUES (?, ?, 1, ?)",
            rusqlite::params![pattern, category_id, now],
        )?;
    }
    Ok(())
}
