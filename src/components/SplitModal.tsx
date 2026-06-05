import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { asTree } from "@/lib/categories";
import { fmtUSD } from "@/lib/formatting";
import type { SplitChild, Transaction } from "@/api/types";

interface Row {
  categoryId: number | null;
  amount: string;
  description: string;
}

export default function SplitModal({
  txn,
  onClose,
}: {
  txn: Transaction;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const categoryTree = useMemo(() => asTree(categories.data ?? []), [categories.data]);
  const detail = useQuery({
    queryKey: ["transaction", txn.id],
    queryFn: () => api.getTransaction(txn.id),
  });

  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    if (!detail.data) return;
    if (detail.data.children.length > 0) {
      setRows(
        detail.data.children.map((c) => ({
          categoryId: c.category_id,
          amount: c.amount.toFixed(2),
          description: c.description,
        })),
      );
    } else {
      setRows([
        { categoryId: txn.category_id, amount: (txn.amount / 2).toFixed(2), description: txn.description },
        { categoryId: null, amount: (txn.amount / 2).toFixed(2), description: txn.description },
      ]);
    }
  }, [detail.data, txn]);

  const parentAmount = detail.data?.children.length
    ? detail.data.children.reduce((s, c) => s + c.amount, 0)
    : txn.amount;

  const sum = rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const remainder = parentAmount - sum;

  const save = useMutation({
    mutationFn: () => {
      const children: SplitChild[] = rows
        .filter((r) => r.amount.trim() !== "")
        .map((r) => ({
          category_id: r.categoryId,
          amount: parseFloat(r.amount),
          description: r.description.trim() || null,
        }));
      return api.splitTransaction(txn.id, children);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      onClose();
    },
    onError: (e) => alert(String(e)),
  });

  const unsplit = useMutation({
    mutationFn: () => api.unsplitTransaction(txn.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-[640px] p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="font-semibold text-sm">Split transaction</h2>
          <p className="text-xs text-gray-500 mt-1">
            {txn.description} · total {fmtUSD(parentAmount)}
          </p>
        </div>

        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex gap-2 items-center">
              <select
                className="border rounded px-2 py-1 text-sm bg-white flex-1"
                value={r.categoryId ?? ""}
                onChange={(e) =>
                  setRows((prev) =>
                    prev.map((p, j) =>
                      j === i ? { ...p, categoryId: e.target.value ? Number(e.target.value) : null } : p,
                    ),
                  )
                }
              >
                <option value="">Category…</option>
                {categoryTree.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Description (optional)"
                className="border rounded px-2 py-1 text-sm bg-white flex-1"
                value={r.description}
                onChange={(e) =>
                  setRows((prev) => prev.map((p, j) => (j === i ? { ...p, description: e.target.value } : p)))
                }
              />
              <input
                type="number"
                step="0.01"
                className="border rounded px-2 py-1 text-sm bg-white w-28 text-right tabular-nums"
                value={r.amount}
                onChange={(e) =>
                  setRows((prev) => prev.map((p, j) => (j === i ? { ...p, amount: e.target.value } : p)))
                }
              />
              <button
                className="text-xs text-gray-500 hover:text-red-600"
                onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="flex justify-between text-xs">
          <button
            className="text-gray-600 hover:text-black"
            onClick={() =>
              setRows((prev) => [...prev, { categoryId: null, amount: remainder.toFixed(2), description: "" }])
            }
          >
            + Add row
          </button>
          <span className={`tabular-nums ${Math.abs(remainder) > 0.005 ? "text-red-600" : "text-gray-500"}`}>
            Remainder: {fmtUSD(remainder)}
          </span>
        </div>

        <div className="flex justify-between gap-2 pt-2 border-t">
          {detail.data && detail.data.children.length > 0 ? (
            <button
              onClick={() => {
                if (confirm("Remove split and restore the original transaction?")) unsplit.mutate();
              }}
              className="px-3 py-1.5 text-sm rounded border bg-white text-red-600"
            >
              Remove split
            </button>
          ) : (
            <div />
          )}
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border bg-white">
              Cancel
            </button>
            <button
              disabled={Math.abs(remainder) > 0.005 || save.isPending}
              onClick={() => save.mutate()}
              className="px-3 py-1.5 text-sm rounded bg-black text-white disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : "Save split"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
