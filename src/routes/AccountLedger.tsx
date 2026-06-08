import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { asTree, makeColorResolver, CategoryColorContext, useCategoryColor } from "@/lib/categories";
import { ResizableTh, useColumnWidths } from "@/lib/columns";
import { fmtDate, fmtUSD, todayISO } from "@/lib/formatting";
import { projectOccurrences } from "@/lib/recurrence";
import { useCollapsed } from "@/lib/collapse";
import type { PayPeriod, Transaction } from "@/api/types";

// A ledger row is either a real transaction or a projected "ghost" occurrence
// of a recurring transaction (future-dated, editable, forecast-only).
// Real rows that are credit-card payments carry the charge window so they can
// expand to show the underlying card charges.
type LedgerItem = Transaction & {
  ghostBillId?: number;
  ccChargesFrom?: string;
  ccChargesTo?: string;
};
const isGhost = (i: LedgerItem): boolean => i.ghostBillId != null;

// Heuristic: is this checking transaction a payment toward the credit card?
function isCcPayment(t: LedgerItem): boolean {
  if (t.ghostBillId != null || t.amount >= 0) return false;
  const d = (t.title ?? t.description ?? "").toUpperCase();
  return (
    d.includes("APPLECARD") ||
    d.includes("CREDIT CARD") ||
    d.includes("CARD PAYMENT") ||
    (t.category_name === "Transfer" && d.includes("CARD"))
  );
}

// Provides the credit-account id to ledger rows so a payment row can fetch the
// charges it paid off, without threading the id through every grouping wrapper.
const CcAccountContext = createContext<number | null>(null);

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

  // Pinned row reflects what would happen if we paid the credit card off
  // as the last transaction of the displayed period. That means we need the
  // CC's full current liability (opening + every CC transaction up to
  // range.to), NOT just this period's activity. Otherwise a payment already
  // made in the bank ledger this period double-counts.
  const ccBalanceQuery = useQuery({
    queryKey: ["account-balance-as-of", creditAccount?.id, range.to],
    queryFn: () => api.accountBalanceAsOf(creditAccount!.id, range.to),
    enabled: showPinnedCcPayment && !!creditAccount,
  });

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

  // CC current balance: negative = still owed on the card; positive = overpaid.
  // Adding it to the bank's last running balance gives the post-CC-payoff bank
  // balance: subtracting if owed, adding back if overpaid.
  const ccCurrentBalance = ccBalanceQuery.data ?? 0;
  const ccPinnedRunning = useMemo(() => {
    const lastWithRunning = [...rows].reverse().find((r) => r.running_balance != null);
    const baseline = lastWithRunning?.running_balance ?? 0;
    return baseline + ccCurrentBalance;
  }, [rows, ccCurrentBalance]);

  // Recurring transactions for this account, projected forward as editable
  // "ghost" rows (Bank Account only). They extend the running balance as a
  // forecast and can be locked in (materialized) by editing or clearing.
  const bills = useQuery({ queryKey: ["recurring-bills"], queryFn: api.listRecurringBills });
  const catNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of categories.data ?? []) m.set(c.id, c.name);
    return m;
  }, [categories.data]);

  const ghosts: LedgerItem[] = useMemo(() => {
    if (!showProjections || !account) return [];
    const t = todayISO();
    const afterToday = addDaysISO(t, 1);
    const horizon = addDaysISO(t, 730); // 2-year forecast
    const startISO = range.from > afterToday ? range.from : afterToday;
    const endISO = range.to < horizon ? range.to : horizon;
    if (startISO > endISO) return [];
    // Skip occurrences already locked in (a real txn carries from_bill_id).
    const materialized = new Set(
      rows.filter((r) => r.from_bill_id != null).map((r) => `${r.from_bill_id}:${r.date}`),
    );
    const occ = projectOccurrences(bills.data ?? [], startISO, endISO).filter(
      (o) => o.account_id === account.id && !materialized.has(`${o.bill_id}:${o.date}`),
    );
    // Forecast running balance threads forward from today's actual balance.
    let run = account.current_balance;
    return occ.map((o, i) => {
      run += o.amount;
      return {
        id: -1 - i,
        account_id: o.account_id,
        date: o.date,
        description: o.name,
        title: null,
        category_id: o.category_id,
        category_name: o.category_id != null ? catNameById.get(o.category_id) ?? null : null,
        amount: o.amount,
        memo: null,
        cleared: false,
        flagged: false,
        needs_review: false,
        split_of_id: null,
        from_bill_id: o.bill_id,
        running_balance: run,
        ghostBillId: o.bill_id,
      };
    });
  }, [showProjections, account, range.from, range.to, rows, bills.data, catNameById]);

  // Real rows + ghosts, ASC by date (real before ghost on the same day).
  // Real rows are cloned so we can safely tag credit-card payments with the
  // charge window they cover (never mutate react-query's cached objects).
  const items: LedgerItem[] = useMemo(() => {
    const merged: LedgerItem[] = [...rows.map((r) => ({ ...r })), ...ghosts];
    merged.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (isGhost(a) ? 1 : 0) - (isGhost(b) ? 1 : 0) ||
        a.id - b.id,
    );
    // Tag each credit-card payment with the window of charges it pays off:
    // (previous payment date, this payment date].
    if (showPinnedCcPayment && creditAccount) {
      let lastPay = account?.opening_date ?? "1900-01-01";
      for (const it of merged) {
        if (isGhost(it)) continue;
        if (isCcPayment(it)) {
          it.ccChargesFrom = lastPay === (account?.opening_date ?? "1900-01-01") ? lastPay : addDaysISO(lastPay, 1);
          it.ccChargesTo = it.date;
          lastPay = it.date;
        }
      }
    }
    return merged;
  }, [rows, ghosts, showPinnedCcPayment, creditAccount, account]);

  const materialize = useMutation({
    mutationFn: (a: { billId: number; date: string; amount: number; cleared: boolean }) =>
      api.materializeOccurrence(a),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const onMaterialize = (billId: number, date: string, amount: number, cleared: boolean) =>
    materialize.mutate({ billId, date, amount, cleared });

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
    <CcAccountContext.Provider value={showPinnedCcPayment ? creditAccount?.id ?? null : null}>
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
                              onMaterialize={onMaterialize}
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
                        onMaterialize={onMaterialize}
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
                      onMaterialize={onMaterialize}
                    />
                    <HalfBody
                      label={`Days 16 – end of month (${groupedHalves.secondHalf.length})`}
                      rows={groupedHalves.secondHalf}
                      categories={categoryTree}
                      groupKey={`acct:${accountKind}:half2:${range.from}`}
                      onUpdate={(args) => update.mutate(args)}
                      onDelete={(id) => del.mutate(id)}
                      onMaterialize={onMaterialize}
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
                      onMaterialize={onMaterialize}
                    />
                  ))}
                </tbody>
              );
            })()}
            {showPinnedCcPayment && creditAccount && (
              <tfoot className="sticky bottom-0 bg-amber-50 border-t-2 border-amber-200">
                <tr>
                  <td className="px-3 py-2 text-amber-900 font-medium" colSpan={4}>
                    Credit Card Payment{" "}
                    <span className="text-xs text-amber-700 font-normal">
                      (projected — pays off {creditAccount.name} balance as of {range.label})
                    </span>
                  </td>
                  <td className={`px-3 py-2 text-right font-semibold tabular-nums ${ccCurrentBalance < 0 ? "text-red-700" : "text-amber-900"}`}>
                    {fmtUSD(ccCurrentBalance)}
                  </td>
                  <td className={`px-3 py-2 text-right font-semibold tabular-nums ${ccPinnedRunning < 0 ? "text-red-700" : "text-amber-900"}`}>
                    {fmtUSD(ccPinnedRunning)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
    </CcAccountContext.Provider>
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
  onMaterialize,
  defaultOpen = true,
}: {
  label: string;
  rows: LedgerItem[];
  categories: ReturnType<typeof asTree>;
  groupKey: string;
  onUpdate: (args: Parameters<typeof api.updateTransaction>[0]) => void;
  onDelete: (id: number) => void;
  onMaterialize: (billId: number, date: string, amount: number, cleared: boolean) => void;
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
            onMaterialize={onMaterialize}
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
  onMaterialize,
}: {
  label: string;
  rows: LedgerItem[];
  categories: ReturnType<typeof asTree>;
  groupKey: string;
  onUpdate: (args: Parameters<typeof api.updateTransaction>[0]) => void;
  onDelete: (id: number) => void;
  onMaterialize: (billId: number, date: string, amount: number, cleared: boolean) => void;
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
            onMaterialize={onMaterialize}
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
  onMaterialize,
}: {
  t: LedgerItem;
  categories: ReturnType<typeof asTree>;
  onUpdate: (args: Parameters<typeof api.updateTransaction>[0]) => void;
  onDelete: (id: number) => void;
  onMaterialize: (billId: number, date: string, amount: number, cleared: boolean) => void;
}) {
  const colorOf = useCategoryColor();
  const creditAccountId = useContext(CcAccountContext);
  const [expanded, setExpanded] = useState(false);
  const isCcPay =
    t.ghostBillId == null &&
    t.ccChargesFrom != null &&
    t.ccChargesTo != null &&
    creditAccountId != null;
  const charges = useQuery({
    queryKey: ["cc-charges", creditAccountId, t.ccChargesFrom, t.ccChargesTo, t.id],
    queryFn: () =>
      api.listTransactions({
        account_id: creditAccountId!,
        date_from: t.ccChargesFrom!,
        date_to: t.ccChargesTo!,
        limit: 500,
      }),
    enabled: isCcPay && expanded,
  });
  const chargeRows = (charges.data?.rows ?? []).filter((c) => c.amount < 0);
  const chargeTotal = chargeRows.reduce((s, c) => s + c.amount, 0);
  // Projected (ghost) occurrence of a recurring transaction: faint, editable
  // amount, and a "lock in" action. Editing the amount or clicking the check
  // materializes this one occurrence into a real transaction.
  if (t.ghostBillId != null) {
    const billId = t.ghostBillId;
    return (
      <tr className="border-t border-dashed border-gray-200 bg-blue-50/20 text-gray-500 italic">
        <td className="px-3 py-1.5 whitespace-nowrap truncate">{fmtDate(t.date)}</td>
        <td className="px-3 py-1.5 truncate">
          <span className="line-clamp-1" title={t.description}>
            {t.description}
          </span>
          <span className="ml-1.5 not-italic text-[9px] uppercase tracking-wide text-blue-600/70 align-middle">
            scheduled
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
            onCommit={(amount) => onMaterialize(billId, t.date, amount, false)}
          />
        </td>
        <td className="px-3 py-1.5 text-right tabular-nums text-gray-400 truncate">
          {t.running_balance != null ? fmtUSD(t.running_balance) : ""}
        </td>
        <td className="px-3 py-1.5 text-right whitespace-nowrap">
          <button
            title="Mark cleared & lock this occurrence in"
            onClick={() => onMaterialize(billId, t.date, t.amount, true)}
            className="text-xs not-italic text-gray-500 hover:text-green-700"
          >
            ✓ Lock in
          </button>
        </td>
      </tr>
    );
  }
  return (
    <>
    <tr className={`border-t border-gray-100 hover:bg-gray-50 ${t.flagged ? "ring-1 ring-amber-300/40" : ""}`}>
      <td className="px-3 py-1.5 whitespace-nowrap text-gray-800 truncate">{fmtDate(t.date)}</td>
      <td className="px-3 py-1.5 truncate">
        <span className="flex items-center gap-1">
          {isCcPay && (
            <button
              type="button"
              onClick={() => setExpanded((o) => !o)}
              className="text-gray-400 hover:text-gray-700 shrink-0"
              title="Show the card charges this payment covers"
            >
              <span className="inline-block w-3">{expanded ? "▾" : "▸"}</span>
            </button>
          )}
          <span className="line-clamp-1" title={t.description}>{t.title ?? t.description}</span>
        </span>
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
        <button
          onClick={() => {
            if (confirm("Delete this transaction?")) onDelete(t.id);
          }}
          className="text-xs text-gray-600 hover:text-red-700"
        >
          Delete
        </button>
      </td>
    </tr>
    {isCcPay && expanded && (
      <>
        {charges.isLoading && (
          <tr className="bg-gray-50/60">
            <td colSpan={7} className="px-3 py-2 pl-10 text-xs text-gray-500">
              Loading card charges…
            </td>
          </tr>
        )}
        {!charges.isLoading && chargeRows.length === 0 && (
          <tr className="bg-gray-50/60">
            <td colSpan={7} className="px-3 py-2 pl-10 text-xs text-gray-500 italic">
              No card charges found between {fmtDate(t.ccChargesFrom!)} and {fmtDate(t.ccChargesTo!)}.
            </td>
          </tr>
        )}
        {chargeRows.map((c) => (
          <tr key={`cc-${c.id}`} className="bg-gray-50/60 text-xs text-gray-600">
            <td className="px-3 py-1 pl-10 whitespace-nowrap">{fmtDate(c.date)}</td>
            <td className="px-3 py-1 truncate" colSpan={3}>
              <span className="line-clamp-1" title={c.description}>{c.title ?? c.description}</span>
            </td>
            <td className="px-3 py-1 text-right tabular-nums text-red-700">{fmtUSD(c.amount)}</td>
            <td className="px-3 py-1" />
            <td className="px-3 py-1 text-right text-[10px] text-gray-400 italic whitespace-nowrap">
              on Credit Card
            </td>
          </tr>
        ))}
        {chargeRows.length > 0 && (
          <tr className="bg-gray-50 text-xs border-b border-gray-200">
            <td colSpan={4} className="px-3 py-1 pl-10 text-gray-500">
              {chargeRows.length} charge{chargeRows.length === 1 ? "" : "s"} · already counted once via the payment above
            </td>
            <td className="px-3 py-1 text-right tabular-nums font-medium text-gray-700">
              {fmtUSD(chargeTotal)}
            </td>
            <td colSpan={2} />
          </tr>
        )}
      </>
    )}
    </>
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
