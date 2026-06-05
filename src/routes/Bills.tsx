import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { asTree } from "@/lib/categories";
import { fmtDate, fmtUSD, todayISO } from "@/lib/formatting";
import type { RecurringBill } from "@/api/types";

const blank = (): RecurringBill => ({
  id: 0,
  name: "",
  amount: 0,
  account_id: 0,
  category_id: null,
  cadence_kind: "monthly",
  day_of_month: 1,
  anchor_date: null,
  active: true,
  last_seen_date: null,
  notes: null,
  start_date: todayISO(),
  end_date: null,
});

export default function Bills() {
  const qc = useQueryClient();
  const bills = useQuery({ queryKey: ["recurring-bills"], queryFn: api.listRecurringBills });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const categoryTree = useMemo(() => asTree(categories.data ?? []), [categories.data]);

  // Group bills by their category's top-level parent for the list view, so
  // sub-category bills sit visually under their parent. Bills with no category
  // (or a parent-level category) cluster under that parent's heading.
  const grouped = useMemo(() => {
    const byCat: Record<number, { name: string }> = {};
    for (const c of categories.data ?? []) byCat[c.id] = { name: c.name };
    const parentOf: Record<number, number | null> = {};
    for (const c of categories.data ?? []) parentOf[c.id] = c.parent_id;
    const groupKey = (b: RecurringBill): string => {
      if (b.category_id == null) return "￿Uncategorized";
      const parent = parentOf[b.category_id];
      const parentId = parent ?? b.category_id;
      return byCat[parentId]?.name ?? "￿Uncategorized";
    };
    const groups: Record<string, RecurringBill[]> = {};
    for (const b of bills.data ?? []) {
      const key = groupKey(b);
      (groups[key] ||= []).push(b);
    }
    const ordered = Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, items]) => ({
        heading: k.startsWith("￿") ? "Uncategorized" : k,
        bills: items.slice().sort((a, b) => {
          // Sub-category bills (category != parent) get visually nested under their parent.
          // Within a group, sort by category name then bill name.
          const aSub = a.category_id != null && parentOf[a.category_id] != null;
          const bSub = b.category_id != null && parentOf[b.category_id] != null;
          if (aSub !== bSub) return aSub ? 1 : -1;
          const aCatName = a.category_id != null ? byCat[a.category_id]?.name ?? "" : "";
          const bCatName = b.category_id != null ? byCat[b.category_id]?.name ?? "" : "";
          if (aCatName !== bCatName) return aCatName.localeCompare(bCatName);
          return a.name.localeCompare(b.name);
        }),
      }));
    return ordered;
  }, [bills.data, categories.data]);

  const [draft, setDraft] = useState<RecurringBill | null>(null);

  const save = useMutation({
    mutationFn: (b: RecurringBill) => api.upsertRecurringBill(b),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recurring-bills"] });
      setDraft(null);
    },
  });
  const del = useMutation({
    mutationFn: (id: number) => api.deleteRecurringBill(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recurring-bills"] }),
  });

  const monthlyTotal = (bills.data ?? [])
    .filter((b) => b.active)
    .reduce((s, b) => {
      const mult =
        b.cadence_kind === "monthly"
          ? 1
          : b.cadence_kind === "quarterly"
            ? 1 / 3
            : b.cadence_kind === "semiannual"
              ? 1 / 6
              : b.cadence_kind === "annual"
                ? 1 / 12
                : b.cadence_kind === "biweekly"
                  ? 26 / 12
                  : b.cadence_kind === "weekly"
                    ? 52 / 12
                    : 0;
      return s + Math.abs(b.amount) * mult;
    }, 0);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Recurring Bills</h1>
        <div className="text-sm text-gray-700">
          Estimated monthly: <span className="font-semibold">{fmtUSD(monthlyTotal)}</span>
        </div>
      </div>

      <button
        onClick={() => setDraft(blank())}
        className="px-3 py-1.5 text-sm rounded-md bg-black text-white"
      >
        Add bill
      </button>

      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        {grouped.length === 0 ? (
          <div className="px-4 py-8 text-sm text-gray-700 text-center">
            No recurring bills yet. Add one to feed the forecast.
          </div>
        ) : (
          grouped.map(({ heading, bills: groupBills }) => (
            <div key={heading} className="border-b border-gray-200 last:border-b-0">
              <div className="px-4 py-1.5 bg-gray-50 text-xs uppercase tracking-wide text-gray-700 font-semibold">
                {heading}
              </div>
              <div className="divide-y divide-gray-200">
                {groupBills.map((b) => {
                  const subcat =
                    b.category_id != null &&
                    (categories.data ?? []).find((c) => c.id === b.category_id)?.parent_id != null;
                  const catName =
                    b.category_id != null
                      ? (categories.data ?? []).find((c) => c.id === b.category_id)?.name
                      : null;
                  return (
                    <div
                      key={b.id}
                      className={`px-4 py-2.5 text-sm flex items-center gap-4 ${
                        subcat ? "pl-10 bg-gray-50/40" : ""
                      }`}
                    >
                      <div className="flex-1">
                        <div className="font-medium text-gray-900">
                          {subcat && <span className="text-gray-400 mr-1">↳</span>}
                          {b.name}
                          {subcat && catName && (
                            <span className="ml-2 text-xs text-gray-600 font-normal">· {catName}</span>
                          )}
                        </div>
                        <div className="text-xs text-gray-600">
                          {b.cadence_kind}
                          {b.day_of_month != null && b.cadence_kind.startsWith("month")
                            ? ` · day ${b.day_of_month}`
                            : ""}
                          {b.anchor_date ? ` · anchor ${b.anchor_date}` : ""}
                          {b.start_date ? ` · starts ${fmtDate(b.start_date)}` : ""}
                          {b.end_date ? ` · ends ${fmtDate(b.end_date)}` : ""}
                          {!b.active ? " · paused" : ""}
                        </div>
                      </div>
                      <div className="tabular-nums text-gray-900">{fmtUSD(Math.abs(b.amount))}</div>
                      <button onClick={() => setDraft(b)} className="text-xs text-gray-600 hover:text-black">
                        Edit
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`Delete "${b.name}"?`)) del.mutate(b.id);
                        }}
                        className="text-xs text-gray-600 hover:text-red-700"
                      >
                        Delete
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {draft && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-xl shadow-xl w-[480px] p-5 space-y-3">
            <h2 className="font-semibold">{draft.id ? "Edit bill" : "Add bill"}</h2>
            <Field label="Name">
              <input
                className="border rounded px-2 py-1 w-full text-sm bg-white"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount (positive)">
                <input
                  type="number"
                  step="0.01"
                  className="border rounded px-2 py-1 w-full text-sm bg-white"
                  value={draft.amount}
                  onChange={(e) => setDraft({ ...draft, amount: parseFloat(e.target.value) || 0 })}
                />
              </Field>
              <Field label="Cadence">
                <select
                  className="border rounded px-2 py-1 w-full text-sm bg-white"
                  value={draft.cadence_kind}
                  onChange={(e) =>
                    setDraft({ ...draft, cadence_kind: e.target.value as RecurringBill["cadence_kind"] })
                  }
                >
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Biweekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="semiannual">Semiannual</option>
                  <option value="annual">Annual</option>
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Account">
                <select
                  className="border rounded px-2 py-1 w-full text-sm bg-white"
                  value={draft.account_id}
                  onChange={(e) => setDraft({ ...draft, account_id: Number(e.target.value) })}
                >
                  <option value={0}>—</option>
                  {(accounts.data ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Category">
                <select
                  className="border rounded px-2 py-1 w-full text-sm bg-white"
                  value={draft.category_id ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      category_id: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                >
                  <option value="">—</option>
                  {categoryTree.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {(draft.cadence_kind === "monthly" ||
              draft.cadence_kind === "quarterly" ||
              draft.cadence_kind === "semiannual" ||
              draft.cadence_kind === "annual") && (
              <Field label="Day of month">
                <input
                  type="number"
                  min={1}
                  max={31}
                  className="border rounded px-2 py-1 w-24 text-sm bg-white"
                  value={draft.day_of_month ?? 1}
                  onChange={(e) =>
                    setDraft({ ...draft, day_of_month: parseInt(e.target.value, 10) || 1 })
                  }
                />
              </Field>
            )}
            {(draft.cadence_kind === "weekly" || draft.cadence_kind === "biweekly") && (
              <Field label="Anchor date (a known hit date)">
                <input
                  type="date"
                  className="border rounded px-2 py-1 text-sm bg-white"
                  value={draft.anchor_date ?? ""}
                  onChange={(e) => setDraft({ ...draft, anchor_date: e.target.value || null })}
                />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start date">
                <input
                  type="date"
                  className="border rounded px-2 py-1 w-full text-sm bg-white"
                  value={draft.start_date ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, start_date: e.target.value || null })
                  }
                />
              </Field>
              <Field label="End date (optional)">
                <input
                  type="date"
                  className="border rounded px-2 py-1 w-full text-sm bg-white"
                  value={draft.end_date ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, end_date: e.target.value || null })
                  }
                />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.active}
                onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
              />
              Active
            </label>
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={() => setDraft(null)} className="px-3 py-1.5 text-sm rounded border bg-white">
                Cancel
              </button>
              <button
                disabled={!draft.name.trim() || !draft.account_id}
                onClick={() => save.mutate(draft)}
                className="px-3 py-1.5 text-sm rounded bg-black text-white disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">{label}</span>
      {children}
    </label>
  );
}
