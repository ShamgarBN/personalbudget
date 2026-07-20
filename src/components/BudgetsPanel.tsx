import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { fmtUSD, fmtDate, todayISO } from "@/lib/formatting";
import { ColorCell, RenameableName } from "@/components/categoryEditors";
import type { BudgetSummaryRow, Category } from "@/api/types";

// Budgets & Categories — one page for everything about categories: color,
// name, budget basis, allocation, and lifecycle (create/delete/archive).
// Sections: per pay period / per month (budgeted), everything else (typing an
// amount promotes it to budgeted), income & special, archived.
export default function BudgetsPanel() {
  const qc = useQueryClient();
  const [activePeriod, setActivePeriod] = useState<number>(0);

  const schedules = useQuery({
    queryKey: ["pay-period-schedules"],
    queryFn: api.listPayPeriodSchedules,
  });
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const catById = useMemo(
    () => new Map((categories.data ?? []).map((c) => [c.id, c])),
    [categories.data],
  );

  const periods = useQuery({
    queryKey: ["pay-periods", "current"],
    queryFn: async () => {
      // Pull a ±2-period window around today.
      const t = new Date();
      const from = new Date(t.getFullYear(), t.getMonth() - 2, 1)
        .toISOString()
        .slice(0, 10);
      const to = new Date(t.getFullYear(), t.getMonth() + 3, 1)
        .toISOString()
        .slice(0, 10);
      return api.generatePayPeriods(from, to);
    },
    enabled: !!schedules.data && schedules.data.length > 0,
  });

  const currentIdx = useMemo(() => {
    const arr = periods.data ?? [];
    const today = todayISO();
    const idx = arr.findIndex((p) => p.start <= today && today < p.end);
    return idx >= 0 ? idx : Math.floor(arr.length / 2);
  }, [periods.data]);

  const idx = activePeriod || currentIdx;
  const period = periods.data?.[idx];

  // Calendar month containing the period start — monthly-basis categories
  // measure their spend against this window instead of the pay period.
  const monthBounds = useMemo(() => {
    const base = period?.start ?? todayISO();
    const d = new Date(base + "T00:00:00");
    const ms = new Date(d.getFullYear(), d.getMonth(), 1);
    const me = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const iso = (x: Date) => x.toISOString().slice(0, 10);
    return { start: iso(ms), end: iso(me), label: ms.toLocaleDateString("en-US", { month: "long", year: "numeric" }) };
  }, [period?.start]);

  const summary = useQuery({
    queryKey: ["budget-summary", period?.start, period?.end, monthBounds.start, monthBounds.end],
    queryFn: () => api.budgetSummary(period!.start, period!.end, monthBounds.start, monthBounds.end),
    enabled: !!period,
  });

  const allocations = useQuery({
    queryKey: ["budget-allocations"],
    queryFn: api.listBudgetAllocations,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["budget-summary"] });
    qc.invalidateQueries({ queryKey: ["budget-allocations"] });
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["transactions"] });
  };

  const upsert = useMutation({
    mutationFn: (vars: { categoryId: number; amount: number }) =>
      api.upsertBudgetAllocation({
        id:
          allocations.data?.find(
            (a) => a.category_id === vars.categoryId && a.effective_to === null,
          )?.id ?? 0,
        category_id: vars.categoryId,
        amount: vars.amount,
        effective_from: period?.start ?? todayISO(),
        effective_to: null,
      }),
    onSuccess: invalidate,
  });

  // Setting an allocation on a not-yet-budgeted category promotes it to
  // budgeted and stores the amount.
  const startBudgeting = useMutation({
    mutationFn: async (vars: { categoryId: number; amount: number }) => {
      await api.updateCategory({ id: vars.categoryId, isBudgeted: true });
      await api.upsertBudgetAllocation({
        id: 0,
        category_id: vars.categoryId,
        amount: vars.amount,
        effective_from: period?.start ?? todayISO(),
        effective_to: null,
      });
    },
    onSuccess: invalidate,
  });

  // Generic category updater: color / name / basis / budgeted / archive.
  const updateCat = useMutation({
    mutationFn: (args: Parameters<typeof api.updateCategory>[0]) => api.updateCategory(args),
    onSuccess: invalidate,
    onError: (e) => alert(String(e)),
  });

  const delCat = useMutation({
    mutationFn: (id: number) => api.deleteCategory(id),
    onSuccess: invalidate,
    onError: (e: unknown, id: number) => {
      // The backend refuses to delete a category that's still attached to
      // transactions. Offer the archive path the error suggests.
      const msg = String(e).replace(/^Error:\s*/, "");
      if (msg.toLowerCase().includes("in use")) {
        if (
          confirm(
            `${msg}\n\nArchive it instead? It'll be hidden from pickers and ledgers, but its existing transactions keep their category.`,
          )
        ) {
          updateCat.mutate({ id, archived: true });
        }
      } else {
        alert(msg);
      }
    },
  });

  const [newCatName, setNewCatName] = useState("");
  const [newCatParent, setNewCatParent] = useState<number | "">("");
  const createCat = useMutation({
    mutationFn: () =>
      api.createCategory({
        name: newCatName.trim(),
        parentId: newCatParent === "" ? null : Number(newCatParent),
      }),
    onSuccess: () => {
      invalidate();
      setNewCatName("");
    },
  });

  const rows = summary.data?.rows ?? [];
  const budgeted = rows.filter((r) => r.is_budgeted);
  const ppRows = budgeted.filter((r) => r.budget_basis === "per_pay_period");
  const moRows = budgeted.filter((r) => r.budget_basis === "monthly");
  const otherRows = rows.filter((r) => !r.is_budgeted);
  const totalAllocated = budgeted.reduce((s, r) => s + r.allocated, 0);
  const totalSpent = rows.reduce((s, r) => s + r.spent, 0);
  const overBudget = budgeted.filter((r) => r.available < 0).length;

  // Categories that budget_summary excludes (income + protected) still need
  // color/rename/delete somewhere — that's here now, not Settings.
  const activeCats = (categories.data ?? []).filter((c) => !c.archived);
  const specialCats = activeCats
    .filter((c) => c.is_income || c.is_protected)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const archivedCats = (categories.data ?? [])
    .filter((c) => c.archived)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const parentOptions = activeCats
    .filter((c) => c.parent_id === null && !c.is_protected && !c.is_income)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const catCtx: CatCtx = {
    catById,
    onColor: (id, color) => updateCat.mutate({ id, color }),
    onRename: (id, name) => updateCat.mutate({ id, name }),
    onBasis: (id, basis) => updateCat.mutate({ id, budgetBasis: basis }),
    onUnbudget: (id) => updateCat.mutate({ id, isBudgeted: false }),
    onDelete: (id, name) => {
      if (confirm(`Delete category "${name}"?`)) delCat.mutate(id);
    },
  };

  return (
    <div className="space-y-4 text-gray-900">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Budgets & Categories</h1>
          <p className="text-xs text-gray-700 mt-1 max-w-2xl">
            Every category lives here: click the swatch to recolor, double-click a name to rename,
            switch a budget between per-pay-period and per-month, and type a dollar amount to set
            (or start) its allocation. Each period starts fresh — there's no rollover.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <button
            onClick={() => setActivePeriod(Math.max(0, idx - 1))}
            disabled={idx <= 0}
            className="px-2 py-1 rounded border border-gray-200 bg-white text-gray-800 disabled:opacity-30"
          >
            ←
          </button>
          <div className="px-2 text-gray-900 min-w-[12rem] text-center">
            {period ? `${fmtDate(period.start)} – ${fmtDate(period.end)}` : "—"}
          </div>
          <button
            onClick={() => setActivePeriod(Math.min((periods.data?.length ?? 1) - 1, idx + 1))}
            disabled={idx >= (periods.data?.length ?? 1) - 1}
            className="px-2 py-1 rounded border border-gray-200 bg-white text-gray-800 disabled:opacity-30"
          >
            →
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-gray-200 bg-white p-3">
          <div className="text-xs uppercase tracking-wide text-gray-600">Total allocated</div>
          <div className="text-lg font-semibold text-gray-900 mt-1 tabular-nums">
            {fmtUSD(totalAllocated)}
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-3">
          <div className="text-xs uppercase tracking-wide text-gray-600">Spent this period</div>
          <div className="text-lg font-semibold text-red-700 mt-1 tabular-nums">
            {fmtUSD(totalSpent)}
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-3">
          <div className="text-xs uppercase tracking-wide text-gray-600">Over budget</div>
          <div className={`text-lg font-semibold mt-1 ${overBudget > 0 ? "text-red-700" : "text-gray-900"}`}>
            {overBudget}
            <span className="text-xs text-gray-700 font-normal ml-2">of {budgeted.length}</span>
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white px-3 py-10 text-center text-sm text-gray-700">
          No categories yet. Add one below and it'll show up here.
        </div>
      ) : (
        <div className="space-y-4">
          <BudgetSection
            title="Per pay period"
            subtitle={period ? `${fmtDate(period.start)} – ${fmtDate(period.end)}` : ""}
            rows={ppRows}
            ctx={catCtx}
            onSave={(categoryId, amount) => upsert.mutate({ categoryId, amount })}
          />
          <BudgetSection
            title="Per month"
            subtitle={monthBounds.label}
            rows={moRows}
            ctx={catCtx}
            onSave={(categoryId, amount) => upsert.mutate({ categoryId, amount })}
          />
          <BudgetSection
            title="Not budgeted"
            subtitle="every other category — type an amount to start budgeting it"
            rows={otherRows}
            ctx={catCtx}
            onSave={(categoryId, amount) => startBudgeting.mutate({ categoryId, amount })}
          />
        </div>
      )}

      {specialCats.length > 0 && (
        <div>
          <div className="flex items-baseline gap-2 mb-1.5">
            <h2 className="text-sm font-semibold text-gray-800">Income & special</h2>
            <span className="text-xs text-gray-500">
              not budgeted — but their colors and names are edited here
            </span>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white overflow-visible shadow-sm">
            <table className="w-full text-sm">
              <tbody>
                {specialCats.map((c) => (
                  <tr key={c.id} className="border-t border-gray-100 first:border-t-0">
                    <td className="px-3 py-2 w-10">
                      <ColorCell value={c.color} onPick={(color) => catCtx.onColor(c.id, color)} />
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        <RenameableName
                          value={c.name}
                          editable={!c.is_protected}
                          onSave={(name) => catCtx.onRename(c.id, name)}
                        />
                        <span className="text-[10px] uppercase tracking-wide text-gray-400">
                          {c.is_protected ? "protected" : "income"}
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right w-24">
                      {!c.is_protected && (
                        <button
                          className="text-xs text-gray-500 hover:text-red-700"
                          onClick={() => catCtx.onDelete(c.id, c.name)}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex gap-2 items-center">
        <input
          type="text"
          placeholder="New category name"
          className="border border-gray-200 rounded-md px-2 py-1.5 text-sm bg-white flex-1 max-w-xs"
          value={newCatName}
          onChange={(e) => setNewCatName(e.target.value)}
        />
        <select
          className="border border-gray-200 rounded-md px-2 py-1.5 text-sm bg-white"
          value={newCatParent}
          onChange={(e) => setNewCatParent(e.target.value === "" ? "" : Number(e.target.value))}
        >
          <option value="">(no parent)</option>
          {parentOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          disabled={!newCatName.trim() || createCat.isPending}
          onClick={() => createCat.mutate()}
          className="px-3 py-1.5 text-sm rounded-md bg-black text-white disabled:opacity-50"
        >
          Add category
        </button>
      </div>

      {archivedCats.length > 0 && (
        <div className="text-xs text-gray-500">
          <span className="uppercase tracking-wide font-semibold">Archived:</span>{" "}
          {archivedCats.map((c, i) => (
            <span key={c.id}>
              {i > 0 && " · "}
              <span className="line-through">{c.name}</span>{" "}
              <button
                className="underline hover:text-gray-800"
                onClick={() => updateCat.mutate({ id: c.id, archived: false })}
              >
                unarchive
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

type CatCtx = {
  catById: Map<number, Category>;
  onColor: (id: number, color: string) => void;
  onRename: (id: number, name: string) => void;
  onBasis: (id: number, basis: "monthly" | "per_pay_period") => void;
  onUnbudget: (id: number) => void;
  onDelete: (id: number, name: string) => void;
};

function BudgetSection({
  title,
  subtitle,
  rows,
  ctx,
  onSave,
}: {
  title: string;
  subtitle: string;
  rows: BudgetSummaryRow[];
  ctx: CatCtx;
  onSave: (categoryId: number, amount: number) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1.5">
        <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
        {subtitle && <span className="text-xs text-gray-500">{subtitle}</span>}
      </div>
      <div className="rounded-xl border border-gray-200 bg-white overflow-visible shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr className="text-left text-xs uppercase tracking-wide text-gray-700">
              <th className="px-3 py-2 w-10">Color</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2 w-36">Basis</th>
              <th className="px-3 py-2 text-right w-32">Allocation</th>
              <th className="px-3 py-2 text-right w-28">Spent</th>
              <th className="px-3 py-2 text-right w-28">Available</th>
              <th className="px-3 py-2 w-32"></th>
              <th className="px-3 py-2 w-36 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const cat = ctx.catById.get(r.category_id);
              return (
                <tr
                  key={r.category_id}
                  className={`border-t border-gray-200 ${r.parent_id ? "bg-gray-50/40" : ""}`}
                >
                  <td className="px-3 py-2">
                    <ColorCell
                      value={cat?.color ?? null}
                      onPick={(color) => ctx.onColor(r.category_id, color)}
                    />
                  </td>
                  <td
                    className={`px-3 py-2 ${
                      r.parent_id ? "pl-8 font-normal text-gray-800" : "font-medium text-gray-900"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      {r.parent_id && <span className="text-gray-400">↳</span>}
                      <RenameableName
                        value={r.category_name}
                        editable
                        onSave={(name) => ctx.onRename(r.category_id, name)}
                      />
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {r.is_budgeted ? (
                      <select
                        className="text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white"
                        value={r.budget_basis}
                        onChange={(e) =>
                          ctx.onBasis(r.category_id, e.target.value as "monthly" | "per_pay_period")
                        }
                      >
                        <option value="per_pay_period">Per pay period</option>
                        <option value="monthly">Per month</option>
                      </select>
                    ) : (
                      <span className="text-gray-300 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <BudgetInput
                      initial={r.allocated}
                      onSave={(amount) => onSave(r.category_id, amount)}
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-red-700">{fmtUSD(r.spent)}</td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${
                      !r.is_budgeted
                        ? "text-gray-400"
                        : r.available < 0
                          ? "text-red-700 font-medium"
                          : "text-green-700"
                    }`}
                  >
                    {r.is_budgeted ? fmtUSD(r.available) : "—"}
                  </td>
                  <td className="px-3 py-2">
                    {r.is_budgeted && (
                      <Bar used={Math.max(0, r.spent)} of={Math.max(r.allocated, r.spent, 1)} />
                    )}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {r.is_budgeted && (
                      <button
                        className="text-xs text-gray-500 hover:text-gray-900 mr-3"
                        title="Stop budgeting this category (it moves to the Not budgeted section)"
                        onClick={() => ctx.onUnbudget(r.category_id)}
                      >
                        Unbudget
                      </button>
                    )}
                    <button
                      className="text-xs text-gray-500 hover:text-red-700"
                      onClick={() => ctx.onDelete(r.category_id, r.category_name)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BudgetInput({ initial, onSave }: { initial: number; onSave: (n: number) => void }) {
  const [v, setV] = useState(initial > 0 ? initial.toFixed(2) : "");
  const unset = initial === 0;
  return (
    <input
      type="number"
      step="0.01"
      placeholder={unset ? "Set amount…" : ""}
      className={`w-28 text-right border rounded px-1.5 py-1 bg-white tabular-nums ${
        unset
          ? "border-amber-300 placeholder-amber-700 focus:border-amber-500"
          : "border-gray-200"
      }`}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v.trim() === "") return;
        const n = parseFloat(v);
        if (!Number.isNaN(n) && n !== initial) onSave(n);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function Bar({ used, of }: { used: number; of: number }) {
  const pct = Math.min(100, (used / of) * 100);
  const danger = pct >= 90;
  return (
    <div className="w-full bg-gray-100 rounded h-1.5 overflow-hidden">
      <div
        className={`h-full ${danger ? "bg-red-500" : "bg-green-500"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
