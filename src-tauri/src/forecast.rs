use std::collections::HashMap;

use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::models::{PayPeriod, PayPeriodSchedule};
use crate::pay_period;

#[derive(Debug, Clone, Deserialize)]
pub struct ForecastOverlay {
    pub date: String,
    pub amount: f64,
    pub account_id: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ForecastArgs {
    pub horizon_days: i64,
    #[serde(default)]
    pub overlays: Vec<ForecastOverlay>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DailyBalance {
    pub date: String,
    pub account_balances: HashMap<i64, f64>,
    pub net_worth: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PayPeriodProjection {
    pub start: String,
    pub end: String,
    pub label: String,
    pub projected_income: f64,
    pub projected_bills: f64,
    pub projected_discretionary: f64,
    pub projected_leftover: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CategoryTrajectory {
    pub category_id: Option<i64>,
    pub category_name: String,
    pub spent_to_date: f64,
    pub projected_period_total: f64,
    pub allocated: Option<f64>,
    pub over_under: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ForecastResult {
    pub start_date: String,
    pub end_date: String,
    pub daily: Vec<DailyBalance>,
    pub pay_periods: Vec<PayPeriodProjection>,
    pub categories: Vec<CategoryTrajectory>,
}

const TRAILING_DAYS: i64 = 90;

pub fn run(conn: &Connection, args: ForecastArgs) -> AppResult<ForecastResult> {
    let today = chrono::Local::now().date_naive();
    let end = today + Duration::days(args.horizon_days.max(1));

    let accounts: Vec<(i64, f64)> = {
        let mut stmt = conn.prepare(
            "SELECT a.id, a.opening_balance + COALESCE(SUM(t.amount),0) \
             FROM account a LEFT JOIN txn t ON t.account_id=a.id AND t.split_of_id IS NULL AND t.date <= ? \
             WHERE a.archived = 0 \
             GROUP BY a.id ORDER BY a.display_order",
        )?;
        let rows: Vec<(i64, f64)> = stmt
            .query_map(rusqlite::params![today.format("%Y-%m-%d").to_string()], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };

    let (avg_daily_income, avg_daily_discretionary, recent_paycheck) =
        trailing_averages(conn, today, TRAILING_DAYS)?;

    let bills = load_recurring_bills(conn)?;

    let mut daily = Vec::with_capacity(args.horizon_days as usize + 1);
    let mut running: HashMap<i64, f64> = accounts.iter().cloned().collect();
    let mut cursor = today;
    while cursor <= end {
        // Recurring bills hitting today
        for b in &bills {
            if bill_hits_on(b, cursor, today) {
                if let Some(bal) = running.get_mut(&b.account_id) {
                    // amount is signed: negative = expense, positive = income.
                    *bal += b.amount;
                }
            }
        }

        // Pay-schedule income on payday
        if let Ok((s, _)) = active_schedule_period(conn, cursor) {
            if is_payday(&s, cursor)? {
                if let Some(primary) = accounts.first() {
                    let amt = if recent_paycheck > 0.0 {
                        recent_paycheck
                    } else {
                        avg_daily_income * 14.0
                    };
                    if let Some(bal) = running.get_mut(&primary.0) {
                        *bal += amt;
                    }
                }
            }
        }

        // Discretionary trickle from the primary checking
        if let Some(primary) = accounts.first() {
            if let Some(bal) = running.get_mut(&primary.0) {
                *bal -= avg_daily_discretionary;
            }
        }

        // Apply user overlays for this date
        for ov in &args.overlays {
            if let Ok(d) = NaiveDate::parse_from_str(&ov.date, "%Y-%m-%d") {
                if d == cursor {
                    if let Some(bal) = running.get_mut(&ov.account_id) {
                        *bal += ov.amount;
                    }
                }
            }
        }

        let net = running.values().sum::<f64>();
        daily.push(DailyBalance {
            date: cursor.format("%Y-%m-%d").to_string(),
            account_balances: running.clone(),
            net_worth: net,
        });
        cursor += Duration::days(1);
    }

    let schedules = load_schedules(conn)?;
    let raw_periods = pay_period::generate(
        &schedules,
        today,
        end,
    )?;
    let pp = build_pay_period_projections(
        conn,
        &raw_periods,
        avg_daily_income,
        avg_daily_discretionary,
        &bills,
        today,
    )?;
    let cats = build_category_trajectories(conn, today)?;

    Ok(ForecastResult {
        start_date: today.format("%Y-%m-%d").to_string(),
        end_date: end.format("%Y-%m-%d").to_string(),
        daily,
        pay_periods: pp,
        categories: cats,
    })
}

fn trailing_averages(conn: &Connection, today: NaiveDate, n_days: i64) -> AppResult<(f64, f64, f64)> {
    let from = today - Duration::days(n_days);
    let from_s = from.format("%Y-%m-%d").to_string();
    let to_s = today.format("%Y-%m-%d").to_string();

    // Trailing averages explicitly exclude savings-account activity; those
    // flows aren't household income or spending, just balance moves.
    let total_income: f64 = conn.query_row(
        "SELECT COALESCE(SUM(t.amount),0) FROM txn t \
         JOIN account a ON a.id = t.account_id \
         LEFT JOIN category c ON c.id=t.category_id \
         WHERE t.date BETWEEN ? AND ? AND t.split_of_id IS NULL \
           AND a.kind != 'savings' \
           AND t.amount > 0 AND (c.name IS NULL OR c.name != 'Transfer')",
        rusqlite::params![from_s, to_s],
        |r| r.get(0),
    )?;
    let total_disc: f64 = conn.query_row(
        "SELECT COALESCE(SUM(ABS(t.amount)),0) FROM txn t \
         JOIN account a ON a.id = t.account_id \
         LEFT JOIN category c ON c.id=t.category_id \
         WHERE t.date BETWEEN ? AND ? AND t.split_of_id IS NULL \
           AND a.kind != 'savings' \
           AND t.amount < 0 AND (c.name IS NULL OR c.name != 'Transfer')",
        rusqlite::params![from_s, to_s],
        |r| r.get(0),
    )?;
    let recent_paycheck: f64 = conn.query_row(
        "SELECT COALESCE(AVG(t.amount),0) FROM txn t \
         JOIN account a ON a.id=t.account_id \
         LEFT JOIN category c ON c.id=t.category_id \
         WHERE t.date BETWEEN ? AND ? AND t.split_of_id IS NULL \
           AND t.amount > 1000 AND a.kind='checking' \
           AND (c.name IS NULL OR c.name != 'Transfer')",
        rusqlite::params![from_s, to_s],
        |r| r.get(0),
    )?;
    let days = n_days as f64;
    Ok((total_income / days, total_disc / days, recent_paycheck))
}

#[derive(Debug, Clone)]
struct Bill {
    pub account_id: i64,
    pub amount: f64,
    pub cadence_kind: String,
    pub day_of_month: Option<i64>,
    pub anchor_date: Option<String>,
    pub interval_days: Option<i64>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

fn load_recurring_bills(conn: &Connection) -> AppResult<Vec<Bill>> {
    let mut stmt = conn.prepare(
        "SELECT account_id, amount, cadence_kind, day_of_month, anchor_date, interval_days, start_date, end_date \
         FROM recurring_bill WHERE active = 1",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Bill {
                account_id: r.get(0)?,
                amount: r.get(1)?,
                cadence_kind: r.get(2)?,
                day_of_month: r.get(3)?,
                anchor_date: r.get(4)?,
                interval_days: r.get(5)?,
                start_date: r.get(6)?,
                end_date: r.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn bill_hits_on(bill: &Bill, on: NaiveDate, from: NaiveDate) -> bool {
    if on < from {
        return false;
    }
    // Respect start/end dates if set.
    if let Some(s) = bill.start_date.as_deref().and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()) {
        if on < s {
            return false;
        }
    }
    if let Some(e) = bill.end_date.as_deref().and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()) {
        if on > e {
            return false;
        }
    }
    match bill.cadence_kind.as_str() {
        "monthly" => bill.day_of_month.map_or(false, |d| on.day() as i64 == clamp_day(on, d)),
        "quarterly" => {
            // Hits every 3 months on day_of_month, anchored to first month of year.
            bill.day_of_month
                .map_or(false, |d| on.day() as i64 == clamp_day(on, d) && [1, 4, 7, 10].contains(&(on.month() as i32)))
        }
        "semiannual" => bill
            .day_of_month
            .map_or(false, |d| on.day() as i64 == clamp_day(on, d) && [1, 7].contains(&(on.month() as i32))),
        "annual" => bill
            .day_of_month
            .map_or(false, |d| on.day() as i64 == clamp_day(on, d) && on.month() == 1),
        "weekly" => bill
            .anchor_date
            .as_deref()
            .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .map_or(false, |a| (on - a).num_days() % 7 == 0),
        "biweekly" => bill
            .anchor_date
            .as_deref()
            .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .map_or(false, |a| (on - a).num_days() % 14 == 0),
        "custom_days" => {
            // Every interval_days from the anchor (start_date is mirrored into
            // anchor_date on save). Guards against a zero/None interval.
            let step = bill.interval_days.unwrap_or(0);
            if step <= 0 {
                return false;
            }
            bill.anchor_date
                .as_deref()
                .or(bill.start_date.as_deref())
                .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
                .map_or(false, |a| {
                    let diff = (on - a).num_days();
                    diff >= 0 && diff % step == 0
                })
        }
        _ => false,
    }
}

fn clamp_day(date: NaiveDate, day: i64) -> i64 {
    // Returns the day-of-month a bill would hit this month, clamped to month length.
    let last = NaiveDate::from_ymd_opt(
        if date.month() == 12 { date.year() + 1 } else { date.year() },
        if date.month() == 12 { 1 } else { date.month() + 1 },
        1,
    )
    .unwrap()
    .pred_opt()
    .unwrap()
    .day() as i64;
    day.min(last)
}

fn active_schedule_period(conn: &Connection, on: NaiveDate) -> AppResult<(PayPeriodSchedule, (NaiveDate, NaiveDate))> {
    let schedules = load_schedules(conn)?;
    let on_s = on.format("%Y-%m-%d").to_string();
    let active = schedules
        .into_iter()
        .filter(|s| s.effective_from <= on_s)
        .filter(|s| match &s.effective_to {
            Some(t) => on_s < *t,
            None => true,
        })
        .max_by_key(|s| s.effective_from.clone())
        .ok_or_else(|| AppError::Invalid(format!("no schedule on {on}")))?;
    let pp = pay_period::period_containing(&active, on)?;
    Ok((active, pp))
}

fn load_schedules(conn: &Connection) -> AppResult<Vec<PayPeriodSchedule>> {
    let mut stmt = conn.prepare(
        "SELECT id, effective_from, effective_to, cadence_kind, anchor_date, day_of_month_1, day_of_month_2, day_of_month, custom_dates_json \
         FROM pay_period_schedule ORDER BY effective_from",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PayPeriodSchedule {
                id: r.get(0)?,
                effective_from: r.get(1)?,
                effective_to: r.get(2)?,
                cadence_kind: r.get(3)?,
                anchor_date: r.get(4)?,
                day_of_month_1: r.get(5)?,
                day_of_month_2: r.get(6)?,
                day_of_month: r.get(7)?,
                custom_dates_json: r.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn is_payday(schedule: &PayPeriodSchedule, on: NaiveDate) -> AppResult<bool> {
    match schedule.cadence_kind.as_str() {
        "semimonthly" => {
            let d1 = schedule.day_of_month_1.unwrap_or(1);
            let d2 = schedule.day_of_month_2.unwrap_or(-1);
            let actual_d2 = if d2 == -1 {
                NaiveDate::from_ymd_opt(
                    if on.month() == 12 { on.year() + 1 } else { on.year() },
                    if on.month() == 12 { 1 } else { on.month() + 1 },
                    1,
                )
                .unwrap()
                .pred_opt()
                .unwrap()
                .day() as i64
            } else {
                d2
            };
            Ok(on.day() as i64 == d1 || on.day() as i64 == actual_d2)
        }
        "monthly" => Ok(schedule.day_of_month.map_or(false, |d| on.day() as i64 == clamp_day(on, d))),
        "biweekly" => Ok(schedule
            .anchor_date
            .as_deref()
            .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .map_or(false, |a| (on - a).num_days() % 14 == 0)),
        "weekly" => Ok(schedule
            .anchor_date
            .as_deref()
            .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            .map_or(false, |a| (on - a).num_days() % 7 == 0)),
        _ => Ok(false),
    }
}

fn build_pay_period_projections(
    conn: &Connection,
    periods: &[PayPeriod],
    avg_daily_income: f64,
    avg_daily_discretionary: f64,
    bills: &[Bill],
    today: NaiveDate,
) -> AppResult<Vec<PayPeriodProjection>> {
    let mut out: Vec<PayPeriodProjection> = Vec::with_capacity(periods.len());
    for p in periods {
        let start = NaiveDate::parse_from_str(&p.start, "%Y-%m-%d")?;
        let end = NaiveDate::parse_from_str(&p.end, "%Y-%m-%d")?;
        let days = (end - start).num_days().max(1) as f64;
        // Project income: avg income/day * days; OR sum of actual if period already started.
        let actual_income: f64 = conn.query_row(
            "SELECT COALESCE(SUM(amount),0) FROM txn t \
             LEFT JOIN category c ON c.id=t.category_id \
             WHERE t.date >= ? AND t.date < ? AND t.split_of_id IS NULL \
               AND t.amount > 0 AND (c.name IS NULL OR c.name != 'Transfer')",
            rusqlite::params![p.start, p.end],
            |r| r.get(0),
        )?;
        let projected_income = if today >= end {
            actual_income
        } else {
            actual_income + avg_daily_income * (end - today.max(start)).num_days().max(0) as f64
        };

        let mut projected_bills = 0.0;
        let actual_bills: f64 = conn.query_row(
            "SELECT COALESCE(SUM(ABS(t.amount)),0) FROM txn t \
             JOIN category c ON c.id=t.category_id \
             WHERE t.date >= ? AND t.date < ? AND t.split_of_id IS NULL \
               AND t.amount < 0 AND c.name='Bills'",
            rusqlite::params![p.start, p.end],
            |r| r.get(0),
        )?;
        projected_bills += actual_bills;
        let proj_from = today.max(start);
        let mut day = proj_from;
        while day < end {
            for b in bills {
                // Only expense recurring transactions (negative) count toward
                // projected bills; income recurring is captured by the income
                // projection separately.
                if b.amount < 0.0 && bill_hits_on(b, day, proj_from) {
                    projected_bills += -b.amount;
                }
            }
            day += Duration::days(1);
        }

        let actual_disc: f64 = conn.query_row(
            "SELECT COALESCE(SUM(ABS(t.amount)),0) FROM txn t \
             LEFT JOIN category c ON c.id=t.category_id \
             WHERE t.date >= ? AND t.date < ? AND t.split_of_id IS NULL \
               AND t.amount < 0 AND (c.name IS NULL OR (c.name != 'Transfer' AND c.name != 'Bills'))",
            rusqlite::params![p.start, p.end],
            |r| r.get(0),
        )?;
        let remaining_days = if today >= end { 0.0 } else { (end - today.max(start)).num_days().max(0) as f64 };
        let projected_discretionary = actual_disc + avg_daily_discretionary * remaining_days;

        out.push(PayPeriodProjection {
            start: p.start.clone(),
            end: p.end.clone(),
            label: p.label.clone(),
            projected_income,
            projected_bills,
            projected_discretionary,
            projected_leftover: projected_income - projected_bills - projected_discretionary,
        });
        let _ = days; // silence unused warning if any
    }
    Ok(out)
}

fn build_category_trajectories(conn: &Connection, today: NaiveDate) -> AppResult<Vec<CategoryTrajectory>> {
    // Use the active pay period as the reference window.
    let schedules = load_schedules(conn)?;
    if schedules.is_empty() {
        return Ok(Vec::new());
    }
    let (active, (start, end)) = active_schedule_period(conn, today)?;
    let _ = active;
    let start_s = start.format("%Y-%m-%d").to_string();
    let end_s = end.format("%Y-%m-%d").to_string();

    let mut spent_stmt = conn.prepare(
        "SELECT t.category_id, COALESCE(c.name, '(uncategorized)'), SUM(ABS(t.amount)) \
         FROM txn t LEFT JOIN category c ON c.id=t.category_id \
         WHERE t.date >= ? AND t.date < ? AND t.split_of_id IS NULL \
           AND t.amount < 0 AND (c.name IS NULL OR c.name != 'Transfer') \
         GROUP BY t.category_id",
    )?;
    let spent_rows: Vec<(Option<i64>, String, f64)> = spent_stmt
        .query_map(rusqlite::params![start_s, end_s], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(spent_stmt);

    let total_days = (end - start).num_days().max(1) as f64;
    let elapsed_days = (today.min(end) - start).num_days().max(0) as f64 + 1.0;

    let mut out: Vec<CategoryTrajectory> = Vec::new();
    for (cid, cname, spent) in spent_rows {
        let allocated: Option<f64> = if let Some(id) = cid {
            conn.query_row(
                "SELECT COALESCE(SUM(amount),0) FROM budget_allocation \
                 WHERE category_id=? AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)",
                rusqlite::params![id, start_s, start_s],
                |r| r.get::<_, f64>(0).map(|v| if v > 0.0 { Some(v) } else { None }),
            )
            .unwrap_or(None)
        } else {
            None
        };
        let projected_total = spent * (total_days / elapsed_days);
        let over_under = allocated.map(|a| a - projected_total);
        out.push(CategoryTrajectory {
            category_id: cid,
            category_name: cname,
            spent_to_date: spent,
            projected_period_total: projected_total,
            allocated,
            over_under,
        });
    }
    out.sort_by(|a, b| b.spent_to_date.partial_cmp(&a.spent_to_date).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}
