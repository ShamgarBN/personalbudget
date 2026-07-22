import { create } from "zustand";
import { persist } from "zustand/middleware";

// The Ledger's view state (range, filters, grouping), persisted so the page
// looks exactly the way it was left after navigating away or restarting.
// Group open/closed state persists separately in `collapse.ts`.
export type RangeMode =
  | { kind: "all" }
  /// All time, grouped by calendar month (every month listed).
  | { kind: "month" }
  | { kind: "year"; year: number }
  | { kind: "custom"; from: string; to: string };

interface LedgerViewState {
  mode: RangeMode;
  customFrom: string;
  customTo: string;
  search: string;
  groupByPP: boolean;
  accountFilter: "all" | number;
  categoryFilter: number | null;
  needsReviewOnly: boolean;
  set: (patch: Partial<Omit<LedgerViewState, "set">>) => void;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthAgo = () => {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return iso(d);
};

export const useLedgerView = create<LedgerViewState>()(
  persist(
    (set) => ({
      mode: { kind: "all" },
      customFrom: monthAgo(),
      customTo: iso(new Date()),
      search: "",
      groupByPP: true,
      accountFilter: "all",
      categoryFilter: null,
      needsReviewOnly: false,
      set: (patch) => set(patch),
    }),
    { name: "family-budget:ledger-view-v1" },
  ),
);
