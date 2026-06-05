import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { fmtUSD, fmtDate, todayISO } from "@/lib/formatting";
import type { BudgetSummaryRow } from "@/api/types";

export default function Budgets() {
  const qc = useQueryClient();
  const [activePeriod, setActivePeriod] = useState<number>(0);

  const schedules = useQuery({
    queryKey: ["pay-period-schedules"],
    queryFn: api.listPayPeriodSchedules,
  });

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

  const summary = useQuery({
    queryKey: ["budget-summary", period?.start, period?.end],
    queryFn: () => api.budgetSummary(period!.start, period!.end),
    enabled: !!period,
  });

  const allocations = useQuery({
    queryKey: ["budget-allocations"],
    queryFn: api.listBudgetAllocations,
  });

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["budget-summary"] });
      qc.invalidateQueries({ queryKey: ["budget-allocations"] });
    },
  });

  const rows = summary.data?.rows ?? [];
  const totalAllocated = rows.reduce((s, r) => s + r.allocated, 0);
  const totalSpent = rows.reduce((s, r) => s + r.spent, 0);
  const unbudgeted = rows.filter((r) => r.allocated === 0).length;

  return (
    <div className="p-6 space-y-4 text-gray-900">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Budgets</h1>
          <p className="text-xs text-gray-700 mt-1 max-w-2xl">
            Set a per-pay-period limit for each category. Unspent amounts roll into the next
            period (the &quot;Rollover in&quot; column); overspends drag it negative. To get
            started, type a dollar amount into the Allocation field on any category row.
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
          <div className="text-xs uppercase tracking-wide text-gray-600">Categories unbudgeted</div>
          <div className="text-lg font-semibold text-gray-900 mt-1">
            {unbudgeted}
            <span className="text-xs text-gray-700 font-normal ml-2">of {rows.length}</span>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white overflow-auto shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr className="text-left text-xs uppercase tracking-wide text-gray-700">
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2 text-right">Allocation / period</th>
              <th className="px-3 py-2 text-right">Rollover in</th>
              <th className="px-3 py-2 text-right">Spent</th>
              <th className="px-3 py-2 text-right">Available</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: BudgetSummaryRow) => (
              <tr
                key={r.category_id}
                className={`border-t border-gray-200 ${r.parent_id ? "bg-gray-50/40" : ""}`}
              >
                <td
                  className={`px-3 py-2 ${
                    r.parent_id
                      ? "pl-8 font-normal text-gray-800"
                      : "font-medium text-gray-900"
                  }`}
                >
                  {r.parent_id && <span className="text-gray-400 mr-1">↳</span>}
                  {r.category_name}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  <BudgetInput
                    initial={r.allocated}
                    onSave={(amount) =>
                      upsert.mutate({ categoryId: r.category_id, amount })
                    }
                  />
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${r.rollover_in < 0 ? "text-red-700" : "text-gray-700"}`}
                >
                  {fmtUSD(r.rollover_in)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-red-700">
                  {fmtUSD(r.spent)}
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums ${r.available < 0 ? "text-red-700 font-medium" : "text-green-700"}`}
                >
                  {fmtUSD(r.available)}
                </td>
                <td className="px-3 py-2 w-32">
                  <Bar
                    used={Math.max(0, r.spent)}
                    of={Math.max(r.allocated + r.rollover_in, r.spent, 1)}
                  />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-sm text-gray-700">
                  No editable categories yet. Add categories in Settings to start budgeting.
                </td>
              </tr>
            )}
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
