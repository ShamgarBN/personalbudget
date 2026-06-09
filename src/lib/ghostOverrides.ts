import { create } from "zustand";
import { persist } from "zustand/middleware";

// User-edited amounts for projected ("ghost") ledger rows that haven't been
// locked in yet. Persisted so an edited-but-not-locked forecast survives
// navigation and restarts. Keyed by the ghost's stable key:
//   recurring -> "bill:<billId>:<date>"
//   budget    -> "budget:<categoryId>:<periodStart>"
interface OverrideState {
  amounts: Record<string, number>;
  set: (key: string, amount: number) => void;
  clear: (key: string) => void;
}

export const useGhostOverrides = create<OverrideState>()(
  persist(
    (set) => ({
      amounts: {},
      set: (key, amount) => set((s) => ({ amounts: { ...s.amounts, [key]: amount } })),
      clear: (key) =>
        set((s) => {
          const next = { ...s.amounts };
          delete next[key];
          return { amounts: next };
        }),
    }),
    { name: "family-budget:ghost-overrides-v1" },
  ),
);
