use std::collections::HashMap;

use chrono::{Datelike, NaiveDate};
use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::AppState;

#[derive(Debug, Serialize)]
pub struct AccountCard {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub current_balance: f64,
}

#[derive(Debug, Serialize)]
pub struct CategoryBreakdown {
    pub category_id: Option<i64>,
    pub category_name: String,
    pub spent: f64,
}

#[derive(Debug, Serialize)]
pub struct DashboardSummary {
    pub accounts: Vec<AccountCard>,
    pub net_worth: f64,
    pub month_to_date_spent: f64,
    pub month_to_date_income: f64,
    pub categories: Vec<CategoryBreakdown>,
}

#[tauri::command]
pub fn dashboard_summary(state: State<AppState>, from: String, to: String) -> AppResult<DashboardSummary> {
    let conn = state.conn.lock();

    let mut acc_stmt = conn.prepare(
        "SELECT a.id, a.name, a.kind, a.opening_balance + COALESCE(SUM(t.amount),0) \
         FROM account a LEFT JOIN txn t ON t.account_id=a.id AND t.split_of_id IS NULL \
         WHERE a.archived = 0 \
         GROUP BY a.id ORDER BY a.display_order",
    )?;
    let accounts: Vec<AccountCard> = acc_stmt
        .query_map([], |r| {
            Ok(AccountCard {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                current_balance: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let net_worth: f64 = accounts.iter().map(|a| a.current_balance).sum();

    // Spend / income, excluding Transfer AND any savings-account activity
    // (interest, withdrawals, deposits). Savings is tracked separately and
    // shouldn't pollute the household income/spend totals.
    let spent: f64 = conn.query_row(
        "SELECT COALESCE(SUM(t.amount),0) FROM txn t \
         JOIN account a ON a.id = t.account_id \
         LEFT JOIN category c ON c.id=t.category_id \
         WHERE t.date BETWEEN ? AND ? AND t.split_of_id IS NULL \
           AND a.kind != 'savings' \
           AND (c.name IS NULL OR c.name != 'Transfer') AND t.amount < 0",
        rusqlite::params![from, to],
        |r| r.get(0),
    )?;
    let income: f64 = conn.query_row(
        "SELECT COALESCE(SUM(t.amount),0) FROM txn t \
         JOIN account a ON a.id = t.account_id \
         LEFT JOIN category c ON c.id=t.category_id \
         WHERE t.date BETWEEN ? AND ? AND t.split_of_id IS NULL \
           AND a.kind != 'savings' \
           AND (c.name IS NULL OR c.name != 'Transfer') AND t.amount > 0",
        rusqlite::params![from, to],
        |r| r.get(0),
    )?;

    let mut cat_stmt = conn.prepare(
        "SELECT t.category_id, COALESCE(c.name, '(uncategorized)') AS cname, SUM(t.amount) \
         FROM txn t \
         JOIN account a ON a.id = t.account_id \
         LEFT JOIN category c ON c.id=t.category_id \
         WHERE t.date BETWEEN ? AND ? AND t.split_of_id IS NULL \
           AND a.kind != 'savings' \
           AND t.amount < 0 \
           AND (c.name IS NULL OR c.name != 'Transfer') \
         GROUP BY t.category_id ORDER BY SUM(t.amount) ASC",
    )?;
    let categories: Vec<CategoryBreakdown> = cat_stmt
        .query_map(rusqlite::params![from, to], |r| {
            Ok(CategoryBreakdown {
                category_id: r.get(0)?,
                category_name: r.get(1)?,
                spent: r.get::<_, f64>(2)?.abs(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(DashboardSummary {
        accounts,
        net_worth,
        month_to_date_spent: spent.abs(),
        month_to_date_income: income,
        categories,
    })
}

#[derive(Debug, Serialize)]
pub struct MonthlyCashFlow {
    pub month: String, // YYYY-MM
    pub income: f64,
    pub expense: f64, // positive number representing the magnitude
}

#[tauri::command]
pub fn cash_flow_monthly(state: State<AppState>, months: u32) -> AppResult<Vec<MonthlyCashFlow>> {
    let conn = state.conn.lock();
    let today = chrono::Local::now().date_naive();
    let n = months.max(1) as i32;
    // Window starts at the 1st of (today - (n-1) months).
    let start = first_of_month_minus(today, (n - 1) as u32);
    let start_iso = start.format("%Y-%m-%d").to_string();

    // Same exclusions as dashboard_summary: skip Transfer category, skip
    // savings-account activity (its interest/withdrawals are tracked apart
    // from household income/spend), skip split parents.
    let mut stmt = conn.prepare(
        "SELECT strftime('%Y-%m', t.date) AS m, \
                COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 0) AS income, \
                COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0) AS expense \
         FROM txn t \
         JOIN account a ON a.id = t.account_id \
         LEFT JOIN category c ON c.id = t.category_id \
         WHERE t.date >= ? AND t.split_of_id IS NULL \
           AND a.kind != 'savings' \
           AND (c.name IS NULL OR c.name != 'Transfer') \
         GROUP BY m",
    )?;
    let mut by_month: HashMap<String, (f64, f64)> = HashMap::new();
    let rows = stmt.query_map(rusqlite::params![start_iso], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?, r.get::<_, f64>(2)?))
    })?;
    for row in rows {
        let (m, inc, exp) = row?;
        by_month.insert(m, (inc, exp));
    }

    // Densify: emit every month in the window even if it had no activity.
    let mut out = Vec::with_capacity(n as usize);
    for i in 0..n as u32 {
        let d = first_of_month_minus(today, n as u32 - 1 - i);
        let key = d.format("%Y-%m").to_string();
        let (income, expense) = by_month.get(&key).copied().unwrap_or((0.0, 0.0));
        out.push(MonthlyCashFlow { month: key, income, expense });
    }
    Ok(out)
}

#[derive(Debug, Serialize)]
pub struct MonthlyNetWorth {
    pub month: String, // YYYY-MM
    pub total: f64,
    pub checking: f64,
    pub savings: f64,
    pub credit: f64,
}

#[tauri::command]
pub fn net_worth_monthly(state: State<AppState>, months: u32) -> AppResult<Vec<MonthlyNetWorth>> {
    let conn = state.conn.lock();
    let today = chrono::Local::now().date_naive();
    let n = months.max(1) as i32;

    let mut out: Vec<MonthlyNetWorth> = Vec::with_capacity(n as usize);
    // For each month in the window, snapshot end-of-month balance per kind.
    // We use the last day of that month, or `today` for the current month so
    // the most recent point reflects the latest activity.
    for i in (0..n as u32).rev() {
        let first = first_of_month_minus(today, i);
        let last_of_that_month = next_month_first(first)
            .pred_opt()
            .expect("month always has a previous day");
        let as_of = if i == 0 { today } else { last_of_that_month };
        let as_of_iso = as_of.format("%Y-%m-%d").to_string();

        // Per-kind balance = sum across each account that existed by `as_of`
        // of (opening_balance + cumulative txn activity). Archived accounts
        // are still included for historical accuracy.
        let mut stmt = conn.prepare(
            "SELECT a.kind, COALESCE(SUM( \
                CASE WHEN a.opening_date <= ?1 \
                  THEN a.opening_balance + COALESCE(t.activity, 0) \
                  ELSE 0 END \
             ), 0) AS bal \
             FROM account a \
             LEFT JOIN ( \
               SELECT account_id, SUM(amount) AS activity FROM txn \
               WHERE date <= ?1 AND split_of_id IS NULL \
               GROUP BY account_id \
             ) t ON t.account_id = a.id \
             GROUP BY a.kind",
        )?;
        let mut by_kind: HashMap<String, f64> = HashMap::new();
        let rows = stmt.query_map(rusqlite::params![as_of_iso], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
        })?;
        for row in rows {
            let (k, v) = row?;
            by_kind.insert(k, v);
        }
        let checking = by_kind.get("checking").copied().unwrap_or(0.0);
        let savings = by_kind.get("savings").copied().unwrap_or(0.0);
        let credit = by_kind.get("credit").copied().unwrap_or(0.0);
        out.push(MonthlyNetWorth {
            month: first.format("%Y-%m").to_string(),
            total: checking + savings + credit,
            checking,
            savings,
            credit,
        });
    }
    Ok(out)
}

#[derive(Debug, Serialize)]
pub struct CategoryDrift {
    pub category_id: i64,
    pub category_name: String,
    pub current: f64,
    pub trailing_avg: f64,
    pub delta_abs: f64,
    pub delta_pct: Option<f64>, // None when trailing_avg is ~0
}

#[tauri::command]
pub fn category_drift(
    state: State<AppState>,
    period_start: String,
    period_end: String,
    trailing_periods: u32,
) -> AppResult<Vec<CategoryDrift>> {
    let conn = state.conn.lock();
    let start = NaiveDate::parse_from_str(&period_start, "%Y-%m-%d")?;
    let end = NaiveDate::parse_from_str(&period_end, "%Y-%m-%d")?;
    let n = trailing_periods.max(1);
    let span_days = (end - start).num_days();
    if span_days <= 0 {
        return Ok(Vec::new());
    }
    let trailing_start = start - chrono::Duration::days(span_days * n as i64);
    let start_iso = start.format("%Y-%m-%d").to_string();
    let end_iso = end.format("%Y-%m-%d").to_string();
    let trailing_start_iso = trailing_start.format("%Y-%m-%d").to_string();

    // One pass per category: sum spend (negative amounts, sign-flipped to
    // positive) in the current period and in the trailing window. Excludes
    // income categories, savings activity, transfers, and split parents.
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, \
                COALESCE(SUM(CASE WHEN t.date >= ?1 AND t.date < ?2 \
                                   AND a.kind != 'savings' \
                                   AND t.amount < 0 \
                                   AND t.split_of_id IS NULL \
                              THEN -t.amount ELSE 0 END), 0) AS current, \
                COALESCE(SUM(CASE WHEN t.date >= ?3 AND t.date < ?1 \
                                   AND a.kind != 'savings' \
                                   AND t.amount < 0 \
                                   AND t.split_of_id IS NULL \
                              THEN -t.amount ELSE 0 END), 0) AS trailing \
         FROM category c \
         LEFT JOIN txn t ON t.category_id = c.id \
         LEFT JOIN account a ON a.id = t.account_id \
         WHERE c.archived = 0 AND c.is_income = 0 AND c.name != 'Transfer' \
         GROUP BY c.id",
    )?;
    let rows = stmt.query_map(
        rusqlite::params![start_iso, end_iso, trailing_start_iso],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, f64>(3)?,
            ))
        },
    )?;
    let mut out: Vec<CategoryDrift> = Vec::new();
    for row in rows {
        let (id, name, current, trailing_total) = row?;
        let trailing_avg = trailing_total / n as f64;
        // Skip categories with no activity in either window — they're noise.
        if current < 0.005 && trailing_avg < 0.005 {
            continue;
        }
        let delta_abs = current - trailing_avg;
        let delta_pct = if trailing_avg.abs() > 0.005 {
            Some(delta_abs / trailing_avg)
        } else {
            None
        };
        out.push(CategoryDrift {
            category_id: id,
            category_name: name,
            current,
            trailing_avg,
            delta_abs,
            delta_pct,
        });
    }
    // Largest absolute drift first — most actionable signal at the top.
    out.sort_by(|a, b| b.delta_abs.abs().partial_cmp(&a.delta_abs.abs()).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

fn first_of_month_minus(today: NaiveDate, n: u32) -> NaiveDate {
    // Walk back n full months from the 1st of today's month.
    let mut y = today.year();
    let mut m = today.month() as i32;
    let mut left = n as i32;
    while left > 0 {
        m -= 1;
        if m < 1 {
            m = 12;
            y -= 1;
        }
        left -= 1;
    }
    NaiveDate::from_ymd_opt(y, m as u32, 1).expect("constructed first-of-month is valid")
}

fn next_month_first(d: NaiveDate) -> NaiveDate {
    let (y, m) = if d.month() == 12 {
        (d.year() + 1, 1)
    } else {
        (d.year(), d.month() + 1)
    };
    NaiveDate::from_ymd_opt(y, m, 1).expect("next-month-first is valid")
}
