use serde::{Deserialize, Serialize};

use super::ParseError;

/// Row from the previous app's export. The legacy CSV is a single file
/// spanning all three accounts, with categories already assigned and
/// split groups identified by a shared UUID in the SplitOf column.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyRow {
    pub date: String,          // already YYYY-MM-DD
    pub account: String,       // "Bank Account" | "Credit Card" | "Savings"
    pub title: String,         // may be prefixed with "↳ " for split children
    pub category: String,
    pub subcategory: String,
    pub type_: String,         // "income" | "expense"
    pub amount: f64,           // signed (positive = inflow)
    pub memo: String,
    pub cleared: bool,
    pub flagged: bool,
    pub split_of: String,      // UUID string; non-empty for any row in a split group
    pub is_split_child: bool,  // title starts with the "↳ " arrow
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyParsed {
    pub rows: Vec<LegacyRow>,
}

const SPLIT_CHILD_PREFIX: &str = "↳ ";

pub fn parse(content: &str) -> Result<LegacyParsed, ParseError> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(content.as_bytes());
    let headers = rdr.headers()?.clone();
    let idx = |name: &str| -> Option<usize> {
        headers.iter().position(|h| h.trim().eq_ignore_ascii_case(name))
    };
    let i_date = idx("Date").ok_or_else(|| ParseError::Other("missing Date".into()))?;
    let i_account = idx("Account").ok_or_else(|| ParseError::Other("missing Account".into()))?;
    let i_title = idx("Title").ok_or_else(|| ParseError::Other("missing Title".into()))?;
    let i_category = idx("Category").ok_or_else(|| ParseError::Other("missing Category".into()))?;
    let i_subcategory = idx("Subcategory").ok_or_else(|| ParseError::Other("missing Subcategory".into()))?;
    let i_type = idx("Type").ok_or_else(|| ParseError::Other("missing Type".into()))?;
    let i_amount = idx("Amount").ok_or_else(|| ParseError::Other("missing Amount".into()))?;
    let i_memo = idx("Memo").ok_or_else(|| ParseError::Other("missing Memo".into()))?;
    let i_cleared = idx("Cleared").ok_or_else(|| ParseError::Other("missing Cleared".into()))?;
    let i_flagged = idx("Flagged").ok_or_else(|| ParseError::Other("missing Flagged".into()))?;
    let i_split = idx("SplitOf").ok_or_else(|| ParseError::Other("missing SplitOf".into()))?;

    let mut rows: Vec<LegacyRow> = Vec::new();
    for result in rdr.records() {
        let rec = result?;
        let date = rec.get(i_date).unwrap_or("").trim().to_string();
        if date.is_empty() {
            continue;
        }
        let title = rec.get(i_title).unwrap_or("").trim().to_string();
        let amount_str = rec
            .get(i_amount)
            .unwrap_or("0")
            .replace(',', "")
            .replace('$', "");
        let amount: f64 = amount_str
            .parse()
            .map_err(|e: std::num::ParseFloatError| ParseError::Other(e.to_string()))?;
        let cleared = rec.get(i_cleared).unwrap_or("no").trim().eq_ignore_ascii_case("yes");
        let flagged = rec.get(i_flagged).unwrap_or("no").trim().eq_ignore_ascii_case("yes");
        let is_split_child = title.starts_with(SPLIT_CHILD_PREFIX);
        let clean_title = if is_split_child {
            title.trim_start_matches(SPLIT_CHILD_PREFIX).to_string()
        } else {
            title.clone()
        };
        rows.push(LegacyRow {
            date,
            account: rec.get(i_account).unwrap_or("").trim().to_string(),
            title: clean_title,
            category: rec.get(i_category).unwrap_or("").trim().to_string(),
            subcategory: rec.get(i_subcategory).unwrap_or("").trim().to_string(),
            type_: rec.get(i_type).unwrap_or("").trim().to_string(),
            amount,
            memo: rec.get(i_memo).unwrap_or("").trim().to_string(),
            cleared,
            flagged,
            split_of: rec.get(i_split).unwrap_or("").trim().to_string(),
            is_split_child,
        });
    }
    Ok(LegacyParsed { rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "Date,Account,Title,Category,Subcategory,Type,Amount,Memo,Cleared,Flagged,SplitOf";

    #[test]
    fn parses_split_group() {
        let content = format!(
            "{HEADER}\n\
            2026-05-11,Bank Account,HEALTHEQUITY,Income,,income,168.50,umbrella,yes,no,uuid-1\n\
            2026-05-11,Bank Account,↳ HEALTHEQUITY,Income,,income,39.50,piece a,yes,no,uuid-1\n\
            2026-05-11,Bank Account,↳ HEALTHEQUITY,Income,,income,129.00,piece b,yes,no,uuid-1"
        );
        let p = parse(&content).expect("parse");
        assert_eq!(p.rows.len(), 3);
        assert!(!p.rows[0].is_split_child);
        assert!(p.rows[1].is_split_child);
        assert!(p.rows[2].is_split_child);
        assert_eq!(p.rows[0].split_of, "uuid-1");
        // Children's title arrows are stripped.
        assert_eq!(p.rows[1].title, "HEALTHEQUITY");
    }
}
