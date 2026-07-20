use chrono::{Datelike, Duration, NaiveDate};

use crate::error::{AppError, AppResult};
use crate::models::{PayPeriod, PayPeriodSchedule};

/// Generate pay periods overlapping the half-open interval [from, to).
/// If multiple schedules apply over the interval, we split at each
/// schedule boundary so historical periods stay anchored to whichever
/// cadence was active at the time.
pub fn generate(
    schedules: &[PayPeriodSchedule],
    from: NaiveDate,
    to: NaiveDate,
) -> AppResult<Vec<PayPeriod>> {
    if schedules.is_empty() {
        return Err(AppError::Invalid("no pay-period schedule configured".into()));
    }
    let mut sorted = schedules.to_vec();
    sorted.sort_by(|a, b| a.effective_from.cmp(&b.effective_from));

    let mut out: Vec<PayPeriod> = Vec::new();
    let mut cursor = from;
    while cursor < to {
        let active = sorted
            .iter()
            .rev()
            .find(|s| {
                let f = NaiveDate::parse_from_str(&s.effective_from, "%Y-%m-%d").ok();
                let until = match &s.effective_to {
                    Some(t) => NaiveDate::parse_from_str(t, "%Y-%m-%d").ok(),
                    None => None,
                };
                match f {
                    Some(f) if f <= cursor => match until {
                        Some(t) => cursor < t,
                        None => true,
                    },
                    _ => false,
                }
            });
        let active = match active {
            Some(s) => s,
            None => {
                // No schedule covers `cursor`. Jump forward to the next schedule's
                // start rather than erroring — periods before any schedule existed
                // simply don't appear in the output.
                let next_start = sorted
                    .iter()
                    .filter_map(|s| NaiveDate::parse_from_str(&s.effective_from, "%Y-%m-%d").ok())
                    .filter(|f| *f > cursor)
                    .min();
                match next_start {
                    Some(f) if f < to => {
                        cursor = f;
                        continue;
                    }
                    _ => break,
                }
            }
        };

        // Only clip the emitted period when a schedule transition splits it
        // mid-period. `to` is the *request* window, not a period boundary —
        // clipping by it would truncate the last visible bucket (e.g. an
        // ongoing Jun 1 → Jun 15 period being shown as Jun 1 → Jun 3 because
        // the caller's last visible row was on Jun 2). The outer `cursor < to`
        // guard already stops us from generating extra periods past `to`.
        let schedule_end_opt = active
            .effective_to
            .as_deref()
            .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok());

        let (start, end) = period_containing(active, cursor)?;
        let bounded_end = match schedule_end_opt {
            Some(se) => end.min(se),
            None => end,
        };
        out.push(PayPeriod {
            start: start.format("%Y-%m-%d").to_string(),
            end: bounded_end.format("%Y-%m-%d").to_string(),
            label: format!("{} \u{2014} {}", start.format("%b %-d"), (bounded_end - Duration::days(1)).format("%b %-d, %Y")),
        });
        // Progress guard: a degenerate schedule (e.g. duplicate custom dates)
        // could yield a period that doesn't advance the cursor. Fail loudly
        // instead of looping forever and eating all memory.
        if bounded_end <= cursor {
            return Err(AppError::Invalid(format!(
                "pay-period schedule failed to advance past {cursor} — check the schedule configuration"
            )));
        }
        cursor = bounded_end;
        // Belt-and-suspenders: no sane request produces this many periods
        // (100 years of weekly ≈ 5,200). Bail out rather than balloon.
        if out.len() > 20_000 {
            return Err(AppError::Invalid(
                "pay-period generation exceeded 20,000 periods — refusing to continue".into(),
            ));
        }
    }
    Ok(out)
}

/// Returns [start, end) of the pay period containing `date` under `schedule`.
pub fn period_containing(schedule: &PayPeriodSchedule, date: NaiveDate) -> AppResult<(NaiveDate, NaiveDate)> {
    match schedule.cadence_kind.as_str() {
        "semimonthly" => semimonthly_period(schedule, date),
        "monthly" => monthly_period(schedule, date),
        "weekly" => fixed_step_period(schedule, date, 7),
        "biweekly" => fixed_step_period(schedule, date, 14),
        "custom_dates" => custom_dates_period(schedule, date),
        other => Err(AppError::Invalid(format!("unknown cadence: {other}"))),
    }
}

fn semimonthly_period(s: &PayPeriodSchedule, date: NaiveDate) -> AppResult<(NaiveDate, NaiveDate)> {
    let d1 = s
        .day_of_month_1
        .ok_or_else(|| AppError::Invalid("semimonthly requires day_of_month_1".into()))? as u32;
    let d2_raw = s
        .day_of_month_2
        .ok_or_else(|| AppError::Invalid("semimonthly requires day_of_month_2".into()))?;
    let year = date.year();
    let month = date.month();
    let first = NaiveDate::from_ymd_opt(year, month, d1).ok_or_else(|| AppError::Invalid("bad d1".into()))?;
    let second_day = resolve_day(year, month, d2_raw);
    let second = NaiveDate::from_ymd_opt(year, month, second_day).ok_or_else(|| AppError::Invalid("bad d2".into()))?;
    if date < first {
        // Previous month's second anchor → this month's first anchor.
        let (prev_year, prev_month) = prev_month(year, month);
        let prev_d2_day = resolve_day(prev_year, prev_month, d2_raw);
        let prev_second = NaiveDate::from_ymd_opt(prev_year, prev_month, prev_d2_day)
            .ok_or_else(|| AppError::Invalid("bad prev d2".into()))?;
        Ok((prev_second, first))
    } else if date < second {
        Ok((first, second))
    } else {
        let (next_year, next_month) = next_month(year, month);
        let next_first = NaiveDate::from_ymd_opt(next_year, next_month, d1)
            .ok_or_else(|| AppError::Invalid("bad next d1".into()))?;
        Ok((second, next_first))
    }
}

fn monthly_period(s: &PayPeriodSchedule, date: NaiveDate) -> AppResult<(NaiveDate, NaiveDate)> {
    let dom_raw = s
        .day_of_month
        .ok_or_else(|| AppError::Invalid("monthly requires day_of_month".into()))?;
    let year = date.year();
    let month = date.month();
    let dom = resolve_day(year, month, dom_raw);
    let this_anchor = NaiveDate::from_ymd_opt(year, month, dom)
        .ok_or_else(|| AppError::Invalid("bad dom".into()))?;
    if date < this_anchor {
        let (prev_year, prev_month) = prev_month(year, month);
        let prev_dom = resolve_day(prev_year, prev_month, dom_raw);
        let prev_anchor = NaiveDate::from_ymd_opt(prev_year, prev_month, prev_dom)
            .ok_or_else(|| AppError::Invalid("bad prev dom".into()))?;
        Ok((prev_anchor, this_anchor))
    } else {
        let (next_year, next_month) = next_month(year, month);
        let next_dom = resolve_day(next_year, next_month, dom_raw);
        let next_anchor = NaiveDate::from_ymd_opt(next_year, next_month, next_dom)
            .ok_or_else(|| AppError::Invalid("bad next dom".into()))?;
        Ok((this_anchor, next_anchor))
    }
}

fn fixed_step_period(s: &PayPeriodSchedule, date: NaiveDate, step_days: i64) -> AppResult<(NaiveDate, NaiveDate)> {
    let anchor_str = s
        .anchor_date
        .as_deref()
        .ok_or_else(|| AppError::Invalid("weekly/biweekly requires anchor_date".into()))?;
    let anchor = NaiveDate::parse_from_str(anchor_str, "%Y-%m-%d")?;
    let diff = (date - anchor).num_days();
    // div_euclid floors toward -inf, so this k is correct for dates before the
    // anchor too — anchor + k*step <= date < anchor + (k+1)*step always holds.
    // (A former `k -= 1` "adjustment" for negative on-boundary dates returned
    // the PREVIOUS period — [start, end) with end == date — which made
    // `generate`'s cursor stop advancing: an infinite loop that ate all memory
    // whenever a request range crossed a pre-anchor step boundary.)
    let k = diff.div_euclid(step_days);
    let start = anchor + Duration::days(k * step_days);
    let end = start + Duration::days(step_days);
    Ok((start, end))
}

fn custom_dates_period(s: &PayPeriodSchedule, date: NaiveDate) -> AppResult<(NaiveDate, NaiveDate)> {
    let raw = s
        .custom_dates_json
        .as_deref()
        .ok_or_else(|| AppError::Invalid("custom_dates requires custom_dates_json".into()))?;
    let mut dates: Vec<NaiveDate> = serde_json::from_str::<Vec<String>>(raw)?
        .into_iter()
        .filter_map(|s| NaiveDate::parse_from_str(&s, "%Y-%m-%d").ok())
        .collect();
    dates.sort();
    if dates.is_empty() {
        return Err(AppError::Invalid("custom_dates_json was empty".into()));
    }
    let idx = match dates.binary_search(&date) {
        Ok(i) => i,
        Err(i) => i.saturating_sub(1),
    };
    let start = dates.get(idx).copied().unwrap_or(date);
    let end = dates.get(idx + 1).copied().unwrap_or(start + Duration::days(14));
    Ok((start, end))
}

/// Resolve day-of-month with sentinel: -1 means "last day of month".
fn resolve_day(year: i32, month: u32, raw: i64) -> u32 {
    if raw == -1 {
        last_day_of_month(year, month)
    } else {
        raw as u32
    }
}

fn last_day_of_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = next_month(year, month);
    NaiveDate::from_ymd_opt(ny, nm, 1)
        .unwrap()
        .pred_opt()
        .unwrap()
        .day()
}

fn prev_month(y: i32, m: u32) -> (i32, u32) {
    if m == 1 {
        (y - 1, 12)
    } else {
        (y, m - 1)
    }
}

fn next_month(y: i32, m: u32) -> (i32, u32) {
    if m == 12 {
        (y + 1, 1)
    } else {
        (y, m + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s_semimonthly(from: &str, d1: i64, d2: i64) -> PayPeriodSchedule {
        PayPeriodSchedule {
            id: 0,
            effective_from: from.into(),
            effective_to: None,
            cadence_kind: "semimonthly".into(),
            anchor_date: None,
            day_of_month_1: Some(d1),
            day_of_month_2: Some(d2),
            day_of_month: None,
            custom_dates_json: None,
        }
    }

    #[test]
    fn semimonthly_15_and_last_basic() {
        let s = s_semimonthly("2026-01-01", 15, -1);
        let d = NaiveDate::from_ymd_opt(2026, 6, 20).unwrap();
        let (start, end) = period_containing(&s, d).unwrap();
        assert_eq!(start, NaiveDate::from_ymd_opt(2026, 6, 15).unwrap());
        assert_eq!(end, NaiveDate::from_ymd_opt(2026, 6, 30).unwrap());
    }

    #[test]
    fn semimonthly_first_half_of_month() {
        let s = s_semimonthly("2026-01-01", 15, -1);
        let d = NaiveDate::from_ymd_opt(2026, 6, 3).unwrap();
        let (start, end) = period_containing(&s, d).unwrap();
        assert_eq!(start, NaiveDate::from_ymd_opt(2026, 5, 31).unwrap());
        assert_eq!(end, NaiveDate::from_ymd_opt(2026, 6, 15).unwrap());
    }

    #[test]
    fn semimonthly_february_28_last_day() {
        let s = s_semimonthly("2026-01-01", 15, -1);
        let d = NaiveDate::from_ymd_opt(2026, 2, 20).unwrap();
        let (start, _end) = period_containing(&s, d).unwrap();
        assert_eq!(start, NaiveDate::from_ymd_opt(2026, 2, 15).unwrap());
    }

    #[test]
    fn last_period_not_clipped_by_request_to() {
        // Reproduces the "May 31 — Jun 2" bug: with a semimonthly 15-and-last
        // schedule, the period containing Jun 1 should extend to Jun 15 even
        // when the caller passes a smaller `to` (the last visible row's date).
        let s = s_semimonthly("2026-06-01", 15, -1);
        let periods = generate(
            &[s],
            NaiveDate::from_ymd_opt(2026, 6, 1).unwrap(),
            // Caller's "last row" was Jun 3 — must not truncate Jun 15 end.
            NaiveDate::from_ymd_opt(2026, 6, 3).unwrap(),
        )
        .unwrap();
        let first = periods.first().unwrap();
        assert_eq!(first.start, "2026-05-31");
        assert_eq!(first.end, "2026-06-15");
    }

    #[test]
    fn schedule_change_splits_periods() {
        let semi = s_semimonthly("2026-01-01", 15, -1);
        let mut bi = PayPeriodSchedule {
            id: 0,
            effective_from: "2027-01-01".into(),
            effective_to: None,
            cadence_kind: "biweekly".into(),
            anchor_date: Some("2027-01-09".into()),
            day_of_month_1: None,
            day_of_month_2: None,
            day_of_month: None,
            custom_dates_json: None,
        };
        let mut semi_capped = semi.clone();
        semi_capped.effective_to = Some("2027-01-01".into());
        bi.effective_from = "2027-01-01".into();
        let periods = generate(
            &[semi_capped, bi],
            NaiveDate::from_ymd_opt(2026, 12, 1).unwrap(),
            NaiveDate::from_ymd_opt(2027, 2, 1).unwrap(),
        )
        .unwrap();
        // Last semimonthly period must terminate exactly at 2027-01-01.
        let mut saw_boundary = false;
        for p in &periods {
            if p.end == "2027-01-01" {
                saw_boundary = true;
            }
        }
        assert!(saw_boundary, "schedule boundary at 2027-01-01 should split a period");
    }
}

#[cfg(test)]
mod fixed_step_boundary {
    use super::*;
    use crate::models::PayPeriodSchedule;

    fn biweekly(effective_from: &str, effective_to: Option<&str>, anchor: &str) -> PayPeriodSchedule {
        PayPeriodSchedule {
            id: 0,
            effective_from: effective_from.into(),
            effective_to: effective_to.map(|s| s.to_string()),
            cadence_kind: "biweekly".into(),
            anchor_date: Some(anchor.into()),
            day_of_month_1: None,
            day_of_month_2: None,
            day_of_month: None,
            custom_dates_json: None,
        }
    }

    /// Regression: dates exactly N steps BEFORE the anchor must fall in the
    /// period that STARTS on them, not the one that ends on them. The old
    /// `k -= 1` adjustment violated this and made generate() loop forever.
    #[test]
    fn on_boundary_before_anchor_is_period_start() {
        let s = biweekly("2025-12-01", None, "2026-01-02");
        for days_before in [14i64, 28, 42] {
            let d = NaiveDate::from_ymd_opt(2026, 1, 2).unwrap() - Duration::days(days_before);
            let (start, end) = period_containing(&s, d).unwrap();
            assert_eq!(start, d, "period must start on {d}");
            assert_eq!(end, d + Duration::days(14));
        }
    }

    /// Regression: the exact configuration + request that bricked v1.5.1 —
    /// Dashboard's 3-years-back window over a biweekly schedule whose anchor
    /// sits after its effective_from. Must terminate.
    #[test]
    fn dashboard_window_over_late_anchor_terminates() {
        let schedules = vec![
            biweekly("2025-12-01", Some("2026-06-30"), "2026-01-02"),
            PayPeriodSchedule {
                id: 1,
                effective_from: "2026-06-15".into(),
                effective_to: None,
                cadence_kind: "semimonthly".into(),
                anchor_date: None,
                day_of_month_1: Some(1),
                day_of_month_2: Some(15),
                day_of_month: None,
                custom_dates_json: None,
            },
        ];
        let periods = generate(
            &schedules,
            NaiveDate::from_ymd_opt(2023, 7, 1).unwrap(),
            NaiveDate::from_ymd_opt(2026, 10, 31).unwrap(),
        )
        .expect("must not loop or error");
        assert!(!periods.is_empty());
        // First emitted period starts at the schedule walk-in, and every
        // period strictly advances.
        for w in periods.windows(2) {
            assert!(w[1].start >= w[0].end || w[1].start > w[0].start);
        }
    }
}
