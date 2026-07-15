import { create } from "zustand";
import { persist } from "zustand/middleware";

// Per-occurrence client state for projected ("ghost") ledger rows, keyed by the
// ghost's stable key:
//   recurring -> "bill:<billId>:<date>"
//   budget    -> "budget:<categoryId>:<periodStart>"
// - `amounts`: user-edited forecast amounts not yet locked in.
// - `dismissed`: occurrences the user deleted from the ledger view (hides just
//   that one projection; the recurring template keeps generating others).
// Persisted so edits and dismissals survive navigation and restarts.
interface OverrideState {
  amounts: Record<string, number>;
  dismissed: Record<string, boolean>;
  set: (key: string, amount: number) => void;
  clear: (key: string) => void;
  dismiss: (key: string) => void;
  undismiss: (key: string) => void;
}

export const useGhostOverrides = create<OverrideState>()(
  persist(
    (set) => ({
      amounts: {},
      dismissed: {},
      set: (key, amount) => set((s) => ({ amounts: { ...s.amounts, [key]: amount } })),
      clear: (key) =>
        set((s) => {
          const next = { ...s.amounts };
          delete next[key];
          return { amounts: next };
        }),
      // Dismiss the occurrence and drop any pending amount edit for it.
      dismiss: (key) =>
        set((s) => {
          const amounts = { ...s.amounts };
          delete amounts[key];
          return { amounts, dismissed: { ...s.dismissed, [key]: true } };
        }),
      // Bring a dismissed occurrence back (the Undo path for a ghost delete).
      undismiss: (key) =>
        set((s) => {
          const dismissed = { ...s.dismissed };
          delete dismissed[key];
          return { dismissed };
        }),
    }),
    { name: "family-budget:ghost-overrides-v1" },
  ),
);
