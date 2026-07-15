import { create } from "zustand";

// App-wide undo stack. Every destructive or edit action in the ledger pushes
// an entry whose `run` applies the inverse (restore the deleted rows, put the
// previous field value back, un-dismiss the ghost, …). Cmd+Z pops and runs the
// most recent entry; a toast reports what was undone. The stack is in-memory
// only — it does not survive an app restart.
export interface UndoEntry {
  /// Short human label, e.g. `delete "Wegmans" ($23.00)` — shown in the toast.
  label: string;
  /// Applies the inverse action. Must be safe to call once.
  run: () => Promise<void>;
}

interface UndoState {
  stack: UndoEntry[];
  /// Most recent toast message (null when hidden).
  toast: string | null;
  push: (entry: UndoEntry) => void;
  pop: () => UndoEntry | undefined;
  showToast: (message: string) => void;
  hideToast: () => void;
}

const MAX_DEPTH = 100;

export const useUndo = create<UndoState>()((set, get) => ({
  stack: [],
  toast: null,
  push: (entry) =>
    set((s) => ({ stack: [...s.stack.slice(-(MAX_DEPTH - 1)), entry] })),
  pop: () => {
    const s = get();
    const entry = s.stack[s.stack.length - 1];
    if (entry) set({ stack: s.stack.slice(0, -1) });
    return entry;
  },
  showToast: (message) => set({ toast: message }),
  hideToast: () => set({ toast: null }),
}));

export const pushUndo = (label: string, run: () => Promise<void>) =>
  useUndo.getState().push({ label, run });
