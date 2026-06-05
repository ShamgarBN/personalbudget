use chrono::NaiveDate;

use super::{ParseError, ParsedFile, ParsedRow};

/// Parser for Capital One 360 Savings CSV exports.
/// Header: `Account Number,Transaction Description,Transaction Date,Transaction Type,Transaction Amount,Balance`.
/// Dates are MM/DD/YY; amounts are always positive (sign derived from the Credit/Debit Type column).
pub fn parse(content: &str) -> Result<ParsedFile, ParseError> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(content.as_bytes());
    let headers = rdr.headers()?.clone();
    let idx = |name: &str| -> Option<usize> {
        headers.iter().position(|h| h.trim().eq_ignore_ascii_case(name))
    };
    let i_desc = idx("Transaction Description").ok_or_else(|| ParseError::Other("missing Transaction Description".into()))?;
    let i_date = idx("Transaction Date").ok_or_else(|| ParseError::Other("missing Transaction Date".into()))?;
    let i_type = idx("Transaction Type").ok_or_else(|| ParseError::Other("missing Transaction Type".into()))?;
    let i_amount = idx("Transaction Amount").ok_or_else(|| ParseError::Other("missing Transaction Amount".into()))?;

    let mut rows: Vec<ParsedRow> = Vec::new();
    for result in rdr.records() {
        let rec = result?;
        let raw_date = rec.get(i_date).unwrap_or("").trim();
        if raw_date.is_empty() {
            continue;
        }
        // Savings uses MM/DD/YY rather than MM/DD/YYYY.
        let parsed_date = NaiveDate::parse_from_str(raw_date, "%m/%d/%y")
            .or_else(|_| NaiveDate::parse_from_str(raw_date, "%m/%d/%Y"))?;
        let date_iso = parsed_date.format("%Y-%m-%d").to_string();
        let desc = rec.get(i_desc).unwrap_or("").trim().to_string();
        let txn_type = rec.get(i_type).unwrap_or("").trim();
        let amt_str = rec
            .get(i_amount)
            .unwrap_or("0")
            .replace(',', "")
            .replace('$', "");
        let raw_amount: f64 = amt_str
            .parse()
            .map_err(|e: std::num::ParseFloatError| ParseError::Other(e.to_string()))?;
        let signed = if txn_type.eq_ignore_ascii_case("Debit") {
            -raw_amount.abs()
        } else {
            raw_amount.abs()
        };
        let desc_up = desc.to_uppercase();
        let is_transfer = desc_up.contains("PREAUTHORIZED DEPOSIT FROM BANK OF AMERICA")
            || desc_up.contains("PREAUTHORIZED WITHDRAWAL TO BANK OF AMERICA");

        rows.push(ParsedRow {
            date: date_iso,
            description: super::bofa_checking::simplify_bofa(&desc),
            amount: signed,
            is_transfer,
            hint_category: None,
            purchased_by: None,
        });
    }

    Ok(ParsedFile {
        format: "capital_one_savings".into(),
        account_hint: "Savings".into(),
        beginning_balance: None,
        beginning_balance_date: None,
        rows,
    })
}
