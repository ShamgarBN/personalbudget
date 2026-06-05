pub mod apple_card;
pub mod bofa_checking;
pub mod capital_one_savings;
pub mod legacy_app;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedRow {
    pub date: String, // ISO YYYY-MM-DD
    pub description: String,
    pub amount: f64, // signed: negative = outflow
    pub is_transfer: bool,
    pub hint_category: Option<String>, // bank-supplied category like Apple Card's
    pub purchased_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedFile {
    pub format: String, // "apple_card" | "bofa_checking" | "bofa_savings"
    pub account_hint: String,
    pub beginning_balance: Option<f64>,
    pub beginning_balance_date: Option<String>,
    pub rows: Vec<ParsedRow>,
}

#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    #[error("unrecognized CSV format")]
    UnknownFormat,
    #[error("csv error: {0}")]
    Csv(#[from] csv::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("date parse: {0}")]
    Date(#[from] chrono::ParseError),
    #[error("parse error: {0}")]
    Other(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_sample(name: &str) -> Option<String> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("sample-data")
            .join(name);
        std::fs::read_to_string(&path).ok()
    }

    #[test]
    fn parses_apple_card_export() {
        let Some(content) = read_sample("Credit Card Export.csv") else {
            eprintln!("sample-data not present; skipping");
            return;
        };
        let p = detect_and_parse(&content).expect("apple card parse");
        assert_eq!(p.format, "apple_card");
        assert!(p.rows.len() > 100, "expected many rows, got {}", p.rows.len());
        let transfers = p.rows.iter().filter(|r| r.is_transfer).count();
        assert!(transfers >= 1, "expected at least one Payment row");
        // All rows should have an ISO date.
        for r in &p.rows {
            assert!(
                r.date.len() == 10 && r.date.chars().nth(4) == Some('-'),
                "bad date {}",
                r.date
            );
        }
    }

    #[test]
    fn parses_bofa_checking_export() {
        let Some(content) = read_sample("Joint Checking Account export.csv") else {
            eprintln!("sample-data not present; skipping");
            return;
        };
        let p = detect_and_parse(&content).expect("bofa checking parse");
        assert_eq!(p.format, "bofa_checking");
        assert!(p.beginning_balance.is_some(), "should capture opening balance");
        assert!(p.beginning_balance_date.is_some());
        let transfers = p.rows.iter().filter(|r| r.is_transfer).count();
        assert!(transfers >= 1, "expected at least one Apple Card payment");
    }

    #[test]
    fn parses_capital_one_savings_export() {
        let Some(content) = read_sample("Savings Account Export.csv") else {
            eprintln!("sample-data not present; skipping");
            return;
        };
        let p = detect_and_parse(&content).expect("savings parse");
        assert_eq!(p.format, "capital_one_savings");
        assert!(!p.rows.is_empty());
        // Debits should be negative, Credits positive.
        for r in &p.rows {
            // Monthly interest is positive
            if r.description.contains("Monthly Interest") {
                assert!(r.amount > 0.0, "interest should be positive");
            }
        }
    }
}

/// Detect which parser to use by sniffing the header line(s).
pub fn detect_and_parse(content: &str) -> Result<ParsedFile, ParseError> {
    let head: String = content.lines().take(10).collect::<Vec<_>>().join("\n");
    let head_upper = head.to_uppercase();

    if head_upper.contains("TRANSACTION DATE") && head_upper.contains("CLEARING DATE") && head_upper.contains("MERCHANT") {
        apple_card::parse(content)
    } else if head_upper.contains("RUNNING BAL") {
        bofa_checking::parse(content)
    } else if head_upper.contains("ACCOUNT NUMBER") && head_upper.contains("TRANSACTION TYPE") {
        capital_one_savings::parse(content)
    } else {
        Err(ParseError::UnknownFormat)
    }
}
