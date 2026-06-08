import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { asTree, makeColorResolver, type ColorResolver } from "@/lib/categories";
import { ResizableTh, useColumnWidths } from "@/lib/columns";
import { fmtDate, fmtUSD } from "@/lib/formatting";
import type { Transaction } from "@/api/types";

// Plain-spreadsheet view of the Savings account: no pay-period grouping,
// no range selector, no search, no collapsible sections. Just every
// transaction in date order with the running balance.
export default function AccountSavings() {
  const qc = useQueryClient();
  const { widthOf, startResize } = useColumnWidths();

  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const categoryTree = useMemo(() => asTree(categories.data ?? []), [categories.data]);
  const colorOf = useMemo(() => makeColorResolver(categories.data ?? []), [categories.data]);

  const account = useMemo(
    () => (accounts.data ?? []).find((a) => a.kind === "savings"),
    [accounts.data],
  );

  const txns = useQuery({
    queryKey: ["transactions", "savings-all", account?.id],
    queryFn: () =>
      api.listTransactions({
        account_id: account?.id,
        // Pull the entire savings history — the account is small enough that
        // a single non-paginated read is simpler than range plumbing.
        limit: 50000,
      }),
    enabled: !!account,
  });

  const update = useMutation({
    mutationFn: (args: Parameters<typeof api.updateTransaction>[0]) =>
      api.updateTransaction(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
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

  // Backend returns DESC; flip to ASC so the oldest row is at the top and
  // the running balance reads naturally downward.
  const rows = useMemo(
    () => (txns.data?.rows ?? []).slice().reverse(),
    [txns.data],
  );
  const total = rows.reduce((s, r) => s + r.amount, 0);

  if (!account) {
    return (
      <div className="p-6 text-gray-900">
        <h1 className="text-2xl font-semibold">Savings</h1>
        <p className="text-sm text-gray-700 mt-2">No savings account found.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4 text-gray-900">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Savings</h1>
          <p className="text-xs text-gray-700 mt-1">{account.name}</p>
        </div>
        <div className="text-sm text-gray-700">
          {rows.length.toLocaleString()} transactions ·{" "}
          <span className={`font-medium tabular-nums ${total < 0 ? "text-red-700" : "text-green-700"}`}>
            {fmtUSD(total)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap text-sm">
        <span className="text-xs uppercase tracking-wide text-gray-700 font-semibold">
          Opening balance
        </span>
        <OpeningBalanceInput
          initial={account.opening_balance}
          onSave={(n) => updateAccount.mutate({ id: account.id, openingBalance: n })}
        />
        <span className="text-xs text-gray-600">as of</span>
        <input
          type="date"
          className="border border-gray-200 rounded px-2 py-1 text-sm bg-white"
          defaultValue={account.opening_date}
          key={account.opening_date}
          onBlur={(e) => {
            if (e.target.value && e.target.value !== account.opening_date) {
              updateAccount.mutate({ id: account.id, openingDate: e.target.value });
            }
          }}
        />
      </div>

      <div className="rounded-xl border border-gray-200 bg-white overflow-auto" style={{ maxHeight: "calc(100vh - 220px)" }}>
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
          <tbody>
            {rows.map((t) => (
              <SavingsRow
                key={t.id}
                t={t}
                categories={categoryTree}
                colorOf={colorOf}
                onUpdate={(args) => update.mutate(args)}
                onDelete={(id) => del.mutate(id)}
              />
            ))}
            {rows.length === 0 && !txns.isLoading && (
              <tr>
                <td colSpan={7} className="px-3 py-12 text-center text-sm text-gray-700">
                  No transactions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SavingsRow({
  t,
  categories,
  colorOf,
  onUpdate,
  onDelete,
}: {
  t: Transaction;
  categories: ReturnType<typeof asTree>;
  colorOf: ColorResolver;
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
