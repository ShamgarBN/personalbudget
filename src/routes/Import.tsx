import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { api } from "@/api";
import { asTree } from "@/lib/categories";
import { fmtDate, fmtUSD } from "@/lib/formatting";
import type { ImportPreview, ImportPreviewRow, LegacyImportPreview } from "@/api/types";

type RowState = ImportPreviewRow & { skip: boolean; chosenCategoryId: number | null };

const LEGACY_HEADER = "Date,Account,Title,Category,Subcategory,Type,Amount,Memo,Cleared,Flagged,SplitOf";
const isLegacyExport = (content: string): boolean => {
  const firstLine = content.split("\n", 1)[0] ?? "";
  return firstLine.replace(/^﻿/, "").trim() === LEGACY_HEADER;
};

const basename = (p: string): string => {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
};

export default function ImportView() {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const categoryTree = useMemo(() => asTree(categories.data ?? []), [categories.data]);
  const batches = useQuery({ queryKey: ["import-batches"], queryFn: api.listImportBatches });

  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [rows, setRows] = useState<RowState[]>([]);
  const [legacyPreview, setLegacyPreview] = useState<LegacyImportPreview | null>(null);
  const [legacySource, setLegacySource] = useState<{ fileName: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearPreview = () => {
    setPreview(null);
    setRows([]);
    setLegacyPreview(null);
    setLegacySource(null);
  };

  // Process a single file by its (name, text content) pair — shared by the
  // file picker (browser File API) and the Tauri drag-drop pathway (file path).
  const processContent = useCallback(async (fileName: string, text: string) => {
    setError(null);
    setBusy(true);
    clearPreview();
    try {
      if (isLegacyExport(text)) {
        const lp = await api.previewLegacyImport({ fileName, content: text });
        setLegacyPreview(lp);
        setLegacySource({ fileName, content: text });
      } else {
        const p = await api.previewImport({ fileName, content: text, accountId: null });
        setPreview(p);
        setRows(
          p.rows.map((r) => ({
            ...r,
            skip: r.is_duplicate,
            chosenCategoryId: r.suggested_category_id,
          })),
        );
      }
    } catch (e) {
      setError(String(e));
      clearPreview();
    } finally {
      setBusy(false);
    }
  }, []);

  const onFiles = useCallback(
    async (files: FileList) => {
      const file = files[0];
      if (!file) return;
      const text = await file.text();
      await processContent(file.name, text);
    },
    [processContent],
  );

  // Tauri 2 on macOS intercepts OS-level file drops and the webview never sees
  // the HTML5 drag-drop event. Subscribe to Tauri's drag-drop event instead
  // and read the dropped file via the fs plugin.
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;
    const setup = async () => {
      const unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        const paths = event.payload.paths;
        if (!paths || paths.length === 0) return;
        const path = paths[0];
        try {
          const content = await readTextFile(path);
          await processContent(basename(path), content);
        } catch (e) {
          setError(`Couldn't read dropped file: ${String(e)}`);
        }
      });
      if (cancelled) {
        unlisten();
      } else {
        unlistenFn = unlisten;
      }
    };
    void setup();
    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
    };
  }, [processContent]);

  const commit = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error("no preview");
      const result = await api.commitImport({
        account_id: preview.account_id,
        source_file: preview.source_file,
        beginning_balance: preview.beginning_balance,
        beginning_balance_date: preview.beginning_balance_date,
        rows: rows.map((r) => ({
          date: r.date,
          description: r.description,
          amount: r.amount,
          category_id: r.chosenCategoryId,
          import_hash: r.import_hash,
          skip: r.skip,
          // If the chosen category matches the suggestion, treat as auto-categorized
          // and flag for review. If the user explicitly picked a different one, trust it.
          auto_categorized:
            r.chosenCategoryId !== null &&
            r.chosenCategoryId === r.suggested_category_id,
        })),
      });
      return result;
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["import-batches"] });
      clearPreview();
      alert(`Imported ${result.inserted} transactions (${result.skipped} skipped).`);
    },
    onError: (e) => setError(String(e)),
  });

  const undo = useMutation({
    mutationFn: (id: number) => api.undoImportBatch(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["import-batches"] });
    },
  });

  const commitLegacy = useMutation({
    mutationFn: async () => {
      if (!legacySource) throw new Error("no legacy source");
      return api.commitLegacyImport(legacySource);
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["import-batches"] });
      qc.invalidateQueries({ queryKey: ["categories"] });
      clearPreview();
      alert(
        `Restored ${result.inserted} transactions, created ${result.categories_created} categories, reconstructed ${result.splits_reconstructed} splits.`,
      );
    },
    onError: (e) => setError(String(e)),
  });

  const accountName = (id: number) =>
    accounts.data?.find((a) => a.id === id)?.name ?? `#${id}`;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Import</h1>

      <div
        className="rounded-xl border-2 border-dashed border-gray-300 bg-white px-8 py-10 text-center"
      >
        <div className="text-sm text-gray-600">
          Drop a CSV here, or
        </div>
        <label className="inline-block mt-2 text-sm">
          <span className="px-3 py-1.5 rounded-md bg-black/5 hover:bg-black/10 cursor-pointer">
            pick a file…
          </span>
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => e.target.files && onFiles(e.target.files)}
          />
        </label>
        <div className="text-xs text-gray-500 mt-2">
          Auto-detects Apple Card, BoA Checking, Capital One 360 Savings exports, and the
          previous-app export format.
        </div>
      </div>

      {busy && <p className="text-sm text-gray-500">Parsing…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {legacyPreview && legacySource && (
        <div className="space-y-3">
          <div className="rounded-xl border bg-amber-50/40 p-4">
            <div className="text-sm">
              <span className="font-medium">{legacySource.fileName}</span>{" "}
              <span className="text-gray-500">— previous-app export detected</span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-500">Total rows</div>
                <div className="text-lg font-semibold">{legacyPreview.total_rows.toLocaleString()}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-500">Split groups</div>
                <div className="text-lg font-semibold">{legacyPreview.split_groups}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-500">Categories to add</div>
                <div className="text-lg font-semibold">
                  {legacyPreview.categories_to_create.length +
                    legacyPreview.subcategories_to_create.length}
                </div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">By account</div>
                <ul className="text-sm">
                  {legacyPreview.by_account.map((a) => (
                    <li key={a.account} className="flex justify-between">
                      <span>{a.account}</span>
                      <span className="tabular-nums text-gray-600">{a.count.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">
                  New categories
                </div>
                {legacyPreview.categories_to_create.length === 0 &&
                legacyPreview.subcategories_to_create.length === 0 ? (
                  <p className="text-sm text-gray-500">None — all already exist.</p>
                ) : (
                  <p className="text-xs text-gray-600 line-clamp-4">
                    {[
                      ...legacyPreview.categories_to_create,
                      ...legacyPreview.subcategories_to_create.map((s) => `· ${s}`),
                    ].join(", ")}
                  </p>
                )}
              </div>
            </div>
            {legacyPreview.accounts_missing.length > 0 && (
              <p className="mt-3 text-xs text-amber-700">
                These accounts don't exist yet and will be created:{" "}
                {legacyPreview.accounts_missing.join(", ")}.
              </p>
            )}
            <p className="mt-3 text-xs text-gray-600">
              This is a one-shot restore. Categories will be reused by name where possible; missing
              ones will be created automatically. Split groups will be reconstructed (parent zeroed,
              children carry the amounts).
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={clearPreview}
                className="px-3 py-1.5 text-sm rounded-md border bg-white hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => commitLegacy.mutate()}
                disabled={commitLegacy.isPending}
                className="px-3 py-1.5 text-sm rounded-md bg-black text-white hover:bg-black/85 disabled:opacity-50"
              >
                {commitLegacy.isPending ? "Restoring…" : "Restore everything"}
              </button>
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm">
              <span className="font-medium">{preview.source_file}</span>
              <span className="text-gray-500"> → {preview.account_name}</span>
              <span className="text-gray-500"> · {preview.format}</span>
              {preview.beginning_balance != null && (
                <span className="text-gray-500">
                  {" "}
                  · opening balance: {fmtUSD(preview.beginning_balance)} as of{" "}
                  {preview.beginning_balance_date}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={clearPreview}
                className="px-3 py-1.5 text-sm rounded-md border bg-white hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => commit.mutate()}
                disabled={commit.isPending}
                className="px-3 py-1.5 text-sm rounded-md bg-black text-white hover:bg-black/85 disabled:opacity-50"
              >
                {commit.isPending ? "Importing…" : "Commit import"}
              </button>
            </div>
          </div>

          <div className="rounded-xl border bg-white overflow-auto" style={{ maxHeight: "55vh" }}>
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white shadow-[0_1px_0_rgba(0,0,0,0.06)]">
                <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2">Skip</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">Flags</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={`border-t ${r.is_duplicate ? "bg-yellow-50" : ""}`}>
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={r.skip}
                        onChange={(e) =>
                          setRows((prev) =>
                            prev.map((p, j) => (j === i ? { ...p, skip: e.target.checked } : p)),
                          )
                        }
                      />
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-gray-700">{fmtDate(r.date)}</td>
                    <td className="px-3 py-1.5">
                      <div className="line-clamp-1">{r.description}</div>
                    </td>
                    <td className="px-3 py-1.5">
                      <select
                        className="border rounded px-1.5 py-0.5 text-xs bg-white"
                        value={r.chosenCategoryId ?? ""}
                        onChange={(e) =>
                          setRows((prev) =>
                            prev.map((p, j) =>
                              j === i
                                ? {
                                    ...p,
                                    chosenCategoryId: e.target.value ? Number(e.target.value) : null,
                                  }
                                : p,
                            ),
                          )
                        }
                      >
                        <option value="">(uncategorized)</option>
                        {categoryTree.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${r.amount < 0 ? "text-red-600" : "text-green-700"}`}>
                      {fmtUSD(r.amount)}
                    </td>
                    <td className="px-3 py-1.5 text-xs">
                      {r.is_transfer && (
                        <span className="inline-block px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 mr-1">
                          transfer
                        </span>
                      )}
                      {r.is_duplicate && (
                        <span className="inline-block px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-800">
                          duplicate
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Recent imports</h2>
        <div className="rounded-xl border bg-white divide-y">
          {(batches.data ?? []).slice(0, 20).map((b) => (
            <div key={b.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <div>
                <div className="font-medium">{b.source_file}</div>
                <div className="text-xs text-gray-500">
                  {new Date(b.imported_at).toLocaleString()} · {accountName(b.account_id)} ·{" "}
                  {b.row_count} rows
                </div>
              </div>
              <button
                onClick={() => {
                  if (confirm(`Undo this import (${b.row_count} rows)?`)) undo.mutate(b.id);
                }}
                className="text-xs text-gray-500 hover:text-red-600"
              >
                Undo
              </button>
            </div>
          ))}
          {(batches.data ?? []).length === 0 && (
            <div className="px-4 py-6 text-sm text-gray-500 text-center">No imports yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
