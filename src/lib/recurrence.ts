import type { RecurringBill } from "@/api/types";

export interface Occurrence {
  bill_id: number;
  name: string;
  date: string; // YYYY-MM-DD
  account_id: number;
  category_id: number | null;
  amount: number; // signed: negative = expense, positive = income
}

function clampDay(year: number, monthIndex0: number, day: number): number {
  const last = new Date(year, monthIndex0 + 1, 0).getDate();
  return Math.min(day, last);
}

/// Does this recurring transaction land on `date`? Mirrors the backend's
/// bill_hits_on logic. `date` is a local Date at midnight.
export function occursOn(b: RecurringBill, date: Date): boolean {
  if (!b.active) return false;
  if (b.start_date) {
    const s = new Date(b.start_date + "T00:00:00");
    if (date < s) return false;
  }
  if (b.end_date) {
    const e = new Date(b.end_date + "T00:00:00");
    if (date > e) return false;
  }
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  switch (b.cadence_kind) {
    case "monthly":
      return b.day_of_month != null && dom === clampDay(date.getFullYear(), date.getMonth(), b.day_of_month);
    case "quarterly":
      return (
        b.day_of_month != null &&
        dom === clampDay(date.getFullYear(), date.getMonth(), b.day_of_month) &&
        [1, 4, 7, 10].includes(month)
      );
    case "semiannual":
      return (
        b.day_of_month != null &&
        dom === clampDay(date.getFullYear(), date.getMonth(), b.day_of_month) &&
        [1, 7].includes(month)
      );
    case "annual":
      return (
        b.day_of_month != null &&
        dom === clampDay(date.getFullYear(), date.getMonth(), b.day_of_month) &&
        month === 1
      );
    case "weekly":
    case "biweekly": {
      const anchor = b.anchor_date ?? b.start_date;
      if (!anchor) return false;
      const a = new Date(anchor + "T00:00:00");
      const diff = Math.round((date.getTime() - a.getTime()) / 86400000);
      const step = b.cadence_kind === "weekly" ? 7 : 14;
      return diff >= 0 && diff % step === 0;
    }
    case "custom_days": {
      const anchor = b.anchor_date ?? b.start_date;
      if (!anchor || !b.interval_days || b.interval_days <= 0) return false;
      const a = new Date(anchor + "T00:00:00");
      const diff = Math.round((date.getTime() - a.getTime()) / 86400000);
      return diff >= 0 && diff % b.interval_days === 0;
    }
    default:
      return false;
  }
}

/// Every occurrence of every active bill within the inclusive [fromISO, toISO]
/// window, in ascending date order. Iterates day-by-day, which is fine for the
/// 2-year horizons used here.
export function projectOccurrences(
  bills: RecurringBill[],
  fromISO: string,
  toISO: string,
): Occurrence[] {
  const out: Occurrence[] = [];
  const from = new Date(fromISO + "T00:00:00");
  const to = new Date(toISO + "T00:00:00");
  if (from > to) return out;
  for (const b of bills) {
    if (!b.active) continue;
    const cur = new Date(from);
    while (cur <= to) {
      if (occursOn(b, cur)) {
        out.push({
          bill_id: b.id,
          name: b.name,
          date: cur.toISOString().slice(0, 10),
          account_id: b.account_id,
          category_id: b.category_id,
          amount: b.amount,
        });
      }
      cur.setDate(cur.getDate() + 1);
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}
