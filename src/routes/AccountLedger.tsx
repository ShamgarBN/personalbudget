import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { asTree } from "@/lib/categories";
import { ResizableTh, useColumnWidths } from "@/lib/columns";
import { fmtDate, fmtUSD } from "@/lib/formatting";
import type { PayPeriod, Transaction } from "@/api/types";

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
  defaultRange = "month",
}: {
  accountKind: "checking" | "credit" | "savings";
  title: string;
  halfMonthCollapse?: boolean;
  showPinnedCcPayment?: boolean;
  /// When true (Bank Account tab), also show an editor for the credit card
  /// account's opening balance inside the starting-balances section.
  showCcStartingBalance?: boolean;
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

  // When pay-period grouping is on, fetch the periods that overlap the
  // visible range. Using the displayed-row span (rather than range.from/to)
  // keeps the query stable when an "all time" view has no rows yet.
  const ppRange = useMemo(() => {
    if (!groupByPP || rows.length === 0) return null;
    return { from: rows[0].date, to: rows[rows.length - 1].date };
  }, [groupByPP, rows]);
  const payPeriods = useQuery({
    queryKey: ["pay-periods", "account-ledger", ppRange?.from, ppRange?.to],
    queryFn: () => api.generatePayPeriods(ppRange!.from, ppRange!.to),
    enabled: !!ppRange,
  });

  const groupedPP = useMemo(() => {
    if (!groupByPP || !payPeriods.data) return null;
    const buckets: Array<{ period: PayPeriod; rows: Transaction[] }> =
      payPeriods.data.map((p) => ({ period: p, rows: [] as Transaction[] }));
    const orphans: Transaction[] = [];
    // Both rows and buckets are sorted ASC by date — single pass with a
    // moving pointer avoids O(rows × periods). PayPeriod.end is exclusive.
    let pi = 0;
    for (const r of rows) {
      while (pi < buckets.length && r.date >= buckets[pi].period.end) pi++;
      if (pi < buckets.length && r.date >= buckets[pi].period.start) {
        buckets[pi].rows.push(r);
      } else {
        orphans.push(r);
      }
    }
    return { buckets: buckets.filter((b) => b.rows.length > 0), orphans };
  }, [groupByPP, payPeriods.data, rows]);

  const groupedHalves = useMemo(() => {
    // Pay-period grouping wins when both are eligible.
    if (groupedPP) return null;
    if (!halfMonthCollapse || mode.kind !== "month") return null;
    const firstHalf: Transaction[] = [];
    const secondHalf: Transaction[] = [];
    for (const r of rows) {
      const day = new Date(r.date + "T00:00:00").getDate();
      (day <= 15 ? firstHalf : secondHalf).push(r);
    }
    return { firstHalf, secondHalf };
  }, [halfMonthCollapse, mode, rows, groupedPP]);

  return (
    <div className="p-6 space-y-4 text-gray-900">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
          <p className="text-xs text-gray-700 mt-1">
            {account ? account.name : "—"} · {range.label}
          </p>
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
              if (rows.length === 0) {
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
                const lastIdx = groupedPP.buckets.length - 1;
                return (
                  <>
                    {groupedPP.buckets.map((bucket, i) => (
                      <PeriodBody
                        key={bucket.period.start}
                        label={bucket.period.label}
                        rows={bucket.rows}
                        categories={categoryTree}
                        onUpdate={(args) => update.mutate(args)}
                        onDelete={(id) => del.mutate(id)}
                        defaultOpen={i === lastIdx}
                      />
                    ))}
                    {groupedPP.orphans.length > 0 && (
                      <PeriodBody
                        label={`Outside any pay period (${groupedPP.orphans.length})`}
                        rows={groupedPP.orphans}
                        categories={categoryTree}
                        onUpdate={(args) => update.mutate(args)}
                        onDelete={(id) => del.mutate(id)}
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
                      onUpdate={(args) => update.mutate(args)}
                      onDelete={(id) => del.mutate(id)}
                    />
                    <HalfBody
                      label={`Days 16 – end of month (${groupedHalves.secondHalf.length})`}
                      rows={groupedHalves.secondHalf}
                      categories={categoryTree}
                      onUpdate={(args) => update.mutate(args)}
                      onDelete={(id) => del.mutate(id)}
                    />
                  </>
                );
              }
              return (
                <tbody>
                  {rows.map((t) => (
                    <LedgerRow
                      key={t.id}
                      t={t}
                      categories={categoryTree}
                      onUpdate={(args) => update.mutate(args)}
                      onDelete={(id) => del.mutate(id)}
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
  );
}

function PeriodBody({
  label,
  rows,
  categories,
  onUpdate,
  onDelete,
  defaultOpen = true,
}: {
  label: string;
  rows: Transaction[];
  categories: ReturnType<typeof asTree>;
  onUpdate: (args: Parameters<typeof api.updateTransaction>[0]) => void;
  onDelete: (id: number) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <tbody>
      <tr className="bg-gray-50 border-y border-gray-200">
        <td colSpan={4} className="px-3 py-1.5 text-xs font-semibold text-gray-800 uppercase tracking-wide">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
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
          />
        ))}
    </tbody>
  );
}

function HalfBody({
  label,
  rows,
  categories,
  onUpdate,
  onDelete,
}: {
  label: string;
  rows: Transaction[];
  categories: ReturnType<typeof asTree>;
  onUpdate: (args: Parameters<typeof api.updateTransaction>[0]) => void;
  onDelete: (id: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <tbody>
      <tr className="bg-gray-50 border-y border-gray-200">
        <td colSpan={4} className="px-3 py-1.5 text-xs font-semibold text-gray-800 uppercase tracking-wide">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
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
}: {
  t: Transaction;
  categories: ReturnType<typeof asTree>;
  onUpdate: (args: Parameters<typeof api.updateTransaction>[0]) => void;
  onDelete: (id: number) => void;
}) {
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
