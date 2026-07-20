import { useEffect, useMemo, useRef, useState } from "react";
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
  interval_days: null,
  active: true,
  last_seen_date: null,
  notes: null,
  start_date: todayISO(),
  end_date: null,
});

// Per-month equivalent count for each cadence — used to estimate a monthly net.
function monthlyMultiplier(b: RecurringBill): number {
  switch (b.cadence_kind) {
    case "monthly":
      return 1;
    case "quarterly":
      return 1 / 3;
    case "semiannual":
      return 1 / 6;
    case "annual":
      return 1 / 12;
    case "biweekly":
      return 26 / 12;
    case "weekly":
      return 52 / 12;
    case "custom_days":
      return b.interval_days && b.interval_days > 0 ? 30.4368 / b.interval_days : 0;
    default:
      return 0;
  }
}

function describeCadence(b: RecurringBill): string {
  if (b.cadence_kind === "custom_days") {
    const n = b.interval_days ?? 0;
    if (n > 0 && n % 7 === 0) {
      const w = n / 7;
      return `Every ${w} week${w === 1 ? "" : "s"}`;
    }
    return `Every ${n} day${n === 1 ? "" : "s"}`;
  }
  const base = b.cadence_kind.charAt(0).toUpperCase() + b.cadence_kind.slice(1);
  if (
    b.day_of_month === -1 &&
    ["monthly", "quarterly", "semiannual", "annual"].includes(b.cadence_kind)
  ) {
    return `${base} · last day`;
  }
  return base;
}

export default function RecurringPanel({
  initialEditBillId = null,
}: {
  initialEditBillId?: number | null;
}) {
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
  // UI-only editor state. Amount is edited as a positive magnitude plus an
  // expense/income toggle; the signed value is assembled on save. Custom
  // cadence is entered in days or weeks.
  const [billKind, setBillKind] = useState<"expense" | "income">("expense");
  const [customUnit, setCustomUnit] = useState<"days" | "weeks">("days");
  // Monthly-family recurrence can pin to the last calendar day (day_of_month -1).
  const [lastDay, setLastDay] = useState(false);
  const openEditor = (b: RecurringBill) => {
    setBillKind(b.amount > 0 ? "income" : "expense");
    setCustomUnit(
      b.cadence_kind === "custom_days" && b.interval_days && b.interval_days % 7 === 0
        ? "weeks"
        : "days",
    );
    setLastDay(b.day_of_month === -1);
    setDraft(b);
  };

  // When launched from a ledger ghost row's "Edit…", open that bill's editor
  // as soon as the list arrives (once).
  const openedInitial = useRef(false);
  useEffect(() => {
    if (openedInitial.current || initialEditBillId == null) return;
    const b = (bills.data ?? []).find((x) => x.id === initialEditBillId);
    if (b) {
      openedInitial.current = true;
      openEditor(b);
    }
  }, [bills.data, initialEditBillId]);

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

  // Net monthly estimate: income (positive) minus expenses (negative), each
  // scaled to a per-month equivalent by cadence.
  const monthlyTotal = (bills.data ?? [])
    .filter((b) => b.active)
    .reduce((s, b) => s + b.amount * monthlyMultiplier(b), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Recurring Transactions</h1>
        <div className="text-sm text-gray-700">
          Estimated monthly net:{" "}
          <span className={`font-semibold ${monthlyTotal < 0 ? "text-red-700" : "text-green-700"}`}>
            {fmtUSD(monthlyTotal)}
          </span>
        </div>
      </div>

      <button
        onClick={() => openEditor(blank())}
        className="px-3 py-1.5 text-sm rounded-md bg-black text-white"
      >
        Add transaction
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
                          {describeCadence(b)}
                          {b.start_date ? ` · starts ${fmtDate(b.start_date)}` : ""}
                          {b.end_date ? ` · ends ${fmtDate(b.end_date)}` : ""}
                          {!b.active ? " · paused" : ""}
                        </div>
                      </div>
                      <div
                        className={`tabular-nums ${b.amount < 0 ? "text-red-700" : "text-green-700"}`}
                      >
                        {fmtUSD(b.amount)}
                      </div>
                      <button onClick={() => openEditor(b)} className="text-xs text-gray-600 hover:text-black">
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
            <h2 className="font-semibold">
              {draft.id ? "Edit recurring transaction" : "Add recurring transaction"}
            </h2>
            <Field label="Name">
              <input
                className="border rounded px-2 py-1 w-full text-sm bg-white"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type">
                <div className="flex rounded-md border border-gray-200 overflow-hidden text-sm">
                  {(["expense", "income"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setBillKind(k)}
                      className={`flex-1 px-2 py-1 capitalize ${
                        billKind === k
                          ? k === "income"
                            ? "bg-green-600 text-white"
                            : "bg-red-600 text-white"
                          : "bg-white text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      {k}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Amount">
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  className="border rounded px-2 py-1 w-full text-sm bg-white text-right tabular-nums"
                  value={draft.amount === 0 ? "" : Math.abs(draft.amount)}
                  onChange={(e) =>
                    setDraft({ ...draft, amount: Math.abs(parseFloat(e.target.value) || 0) })
                  }
                />
              </Field>
            </div>
            <Field label="Cadence">
              <select
                className="border rounded px-2 py-1 w-full text-sm bg-white"
                value={draft.cadence_kind}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    cadence_kind: e.target.value as RecurringBill["cadence_kind"],
                    interval_days:
                      e.target.value === "custom_days" ? draft.interval_days ?? 30 : null,
                  })
                }
              >
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="semiannual">Semiannual</option>
                <option value="annual">Annual</option>
                <option value="custom_days">Custom (every N days/weeks)</option>
              </select>
            </Field>
            {["monthly", "quarterly", "semiannual", "annual"].includes(draft.cadence_kind) && (
              <label className="flex items-center gap-2 text-sm text-gray-800">
                <input
                  type="checkbox"
                  checked={lastDay}
                  onChange={(e) => setLastDay(e.target.checked)}
                />
                Recur on the last day of the month
              </label>
            )}
            {draft.cadence_kind === "custom_days" && (
              <Field label="Repeat every">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    className="border rounded px-2 py-1 w-24 text-sm bg-white text-right tabular-nums"
                    value={
                      customUnit === "weeks"
                        ? Math.max(1, Math.round((draft.interval_days ?? 7) / 7))
                        : draft.interval_days ?? 1
                    }
                    onChange={(e) => {
                      const n = Math.max(1, parseInt(e.target.value, 10) || 1);
                      setDraft({
                        ...draft,
                        interval_days: customUnit === "weeks" ? n * 7 : n,
                      });
                    }}
                  />
                  <select
                    className="border rounded px-2 py-1 text-sm bg-white"
                    value={customUnit}
                    onChange={(e) => {
                      const unit = e.target.value as "days" | "weeks";
                      // Re-express the current interval in the new unit.
                      const days = draft.interval_days ?? 7;
                      const n =
                        unit === "weeks" ? Math.max(1, Math.round(days / 7)) : days;
                      setCustomUnit(unit);
                      setDraft({ ...draft, interval_days: unit === "weeks" ? n * 7 : n });
                    }}
                  >
                    <option value="days">days</option>
                    <option value="weeks">weeks</option>
                  </select>
                </div>
              </Field>
            )}
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
            <p className="text-xs text-gray-500">
              It recurs on the start date's day going forward — e.g. start Jun 8, monthly → Jul 8,
              Aug 8, and so on. Use “last day of the month” above for paydays like the 15th &amp; end
              of month.
            </p>
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
                disabled={
                  !draft.name.trim() ||
                  !draft.account_id ||
                  (draft.cadence_kind === "custom_days" && !(draft.interval_days && draft.interval_days > 0))
                }
                onClick={() => {
                  // Derive the recurrence anchor from the start date so the user
                  // never enters a day-of-month separately. day_of_month feeds the
                  // monthly-family math; anchor_date feeds weekly/biweekly/custom.
                  const start = draft.start_date ?? todayISO();
                  const startDom = parseInt(start.slice(8, 10), 10) || 1;
                  const isMonthly = ["monthly", "quarterly", "semiannual", "annual"].includes(
                    draft.cadence_kind,
                  );
                  const signed =
                    billKind === "income" ? Math.abs(draft.amount) : -Math.abs(draft.amount);
                  const final: RecurringBill = {
                    ...draft,
                    amount: signed,
                    start_date: start,
                    // -1 = last day of month; otherwise the start date's day.
                    day_of_month: isMonthly && lastDay ? -1 : startDom,
                    anchor_date: start,
                    interval_days:
                      draft.cadence_kind === "custom_days" ? draft.interval_days ?? null : null,
                  };
                  save.mutate(final);
                }}
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
