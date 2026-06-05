use chrono::NaiveDate;

use super::{ParseError, ParsedFile, ParsedRow};

pub fn parse(content: &str) -> Result<ParsedFile, ParseError> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(content.as_bytes());
    let headers = rdr.headers()?.clone();
    let idx = |name: &str| -> Option<usize> {
        headers.iter().position(|h| h.trim().eq_ignore_ascii_case(name))
    };
    let i_date = idx("Transaction Date").ok_or_else(|| ParseError::Other("missing Transaction Date".into()))?;
    let i_desc = idx("Description").ok_or_else(|| ParseError::Other("missing Description".into()))?;
    let i_merchant = idx("Merchant");
    let i_cat = idx("Category");
    let i_type = idx("Type");
    let i_amount = idx("Amount (USD)").ok_or_else(|| ParseError::Other("missing Amount (USD)".into()))?;
    let i_by = idx("Purchased By");

    let mut rows: Vec<ParsedRow> = Vec::new();
    for result in rdr.records() {
        let rec = result?;
        let raw_date = rec.get(i_date).unwrap_or("").trim();
        if raw_date.is_empty() {
            continue;
        }
        let date = NaiveDate::parse_from_str(raw_date, "%m/%d/%Y")?
            .format("%Y-%m-%d")
            .to_string();
        let desc_raw = rec.get(i_desc).unwrap_or("").trim().to_string();
        let merchant = i_merchant
            .and_then(|i| rec.get(i))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| desc_raw.clone());
        let txn_type = i_type.and_then(|i| rec.get(i)).unwrap_or("").trim().to_string();
        let hint_cat = i_cat
            .and_then(|i| rec.get(i))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let purchased_by = i_by
            .and_then(|i| rec.get(i))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let amt_str = rec.get(i_amount).unwrap_or("0").replace(',', "").replace('$', "");
        let raw_amount: f64 = amt_str.parse().map_err(|e: std::num::ParseFloatError| ParseError::Other(e.to_string()))?;
        // Apple Card convention: positive=purchase (outflow), negative=payment (inflow on the card).
        // Our convention on the CREDIT card account: purchases reduce available balance
        // (we store as negative). Payments increase balance (we store as positive).
        let signed = -raw_amount;
        let is_transfer = txn_type.eq_ignore_ascii_case("Payment")
            || desc_raw.to_uppercase().contains("ACH DEPOSIT INTERNET TRANSFER")
            || hint_cat.as_deref().map(|s| s.eq_ignore_ascii_case("Payment")).unwrap_or(false);

        // Prefer the Merchant column over the raw description — it's already a
        // clean human name like "Texas Roadhouse" instead of the long
        // address-laden raw line.
        let description = if !merchant.is_empty() {
            merchant
        } else {
            simplify_raw(&desc_raw)
        };
        rows.push(ParsedRow {
            date,
            description,
            amount: signed,
            is_transfer,
            hint_category: hint_cat,
            purchased_by,
        });
    }

    Ok(ParsedFile {
        format: "apple_card".into(),
        account_hint: "Apple Card".into(),
        beginning_balance: None,
        beginning_balance_date: None,
        rows,
    })
}

fn simplify_raw(raw: &str) -> String {
    // Take everything before the first sequence of digits — bank descriptions
    // typically lead with a merchant name then a store number / address.
    let cut = raw.find(|c: char| c.is_ascii_digit()).unwrap_or(raw.len());
    raw[..cut].trim().to_string()
}
