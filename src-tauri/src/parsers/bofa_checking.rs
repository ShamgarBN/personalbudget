use chrono::NaiveDate;

use super::{ParseError, ParsedFile, ParsedRow};

/// BoA checking CSVs lead with a balance summary block (Description, Summary Amt),
/// a blank line, then a transactions header row "Date,Description,Amount,Running Bal.".
/// The first transactions row repeats "Beginning balance as of ..." which we capture.
pub fn parse(content: &str) -> Result<ParsedFile, ParseError> {
    // The summary block confuses csv::Reader because it has different column counts.
    // Split into "before the transactions header" and the table itself.
    let mut header_line_idx: Option<usize> = None;
    for (i, line) in content.lines().enumerate() {
        let l = line.trim();
        if l.eq_ignore_ascii_case("Date,Description,Amount,Running Bal.") {
            header_line_idx = Some(i);
            break;
        }
    }
    let header_idx = header_line_idx.ok_or_else(|| ParseError::Other("transactions header not found".into()))?;
    let table_text: String = content.lines().skip(header_idx).collect::<Vec<_>>().join("\n");

    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(table_text.as_bytes());

    let mut beginning_balance: Option<f64> = None;
    let mut beginning_balance_date: Option<String> = None;
    let mut rows: Vec<ParsedRow> = Vec::new();

    for result in rdr.records() {
        let rec = result?;
        let raw_date = rec.get(0).unwrap_or("").trim();
        let raw_desc = rec.get(1).unwrap_or("").trim();
        let raw_amount = rec.get(2).unwrap_or("").trim();
        if raw_date.is_empty() {
            continue;
        }
        let date_iso = NaiveDate::parse_from_str(raw_date, "%m/%d/%Y")?
            .format("%Y-%m-%d")
            .to_string();

        // The "Beginning balance" row has no amount but does have a running balance.
        if raw_desc.starts_with("Beginning balance") {
            if let Some(running) = rec.get(3) {
                let cleaned = running.trim().replace(',', "").replace('"', "");
                if let Ok(b) = cleaned.parse::<f64>() {
                    beginning_balance = Some(b);
                    beginning_balance_date = Some(date_iso.clone());
                }
            }
            continue;
        }
        if raw_amount.is_empty() {
            continue;
        }
        let cleaned_amount = raw_amount.replace(',', "").replace('"', "");
        let amount: f64 = cleaned_amount
            .parse()
            .map_err(|e: std::num::ParseFloatError| ParseError::Other(e.to_string()))?;
        let desc_up = raw_desc.to_uppercase();
        let is_transfer = desc_up.contains("APPLECARD GSBANK DES:PAYMENT")
            || desc_up.contains("ONLINE BANKING TRANSFER TO")
            || desc_up.contains("ONLINE BANKING TRANSFER FROM");

        rows.push(ParsedRow {
            date: date_iso,
            description: simplify_bofa(raw_desc),
            amount,
            is_transfer,
            hint_category: None,
            purchased_by: None,
        });
    }

    Ok(ParsedFile {
        format: "bofa_checking".into(),
        account_hint: "Bank Account".into(),
        beginning_balance,
        beginning_balance_date,
        rows,
    })
}

/// Strip BoA's machine-readable markers from a transaction description.
/// Examples that get cleaned:
///   "JPMorgan Chase DES:Ext Trnsfr ID:28428404829 INDN:SARAH NIEMANN CO ID:9200502231 WEB"
///   → "JPMorgan Chase"
///   "FOCUS ON THE FAMILY 04/14 PURCHASE 719-5313400 CO"
///   → "FOCUS ON THE FAMILY"
///   "APPLECARD GSBANK DES:PAYMENT ID:1042516 INDN:Sarah Niemann CO ID:9999999999 WEB"
///   → "APPLECARD GSBANK"
pub(crate) fn simplify_bofa(raw: &str) -> String {
    let mut out = raw.to_string();
    // Cut at the first machine marker.
    for marker in [
        " DES:",
        " ID:",
        " INDN:",
        " CO ID:",
        " PURCHASE ",
        " MOBILE PURCHASE",
        " WEB",
        " ACH ",
        " PPD",
    ] {
        if let Some(idx) = out.find(marker) {
            out = out[..idx].trim().to_string();
        }
    }
    // Cut at the first MM/DD-style date fragment.
    let bytes = out.as_bytes();
    for i in 0..bytes.len().saturating_sub(4) {
        if bytes[i] == b' '
            && bytes[i + 1].is_ascii_digit()
            && bytes[i + 2].is_ascii_digit()
            && bytes[i + 3] == b'/'
            && bytes[i + 4].is_ascii_digit()
        {
            out = out[..i].trim().to_string();
            break;
        }
    }
    out.trim().to_string()
}
