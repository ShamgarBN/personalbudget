import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { asTree, makeColorResolver, CategoryColorContext, useCategoryColor } from "@/lib/categories";
import { ResizableTh, useColumnWidths } from "@/lib/columns";
import { fmtDate, fmtUSD, todayISO } from "@/lib/formatting";
import { projectOccurrences } from "@/lib/recurrence";
import { useCollapsed } from "@/lib/collapse";
import { useGhostOverrides } from "@/lib/ghostOverrides";
import type { PayPeriod, Transaction } from "@/api/types";

// A ledger row is either a real transaction or a projected "ghost": a future
// occurrence of a recurring transaction, or a budgeted item for a pay period.
// Ghosts are editable + forecast-only until locked in (materialized).
type LedgerItem = Transaction & {
  ghostBillId?: number; // recurring ghost
  ghostKey?: string; // stable override/lock key for any ghost
  ghostBudgetCategoryId?: number; // budget ghost: category to record under
  ghostBudgetKey?: string; // budget ghost: lock key "<catId>:<periodStart>"
  ghostSeq?: number; // stable display order among same-date ghosts
};
const isGhost = (i: LedgerItem): boolean => i.ghostBillId != null || i.ghostBudgetKey != null;

// Whether a real row was locked in from a projection (so it shows a checkbox
// that can be unchecked to undo it).
const isLockedProjection = (i: LedgerItem): boolean =>
  !isGhost(i) && (i.from_bill_id != null || i.from_budget_key != null);

type GhostHandlers = {
  setAmount: (key: string, amount: number) => void;
  lockIn: (item: LedgerItem) => void;
  unlock: (id: number) => void;
  dismiss: (key: string) => void;
};

function addDaysISO(isoDate: string, n: number): string {
  const d = new Date(isoDate + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

type RangeMode =
  | { kind: "all" }
  | { kind: "month"; year: number; month: number /* 1-12 */ }
  | { kind: "year"; year: number }
  | { kind: "custom"; from: string; to: string };

const iso = (d: Date) => d.toISOString().slice(0, 10);

function rangeBounds(mode: RangeMode): { from: string; to: string; label: string } {
  if (mode.kind === "all") {
    return { from: "1900-01-01", to: "2999-12-31", label: "All time" };
  }
  if (mode.kind === "month") {
    const start = new Date(mode.year, mode.month - 1, 1);
    const end = new Date(mode.year, mode.month, 0); // last day of month
    const label = start.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    return { from: iso(start), to: iso(end), label };
  }
  if (mode.kind === "year") {
    return {
      from: `${mode.year}-01-01`,
      to: `${mode.year}-12-31`,
      label: String(mode.year),
    };
  }
  return { from: mode.from, to: mode.to, label: `${fmtDate(mode.from)} – ${fmtDate(mode.to)}` };
}

export default function AccountLedger({
  accountKind,
  title,
  halfMonthCollapse = false,
  showPinnedCcPayment = false,
  showCcStartingBalance = false,
  showProjections = false,
  defaultRange = "month",
}: {
  accountKind: "checking" | "credit" | "savings";
  title: string;
  halfMonthCollapse?: boolean;
  showPinnedCcPayment?: boolean;
  /// When true (Bank Account tab), also show an editor for the credit card
  /// account's opening balance inside the starting-balances section.
  showCcStartingBalance?: boolean;
  /// When true (Bank Account tab), project recurring transactions forward as
  /// editable "ghost" rows that extend the running balance as a forecast.
  showProjections?: boolean;
  defaultRange?: "all" | "month";
}) {
  const qc = useQueryClient();
  const today = new Date();
  const [mode, setMode] = useState<RangeMode>(() =>
    defaultRange === "all"
      ? { kind: "all" }
      : { kind: "month", year: today.getFullYear(), month: today.getMonth() + 1 },
  );
  const [customFrom, setCustomFrom] = useState<string>(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return iso(d);
  });
  const [customTo, setCustomTo] = useState<string>(() => iso(today));
  const [search, setSearch] = useState("");
  const [groupByPP, setGroupByPP] = useState(true);
  const { widthOf, startResize } = useColumnWidths();

  // Persist the collapse state of the starting-balances section so once a
  // user has entered their values, the strip stays hidden across visits.
  const [startingBalCollapsed, setStartingBalCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("family-budget:starting-bal-collapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleStartingBal = () => {
    setStartingBalCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("family-budget:starting-bal-collapsed", next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  };

  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const categoryTree = useMemo(() => asTree(categories.data ?? []), [categories.data]);
  const colorOf = useMemo(() => makeColorResolver(categories.data ?? []), [categories.data]);

  const account = useMemo(
    () => (accounts.data ?? []).find((a) => a.kind === accountKind),
    [accounts.data, accountKind],
  );
  const creditAccount = useMemo(
    () => (accounts.data ?? []).find((a) => a.kind === "credit"),
    [accounts.data],
  );

  const effectiveMode: RangeMode =
    mode.kind === "custom" ? { kind: "custom", from: customFrom, to: customTo } : mode;
  const range = rangeBounds(effectiveMode);

  const txns = useQuery({
    queryKey: ["transactions", account?.id, range.from, range.to, search],
    queryFn: () =>
      api.listTransactions({
        account_id: account?.id,
        date_from: range.from,
        date_to: range.to,
        search: search || undefined,
        limit: 2000,
      }),
    enabled: !!account,
  });

  // The pinned "Credit Card Payment" row collects THIS period's credit-card
  // charges (the transactions on the credit account within the visible range),
  // so it can accordion open to itemize them. Only the charges in this window
  // count — not the full running card balance.
  const ccChargesQuery = useQuery({
    queryKey: ["cc-period-charges", creditAccount?.id, range.from, range.to],
    queryFn: () =>
      api.listTransactions({
        account_id: creditAccount!.id,
        date_from: range.from,
        date_to: range.to,
        limit: 1000,
      }),
    enabled: showPinnedCcPayment && !!creditAccount,
  });
  const ccCharges = useMemo(
    () => (ccChargesQuery.data?.rows ?? []).filter((r) => r.amount < 0).slice().reverse(),
    [ccChargesQuery.data],
  );
  const ccChargesTotal = useMemo(() => ccCharges.reduce((s, c) => s + c.amount, 0), [ccCharges]);
  const [ccExpanded, setCcExpanded] = useState(false);

  const update = useMutation({
    mutationFn: (args: Parameters<typeof api.updateTransaction>[0]) =>
      api.updateTransaction(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
  const del = useMutation({
    mutationFn: (id: number) => api.deleteTransaction(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
  const updateAccount = useMutation({
    mutationFn: (args: { id: number; openingBalance?: number; openingDate?: string }) =>
      api.updateAccount(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
    },
  });

  const rawRows = txns.data?.rows ?? [];
  // Backend returns DESC (most recent first); display ASC top-to-bottom so
  // the first day of the period sits at the top of the table.
  const rows = useMemo(() => rawRows.slice().reverse(), [rawRows]);
  const total = rows.reduce((s, r) => s + r.amount, 0);

  // Projections (Bank Account only): recurring transactions + budgeted items
  // appear as editable "ghost" rows that extend the running balance as a
  // forecast until locked in.
  const bills = useQuery({ queryKey: ["recurring-bills"], queryFn: api.listRecurringBills });
  const catNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of categories.data ?? []) m.set(c.id, c.name);
    return m;
  }, [categories.data]);

  // Pay periods from today out 2 years, used to place budget projections.
  // periods[0] is the period containing today.
  const budgetPeriods = useQuery({
    queryKey: ["pay-periods", "budget-proj", todayISO()],
    queryFn: () => api.generatePayPeriods(todayISO(), addDaysISO(todayISO(), 730)),
    enabled: showProjections,
    retry: false,
  });
  const currentBudgetPeriod = budgetPeriods.data?.[0] ?? null;
  const monthOf = (isoDate: string) => {
    const d = new Date(isoDate + "T00:00:00");
    return {
      start: iso(new Date(d.getFullYear(), d.getMonth(), 1)),
      end: iso(new Date(d.getFullYear(), d.getMonth() + 1, 1)),
    };
  };
  // Current-period budget allocations + spend, so the current period projects
  // only the *remaining* (unspent) budget.
  const currentBudget = useQuery({
    queryKey: ["budget-summary", currentBudgetPeriod?.start, currentBudgetPeriod?.end, "proj"],
    queryFn: () => {
      const mb = monthOf(currentBudgetPeriod!.start);
      return api.budgetSummary(currentBudgetPeriod!.start, currentBudgetPeriod!.end, mb.start, mb.end);
    },
    enabled: showProjections && !!currentBudgetPeriod,
  });

  const overrides = useGhostOverrides((s) => s.amounts);
  const dismissed = useGhostOverrides((s) => s.dismissed);

  const ghosts: LedgerItem[] = useMemo(() => {
    if (!showProjections || !account) return [];
    const t = todayISO();
    const afterToday = addDaysISO(t, 1);
    const horizon = addDaysISO(t, 730); // 2-year forecast

    type Proj = {
      date: string;
      amount: number;
      key: string; // override key
      description: string;
      categoryId: number | null;
      categoryName: string | null;
      billId?: number;
      budgetKey?: string; // "<catId>:<periodStart>"
      budgetCategoryId?: number;
    };
    const projected: Proj[] = [];

    // --- Recurring ghosts: occurrences strictly after today, within view ---
    const recStart = range.from > afterToday ? range.from : afterToday;
    const recEnd = range.to < horizon ? range.to : horizon;
    if (recStart <= recEnd) {
      const materializedBill = new Set(
        rows.filter((r) => r.from_bill_id != null).map((r) => `${r.from_bill_id}:${r.date}`),
      );
      for (const o of projectOccurrences(bills.data ?? [], recStart, recEnd)) {
        if (o.account_id !== account.id) continue;
        if (materializedBill.has(`${o.bill_id}:${o.date}`)) continue;
        const key = `bill:${o.bill_id}:${o.date}`;
        if (dismissed[key]) continue; // user deleted this projected occurrence
        projected.push({
          date: o.date,
          amount: overrides[key] ?? o.amount,
          key,
          description: o.name,
          categoryId: o.category_id,
          categoryName: o.category_id != null ? catNameById.get(o.category_id) ?? null : null,
          billId: o.bill_id,
        });
      }
    }

    // --- Budget ghosts: per-pay-period budgeted categories, current + future ---
    const allocRows = (currentBudget.data?.rows ?? []).filter(
      (r) => r.budget_basis === "per_pay_period" && r.allocated > 0.005,
    );
    if (allocRows.length > 0) {
      const materializedBudget = new Set(
        rows.filter((r) => r.from_budget_key != null).map((r) => r.from_budget_key as string),
      );
      const periods = budgetPeriods.data ?? [];
      periods.forEach((p, pi) => {
        // Place the projection on the period's last day (end is exclusive).
        const ghostDate = addDaysISO(p.end, -1);
        if (ghostDate < t || ghostDate < range.from || ghostDate > range.to) return;
        const isCurrent = pi === 0;
        for (const r of allocRows) {
          const budgetKey = `${r.category_id}:${p.start}`;
          if (materializedBudget.has(budgetKey)) continue;
          const base = isCurrent ? -Math.max(0, r.allocated - r.spent) : -r.allocated;
          if (Math.abs(base) < 0.005) continue;
          const key = `budget:${budgetKey}`;
          if (dismissed[key]) continue; // user deleted this projected item
          projected.push({
            date: ghostDate,
            amount: overrides[key] ?? base,
            key,
            description: `Budget · ${r.category_name}`,
            categoryId: r.category_id,
            categoryName: r.category_name,
            budgetKey,
            budgetCategoryId: r.category_id,
          });
        }
      });
    }

    // Order projections chronologically; the running balance is computed later
    // in a single top-to-bottom pass over the merged display list so it always
    // sums in ledger order.
    projected.sort((a, b) => a.date.localeCompare(b.date));
    return projected.map((pj, i) => ({
      id: -1 - i,
      account_id: account.id,
      date: pj.date,
      description: pj.description,
      title: null,
      category_id: pj.categoryId,
      category_name: pj.categoryName,
      amount: pj.amount,
      memo: null,
      cleared: false,
      flagged: false,
      needs_review: false,
      split_of_id: null,
      from_bill_id: pj.billId ?? null,
      from_budget_key: pj.budgetKey ?? null,
      running_balance: null,
      ghostBillId: pj.billId,
      ghostKey: pj.key,
      ghostBudgetKey: pj.budgetKey,
      ghostBudgetCategoryId: pj.budgetCategoryId,
      ghostSeq: i,
    }));
  }, [
    showProjections,
    account,
    range.from,
    range.to,
    rows,
    bills.data,
    catNameById,
    overrides,
    dismissed,
    currentBudget.data,
    budgetPeriods.data,
  ]);

  // Real rows + ghosts, in stable display order: by date, real before ghost on
  // the same day, then real rows by id and ghosts by their projection sequence.
  // The running balance is then computed in one top-to-bottom pass so it always
  // sums in ledger order — real rows keep their authoritative backend running,
  // and ghosts continue the running sum from the last real row above them.
  const items: LedgerItem[] = useMemo(() => {
    const merged: LedgerItem[] = [...rows.map((r) => ({ ...r })), ...ghosts];
    merged.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      const ag = isGhost(a);
      const bg = isGhost(b);
      if (ag !== bg) return ag ? 1 : -1; // real rows before ghosts on the same day
      if (!ag) return a.id - b.id; // both real → backend order (date, id)
      // Both ghosts on the same day: projected expenses before income, so a
      // paycheck never inflates the running balance of the spending above it.
      const ai = a.amount >= 0 ? 1 : 0;
      const bi = b.amount >= 0 ? 1 : 0;
      return ai - bi || (a.ghostSeq ?? 0) - (b.ghostSeq ?? 0);
    });
    // Running balance, strictly top-to-bottom in this exact display order. Real
    // rows keep their authoritative backend balance; each ghost continues the
    // sum from the row directly above it.
    let run: number | null = null;
    for (const it of merged) {
      if (!isGhost(it)) {
        if (it.running_balance != null) run = it.running_balance;
      } else {
        if (run == null) run = account?.current_balance ?? 0;
        run += it.amount;
        it.running_balance = run;
      }
    }
    return merged;
  }, [rows, ghosts, account]);

  // The projected Credit Card payoff sits at the very bottom of the ledger, so
  // its running balance continues from the last row above it — which already
  // reflects every real AND projected (ghost) transaction in the view.
  const ccPinnedRunning = useMemo(() => {
    const last = items[items.length - 1];
    const baseline = last?.running_balance ?? account?.current_balance ?? 0;
    return baseline + ccChargesTotal;
  }, [items, ccChargesTotal, account]);

  const invalidateAfterLock = () => {
    qc.invalidateQueries({ queryKey: ["transactions"] });
    qc.invalidateQueries({ queryKey: ["accounts"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["budget-summary"] });
  };
  const materialize = useMutation({
    mutationFn: (a: { billId: number; date: string; amount: number; cleared: boolean }) =>
      api.materializeOccurrence(a),
    onSuccess: invalidateAfterLock,
  });
  const materializeBudget = useMutation({
    mutationFn: (a: Parameters<typeof api.materializeBudgetItem>[0]) => api.materializeBudgetItem(a),
    onSuccess: invalidateAfterLock,
  });
  const setOverride = useGhostOverrides((s) => s.set);
  const clearOverride = useGhostOverrides((s) => s.clear);
  const dismissGhost = useGhostOverrides((s) => s.dismiss);

  // Edit a ghost's amount (persisted override; affects the forecast only).
  const onSetGhostAmount = (key: string, amount: number) => setOverride(key, amount);
  // Check the box → lock in (materialize) the projection as a real cleared txn.
  const onLockIn = (item: LedgerItem) => {
    if (item.ghostBillId != null) {
      materialize.mutate({ billId: item.ghostBillId, date: item.date, amount: item.amount, cleared: true });
    } else if (item.ghostBudgetKey != null) {
      materializeBudget.mutate({
        accountId: item.account_id,
        categoryId: item.ghostBudgetCategoryId ?? null,
        date: item.date,
        amount: item.amount,
        description: item.description,
        cleared: true,
        budgetKey: item.ghostBudgetKey,
      });
    }
    if (item.ghostKey) clearOverride(item.ghostKey);
  };
  // Uncheck the box on a locked-in projection → delete it (revert to a ghost).
  const onUnlock = (id: number) => del.mutate(id);
  // Delete a projected occurrence from the view (hides just this one).
  const onDismiss = (key: string) => dismissGhost(key);
  const ghostHandlers: GhostHandlers = {
    setAmount: onSetGhostAmount,
    lockIn: onLockIn,
    unlock: onUnlock,
    dismiss: onDismiss,
  };

  // When pay-period grouping is on, fetch the periods that overlap the
  // visible range. Using the displayed-row span (rather than range.from/to)
  // keeps the query stable when an "all time" view has no rows yet.
  const ppRange = useMemo(() => {
    if (!groupByPP || items.length === 0) return null;
    // Span includes ghost dates so the generated periods reach into the future.
    return { from: items[0].date, to: items[items.length - 1].date };
  }, [groupByPP, items]);
  const payPeriods = useQuery({
    queryKey: ["pay-periods", "account-ledger", ppRange?.from, ppRange?.to],
    queryFn: () => api.generatePayPeriods(ppRange!.from, ppRange!.to),
    enabled: !!ppRange,
  });

  const groupedPP = useMemo(() => {
    if (!groupByPP || !payPeriods.data) return null;
    const buckets: Array<{ period: PayPeriod; rows: LedgerItem[] }> =
      payPeriods.data.map((p) => ({ period: p, rows: [] as LedgerItem[] }));
    const orphans: LedgerItem[] = [];
    // Both items and buckets are sorted ASC by date — single pass with a
    // moving pointer avoids O(items × periods). PayPeriod.end is exclusive.
    let pi = 0;
    for (const r of items) {
      while (pi < buckets.length && r.date >= buckets[pi].period.end) pi++;
      if (pi < buckets.length && r.date >= buckets[pi].period.start) {
        buckets[pi].rows.push(r);
      } else {
        orphans.push(r);
      }
    }
    return { buckets: buckets.filter((b) => b.rows.length > 0), orphans };
  }, [groupByPP, payPeriods.data, items]);

  const groupedHalves = useMemo(() => {
    // Pay-period grouping wins when both are eligible.
    if (groupedPP) return null;
    if (!halfMonthCollapse || mode.kind !== "month") return null;
    const firstHalf: LedgerItem[] = [];
    const secondHalf: LedgerItem[] = [];
    for (const r of items) {
      const day = new Date(r.date + "T00:00:00").getDate();
      (day <= 15 ? firstHalf : secondHalf).push(r);
    }
    return { firstHalf, secondHalf };
  }, [halfMonthCollapse, mode, items, groupedPP]);

  return (
    <CategoryColorContext.Provider value={colorOf}>
    <div className="p-6 space-y-4 text-gray-900">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
          <p className="text-xs text-gray-700 mt-1">{range.label}</p>
        </div>
        <div className="flex items-center gap-1.5 text-sm flex-wrap">
          <button
            onClick={() => {
              if (mode.kind === "month") {
                const d = new Date(mode.year, mode.month - 2, 1);
                setMode({ kind: "month", year: d.getFullYear(), month: d.getMonth() + 1 });
              } else if (mode.kind === "year") {
                setMode({ kind: "year", year: mode.year - 1 });
              }
            }}
            disabled={mode.kind === "custom"}
            className="px-2 py-1 rounded border border-gray-200 bg-white text-gray-800 disabled:opacity-30"
          >
            ←
          </button>
          <button
            onClick={() => {
              if (mode.kind === "month") {
                const d = new Date(mode.year, mode.month, 1);
                setMode({ kind: "month", year: d.getFullYear(), month: d.getMonth() + 1 });
              } else if (mode.kind === "year") {
                setMode({ kind: "year", year: mode.year + 1 });
              }
            }}
            disabled={mode.kind === "custom"}
            className="px-2 py-1 rounded border border-gray-200 bg-white text-gray-800 disabled:opacity-30"
          >
            →
          </button>
          <div className="w-px h-6 bg-gray-200 mx-1" />
          {(
            [
              ["all", "All time"],
              ["month", "Monthly"],
              ["year", "Yearly"],
              ["custom", "Custom"],
            ] as const
          ).map(([k, lbl]) => (
            <button
              key={k}
              onClick={() => {
                if (k === "all") setMode({ kind: "all" });
                if (k === "month")
                  setMode({ kind: "month", year: today.getFullYear(), month: today.getMonth() + 1 });
                if (k === "year") setMode({ kind: "year", year: today.getFullYear() });
                if (k === "custom") setMode({ kind: "custom", from: customFrom, to: customTo });
              }}
              className={`px-2.5 py-1 rounded ${
                mode.kind === k
                  ? "bg-gray-900 text-white"
                  : "border border-gray-200 bg-white text-gray-800 hover:bg-gray-50"
              }`}
            >
              {lbl}
            </button>
          ))}
          {mode.kind === "custom" && (
            <>
              <input
                type="date"
                className="border border-gray-200 rounded px-2 py-1 text-sm bg-white"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
              <span className="text-xs text-gray-600">to</span>
              <input
                type="date"
                className="border border-gray-200 rounded px-2 py-1 text-sm bg-white"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </>
          )}
        </div>
      </div>

      {account && (
        <div className="rounded-lg border border-gray-200 bg-gray-50">
          <button
            type="button"
            onClick={toggleStartingBal}
            className="w-full flex items-center justify-between gap-3 px-3 py-2"
          >
            <span className="flex items-center gap-2 text-xs uppercase tracking-wide text-gray-700 font-semibold">
              <span className="inline-block w-3">{startingBalCollapsed ? "▸" : "▾"}</span>
              Starting balances
            </span>
            {startingBalCollapsed && (
              <span className="text-xs text-gray-600 font-normal normal-case truncate">
                {account.name}: {fmtUSD(account.opening_balance)} as of {fmtDate(account.opening_date)}
                {showCcStartingBalance && creditAccount && (
                  <>
                    {" · "}
                    {creditAccount.name}: {fmtUSD(creditAccount.opening_balance)} as of {fmtDate(creditAccount.opening_date)}
                  </>
                )}
              </span>
            )}
          </button>
          {!startingBalCollapsed && (
            <div className="px-3 pb-3 space-y-2 border-t border-gray-200 pt-2">
              <StartingBalanceRow
                label={account.name}
                balance={account.opening_balance}
                date={account.opening_date}
                onBalanceChange={(n) =>
                  updateAccount.mutate({ id: account.id, openingBalance: n })
                }
                onDateChange={(d) =>
                  updateAccount.mutate({ id: account.id, openingDate: d })
                }
              />
              {showCcStartingBalance && creditAccount && (
                <StartingBalanceRow
                  label={creditAccount.name}
                  balance={creditAccount.opening_balance}
                  date={creditAccount.opening_date}
                  onBalanceChange={(n) =>
                    updateAccount.mutate({ id: creditAccount.id, openingBalance: n })
                  }
                  onDateChange={(d) =>
                    updateAccount.mutate({ id: creditAccount.id, openingDate: d })
                  }
                />
              )}
              <p className="text-xs text-gray-500 italic">
                Each account's running balance is computed forward from its starting balance.
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="text"
          placeholder="Search description / memo…"
          className="border border-gray-200 rounded px-2 py-1.5 text-sm bg-white flex-1 max-w-md"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-1.5 text-sm text-gray-800">
          <input
            type="checkbox"
            checked={groupByPP}
            onChange={(e) => setGroupByPP(e.target.checked)}
          />
          Group by pay period
        </label>
        <div className="text-sm text-gray-700 ml-auto">
          {rows.length.toLocaleString()} transactions ·{" "}
          <span className={`font-medium tabular-nums ${total < 0 ? "text-red-700" : "text-green-700"}`}>
            {fmtUSD(total)}
          </span>
        </div>
      </div>

      {!account ? (
        <p className="text-sm text-gray-700">No {accountKind} account found.</p>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white overflow-auto" style={{ maxHeight: "calc(100vh - 320px)" }}>
          <table className="text-sm" style={{ tableLayout: "fixed", width: "max-content", minWidth: "100%" }}>
            <thead className="sticky top-0 bg-white shadow-[0_1px_0_rgba(0,0,0,0.06)] z-10">
              <tr className="text-left text-xs uppercase tracking-wide text-gray-700">
                <ResizableTh colId="date" widthOf={widthOf} startResize={startResize}>Date</ResizableTh>
                <ResizableTh colId="description" widthOf={widthOf} startResize={startResize}>Description</ResizableTh>
                <ResizableTh colId="memo" widthOf={widthOf} startResize={startResize}>Memo</ResizableTh>
                <ResizableTh colId="category" widthOf={widthOf} startResize={startResize}>Category</ResizableTh>
                <ResizableTh colId="amount" widthOf={widthOf} startResize={startResize} className="text-right">Amount</ResizableTh>
                <ResizableTh colId="running" widthOf={widthOf} startResize={startResize} className="text-right">Running</ResizableTh>
                <ResizableTh colId="actions" widthOf={widthOf} startResize={startResize}></ResizableTh>
              </tr>
            </thead>
            {(() => {
              if (items.length === 0) {
                return (
                  <tbody>
                    {!txns.isLoading && (
                      <tr>
                        <td colSpan={7} className="px-3 py-12 text-center text-sm text-gray-700">
                          No transactions in this range.
                        </td>
                      </tr>
                    )}
                  </tbody>
                );
              }
              // CRITICAL: when grouping is on we must NOT fall through to the
              // flat tbody while pay-periods is loading/erroring — mounting
              // every row + its stateful inline editors synchronously is what
              // wedged the tab on initial load.
              if (groupByPP) {
                if (payPeriods.isError) {
                  return (
                    <tbody>
                      <tr>
                        <td colSpan={7} className="px-3 py-12 text-center text-sm text-amber-700">
                          Couldn't group by pay period: {String((payPeriods.error as Error | null)?.message ?? "no schedule configured")}.{" "}
                          <button onClick={() => setGroupByPP(false)} className="underline">
                            Show ungrouped list
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  );
                }
                if (!groupedPP) {
                  return (
                    <tbody>
                      <tr>
                        <td colSpan={7} className="px-3 py-12 text-center text-sm text-gray-700">
                          Loading pay periods…
                        </td>
                      </tr>
                    </tbody>
                  );
                }
                // Display order is ASC, so the last bucket is the most recent
                // pay period. Default-open only that one to keep the mount
                // cost flat across "all time" views.
                const lastBucket = groupedPP.buckets[groupedPP.buckets.length - 1];
                const curYear = todayISO().slice(0, 4);
                // Group the pay-period buckets by calendar year (buckets are ASC).
                const years: Array<{ year: string; buckets: typeof groupedPP.buckets }> = [];
                for (const b of groupedPP.buckets) {
                  const y = b.period.start.slice(0, 4);
                  let g = years.find((x) => x.year === y);
                  if (!g) {
                    g = { year: y, buckets: [] };
                    years.push(g);
                  }
                  g.buckets.push(b);
                }
                return (
                  <>
                    {years.map((yg) => {
                      const yearTotal = yg.buckets.reduce(
                        (s, b) => s + b.rows.reduce((ss, r) => ss + r.amount, 0),
                        0,
                      );
                      return (
                        <YearGroup
                          key={yg.year}
                          year={yg.year}
                          total={yearTotal}
                          colSpan={7}
                          groupKey={`acct:${accountKind}:year:${yg.year}`}
                          defaultOpen={yg.year === curYear}
                        >
                          {yg.buckets.map((bucket) => (
                            <PeriodBody
                              key={bucket.period.start}
                              label={bucket.period.label}
                              rows={bucket.rows}
                              categories={categoryTree}
                              groupKey={`acct:${accountKind}:pp:${bucket.period.start}`}
                              onUpdate={(args) => update.mutate(args)}
                              onDelete={(id) => del.mutate(id)}
                              ghost={ghostHandlers}
                              defaultOpen={bucket === lastBucket}
                            />
                          ))}
                        </YearGroup>
                      );
                    })}
                    {groupedPP.orphans.length > 0 && (
                      <PeriodBody
                        label={`Outside any pay period (${groupedPP.orphans.length})`}
                        rows={groupedPP.orphans}
                        categories={categoryTree}
                        groupKey={`acct:${accountKind}:pp:orphans`}
                        onUpdate={(args) => update.mutate(args)}
                        onDelete={(id) => del.mutate(id)}
                        ghost={ghostHandlers}
                        defaultOpen={false}
                      />
                    )}
                  </>
                );
              }
              if (groupedHalves) {
                return (
                  <>
                    <HalfBody
                      label={`Days 1 – 15 (${groupedHalves.firstHalf.length})`}
                      rows={groupedHalves.firstHalf}
                      categories={categoryTree}
                      groupKey={`acct:${accountKind}:half1:${range.from}`}
                      onUpdate={(args) => update.mutate(args)}
                      onDelete={(id) => del.mutate(id)}
                      ghost={ghostHandlers}
                    />
                    <HalfBody
                      label={`Days 16 – end of month (${groupedHalves.secondHalf.length})`}
                      rows={groupedHalves.secondHalf}
                      categories={categoryTree}
                      groupKey={`acct:${accountKind}:half2:${range.from}`}
                      onUpdate={(args) => update.mutate(args)}
                      onDelete={(id) => del.mutate(id)}
                      ghost={ghostHandlers}
                    />
                  </>
                );
              }
              return (
                <tbody>
                  {items.map((t) => (
                    <LedgerRow
                      key={t.id}
                      t={t}
                      categories={categoryTree}
                      onUpdate={(args) => update.mutate(args)}
                      onDelete={(id) => del.mutate(id)}
                      ghost={ghostHandlers}
                    />
                  ))}
                </tbody>
              );
            })()}
            {showPinnedCcPayment && creditAccount && (
              <tfoot className={`${ccExpanded ? "" : "sticky bottom-0"} bg-amber-50 border-t-2 border-amber-200`}>
                <tr>
                  <td className="px-3 py-2 text-amber-900 font-medium" colSpan={4}>
                    <button
                      type="button"
                      onClick={() => setCcExpanded((o) => !o)}
                      className="flex items-center gap-2 hover:text-black"
                      title="Show this period's credit-card charges"
                    >
                      <span className="inline-block w-3">{ccExpanded ? "▾" : "▸"}</span>
                      Credit Card Payment{" "}
                      <span className="text-xs text-amber-700 font-normal normal-case">
                        (projected — {creditAccount.name} charges in {range.label})
                      </span>
                    </button>
                  </td>
                  <td className={`px-3 py-2 text-right font-semibold tabular-nums ${ccChargesTotal < 0 ? "text-red-700" : "text-amber-900"}`}>
                    {fmtUSD(ccChargesTotal)}
                  </td>
                  <td className={`px-3 py-2 text-right font-semibold tabular-nums ${ccPinnedRunning < 0 ? "text-red-700" : "text-amber-900"}`}>
                    {fmtUSD(ccPinnedRunning)}
                  </td>
                  <td />
                </tr>
                {ccExpanded &&
                  (ccCharges.length === 0 ? (
                    <tr className="bg-amber-50/60">
                      <td colSpan={7} className="px-3 py-2 pl-10 text-xs text-amber-800/70 italic">
                        No credit-card charges in {range.label}.
                      </td>
                    </tr>
                  ) : (
                    ccCharges.map((c) => (
                      <tr key={`ccp-${c.id}`} className="bg-amber-50/50 text-xs text-amber-900/80">
                        <td className="px-3 py-1 pl-10 whitespace-nowrap">{fmtDate(c.date)}</td>
                        <td className="px-3 py-1 truncate" colSpan={3}>
                          <span className="line-clamp-1" title={c.description}>
                            {c.title ?? c.description}
                          </span>
                        </td>
                        <td className="px-3 py-1 text-right tabular-nums text-red-700">{fmtUSD(c.amount)}</td>
                        <td className="px-3 py-1" />
                        <td className="px-3 py-1 text-right text-[10px] text-amber-700/60 italic whitespace-nowrap">
                          on {creditAccount.name}
                        </td>
                      </tr>
                    ))
                  ))}
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
    </CategoryColorContext.Provider>
  );
}

// Collapsible year wrapper: a header tbody followed (when open) by its
// pay-period tbodies. Rendered as a fragment so the period <tbody>s remain
// siblings (a tbody can't contain tbodies).
function YearGroup({
  year,
  total,
  groupKey,
  colSpan,
  defaultOpen,
  children,
}: {
  year: string;
  total: number;
  groupKey: string;
  colSpan: number;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, toggle] = useCollapsed(groupKey, defaultOpen);
  return (
    <>
      <tbody>
        <tr className="bg-gray-100 border-y border-gray-300">
          <td colSpan={colSpan - 1} className="px-3 py-2 text-sm font-semibold text-gray-900">
            <button type="button" onClick={toggle} className="flex items-center gap-2 hover:text-black">
              <span className="inline-block w-3">{open ? "▾" : "▸"}</span>
              {year}
            </button>
          </td>
          <td
            className={`px-3 py-2 text-right text-sm font-semibold tabular-nums ${
              total < 0 ? "text-red-700" : "text-green-700"
            }`}
          >
            {fmtUSD(total)}
          </td>
        </tr>
      </tbody>
      {open && children}
    </>
  );
}

function PeriodBody({
  label,
  rows,
  categories,
  groupKey,
  onUpdate,
  onDelete,
  ghost,
  defaultOpen = true,
}: {
  label: string;
  rows: LedgerItem[];
  categories: ReturnType<typeof asTree>;
  groupKey: string;
  onUpdate: (args: Parameters<typeof api.updateTransaction>[0]) => void;
  onDelete: (id: number) => void;
  ghost: GhostHandlers;
  defaultOpen?: boolean;
}) {
  const [open, toggle] = useCollapsed(groupKey, defaultOpen);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <tbody>
      <tr className="bg-gray-50 border-y border-gray-200">
        <td colSpan={4} className="px-3 py-1.5 text-xs font-semibold text-gray-800 uppercase tracking-wide">
          <button
            type="button"
            onClick={toggle}
            className="flex items-center gap-2 hover:text-black"
          >
            <span className="inline-block w-3">{open ? "▾" : "▸"}</span>
            {label} <span className="text-gray-500 normal-case font-normal">({rows.length})</span>
          </button>
        </td>
        <td className={`px-3 py-1.5 text-right text-xs font-semibold tabular-nums ${total < 0 ? "text-red-700" : "text-green-700"}`}>
          {fmtUSD(total)}
        </td>
        <td />
        <td />
      </tr>
      {open &&
        rows.map((t) => (
          <LedgerRow
            key={t.id}
            t={t}
            categories={categories}
            onUpdate={onUpdate}
            onDelete={onDelete}
            ghost={ghost}
          />
        ))}
    </tbody>
  );
}

function HalfBody({
  label,
  rows,
  categories,
  groupKey,
  onUpdate,
  onDelete,
  ghost,
}: {
  label: string;
  rows: LedgerItem[];
  categories: ReturnType<typeof asTree>;
  groupKey: string;
  onUpdate: (args: Parameters<typeof api.updateTransaction>[0]) => void;
  onDelete: (id: number) => void;
  ghost: GhostHandlers;
}) {
  const [open, toggle] = useCollapsed(groupKey, true);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <tbody>
      <tr className="bg-gray-50 border-y border-gray-200">
        <td colSpan={4} className="px-3 py-1.5 text-xs font-semibold text-gray-800 uppercase tracking-wide">
          <button
            type="button"
            onClick={toggle}
            className="flex items-center gap-2 hover:text-black"
          >
            <span className="inline-block w-3">{open ? "▾" : "▸"}</span>
            {label}
          </button>
        </td>
        <td className={`px-3 py-1.5 text-right text-xs font-semibold tabular-nums ${total < 0 ? "text-red-700" : "text-green-700"}`}>
          {fmtUSD(total)}
        </td>
        <td />
        <td />
      </tr>
      {open &&
        rows.map((t) => (
          <LedgerRow
            key={t.id}
            t={t}
            categories={categories}
            onUpdate={onUpdate}
            onDelete={onDelete}
            ghost={ghost}
          />
        ))}
      {open && rows.length === 0 && (
        <tr>
          <td colSpan={7} className="px-3 py-3 text-center text-xs text-gray-700 italic">
            (no transactions)
          </td>
        </tr>
      )}
    </tbody>
  );
}

function LedgerRow({
  t,
  categories,
  onUpdate,
  onDelete,
  ghost,
}: {
  t: LedgerItem;
  categories: ReturnType<typeof asTree>;
  onUpdate: (args: Parameters<typeof api.updateTransaction>[0]) => void;
  onDelete: (id: number) => void;
  ghost: GhostHandlers;
}) {
  const colorOf = useCategoryColor();

  // Projected (ghost) row: a recurring occurrence or a budgeted item. Faint,
  // with an editable amount and an unchecked "lock in" box.
  if (isGhost(t)) {
    return (
      <tr className="border-t border-dashed border-gray-200 bg-blue-50/20 text-gray-500 italic">
        <td className="px-3 py-1.5 whitespace-nowrap truncate">{fmtDate(t.date)}</td>
        <td className="px-3 py-1.5 truncate">
          <span className="line-clamp-1" title={t.description}>
            {t.description}
          </span>
          <span className="ml-1.5 not-italic text-[9px] uppercase tracking-wide text-blue-600/70 align-middle">
            {t.ghostBudgetKey != null ? "budgeted" : "scheduled"}
          </span>
        </td>
        <td className="px-3 py-1.5 text-gray-400">—</td>
        <td className="px-3 py-1.5">
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block w-2 h-2 rounded-sm shrink-0"
              style={{ background: colorOf(t.category_id) ?? "transparent" }}
            />
            <span className="text-xs truncate not-italic text-gray-600">
              {t.category_name ?? "(uncategorized)"}
            </span>
          </div>
        </td>
        <td className={`px-3 py-1.5 text-right tabular-nums ${t.amount < 0 ? "text-red-600/80" : "text-green-700/80"}`}>
          <GhostAmount
            value={t.amount}
            onCommit={(amount) => t.ghostKey && ghost.setAmount(t.ghostKey, amount)}
          />
        </td>
        <td className="px-3 py-1.5 text-right tabular-nums text-gray-400 truncate">
          {t.running_balance != null ? fmtUSD(t.running_balance) : ""}
        </td>
        <td className="px-3 py-1.5 whitespace-nowrap">
          <div className="flex items-center justify-center gap-3">
            <input
              type="checkbox"
              checked={false}
              onChange={() => ghost.lockIn(t)}
              title="Lock this in as a real transaction"
              className="cursor-pointer align-middle"
            />
            <button
              type="button"
              onClick={() => t.ghostKey && ghost.dismiss(t.ghostKey)}
              title="Remove this projected item from the ledger"
              className="text-xs not-italic text-gray-400 hover:text-red-700"
            >
              Delete
            </button>
          </div>
        </td>
      </tr>
    );
  }

  const locked = isLockedProjection(t);
  return (
    <tr className={`border-t border-gray-100 hover:bg-gray-50 ${t.flagged ? "ring-1 ring-amber-300/40" : ""}`}>
      <td className="px-3 py-1.5 whitespace-nowrap text-gray-800 truncate">{fmtDate(t.date)}</td>
      <td className="px-3 py-1.5 truncate">
        <span className="line-clamp-1" title={t.description}>{t.title ?? t.description}</span>
      </td>
      <td className="px-3 py-1.5">
        <MemoCell value={t.memo} onSave={(v) => onUpdate({ id: t.id, memo: v })} />
      </td>
      <td className="px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block w-2 h-2 rounded-sm shrink-0"
            style={{ background: colorOf(t.category_id) ?? "transparent" }}
          />
          <select
            className="border border-gray-200 rounded px-1.5 py-0.5 text-xs bg-white w-full"
            value={t.category_id ?? ""}
            onChange={(e) =>
              onUpdate({ id: t.id, categoryId: e.target.value ? Number(e.target.value) : null })
            }
          >
            <option value="">(uncategorized)</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </td>
      <td className={`px-3 py-1.5 text-right tabular-nums truncate ${t.amount < 0 ? "text-red-700" : "text-green-700"}`}>
        {fmtUSD(t.amount)}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums text-gray-700 truncate">
        {t.running_balance != null ? fmtUSD(t.running_balance) : ""}
      </td>
      <td className="px-3 py-1.5 text-right whitespace-nowrap">
        {locked ? (
          <input
            type="checkbox"
            checked
            onChange={() => ghost.unlock(t.id)}
            title="Locked in from a projection — uncheck to undo"
            className="cursor-pointer align-middle"
          />
        ) : (
          <button
            onClick={() => {
              if (confirm("Delete this transaction?")) onDelete(t.id);
            }}
            className="text-xs text-gray-600 hover:text-red-700"
          >
            Delete
          </button>
        )}
      </td>
    </tr>
  );
}

function MemoCell({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  if (!editing) {
    return (
      <span
        className="line-clamp-1 cursor-text text-xs text-gray-700 block min-h-[1.2em]"
        onDoubleClick={() => {
          setDraft(value ?? "");
          setEditing(true);
        }}
        title="Double-click to add/edit a memo"
      >
        {value || <span className="text-gray-400 italic">add memo…</span>}
      </span>
    );
  }
  return (
    <input
      autoFocus
      className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs bg-white"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        // Save anything different — empty string is a valid "clear" intent.
        if (draft !== (value ?? "")) onSave(draft === "" ? null : draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value ?? "");
          setEditing(false);
        }
      }}
    />
  );
}

// Editable amount for a projected ghost row. Editing commits (materializes)
// the occurrence with the entered magnitude, preserving the expense/income sign.
function GhostAmount({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(Math.abs(value).toFixed(2));
  if (!editing) {
    return (
      <span
        className="cursor-text"
        onDoubleClick={() => {
          setDraft(Math.abs(value).toFixed(2));
          setEditing(true);
        }}
        title="Double-click to set the actual amount (locks it in)"
      >
        {fmtUSD(value)}
      </span>
    );
  }
  const sign = value < 0 ? -1 : 1;
  return (
    <input
      autoFocus
      type="number"
      step="0.01"
      className="w-24 border rounded px-1 py-0.5 text-sm bg-white text-right tabular-nums not-italic"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const mag = parseFloat(draft);
        if (!Number.isNaN(mag)) {
          const signed = sign * Math.abs(mag);
          if (signed !== value) onCommit(signed);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

function StartingBalanceRow({
  label,
  balance,
  date,
  onBalanceChange,
  onDateChange,
}: {
  label: string;
  balance: number;
  date: string;
  onBalanceChange: (n: number) => void;
  onDateChange: (d: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-xs text-gray-700 w-40 truncate">{label}</span>
      <OpeningBalanceInput initial={balance} onSave={onBalanceChange} />
      <span className="text-xs text-gray-600">as of</span>
      <input
        type="date"
        className="border border-gray-200 rounded px-2 py-1 text-sm bg-white"
        defaultValue={date}
        key={date}
        onBlur={(e) => {
          if (e.target.value && e.target.value !== date) onDateChange(e.target.value);
        }}
      />
    </div>
  );
}

function OpeningBalanceInput({
  initial,
  onSave,
}: {
  initial: number;
  onSave: (n: number) => void;
}) {
  const [v, setV] = useState(initial.toFixed(2));
  return (
    <input
      type="number"
      step="0.01"
      className="w-32 text-right border border-gray-200 rounded px-2 py-1 text-sm bg-white tabular-nums"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const n = parseFloat(v);
        if (!Number.isNaN(n) && Math.abs(n - initial) > 0.005) onSave(n);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
