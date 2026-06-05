import { useCallback, useEffect, useRef, useState } from "react";

/// Shared identifiers for every column the user can resize. Held to a small
/// fixed set so widths persist coherently across the Ledger and the
/// per-account views (Bank Account, Credit Card, Savings).
export type LedgerColumnId =
  | "date"
  | "account"
  | "description"
  | "memo"
  | "category"
  | "amount"
  | "running"
  | "flags"
  | "actions";

export type ColumnWidths = Partial<Record<LedgerColumnId, number>>;

const STORAGE_KEY = "family-budget:ledger-col-widths";

export const DEFAULT_WIDTHS: Record<LedgerColumnId, number> = {
  date: 110,
  account: 130,
  description: 260,
  memo: 220,
  category: 170,
  amount: 110,
  running: 120,
  flags: 80,
  actions: 110,
};

function loadStored(): ColumnWidths {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as ColumnWidths;
  } catch {
    return {};
  }
}

/// Cross-component hook: every ledger view reads/writes the same persisted
/// widths, so a resize on one tab takes effect everywhere immediately.
export function useColumnWidths(): {
  widthOf: (id: LedgerColumnId) => number;
  startResize: (id: LedgerColumnId, e: React.MouseEvent) => void;
} {
  const [widths, setWidths] = useState<ColumnWidths>(loadStored);

  // Listen for storage updates from any window/component instance.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setWidths(loadStored());
    };
    const onLocal = () => setWidths(loadStored());
    window.addEventListener("storage", onStorage);
    window.addEventListener("ledger-cols-updated", onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("ledger-cols-updated", onLocal);
    };
  }, []);

  const widthOf = useCallback(
    (id: LedgerColumnId) => widths[id] ?? DEFAULT_WIDTHS[id],
    [widths],
  );

  const dragRef = useRef<{
    id: LedgerColumnId;
    startX: number;
    startWidth: number;
  } | null>(null);

  const startResize = useCallback(
    (id: LedgerColumnId, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = {
        id,
        startX: e.clientX,
        startWidth: widths[id] ?? DEFAULT_WIDTHS[id],
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const delta = ev.clientX - dragRef.current.startX;
        const next = Math.max(60, dragRef.current.startWidth + delta);
        setWidths((prev) => ({ ...prev, [dragRef.current!.id]: next }));
      };
      const onUp = () => {
        if (!dragRef.current) return;
        // Persist on release (avoid spamming localStorage during drag)
        setWidths((prev) => {
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(prev));
            window.dispatchEvent(new Event("ledger-cols-updated"));
          } catch {
            // ignore quota errors etc.
          }
          return prev;
        });
        dragRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [widths],
  );

  return { widthOf, startResize };
}

/// Drop-in <th> that supports drag-resizing on its right edge.
export function ResizableTh({
  colId,
  widthOf,
  startResize,
  className = "",
  children,
}: {
  colId: LedgerColumnId;
  widthOf: (id: LedgerColumnId) => number;
  startResize: (id: LedgerColumnId, e: React.MouseEvent) => void;
  className?: string;
  children?: React.ReactNode;
}) {
  const w = widthOf(colId);
  return (
    <th
      style={{ width: w, minWidth: w, maxWidth: w }}
      className={`relative px-3 py-2 ${className}`}
    >
      {children}
      <span
        onMouseDown={(e) => startResize(colId, e)}
        className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-300/60 active:bg-blue-400/70"
        aria-hidden
      />
    </th>
  );
}
