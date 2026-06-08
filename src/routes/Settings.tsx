import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { save as saveDialog, open as openDialog, confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { api } from "@/api";
import { fmtDate, todayISO } from "@/lib/formatting";
import type { Category, PayPeriodSchedule } from "@/api/types";

export default function Settings() {
  const qc = useQueryClient();
  const schedules = useQuery({
    queryKey: ["pay-period-schedules"],
    queryFn: api.listPayPeriodSchedules,
  });
  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: api.listCategories,
  });
  const backups = useQuery({ queryKey: ["backups"], queryFn: api.listBackups });

  const createBackup = useMutation({
    mutationFn: api.createBackup,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["backups"] }),
  });

  const restoreBackup = useMutation({
    mutationFn: async (path: string) => {
      const ok = await confirmDialog(
        `Restore from this backup? Your current data will be archived, then replaced when you reopen the app.\n\n${path}`,
        { title: "Restore backup", kind: "warning" },
      );
      if (!ok) throw new Error("cancelled");
      await api.restoreBackup(path);
    },
    onSuccess: () => {
      alert("Backup staged. Quit and reopen the app to complete the restore.");
    },
    onError: (e) => {
      if (String(e) !== "Error: cancelled") alert(String(e));
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
      qc.invalidateQueries({ queryKey: ["categories"] });
      setNewCatName("");
    },
  });

  const invalidateCats = () => {
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["budget-summary"] });
    qc.invalidateQueries({ queryKey: ["transactions"] });
  };

  // Single generic updater for color / name / parent / budgeted / basis / archive.
  const updateCat = useMutation({
    mutationFn: (args: Parameters<typeof api.updateCategory>[0]) => api.updateCategory(args),
    onSuccess: invalidateCats,
    onError: (e) => alert(String(e)),
  });

  const delCat = useMutation({
    mutationFn: (id: number) => api.deleteCategory(id),
    onSuccess: invalidateCats,
    onError: (e: unknown, id: number) => {
      // The backend refuses to delete a category that's still attached to
      // transactions. Surface that clearly and offer the archive path the
      // error itself suggests, instead of failing silently (the old bug).
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

  const [newSchedule, setNewSchedule] = useState<PayPeriodSchedule | null>(null);
  const saveSchedule = useMutation({
    mutationFn: (s: PayPeriodSchedule) => api.upsertPayPeriodSchedule(s),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pay-period-schedules"] });
      // Prefix-match covers ["pay-periods", "current"], the ledger groupings,
      // and the account-ledger groupings in one shot.
      qc.invalidateQueries({ queryKey: ["pay-periods"] });
      qc.invalidateQueries({ queryKey: ["forecast"] });
      setNewSchedule(null);
    },
  });
  const deleteSchedule = useMutation({
    mutationFn: (id: number) => api.deletePayPeriodSchedule(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pay-period-schedules"] });
      qc.invalidateQueries({ queryKey: ["pay-periods"] });
      qc.invalidateQueries({ queryKey: ["forecast"] });
    },
  });

  const simplifyDesc = useMutation({
    mutationFn: () => api.simplifyDescriptions(),
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      alert(`Simplified ${n} transaction descriptions.`);
    },
  });

  const exportJson = useMutation({
    mutationFn: async () => {
      const path = await saveDialog({
        defaultPath: `family-budget-export-${todayISO()}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) throw new Error("cancelled");
      return api.exportJson(path);
    },
    onError: (e) => {
      if (String(e) !== "Error: cancelled") alert(String(e));
    },
  });

  return (
    <div className="p-6 space-y-8">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-700">Pay period schedule</h2>
          <button
            onClick={() => setNewSchedule(blankSchedule())}
            className="text-xs px-2.5 py-1 rounded border bg-white hover:bg-gray-50"
          >
            + Schedule change
          </button>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white divide-y divide-gray-200">
          {(schedules.data ?? []).map((s: PayPeriodSchedule) => (
            <div key={s.id} className="px-4 py-3 text-sm flex justify-between items-center gap-3">
              <div className="flex-1">
                <div className="font-medium text-gray-900">{describeSchedule(s)}</div>
                <div className="text-xs text-gray-600">
                  Effective {fmtDate(s.effective_from)} →{" "}
                  {s.effective_to ? fmtDate(s.effective_to) : "ongoing"}
                </div>
              </div>
              <button
                onClick={() => setNewSchedule({ ...s })}
                className="text-xs text-gray-600 hover:text-black"
              >
                Edit
              </button>
              <button
                onClick={() => {
                  if (
                    confirm(
                      `Delete this schedule entry?\n\n${describeSchedule(s)}\n\nPay periods falling under it will fall back to whichever schedule was previously active.`,
                    )
                  )
                    deleteSchedule.mutate(s.id);
                }}
                className="text-xs text-gray-600 hover:text-red-700"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-600 mt-2">
          Adding a new <em>ongoing</em> schedule (no end date) caps any currently-ongoing one at the
          new start date. To capture a historical cadence (e.g., "we used to be biweekly"), give it
          both a start and end date — existing schedules won't be touched.
        </p>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">Categories</h2>
        <p className="text-xs text-gray-600 mb-3 max-w-2xl">
          Click a color swatch to recolor a category — the color shows on every ledger row. Check
          <span className="font-medium"> Budgeted</span> to include a category on the Budgets tab, and
          pick whether its limit is measured per month or per pay period.
        </p>
        <div className="rounded-xl border bg-white max-h-[28rem] overflow-auto">
          <CategoryTable
            categories={categories.data ?? []}
            onUpdate={(args) => updateCat.mutate(args)}
            onDelete={(id) => delCat.mutate(id)}
          />
        </div>
        <div className="flex gap-2 mt-3">
          <input
            type="text"
            placeholder="New category name"
            className="border rounded-md px-2 py-1.5 text-sm bg-white flex-1 max-w-xs"
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
          />
          <select
            className="border rounded-md px-2 py-1.5 text-sm bg-white"
            value={newCatParent}
            onChange={(e) =>
              setNewCatParent(e.target.value === "" ? "" : Number(e.target.value))
            }
          >
            <option value="">(no parent)</option>
            {(categories.data ?? [])
              .filter((c) => c.parent_id === null && !c.is_protected)
              .map((c) => (
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
            Add
          </button>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Maintenance</h2>
        <button
          onClick={() => {
            if (
              confirm(
                "Walk every transaction and trim cluttered import-era descriptions (\"Texas Roadhouse | TEXAS ROADHOUSE #2294 11440 …\" → \"Texas Roadhouse\")?",
              )
            )
              simplifyDesc.mutate();
          }}
          disabled={simplifyDesc.isPending}
          className="px-3 py-1.5 text-sm rounded-md border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-50"
        >
          {simplifyDesc.isPending ? "Cleaning…" : "Simplify descriptions"}
        </button>
        <p className="text-xs text-gray-500 mt-2">
          One-shot cleanup. Future imports already use the simplified format.
        </p>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Export</h2>
        <button
          onClick={() => exportJson.mutate()}
          disabled={exportJson.isPending}
          className="px-3 py-1.5 text-sm rounded-md border bg-white hover:bg-gray-50 disabled:opacity-50"
        >
          {exportJson.isPending ? "Exporting…" : "Export JSON…"}
        </button>
        {exportJson.data && (
          <p className="text-xs text-gray-500 mt-2 truncate">Wrote {exportJson.data.path}</p>
        )}
        <p className="text-xs text-gray-500 mt-2">
          Lossless JSON export covering every table. Use this when migrating to a new computer
          alongside the backup file.
        </p>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Backups</h2>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => createBackup.mutate()}
            disabled={createBackup.isPending}
            className="px-3 py-1.5 text-sm rounded-md bg-black text-white disabled:opacity-50"
          >
            {createBackup.isPending ? "Backing up…" : "Back up now"}
          </button>
          <button
            onClick={async () => {
              const picked = await openDialog({
                multiple: false,
                directory: false,
                filters: [{ name: "SQLite backup", extensions: ["sqlite3", "sqlite", "db"] }],
                title: "Pick a backup file to restore",
              });
              if (typeof picked === "string") restoreBackup.mutate(picked);
            }}
            className="px-3 py-1.5 text-sm rounded-md border border-gray-200 bg-white hover:bg-gray-50"
          >
            Restore from file…
          </button>
        </div>
        <div className="rounded-xl border bg-white divide-y mt-3 max-h-64 overflow-auto">
          {(backups.data ?? []).slice(0, 10).map((b) => (
            <div key={b.path} className="px-4 py-2 text-sm flex justify-between items-center gap-3">
              <div className="truncate pr-3 flex-1">
                <div className="truncate">{b.path}</div>
                <div className="text-xs text-gray-500">
                  {new Date(b.modified).toLocaleString()} · {(b.size / 1024).toFixed(1)} KB
                </div>
              </div>
              <button
                onClick={() => restoreBackup.mutate(b.path)}
                className="text-xs px-2 py-0.5 rounded border bg-white hover:bg-gray-50"
              >
                Restore
              </button>
            </div>
          ))}
          {(backups.data ?? []).length === 0 && (
            <div className="px-4 py-6 text-sm text-gray-500 text-center">
              Backups are written to ~/Library/Mobile Documents/com~apple~CloudDocs/family-budget-backups
            </div>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Restoring stages the chosen file for the next launch. Your current database is archived
          to <code className="text-[10px]">budget.pre-restore-…sqlite3</code> alongside the live DB
          so you can recover from a bad restore.
        </p>
      </section>

      {newSchedule && (
        <ScheduleEditor
          draft={newSchedule}
          onChange={setNewSchedule}
          onCancel={() => setNewSchedule(null)}
          onSave={() => saveSchedule.mutate(newSchedule)}
          busy={saveSchedule.isPending}
        />
      )}
    </div>
  );
}

function blankSchedule(): PayPeriodSchedule {
  return {
    id: 0,
    effective_from: todayISO(),
    effective_to: null,
    cadence_kind: "semimonthly",
    anchor_date: null,
    day_of_month_1: 15,
    day_of_month_2: -1,
    day_of_month: null,
    custom_dates_json: null,
  };
}

function ordinal(n: number): string {
  if (n === -1) return "last day";
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${n % 10 > 3 || n % 10 === 0 ? "th" : suffix}`;
}

function describeSchedule(s: PayPeriodSchedule): string {
  switch (s.cadence_kind) {
    case "semimonthly": {
      // d1 and d2 are *period start* anchors. Spell out the resulting
      // periods so the label can't be misread as "the dividers fall here"
      // (which was the mistake that led to the May-31 surprise).
      const d1 = s.day_of_month_1 ?? 1;
      const d2 = s.day_of_month_2 ?? -1;
      return `Semimonthly · periods ${ordinal(d1)} → ${ordinal(d2)}, ${ordinal(d2)} → ${ordinal(d1)} of next month`;
    }
    case "monthly":
      return `Monthly · period starts ${ordinal(s.day_of_month ?? 1)}`;
    case "biweekly":
      return `Biweekly · anchor ${s.anchor_date}`;
    case "weekly":
      return `Weekly · anchor ${s.anchor_date}`;
    case "custom_dates":
      return "Custom dates";
    default:
      return s.cadence_kind;
  }
}

function ScheduleEditor({
  draft,
  onChange,
  onCancel,
  onSave,
  busy,
}: {
  draft: PayPeriodSchedule;
  onChange: (s: PayPeriodSchedule) => void;
  onCancel: () => void;
  onSave: () => void;
  busy: boolean;
}) {
  const k = draft.cadence_kind;
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30">
      <div className="bg-white rounded-xl shadow-xl w-[480px] p-5 space-y-3">
        <h2 className="font-semibold text-sm">New schedule change</h2>
        <p className="text-xs text-gray-500">
          The current ongoing schedule will be capped at the new effective date. Past pay periods
          remain anchored to their original cadence.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
              Effective from
            </span>
            <input
              type="date"
              className="border rounded px-2 py-1 text-sm bg-white"
              value={draft.effective_from}
              onChange={(e) => onChange({ ...draft, effective_from: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
              Effective to (blank = ongoing)
            </span>
            <input
              type="date"
              className="border rounded px-2 py-1 text-sm bg-white"
              value={draft.effective_to ?? ""}
              onChange={(e) =>
                onChange({ ...draft, effective_to: e.target.value || null })
              }
            />
          </label>
        </div>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Cadence</span>
          <select
            className="border rounded px-2 py-1 text-sm bg-white"
            value={k}
            onChange={(e) =>
              onChange({
                ...draft,
                cadence_kind: e.target.value as PayPeriodSchedule["cadence_kind"],
              })
            }
          >
            <option value="semimonthly">Semimonthly (two days each month)</option>
            <option value="monthly">Monthly (one day each month)</option>
            <option value="biweekly">Biweekly (every 14 days from an anchor)</option>
            <option value="weekly">Weekly (every 7 days from an anchor)</option>
            <option value="custom_dates">Custom dates (paste a list)</option>
          </select>
        </label>
        {k === "semimonthly" && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <label className="block">
                <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
                  Period 1 starts on day
                </span>
                <input
                  type="number"
                  min={1}
                  max={31}
                  className="border rounded px-2 py-1 w-20 text-sm bg-white"
                  value={draft.day_of_month_1 ?? 1}
                  onChange={(e) =>
                    onChange({ ...draft, day_of_month_1: parseInt(e.target.value, 10) || 1 })
                  }
                />
              </label>
              <label className="block">
                <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
                  Period 2 starts on day (−1 = last)
                </span>
                <input
                  type="number"
                  min={-1}
                  max={31}
                  className="border rounded px-2 py-1 w-20 text-sm bg-white"
                  value={draft.day_of_month_2 ?? -1}
                  onChange={(e) =>
                    onChange({ ...draft, day_of_month_2: parseInt(e.target.value, 10) || -1 })
                  }
                />
              </label>
            </div>
            <p className="text-xs text-gray-600 leading-relaxed">
              These are the days each pay period <em>starts</em>. The resulting periods are:
              <br />
              <strong className="text-gray-800">{describeSchedule(draft)}</strong>
              <br />
              <span className="text-gray-500">
                For calendar halves (1–15 then 16–end), use <strong>1</strong> and <strong>16</strong>.
              </span>
            </p>
          </div>
        )}
        {k === "monthly" && (
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
              Day of month
            </span>
            <input
              type="number"
              min={1}
              max={31}
              className="border rounded px-2 py-1 w-20 text-sm bg-white"
              value={draft.day_of_month ?? 1}
              onChange={(e) =>
                onChange({ ...draft, day_of_month: parseInt(e.target.value, 10) || 1 })
              }
            />
          </label>
        )}
        {(k === "weekly" || k === "biweekly") && (
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
              Anchor date (a known payday)
            </span>
            <input
              type="date"
              className="border rounded px-2 py-1 text-sm bg-white"
              value={draft.anchor_date ?? ""}
              onChange={(e) => onChange({ ...draft, anchor_date: e.target.value || null })}
            />
          </label>
        )}
        {k === "custom_dates" && (
          <label className="block">
            <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
              JSON array of YYYY-MM-DD
            </span>
            <textarea
              className="border rounded px-2 py-1 w-full text-sm bg-white font-mono h-24"
              placeholder='["2026-06-01", "2026-06-15"]'
              value={draft.custom_dates_json ?? ""}
              onChange={(e) => onChange({ ...draft, custom_dates_json: e.target.value || null })}
            />
          </label>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm rounded border bg-white">
            Cancel
          </button>
          <button
            disabled={busy}
            onClick={onSave}
            className="px-3 py-1.5 text-sm rounded bg-black text-white disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Preset palette for the swatch picker — the seed colors plus a few extras.
const CATEGORY_COLORS = [
  "#ff9500", "#ff9f0a", "#ffcc00", "#30d158", "#34c759", "#14b8a6",
  "#0a84ff", "#5e5ce6", "#64d2ff", "#bf5af2", "#a78bfa", "#ff375f",
  "#ff453a", "#ff6b6b", "#f97316", "#94a3b8", "#9ca3af", "#888888",
];

type UpdateCatArgs = Parameters<typeof api.updateCategory>[0];

function CategoryTable({
  categories,
  onUpdate,
  onDelete,
}: {
  categories: Category[];
  onUpdate: (args: UpdateCatArgs) => void;
  onDelete: (id: number) => void;
}) {
  const byName = (a: Category, b: Category) => a.name.localeCompare(b.name);
  const active = categories.filter((c) => !c.archived);
  const archived = categories.filter((c) => c.archived);
  const parents = active.filter((c) => c.parent_id === null).slice().sort(byName);
  const childrenOf = (id: number) =>
    active.filter((c) => c.parent_id === id).slice().sort(byName);
  const parentOptions = parents.filter((p) => !p.is_protected);

  // Flatten to render order (parent then its children) for zebra striping.
  const ordered: Array<{ cat: Category; depth: number }> = [];
  for (const p of parents) {
    ordered.push({ cat: p, depth: 0 });
    for (const c of childrenOf(p.id)) ordered.push({ cat: c, depth: 1 });
  }

  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-gray-50 z-10">
        <tr className="text-left text-xs uppercase tracking-wide text-gray-600">
          <th className="px-3 py-2 w-10">Color</th>
          <th className="px-3 py-2">Category</th>
          <th className="px-3 py-2 w-20 text-center">Budgeted</th>
          <th className="px-3 py-2 w-40">Basis</th>
          <th className="px-3 py-2 w-36">Move to</th>
          <th className="px-3 py-2 w-16"></th>
        </tr>
      </thead>
      <tbody>
        {ordered.map(({ cat, depth }, i) => {
          const canBudget = !cat.is_protected && !cat.is_income;
          return (
            <tr
              key={cat.id}
              className={`border-t border-gray-100 ${i % 2 === 1 ? "bg-gray-50/60" : "bg-white"}`}
            >
              <td className="px-3 py-1.5">
                <ColorCell
                  value={cat.color}
                  onPick={(color) => onUpdate({ id: cat.id, color })}
                />
              </td>
              <td className={`px-3 py-1.5 ${depth === 1 ? "pl-7" : ""}`}>
                <span className="flex items-center gap-2">
                  {depth === 1 && <span className="text-gray-400">↳</span>}
                  <RenameableName
                    value={cat.name}
                    editable={!cat.is_protected}
                    onSave={(name) => onUpdate({ id: cat.id, name })}
                  />
                  {cat.is_protected && (
                    <span className="text-[10px] uppercase tracking-wide text-gray-400">
                      protected
                    </span>
                  )}
                </span>
              </td>
              <td className="px-3 py-1.5 text-center">
                {canBudget ? (
                  <input
                    type="checkbox"
                    checked={cat.is_budgeted}
                    onChange={(e) => onUpdate({ id: cat.id, isBudgeted: e.target.checked })}
                    title="Include on the Budgets tab"
                  />
                ) : (
                  <span className="text-gray-300">—</span>
                )}
              </td>
              <td className="px-3 py-1.5">
                {canBudget && cat.is_budgeted ? (
                  <select
                    className="text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white"
                    value={cat.budget_basis}
                    onChange={(e) =>
                      onUpdate({
                        id: cat.id,
                        budgetBasis: e.target.value as "monthly" | "per_pay_period",
                      })
                    }
                  >
                    <option value="per_pay_period">Per pay period</option>
                    <option value="monthly">Per month</option>
                  </select>
                ) : (
                  <span className="text-gray-300 text-xs">—</span>
                )}
              </td>
              <td className="px-3 py-1.5">
                {!cat.is_protected && depth === 1 ? (
                  <select
                    className="text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white w-full"
                    value={cat.parent_id ?? ""}
                    onChange={(e) =>
                      onUpdate({
                        id: cat.id,
                        parentId: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    title="Move to a different parent (or top level)"
                  >
                    <option value="">(top level)</option>
                    {parentOptions.map((po) => (
                      <option key={po.id} value={po.id}>
                        {po.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-gray-300 text-xs">—</span>
                )}
              </td>
              <td className="px-3 py-1.5 text-right">
                {!cat.is_protected && (
                  <button
                    className="text-xs text-gray-500 hover:text-red-700"
                    onClick={() => {
                      if (confirm(`Delete category "${cat.name}"?`)) onDelete(cat.id);
                    }}
                  >
                    Delete
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
      {archived.length > 0 && (
        <tbody>
          <tr className="border-t border-gray-200">
            <td colSpan={6} className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wide text-gray-400 font-semibold">
              Archived
            </td>
          </tr>
          {archived
            .slice()
            .sort(byName)
            .map((cat) => (
              <tr key={cat.id} className="border-t border-gray-100 bg-gray-50/40 text-gray-500">
                <td className="px-3 py-1.5">
                  {cat.color && (
                    <span
                      className="inline-block w-3.5 h-3.5 rounded-sm opacity-60"
                      style={{ background: cat.color }}
                    />
                  )}
                </td>
                <td className="px-3 py-1.5 line-through" colSpan={4}>
                  {cat.name}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <button
                    className="text-xs text-gray-500 hover:text-gray-900"
                    onClick={() => onUpdate({ id: cat.id, archived: false })}
                  >
                    Unarchive
                  </button>
                </td>
              </tr>
            ))}
        </tbody>
      )}
    </table>
  );
}

function ColorCell({
  value,
  onPick,
}: {
  value: string | null;
  onPick: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-5 h-5 rounded border border-gray-300 shadow-sm"
        style={{ background: value ?? "#ffffff" }}
        title="Change color"
      />
      {open && (
        <>
          {/* Click-away backdrop */}
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute z-30 mt-1 p-2 bg-white border border-gray-200 rounded-lg shadow-xl w-44">
            <div className="grid grid-cols-6 gap-1.5">
              {CATEGORY_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    onPick(c);
                    setOpen(false);
                  }}
                  className={`w-5 h-5 rounded border ${
                    value === c ? "ring-2 ring-offset-1 ring-gray-900 border-white" : "border-gray-300"
                  }`}
                  style={{ background: c }}
                />
              ))}
            </div>
            <label className="flex items-center gap-2 mt-2 pt-2 border-t border-gray-100 text-xs text-gray-600">
              Custom
              <input
                type="color"
                value={value ?? "#888888"}
                onChange={(e) => onPick(e.target.value)}
                className="w-7 h-6 p-0 border-0 bg-transparent cursor-pointer"
              />
            </label>
          </div>
        </>
      )}
    </div>
  );
}

function RenameableName({
  value,
  editable,
  onSave,
}: {
  value: string;
  editable: boolean;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editable || !editing) {
    return (
      <span
        className="text-gray-900 cursor-text"
        onDoubleClick={() => {
          if (!editable) return;
          setDraft(value);
          setEditing(true);
        }}
        title={editable ? "Double-click to rename" : ""}
      >
        {value}
      </span>
    );
  }
  return (
    <input
      autoFocus
      className="border border-gray-200 rounded px-1.5 py-0.5 text-sm bg-white"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const next = draft.trim();
        if (next && next !== value) onSave(next);
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
