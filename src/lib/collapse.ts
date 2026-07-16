import { create } from "zustand";
import { persist } from "zustand/middleware";

// Persistent open/closed state for collapsible ledger groups (years, pay
// periods, half-months). Keyed by a stable string so a section the user
// expands stays expanded after navigating away and back, and across restarts.
interface CollapseState {
  open: Record<string, boolean>;
  toggle: (key: string) => void;
  setOpen: (key: string, open: boolean) => void;
  /// Bulk set — powers the Ledger's Expand all / Collapse all buttons.
  setMany: (entries: Record<string, boolean>) => void;
}

export const useCollapseStore = create<CollapseState>()(
  persist(
    (set) => ({
      open: {},
      toggle: (key) =>
        set((s) => ({ open: { ...s.open, [key]: !(s.open[key] ?? false) } })),
      setOpen: (key, open) => set((s) => ({ open: { ...s.open, [key]: open } })),
      setMany: (entries) => set((s) => ({ open: { ...s.open, ...entries } })),
    }),
    { name: "family-budget:collapse-v1" },
  ),
);

/// Returns [open, toggle] for a collapsible section. Falls back to `defaultOpen`
/// until the user has explicitly toggled it (no stored value yet).
export function useCollapsed(key: string, defaultOpen: boolean): [boolean, () => void] {
  const stored = useCollapseStore((s) => s.open[key]);
  const setOpen = useCollapseStore((s) => s.setOpen);
  const open = stored === undefined ? defaultOpen : stored;
  return [open, () => setOpen(key, !open)];
}
