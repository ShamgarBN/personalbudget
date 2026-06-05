import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { fmtDate, fmtUSD } from "@/lib/formatting";
import type { Goal } from "@/api/types";

const blank = (): Goal => ({
  id: 0,
  name: "",
  target_amount: 0,
  target_date: null,
  account_id: null,
  category_id: null,
  current_amount: 0,
  created_at: new Date().toISOString(),
});

export default function Goals() {
  const qc = useQueryClient();
  const goals = useQuery({ queryKey: ["goals"], queryFn: api.listGoals });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });

  const [draft, setDraft] = useState<Goal | null>(null);

  const save = useMutation({
    mutationFn: (g: Goal) => api.upsertGoal(g),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["goals"] });
      setDraft(null);
    },
  });
  const del = useMutation({
    mutationFn: (id: number) => api.deleteGoal(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["goals"] }),
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Goals</h1>
        <button onClick={() => setDraft(blank())} className="px-3 py-1.5 text-sm rounded-md bg-black text-white">
          Add goal
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {(goals.data ?? []).map((g) => {
          const pct = Math.max(0, Math.min(100, (g.current_amount / Math.max(g.target_amount, 1)) * 100));
          return (
            <div key={g.id} className="rounded-xl border bg-white p-4 space-y-2">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-medium">{g.name}</div>
                  {g.target_date && (
                    <div className="text-xs text-gray-500">by {fmtDate(g.target_date)}</div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold">
                    {fmtUSD(g.current_amount)}{" "}
                    <span className="text-gray-400 font-normal">/ {fmtUSD(g.target_amount)}</span>
                  </div>
                </div>
              </div>
              <div className="h-2 bg-gray-100 rounded overflow-hidden">
                <div className="h-full bg-green-500" style={{ width: `${pct}%` }} />
              </div>
              <div className="flex justify-end gap-2 text-xs text-gray-500">
                <button onClick={() => setDraft(g)} className="hover:text-black">
                  Edit
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete goal "${g.name}"?`)) del.mutate(g.id);
                  }}
                  className="hover:text-red-600"
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
        {(goals.data ?? []).length === 0 && (
          <div className="col-span-2 text-center text-sm text-gray-500 py-12">
            No goals yet. Try one like “Anniversary Trip · $2,000 by 12/2026.”
          </div>
        )}
      </div>

      {draft && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-xl shadow-xl w-[420px] p-5 space-y-3">
            <h2 className="font-semibold">{draft.id ? "Edit goal" : "New goal"}</h2>
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Name</span>
              <input
                className="border rounded px-2 py-1 w-full text-sm bg-white"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Target amount</span>
                <input
                  type="number"
                  step="0.01"
                  className="border rounded px-2 py-1 w-full text-sm bg-white"
                  value={draft.target_amount}
                  onChange={(e) =>
                    setDraft({ ...draft, target_amount: parseFloat(e.target.value) || 0 })
                  }
                />
              </label>
              <label className="block">
                <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Current amount</span>
                <input
                  type="number"
                  step="0.01"
                  className="border rounded px-2 py-1 w-full text-sm bg-white"
                  value={draft.current_amount}
                  onChange={(e) =>
                    setDraft({ ...draft, current_amount: parseFloat(e.target.value) || 0 })
                  }
                />
              </label>
            </div>
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Target date</span>
              <input
                type="date"
                className="border rounded px-2 py-1 text-sm bg-white"
                value={draft.target_date ?? ""}
                onChange={(e) => setDraft({ ...draft, target_date: e.target.value || null })}
              />
            </label>
            <label className="block">
              <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Parked in</span>
              <select
                className="border rounded px-2 py-1 w-full text-sm bg-white"
                value={draft.account_id ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, account_id: e.target.value ? Number(e.target.value) : null })
                }
              >
                <option value="">—</option>
                {(accounts.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setDraft(null)} className="px-3 py-1.5 text-sm rounded border bg-white">
                Cancel
              </button>
              <button
                disabled={!draft.name.trim()}
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
