import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { asTree, makeColorResolver } from "@/lib/categories";
import { useCollapsed } from "@/lib/collapse";
import { ResizableTh, useColumnWidths } from "@/lib/columns";
import { fmtDate, fmtUSD, todayISO } from "@/lib/formatting";
import type { PayPeriod, Transaction, TxnFilter } from "@/api/types";
import SplitModal from "@/components/SplitModal";
import ImportModal from "@/routes/Import";

export default function Ledger() {
  const qc = useQueryClient();
  // Default limit is generous — typical multi-year ledgers fit easily, and
  // restricting to 500 was clipping older history from view. The table is
  // virtual-scroll capable so render cost is fine.
  const [filter, setFilter] = useState<TxnFilter>({ limit: 50000 });

  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const txns = useQuery({
    queryKey: ["transactions", filter],
    queryFn: () => api.listTransactions(filter),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.deleteTransaction(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });

  const markReviewed = useMutation({
    mutationFn: (ids: number[]) => api.markReviewed(ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
    },
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

  const accountById = useMemo(
    () => Object.fromEntries((accounts.data ?? []).map((a) => [a.id, a])),
    [accounts.data],
  );
  const categoryTree = useMemo(() => asTree(categories.data ?? []), [categories.data]);
  const colorOf = useMemo(() => makeColorResolver(categories.data ?? []), [categories.data]);
  const { widthOf, startResize } = useColumnWidths();

  const [splitTarget, setSplitTarget] = useState<Transaction | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // Default on. Without grouping, every one of the ~50K rows mounts into a
  // single flat tbody, and toggling grouping on later has to unmount+remount
  // every stateful inline editor — that's what froze the UI on click.
  const [groupByPP, setGroupByPP] = useState(true);

  // ASC-display view of the current page (backend returns DESC).
  const displayRows = useMemo(
    () => (txns.data?.rows ?? []).slice().reverse(),
    [txns.data],
  );

  // When pay-period grouping is on, fetch periods over the visible date span
  // using the active schedule history (so a historical biweekly → semimonthly
  // transition renders correctly without backfilling group memberships).
  const ppRange = useMemo(() => {
    if (!groupByPP || displayRows.length === 0) return null;
    return { from: displayRows[0].date, to: displayRows[displayRows.length - 1].date };
  }, [groupByPP, displayRows]);
  const payPeriods = useQuery({
    queryKey: ["pay-periods", "ledger", ppRange?.from, ppRange?.to],
    queryFn: () => api.generatePayPeriods(ppRange!.from, ppRange!.to),
    enabled: !!ppRange,
  });

  const grouped = useMemo(() => {
    if (!groupByPP || !payPeriods.data) return null;
    const buckets: Array<{ period: PayPeriod; rows: Transaction[] }> = payPeriods.data.map(
      (p) => ({ period: p, rows: [] as Transaction[] }),
    );
    const orphans: Transaction[] = [];
    // Both displayRows and buckets are sorted ASC by date — single pass with a
    // moving pointer avoids the O(rows × periods) Array.find that previously
    // spent seconds on multi-year ledgers. PayPeriod.end is exclusive.
    let pi = 0;
    for (const r of displayRows) {
      while (pi < buckets.length && r.date >= buckets[pi].period.end) pi++;
      if (pi < buckets.length && r.date >= buckets[pi].period.start) {
        buckets[pi].rows.push(r);
      } else {
        orphans.push(r);
      }
    }
    return { buckets: buckets.filter((b) => b.rows.length > 0), orphans };
  }, [groupByPP, payPeriods.data, displayRows]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Ledger</h1>
        <div className="flex items-center gap-3">
          {txns.data && (
            <span className="text-sm text-gray-500">
              {txns.data.total.toLocaleString()} transactions
            </span>
          )}
          <button
            onClick={() => setImportOpen(true)}
            className="px-3 py-1.5 text-sm rounded-md bg-gray-900 text-white hover:bg-gray-800"
            title="Import a CSV — or just drop one anywhere on this page"
          >
            Import CSV
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <select
          className="border rounded-md px-2 py-1.5 text-sm bg-white"
          value={filter.account_id ?? ""}
          onChange={(e) =>
            setFilter((f) => ({
              ...f,
              account_id: e.target.value ? Number(e.target.value) : undefined,
            }))
          }
        >
          <option value="">All accounts</option>
          {(accounts.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          className="border rounded-md px-2 py-1.5 text-sm bg-white"
          value={filter.category_id ?? ""}
          onChange={(e) =>
            setFilter((f) => ({
              ...f,
              category_id: e.target.value ? Number(e.target.value) : undefined,
            }))
          }
        >
          <option value="">All categories</option>
          {categoryTree.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Search description / memo…"
          className="border rounded-md px-2 py-1.5 text-sm bg-white flex-1 max-w-xs"
          value={filter.search ?? ""}
          onChange={(e) => setFilter((f) => ({ ...f, search: e.target.value || undefined }))}
        />
        <input
          type="date"
          className="border rounded-md px-2 py-1.5 text-sm bg-white"
          value={filter.date_from ?? ""}
          onChange={(e) => setFilter((f) => ({ ...f, date_from: e.target.value || undefined }))}
        />
        <input
          type="date"
          className="border rounded-md px-2 py-1.5 text-sm bg-white"
          value={filter.date_to ?? ""}
          onChange={(e) => setFilter((f) => ({ ...f, date_to: e.target.value || undefined }))}
        />
        <label className="flex items-center gap-1.5 text-sm text-gray-800 ml-2">
          <input
            type="checkbox"
            checked={filter.needs_review === true}
            onChange={(e) =>
              setFilter((f) => ({ ...f, needs_review: e.target.checked ? true : undefined }))
            }
          />
          Needs review only
        </label>
        <label className="flex items-center gap-1.5 text-sm text-gray-800 ml-2">
          <input
            type="checkbox"
            checked={groupByPP}
            onChange={(e) => setGroupByPP(e.target.checked)}
          />
          Group by pay period
        </label>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white overflow-auto" style={{ maxHeight: "calc(100vh - 220px)" }}>
        <table className="text-sm" style={{ tableLayout: "fixed", width: "max-content", minWidth: "100%" }}>
          <thead className="sticky top-0 bg-white shadow-[0_1px_0_rgba(0,0,0,0.06)] z-10">
            <tr className="text-left text-xs uppercase tracking-wide text-gray-700">
              <ResizableTh colId="date" widthOf={widthOf} startResize={startResize}>Date</ResizableTh>
              <ResizableTh colId="account" widthOf={widthOf} startResize={startResize}>Account</ResizableTh>
              <ResizableTh colId="description" widthOf={widthOf} startResize={startResize}>Description</ResizableTh>
              <ResizableTh colId="memo" widthOf={widthOf} startResize={startResize}>Memo</ResizableTh>
              <ResizableTh colId="category" widthOf={widthOf} startResize={startResize}>Category</ResizableTh>
              <ResizableTh colId="amount" widthOf={widthOf} startResize={startResize} className="text-right">Amount</ResizableTh>
              <ResizableTh colId="running" widthOf={widthOf} startResize={startResize} className="text-right">Running</ResizableTh>
              <ResizableTh colId="flags" widthOf={widthOf} startResize={startResize} className="text-center">C/F</ResizableTh>
              <ResizableTh colId="actions" widthOf={widthOf} startResize={startResize}></ResizableTh>
            </tr>
          </thead>
          {(() => {
            const renderRow = (t: Transaction) => {
              const isChild = t.split_of_id !== null;
              return (
                <tr key={t.id} className={`border-t hover:bg-gray-50 ${isChild ? "bg-gray-50/50" : ""} ${t.flagged ? "ring-1 ring-amber-300/40" : ""}`}>
                  <td className="px-3 py-1.5 whitespace-nowrap text-gray-700">
                    {isChild && <span className="text-gray-400 mr-1">↳</span>}
                    <InlineDate value={t.date} onSave={(date) => update.mutate({ id: t.id, date })} />
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap text-gray-700">
                    {accountById[t.account_id]?.name ?? `#${t.account_id}`}
                  </td>
                  <td className="px-3 py-1.5">
                    <InlineText
                      value={t.title ?? t.description}
                      onSave={(v) => update.mutate({ id: t.id, title: v || null })}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <InlineMemo
                      value={t.memo}
                      onSave={(v) => update.mutate({ id: t.id, memo: v })}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="inline-block w-2 h-2 rounded-sm shrink-0"
                        style={{ background: colorOf(t.category_id) ?? "transparent" }}
                      />
                      <select
                        className="border rounded px-1.5 py-0.5 text-xs bg-white"
                        value={t.category_id ?? ""}
                        onChange={(e) =>
                          update.mutate({
                            id: t.id,
                            categoryId: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                      >
                        <option value="">(uncategorized)</option>
                        {categoryTree.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </td>
                  <td
                    className={`px-3 py-1.5 text-right tabular-nums ${t.amount < 0 ? "text-red-600" : t.amount > 0 ? "text-green-700" : "text-gray-400"}`}
                  >
                    <InlineNumber
                      value={t.amount}
                      onSave={(amount) => update.mutate({ id: t.id, amount })}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-700 truncate">
                    {t.running_balance != null ? fmtUSD(t.running_balance) : ""}
                  </td>
                  <td className="px-3 py-1.5 text-center whitespace-nowrap">
                    {t.needs_review && (
                      <button
                        title="Auto-categorized — click to mark reviewed"
                        onClick={() => markReviewed.mutate([t.id])}
                        className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 hover:bg-amber-200 mr-1"
                      >
                        Review
                      </button>
                    )}
                    <button
                      title={t.cleared ? "Cleared" : "Mark cleared"}
                      onClick={() => update.mutate({ id: t.id, cleared: !t.cleared })}
                      className={`text-xs mr-1 ${t.cleared ? "text-green-700" : "text-gray-400 hover:text-gray-600"}`}
                    >
                      ✓
                    </button>
                    <button
                      title={t.flagged ? "Flagged" : "Flag"}
                      onClick={() => update.mutate({ id: t.id, flagged: !t.flagged })}
                      className={`text-xs ${t.flagged ? "text-amber-600" : "text-gray-400 hover:text-gray-600"}`}
                    >
                      ⚑
                    </button>
                  </td>
                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                    {!isChild && (
                      <button
                        onClick={() => setSplitTarget(t)}
                        className="text-xs text-gray-500 hover:text-black mr-3"
                      >
                        Split
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (confirm("Delete this transaction?")) del.mutate(t.id);
                      }}
                      className="text-xs text-gray-500 hover:text-red-600"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            };

            if (displayRows.length === 0) {
              return (
                <tbody>
                  {!txns.isLoading && (
                    <tr>
                      <td colSpan={9} className="px-3 py-12 text-center text-sm text-gray-500">
                        No transactions yet. Drop a CSV anywhere here (or use Import CSV) to get started.
                      </td>
                    </tr>
                  )}
                </tbody>
              );
            }
            // CRITICAL: when grouping is on we must NOT fall through to the flat
            // tbody while pay-periods is loading/erroring. Mounting every row +
            // its 4 stateful inline editors synchronously is what wedged the tab.
            if (groupByPP) {
              if (payPeriods.isError) {
                return (
                  <tbody>
                    <tr>
                      <td colSpan={9} className="px-3 py-12 text-center text-sm text-amber-700">
                        Couldn't group by pay period: {String((payPeriods.error as Error | null)?.message ?? "no schedule configured")}.{" "}
                        <button onClick={() => setGroupByPP(false)} className="underline">
                          Show ungrouped list
                        </button>
                      </td>
                    </tr>
                  </tbody>
                );
              }
              if (!grouped) {
                return (
                  <tbody>
                    <tr>
                      <td colSpan={9} className="px-3 py-12 text-center text-sm text-gray-500">
                        Loading pay periods…
                      </td>
                    </tr>
                  </tbody>
                );
              }
              // Buckets are in ASC date order, so the last one is the most
              // recent pay period. Open only that one — opening every group by
              // default would mount tens of thousands of stateful row editors
              // at once and freeze the UI.
              const lastBucket = grouped.buckets[grouped.buckets.length - 1];
              const curYear = todayISO().slice(0, 4);
              const years: Array<{ year: string; buckets: typeof grouped.buckets }> = [];
              for (const b of grouped.buckets) {
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
                      <YearTbody
                        key={yg.year}
                        year={yg.year}
                        total={yearTotal}
                        colSpan={9}
                        groupKey={`ledger:year:${yg.year}`}
                        defaultOpen={yg.year === curYear}
                      >
                        {yg.buckets.map((bucket) => (
                          <PeriodTbody
                            key={bucket.period.start}
                            label={bucket.period.label}
                            rows={bucket.rows}
                            colSpan={9}
                            groupKey={`ledger:pp:${bucket.period.start}`}
                            renderRow={renderRow}
                            defaultOpen={bucket === lastBucket}
                          />
                        ))}
                      </YearTbody>
                    );
                  })}
                  {grouped.orphans.length > 0 && (
                    <PeriodTbody
                      label={`Outside any pay period (${grouped.orphans.length})`}
                      rows={grouped.orphans}
                      colSpan={9}
                      groupKey="ledger:pp:orphans"
                      renderRow={renderRow}
                      defaultOpen={false}
                    />
                  )}
                </>
              );
            }
            return (
              <tbody>
                {displayRows.map(renderRow)}
              </tbody>
            );
          })()}
        </table>
      </div>

      {splitTarget && <SplitModal txn={splitTarget} onClose={() => setSplitTarget(null)} />}
      <ImportModal open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}

function YearTbody({
  year,
  total,
  colSpan,
  groupKey,
  defaultOpen,
  children,
}: {
  year: string;
  total: number;
  colSpan: number;
  groupKey: string;
  defaultOpen: boolean;
  children: React.ReactNode;
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

function PeriodTbody({
  label,
  rows,
  colSpan,
  groupKey,
  renderRow,
  defaultOpen = true,
}: {
  label: string;
  rows: Transaction[];
  colSpan: number;
  groupKey: string;
  renderRow: (t: Transaction) => React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, toggle] = useCollapsed(groupKey, defaultOpen);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <tbody>
      <tr className="bg-gray-50 border-y border-gray-200">
        <td colSpan={colSpan - 1} className="px-3 py-1.5 text-xs font-semibold text-gray-800 uppercase tracking-wide">
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
      </tr>
      {open && rows.map(renderRow)}
    </tbody>
  );
}

function InlineText({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing) {
    return (
      <span
        className="line-clamp-1 cursor-text"
        onDoubleClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        title="Double-click to edit"
      >
        {value || <span className="text-gray-400">—</span>}
      </span>
    );
  }
  return (
    <input
      autoFocus
      className="w-full border rounded px-1 py-0.5 text-sm bg-white"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft !== value) onSave(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          setEditing(false);
        }
      }}
    />
  );
}

function InlineNumber({ value, onSave }: { value: number; onSave: (n: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value.toFixed(2));
  if (!editing) {
    return (
      <span
        className="cursor-text tabular-nums"
        onDoubleClick={() => {
          setDraft(value.toFixed(2));
          setEditing(true);
        }}
        title="Double-click to edit"
      >
        {fmtUSD(value)}
      </span>
    );
  }
  return (
    <input
      autoFocus
      type="number"
      step="0.01"
      className="w-24 border rounded px-1 py-0.5 text-sm bg-white text-right tabular-nums"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const n = parseFloat(draft);
        if (!Number.isNaN(n) && n !== value) onSave(n);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value.toFixed(2));
          setEditing(false);
        }
      }}
    />
  );
}

function InlineMemo({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  if (!editing) {
    return (
      <span
        className="line-clamp-1 cursor-text text-xs text-gray-700"
        onDoubleClick={() => {
          setDraft(value ?? "");
          setEditing(true);
        }}
        title="Double-click to add a memo"
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
        const next = draft.trim();
        if (next !== (value ?? "")) onSave(next === "" ? null : next);
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

function InlineDate({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <span
        className="cursor-text"
        onDoubleClick={() => setEditing(true)}
        title="Double-click to edit"
      >
        {fmtDate(value)}
      </span>
    );
  }
  return (
    <input
      autoFocus
      type="date"
      className="border rounded px-1 py-0.5 text-sm bg-white"
      defaultValue={value}
      onBlur={(e) => {
        setEditing(false);
        if (e.target.value && e.target.value !== value) onSave(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}
