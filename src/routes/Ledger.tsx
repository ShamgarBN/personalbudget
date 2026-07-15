import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import { asTree, makeColorResolver, CategoryColorContext, useCategoryColor } from "@/lib/categories";
import { ResizableTh, useColumnWidths, type LedgerColumnId } from "@/lib/columns";
import { fmtDate, fmtUSD, todayISO } from "@/lib/formatting";
import { projectOccurrences } from "@/lib/recurrence";
import { useCollapsed } from "@/lib/collapse";
import { useGhostOverrides } from "@/lib/ghostOverrides";
import { pushUndo } from "@/lib/undo";
import { TXN_SOURCE_LABELS, txnSource, type PayPeriod, type Transaction, type TxnSource } from "@/api/types";
import SplitModal from "@/components/SplitModal";
import ImportModal from "@/routes/Import";

// The one ledger: bank + credit card transactions interleaved, with the bank
// account's running balance extended forward by projected "ghost" rows
// (recurring occurrences + per-pay-period budget items). Credit rows count
// against budgets but do not move the bank running — the pinned Credit Card
// Payoff footer carries their impact instead.
type LedgerItem = Transaction & {
  ghostBillId?: number; // recurring ghost
  ghostKey?: string; // stable override/lock key for any ghost
  ghostBudgetCategoryId?: number; // budget ghost: category to record under
  ghostBudgetKey?: string; // budget ghost: lock key "<catId>:<periodStart>"
  ghostSeq?: number; // stable display order among same-date ghosts
};
const isGhost = (i: LedgerItem): boolean => i.ghostBillId != null || i.ghostBudgetKey != null;

// Whether a real row was locked in from a projection (so it shows a checkbox
// that can be unchecked to undo it).
const isLockedProjection = (i: LedgerItem): boolean =>
  !isGhost(i) && (i.from_bill_id != null || i.from_budget_key != null);

type GhostHandlers = {
  setAmount: (key: string, amount: number) => void;
  lockIn: (item: LedgerItem) => void;
  unlock: (item: LedgerItem) => void;
  dismiss: (item: LedgerItem) => void;
};

const COLS: LedgerColumnId[] = [
  "sel",
  "date",
  "account",
  "description",
  "memo",
  "category",
  "source",
  "amount",
  "running",
  "flags",
  "actions",
];
const NUM_COLS = COLS.length;

function addDaysISO(isoDate: string, n: number): string {
  const d = new Date(isoDate + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

type RangeMode =
  | { kind: "all" }
  | { kind: "month"; year: number; month: number /* 1-12 */ }
  | { kind: "year"; year: number }
  | { kind: "custom"; from: string; to: string };

const iso = (d: Date) => d.toISOString().slice(0, 10);

function rangeBounds(mode: RangeMode): { from: string; to: string; label: string } {
  if (mode.kind === "all") {
    return { from: "1900-01-01", to: "2999-12-31", label: "All time" };
  }
  if (mode.kind === "month") {
    const start = new Date(mode.year, mode.month - 1, 1);
    const end = new Date(mode.year, mode.month, 0); // last day of month
    const label = start.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    return { from: iso(start), to: iso(end), label };
  }
  if (mode.kind === "year") {
    return {
      from: `${mode.year}-01-01`,
      to: `${mode.year}-12-31`,
      label: String(mode.year),
    };
  }
  return { from: mode.from, to: mode.to, label: `${fmtDate(mode.from)} – ${fmtDate(mode.to)}` };
}

export default function Ledger() {
  const qc = useQueryClient();
  const today = new Date();
  const [mode, setMode] = useState<RangeMode>({ kind: "all" });
  const [customFrom, setCustomFrom] = useState<string>(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return iso(d);
  });
  const [customTo, setCustomTo] = useState<string>(() => iso(today));
  const [search, setSearch] = useState("");
  const [groupByPP, setGroupByPP] = useState(true);
  const [accountFilter, setAccountFilter] = useState<"all" | number>("all");
  const [categoryFilter, setCategoryFilter] = useState<number | null>(null);
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [splitTarget, setSplitTarget] = useState<Transaction | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const { widthOf, startResize } = useColumnWidths();

  // Persist the collapse state of the starting-balances section so once the
  // values are entered, the strip stays hidden across visits.
  const [startingBalCollapsed, setStartingBalCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("family-budget:starting-bal-collapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggleStartingBal = () => {
    setStartingBalCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("family-budget:starting-bal-collapsed", next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  };

  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const categoryTree = useMemo(() => asTree(categories.data ?? []), [categories.data]);
  const colorOf = useMemo(() => makeColorResolver(categories.data ?? []), [categories.data]);

  // Savings is intentionally absent: the household ledger is bank + credit.
  const bankAccount = useMemo(
    () => (accounts.data ?? []).find((a) => a.kind === "checking"),
    [accounts.data],
  );
  const creditAccount = useMemo(
    () => (accounts.data ?? []).find((a) => a.kind === "credit"),
    [accounts.data],
  );
  const visibleAccountIds = useMemo(
    () => new Set([bankAccount?.id, creditAccount?.id].filter((x): x is number => x != null)),
    [bankAccount, creditAccount],
  );
  const accountById = useMemo(
    () => Object.fromEntries((accounts.data ?? []).map((a) => [a.id, a])),
    [accounts.data],
  );

  const effectiveMode: RangeMode =
    mode.kind === "custom" ? { kind: "custom", from: customFrom, to: customTo } : mode;
  const range = rangeBounds(effectiveMode);

  const txns = useQuery({
    queryKey: ["transactions", "unified", range.from, range.to, search],
    queryFn: () =>
      api.listTransactions({
        date_from: range.from,
        date_to: range.to,
        search: search || undefined,
        limit: 50000,
      }),
  });

  const update = useMutation({
    mutationFn: (args: Parameters<typeof api.updateTransaction>[0]) =>
      api.updateTransaction(args),
    onSuccess: () => invalidateAll(),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.deleteTransaction(id),
    onSuccess: () => invalidateAll(),
  });
  const updateAccount = useMutation({
    mutationFn: (args: { id: number; openingBalance?: number; openingDate?: string }) =>
      api.updateAccount(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
    },
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["transactions"] });
    qc.invalidateQueries({ queryKey: ["accounts"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["budget-summary"] });
  };

  // Backend returns DESC (most recent first); display ASC top-to-bottom.
  // Only bank + credit rows belong to the household ledger.
  const rows = useMemo(
    () =>
      (txns.data?.rows ?? [])
        .filter((r) => visibleAccountIds.has(r.account_id))
        .slice()
        .reverse(),
    [txns.data, visibleAccountIds],
  );

  // View filters (account / category / needs-review) applied client-side so
  // switching them is instant and never refetches.
  const filteredRows = useMemo(
    () =>
      rows.filter(
        (r) =>
          (accountFilter === "all" || r.account_id === accountFilter) &&
          (categoryFilter == null || r.category_id === categoryFilter) &&
          (!needsReviewOnly || r.needs_review),
      ),
    [rows, accountFilter, categoryFilter, needsReviewOnly],
  );
  const total = useMemo(() => filteredRows.reduce((s, r) => s + r.amount, 0), [filteredRows]);

  // ---- Projections (ghosts): bank account only ----
  const bills = useQuery({ queryKey: ["recurring-bills"], queryFn: api.listRecurringBills });
  const catNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of categories.data ?? []) m.set(c.id, c.name);
    return m;
  }, [categories.data]);

  // Pay periods from today out 2 years, used to place budget projections.
  // periods[0] is the period containing today.
  const budgetPeriods = useQuery({
    queryKey: ["pay-periods", "budget-proj", todayISO()],
    queryFn: () => api.generatePayPeriods(todayISO(), addDaysISO(todayISO(), 730)),
    retry: false,
  });
  const currentBudgetPeriod = budgetPeriods.data?.[0] ?? null;
  const monthOf = (isoDate: string) => {
    const d = new Date(isoDate + "T00:00:00");
    return {
      start: iso(new Date(d.getFullYear(), d.getMonth(), 1)),
      end: iso(new Date(d.getFullYear(), d.getMonth() + 1, 1)),
    };
  };
  // Current-period budget allocations + spend, so the current period projects
  // only the *remaining* (unspent) budget.
  const currentBudget = useQuery({
    queryKey: ["budget-summary", currentBudgetPeriod?.start, currentBudgetPeriod?.end, "proj"],
    queryFn: () => {
      const mb = monthOf(currentBudgetPeriod!.start);
      return api.budgetSummary(currentBudgetPeriod!.start, currentBudgetPeriod!.end, mb.start, mb.end);
    },
    enabled: !!currentBudgetPeriod,
  });

  const overrides = useGhostOverrides((s) => s.amounts);
  const dismissed = useGhostOverrides((s) => s.dismissed);

  // Ghosts are hidden while searching or filtering to needs-review / a single
  // category view that isn't theirs — they only make sense in the full flow.
  const showGhosts =
    !search &&
    !needsReviewOnly &&
    !!bankAccount &&
    (accountFilter === "all" || accountFilter === bankAccount.id);

  const ghosts: LedgerItem[] = useMemo(() => {
    if (!showGhosts || !bankAccount) return [];
    const t = todayISO();
    const afterToday = addDaysISO(t, 1);
    const horizon = addDaysISO(t, 730); // 2-year forecast

    type Proj = {
      date: string;
      amount: number;
      key: string; // override key
      description: string;
      categoryId: number | null;
      categoryName: string | null;
      billId?: number;
      budgetKey?: string; // "<catId>:<periodStart>"
      budgetCategoryId?: number;
    };
    const projected: Proj[] = [];

    // --- Recurring ghosts: occurrences strictly after today, within view ---
    const recStart = range.from > afterToday ? range.from : afterToday;
    const recEnd = range.to < horizon ? range.to : horizon;
    if (recStart <= recEnd) {
      const materializedBill = new Set(
        rows.filter((r) => r.from_bill_id != null).map((r) => `${r.from_bill_id}:${r.date}`),
      );
      for (const o of projectOccurrences(bills.data ?? [], recStart, recEnd)) {
        if (o.account_id !== bankAccount.id) continue;
        if (materializedBill.has(`${o.bill_id}:${o.date}`)) continue;
        const key = `bill:${o.bill_id}:${o.date}`;
        if (dismissed[key]) continue; // user deleted this projected occurrence
        projected.push({
          date: o.date,
          amount: overrides[key] ?? o.amount,
          key,
          description: o.name,
          categoryId: o.category_id,
          categoryName: o.category_id != null ? catNameById.get(o.category_id) ?? null : null,
          billId: o.bill_id,
        });
      }
    }

    // --- Budget ghosts: per-pay-period budgeted categories, current + future ---
    const allocRows = (currentBudget.data?.rows ?? []).filter(
      (r) => r.is_budgeted && r.budget_basis === "per_pay_period" && r.allocated > 0.005,
    );
    if (allocRows.length > 0) {
      const materializedBudget = new Set(
        rows.filter((r) => r.from_budget_key != null).map((r) => r.from_budget_key as string),
      );
      const periods = budgetPeriods.data ?? [];
      periods.forEach((p, pi) => {
        // Place the projection on the period's last day (end is exclusive).
        const ghostDate = addDaysISO(p.end, -1);
        if (ghostDate < t || ghostDate < range.from || ghostDate > range.to) return;
        const isCurrent = pi === 0;
        for (const r of allocRows) {
          const budgetKey = `${r.category_id}:${p.start}`;
          if (materializedBudget.has(budgetKey)) continue;
          const base = isCurrent ? -Math.max(0, r.allocated - r.spent) : -r.allocated;
          if (Math.abs(base) < 0.005) continue;
          const key = `budget:${budgetKey}`;
          if (dismissed[key]) continue; // user deleted this projected item
          projected.push({
            date: ghostDate,
            amount: overrides[key] ?? base,
            key,
            description: `Budget · ${r.category_name}`,
            categoryId: r.category_id,
            categoryName: r.category_name,
            budgetKey,
            budgetCategoryId: r.category_id,
          });
        }
      });
    }

    // Order projections chronologically; the running balance is computed later
    // in a single top-to-bottom pass over the merged display list so it always
    // sums in ledger order.
    projected.sort((a, b) => a.date.localeCompare(b.date));
    return projected
      .filter((pj) => categoryFilter == null || pj.categoryId === categoryFilter)
      .map((pj, i) => ({
        id: -1 - i,
        account_id: bankAccount.id,
        date: pj.date,
        description: pj.description,
        title: null,
        category_id: pj.categoryId,
        category_name: pj.categoryName,
        amount: pj.amount,
        memo: null,
        cleared: false,
        flagged: false,
        needs_review: false,
        split_of_id: null,
        from_bill_id: pj.billId ?? null,
        from_budget_key: pj.budgetKey ?? null,
        import_batch_id: null,
        source_override: null,
        running_balance: null,
        ghostBillId: pj.billId,
        ghostKey: pj.key,
        ghostBudgetKey: pj.budgetKey,
        ghostBudgetCategoryId: pj.budgetCategoryId,
        ghostSeq: i,
      }));
  }, [
    showGhosts,
    bankAccount,
    range.from,
    range.to,
    rows,
    bills.data,
    catNameById,
    overrides,
    dismissed,
    currentBudget.data,
    budgetPeriods.data,
    categoryFilter,
  ]);

  // Real rows + ghosts, in stable display order: by date, real before ghost on
  // the same day, then real rows by id and ghosts by their projection sequence.
  // The bank running balance is computed in one top-to-bottom pass — real bank
  // rows keep their authoritative backend running, ghosts continue from the
  // bank row above them, and credit rows are carried along without moving it.
  const { items, endBankRunning } = useMemo(() => {
    const merged: LedgerItem[] = [...filteredRows.map((r) => ({ ...r })), ...ghosts];
    merged.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      const ag = isGhost(a);
      const bg = isGhost(b);
      if (ag !== bg) return ag ? 1 : -1; // real rows before ghosts on the same day
      if (!ag) return a.id - b.id; // both real → backend order (date, id)
      // Both ghosts on the same day: projected expenses before income, so a
      // paycheck never inflates the running balance of the spending above it.
      const ai = a.amount >= 0 ? 1 : 0;
      const bi = b.amount >= 0 ? 1 : 0;
      return ai - bi || (a.ghostSeq ?? 0) - (b.ghostSeq ?? 0);
    });
    let bankRun: number | null = null;
    for (const it of merged) {
      if (!isGhost(it)) {
        if (it.account_id === bankAccount?.id && it.running_balance != null) {
          bankRun = it.running_balance;
        }
      } else {
        if (bankRun == null) bankRun = bankAccount?.current_balance ?? 0;
        bankRun += it.amount;
        it.running_balance = bankRun;
      }
    }
    return { items: merged, endBankRunning: bankRun ?? bankAccount?.current_balance ?? 0 };
  }, [filteredRows, ghosts, bankAccount]);

  // ---- Pinned Credit Card Payoff footer ----
  // The payoff amount is the card's live balance (what a payment today would
  // cost the bank account); the accordion itemizes the visible range's charges.
  const ccCharges = useMemo(
    () =>
      rows.filter((r) => r.account_id === creditAccount?.id && r.amount < 0),
    [rows, creditAccount],
  );
  const ccPayoff = creditAccount?.current_balance ?? 0; // negative = owed
  const [ccExpanded, setCcExpanded] = useState(false);
  const ccPinnedRunning = endBankRunning + ccPayoff;

  // ---- Ghost lock-in / unlock / dismiss (all undoable) ----
  const materialize = useMutation({
    mutationFn: (a: { billId: number; date: string; amount: number; cleared: boolean }) =>
      api.materializeOccurrence(a),
    onSuccess: () => invalidateAll(),
  });
  const materializeBudget = useMutation({
    mutationFn: (a: Parameters<typeof api.materializeBudgetItem>[0]) => api.materializeBudgetItem(a),
    onSuccess: () => invalidateAll(),
  });
  const setOverride = useGhostOverrides((s) => s.set);
  const clearOverride = useGhostOverrides((s) => s.clear);
  const dismissGhost = useGhostOverrides((s) => s.dismiss);
  const undismissGhost = useGhostOverrides((s) => s.undismiss);

  const ghostHandlers: GhostHandlers = {
    // Edit a ghost's amount (persisted override; affects the forecast only).
    setAmount: (key, amount) => {
      const prev = overrides[key];
      pushUndo("projection amount edit", async () => {
        if (prev === undefined) clearOverride(key);
        else setOverride(key, prev);
      });
      setOverride(key, amount);
    },
    // Check the box → lock in (materialize) the projection as a real cleared txn.
    lockIn: async (item) => {
      let newId: number | null = null;
      if (item.ghostBillId != null) {
        newId = await materialize.mutateAsync({
          billId: item.ghostBillId,
          date: item.date,
          amount: item.amount,
          cleared: true,
        });
      } else if (item.ghostBudgetKey != null) {
        newId = await materializeBudget.mutateAsync({
          accountId: item.account_id,
          categoryId: item.ghostBudgetCategoryId ?? null,
          date: item.date,
          amount: item.amount,
          description: item.description,
          cleared: true,
          budgetKey: item.ghostBudgetKey,
        });
      }
      if (item.ghostKey) clearOverride(item.ghostKey);
      if (newId != null) {
        pushUndo(`lock-in of "${item.description}"`, async () => {
          await api.deleteTransaction(newId);
        });
      }
    },
    // Uncheck the box on a locked-in projection → delete it (revert to a ghost).
    unlock: (item) => {
      const snapshot = { ...item };
      pushUndo(`unlock of "${item.title ?? item.description}"`, async () => {
        await api.restoreTransactions([snapshot]);
      });
      del.mutate(item.id);
    },
    // Delete a projected occurrence from the view (hides just this one).
    dismiss: (item) => {
      if (!item.ghostKey) return;
      const key = item.ghostKey;
      pushUndo(`removal of projected "${item.description}"`, async () => {
        undismissGhost(key);
      });
      dismissGhost(key);
    },
  };

  // ---- Row edit / delete helpers (all undoable) ----
  const editField = (
    t: Transaction,
    label: string,
    next: Omit<Parameters<typeof api.updateTransaction>[0], "id">,
    prev: Omit<Parameters<typeof api.updateTransaction>[0], "id">,
  ) => {
    pushUndo(`${label} on "${t.title ?? t.description}"`, async () => {
      await api.updateTransaction({ id: t.id, ...prev });
    });
    update.mutate({ id: t.id, ...next });
  };

  const deleteOne = (t: Transaction) => {
    const snapshot = { ...t };
    pushUndo(`delete of "${t.title ?? t.description}" (${fmtUSD(t.amount)})`, async () => {
      await api.restoreTransactions([snapshot]);
    });
    setSelected((s) => {
      if (!s.has(t.id)) return s;
      const next = new Set(s);
      next.delete(t.id);
      return next;
    });
    del.mutate(t.id);
  };

  const realVisibleIds = useMemo(
    () => items.filter((i) => !isGhost(i)).map((i) => i.id),
    [items],
  );
  const allSelected = realVisibleIds.length > 0 && realVisibleIds.every((id) => selected.has(id));
  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(realVisibleIds));
  };
  const toggleSelect = (id: number) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bulkDelete = async () => {
    const doomed = items.filter((i) => !isGhost(i) && selected.has(i.id));
    if (doomed.length === 0) return;
    if (!confirm(`Delete ${doomed.length} transaction${doomed.length === 1 ? "" : "s"}?`)) return;
    const snapshots = doomed.map((d) => ({ ...d }));
    for (const d of doomed) {
      await api.deleteTransaction(d.id);
    }
    pushUndo(`delete of ${doomed.length} transactions`, async () => {
      await api.restoreTransactions(snapshots);
    });
    setSelected(new Set());
    invalidateAll();
  };

  // When pay-period grouping is on, fetch the periods that overlap the visible
  // items (ghost dates included so generated periods reach into the future).
  const ppRange = useMemo(() => {
    if (!groupByPP || items.length === 0) return null;
    return { from: items[0].date, to: items[items.length - 1].date };
  }, [groupByPP, items]);
  const payPeriods = useQuery({
    queryKey: ["pay-periods", "unified-ledger", ppRange?.from, ppRange?.to],
    queryFn: () => api.generatePayPeriods(ppRange!.from, ppRange!.to),
    enabled: !!ppRange,
  });

  const groupedPP = useMemo(() => {
    if (!groupByPP || !payPeriods.data) return null;
    const buckets: Array<{ period: PayPeriod; rows: LedgerItem[] }> =
      payPeriods.data.map((p) => ({ period: p, rows: [] as LedgerItem[] }));
    const orphans: LedgerItem[] = [];
    // Both items and buckets are sorted ASC by date — single pass with a
    // moving pointer avoids O(items × periods). PayPeriod.end is exclusive.
    let pi = 0;
    for (const r of items) {
      while (pi < buckets.length && r.date >= buckets[pi].period.end) pi++;
      if (pi < buckets.length && r.date >= buckets[pi].period.start) {
        buckets[pi].rows.push(r);
      } else {
        orphans.push(r);
      }
    }
    return { buckets: buckets.filter((b) => b.rows.length > 0), orphans };
  }, [groupByPP, payPeriods.data, items]);

  const rowCtx: RowCtx = {
    categories: categoryTree,
    accountName: (id: number) => accountById[id]?.name ?? `#${id}`,
    bankAccountId: bankAccount?.id ?? -1,
    selected,
    toggleSelect,
    onEdit: editField,
    onDelete: deleteOne,
    onSplit: (t) => setSplitTarget(t),
    ghost: ghostHandlers,
  };

  return (
    <CategoryColorContext.Provider value={colorOf}>
    <div className="p-6 space-y-4 text-gray-900">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Ledger</h1>
          <p className="text-xs text-gray-700 mt-1">{range.label}</p>
        </div>
        <div className="flex items-center gap-1.5 text-sm flex-wrap">
          <button
            onClick={() => {
              if (mode.kind === "month") {
                const d = new Date(mode.year, mode.month - 2, 1);
                setMode({ kind: "month", year: d.getFullYear(), month: d.getMonth() + 1 });
              } else if (mode.kind === "year") {
                setMode({ kind: "year", year: mode.year - 1 });
              }
            }}
            disabled={mode.kind === "custom" || mode.kind === "all"}
            className="px-2 py-1 rounded border border-gray-200 bg-white text-gray-800 disabled:opacity-30"
          >
            ←
          </button>
          <button
            onClick={() => {
              if (mode.kind === "month") {
                const d = new Date(mode.year, mode.month, 1);
                setMode({ kind: "month", year: d.getFullYear(), month: d.getMonth() + 1 });
              } else if (mode.kind === "year") {
                setMode({ kind: "year", year: mode.year + 1 });
              }
            }}
            disabled={mode.kind === "custom" || mode.kind === "all"}
            className="px-2 py-1 rounded border border-gray-200 bg-white text-gray-800 disabled:opacity-30"
          >
            →
          </button>
          <div className="w-px h-6 bg-gray-200 mx-1" />
          {(
            [
              ["all", "All time"],
              ["month", "Monthly"],
              ["year", "Yearly"],
              ["custom", "Custom"],
            ] as const
          ).map(([k, lbl]) => (
            <button
              key={k}
              onClick={() => {
                if (k === "all") setMode({ kind: "all" });
                if (k === "month")
                  setMode({ kind: "month", year: today.getFullYear(), month: today.getMonth() + 1 });
                if (k === "year") setMode({ kind: "year", year: today.getFullYear() });
                if (k === "custom") setMode({ kind: "custom", from: customFrom, to: customTo });
              }}
              className={`px-2.5 py-1 rounded ${
                mode.kind === k
                  ? "bg-gray-900 text-white"
                  : "border border-gray-200 bg-white text-gray-800 hover:bg-gray-50"
              }`}
            >
              {lbl}
            </button>
          ))}
          {mode.kind === "custom" && (
            <>
              <input
                type="date"
                className="border border-gray-200 rounded px-2 py-1 text-sm bg-white"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
              <span className="text-xs text-gray-600">to</span>
              <input
                type="date"
                className="border border-gray-200 rounded px-2 py-1 text-sm bg-white"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </>
          )}
          <div className="w-px h-6 bg-gray-200 mx-1" />
          <button
            onClick={() => setImportOpen(true)}
            className="px-3 py-1.5 text-sm rounded-md bg-gray-900 text-white hover:bg-gray-800"
            title="Import a CSV — or just drop one anywhere on this page"
          >
            Import CSV
          </button>
        </div>
      </div>

      {bankAccount && (
        <div className="rounded-lg border border-gray-200 bg-gray-50">
          <button
            type="button"
            onClick={toggleStartingBal}
            className="w-full flex items-center justify-between gap-3 px-3 py-2"
          >
            <span className="flex items-center gap-2 text-xs uppercase tracking-wide text-gray-700 font-semibold">
              <span className="inline-block w-3">{startingBalCollapsed ? "▸" : "▾"}</span>
              Starting balances
            </span>
            {startingBalCollapsed && (
              <span className="text-xs text-gray-600 font-normal normal-case truncate">
                {bankAccount.name}: {fmtUSD(bankAccount.opening_balance)} as of {fmtDate(bankAccount.opening_date)}
                {creditAccount && (
                  <>
                    {" · "}
                    {creditAccount.name}: {fmtUSD(creditAccount.opening_balance)} as of {fmtDate(creditAccount.opening_date)}
                  </>
                )}
              </span>
            )}
          </button>
          {!startingBalCollapsed && (
            <div className="px-3 pb-3 space-y-2 border-t border-gray-200 pt-2">
              <StartingBalanceRow
                label={bankAccount.name}
                balance={bankAccount.opening_balance}
                date={bankAccount.opening_date}
                onBalanceChange={(n) =>
                  updateAccount.mutate({ id: bankAccount.id, openingBalance: n })
                }
                onDateChange={(d) =>
                  updateAccount.mutate({ id: bankAccount.id, openingDate: d })
                }
              />
              {creditAccount && (
                <StartingBalanceRow
                  label={creditAccount.name}
                  balance={creditAccount.opening_balance}
                  date={creditAccount.opening_date}
                  onBalanceChange={(n) =>
                    updateAccount.mutate({ id: creditAccount.id, openingBalance: n })
                  }
                  onDateChange={(d) =>
                    updateAccount.mutate({ id: creditAccount.id, openingDate: d })
                  }
                />
              )}
              <p className="text-xs text-gray-500 italic">
                Each account's running balance is computed forward from its starting balance.
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <select
          className="border border-gray-200 rounded px-2 py-1.5 text-sm bg-white"
          value={accountFilter === "all" ? "" : String(accountFilter)}
          onChange={(e) => setAccountFilter(e.target.value ? Number(e.target.value) : "all")}
        >
          <option value="">All accounts</option>
          {[bankAccount, creditAccount]
            .filter((a): a is NonNullable<typeof a> => a != null)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
        <select
          className="border border-gray-200 rounded px-2 py-1.5 text-sm bg-white"
          value={categoryFilter ?? ""}
          onChange={(e) => setCategoryFilter(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">All categories</option>
          {categoryTree.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Search description / memo…"
          className="border border-gray-200 rounded px-2 py-1.5 text-sm bg-white flex-1 max-w-xs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-1.5 text-sm text-gray-800">
          <input
            type="checkbox"
            checked={needsReviewOnly}
            onChange={(e) => setNeedsReviewOnly(e.target.checked)}
          />
          Needs review only
        </label>
        <label className="flex items-center gap-1.5 text-sm text-gray-800">
          <input
            type="checkbox"
            checked={groupByPP}
            onChange={(e) => setGroupByPP(e.target.checked)}
          />
          Group by pay period
        </label>
        <div className="text-sm text-gray-700 ml-auto">
          {filteredRows.length.toLocaleString()} transactions ·{" "}
          <span className={`font-medium tabular-nums ${total < 0 ? "text-red-700" : "text-green-700"}`}>
            {fmtUSD(total)}
          </span>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm">
          <span className="font-medium text-blue-900">
            {selected.size} selected
          </span>
          <button
            onClick={bulkDelete}
            className="px-2.5 py-1 rounded bg-red-600 text-white text-xs font-medium hover:bg-red-700"
          >
            Delete selected
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="px-2.5 py-1 rounded border border-blue-200 bg-white text-xs text-blue-900 hover:bg-blue-100"
          >
            Clear selection
          </button>
          <span className="text-xs text-blue-800/70">⌘Z undoes a delete</span>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white overflow-auto" style={{ maxHeight: "calc(100vh - 300px)" }}>
        <table className="text-sm" style={{ tableLayout: "fixed", width: "100%" }}>
          <thead className="sticky top-0 bg-white shadow-[0_1px_0_rgba(0,0,0,0.06)] z-10">
            <tr className="text-left text-xs uppercase tracking-wide text-gray-700">
              {(() => {
                const fluidTotal = COLS.reduce((s, c) => s + widthOf(c), 0);
                const th = (colId: LedgerColumnId, label: ReactNode, className?: string) => (
                  <ResizableTh
                    key={colId}
                    colId={colId}
                    widthOf={widthOf}
                    startResize={startResize}
                    fluidTotal={fluidTotal}
                    className={className}
                  >
                    {label}
                  </ResizableTh>
                );
                return (
                  <>
                    {th(
                      "sel",
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleSelectAll}
                        title="Select all transactions in view"
                        className="align-middle cursor-pointer"
                      />,
                      "text-center",
                    )}
                    {th("date", "Date")}
                    {th("account", "Account")}
                    {th("description", "Description")}
                    {th("memo", "Memo")}
                    {th("category", "Category")}
                    {th("source", "Source")}
                    {th("amount", "Amount", "text-right")}
                    {th("running", "Running", "text-right")}
                    {th("flags", "C/F", "text-center")}
                    {th("actions", "")}
                  </>
                );
              })()}
            </tr>
          </thead>
          {(() => {
            if (items.length === 0) {
              return (
                <tbody>
                  {!txns.isLoading && (
                    <tr>
                      <td colSpan={NUM_COLS} className="px-3 py-12 text-center text-sm text-gray-700">
                        No transactions in this range. Drop a CSV anywhere here (or use Import CSV) to get started.
                      </td>
                    </tr>
                  )}
                </tbody>
              );
            }
            // CRITICAL: when grouping is on we must NOT fall through to the
            // flat tbody while pay-periods is loading/erroring — mounting
            // every row + its stateful inline editors synchronously is what
            // wedged the tab on initial load.
            if (groupByPP) {
              if (payPeriods.isError) {
                return (
                  <tbody>
                    <tr>
                      <td colSpan={NUM_COLS} className="px-3 py-12 text-center text-sm text-amber-700">
                        Couldn't group by pay period: {String((payPeriods.error as Error | null)?.message ?? "no schedule configured")}.{" "}
                        <button onClick={() => setGroupByPP(false)} className="underline">
                          Show ungrouped list
                        </button>
                      </td>
                    </tr>
                  </tbody>
                );
              }
              if (!groupedPP) {
                return (
                  <tbody>
                    <tr>
                      <td colSpan={NUM_COLS} className="px-3 py-12 text-center text-sm text-gray-700">
                        Loading pay periods…
                      </td>
                    </tr>
                  </tbody>
                );
              }
              // Default-open only the pay period containing today (ghosts can
              // extend buckets two years out, so "last" would open the wrong
              // one). Keeping the rest collapsed keeps the mount cost flat
              // across "all time" views.
              const t = todayISO();
              const currentBucket =
                groupedPP.buckets.find((b) => b.period.start <= t && t < b.period.end) ??
                groupedPP.buckets[groupedPP.buckets.length - 1];
              const curYear = t.slice(0, 4);
              // Group the pay-period buckets by calendar year (buckets are ASC).
              const years: Array<{ year: string; buckets: typeof groupedPP.buckets }> = [];
              for (const b of groupedPP.buckets) {
                const y = b.period.start.slice(0, 4);
                let g = years.find((x) => x.year === y);
                if (!g) {
                  g = { year: y, buckets: [] };
                  years.push(g);
                }
                g.buckets.push(b);
              }
              return (
                <>
                  {years.map((yg) => {
                    const yearTotal = yg.buckets.reduce(
                      (s, b) => s + b.rows.reduce((ss, r) => ss + r.amount, 0),
                      0,
                    );
                    return (
                      <YearGroup
                        key={yg.year}
                        year={yg.year}
                        total={yearTotal}
                        groupKey={`ledger:year:${yg.year}`}
                        defaultOpen={yg.year === curYear}
                      >
                        {yg.buckets.map((bucket) => (
                          <PeriodBody
                            key={bucket.period.start}
                            label={bucket.period.label}
                            rows={bucket.rows}
                            groupKey={`ledger:pp:${bucket.period.start}`}
                            ctx={rowCtx}
                            defaultOpen={bucket === currentBucket}
                          />
                        ))}
                      </YearGroup>
                    );
                  })}
                  {groupedPP.orphans.length > 0 && (
                    <PeriodBody
                      label={`Outside any pay period (${groupedPP.orphans.length})`}
                      rows={groupedPP.orphans}
                      groupKey="ledger:pp:orphans"
                      ctx={rowCtx}
                      defaultOpen={false}
                    />
                  )}
                </>
              );
            }
            return (
              <tbody>
                {items.map((t) => (
                  <LedgerRow key={t.id} t={t} ctx={rowCtx} />
                ))}
              </tbody>
            );
          })()}
          {creditAccount && (
            <tfoot className={`${ccExpanded ? "" : "sticky bottom-0"} bg-amber-50 border-t-2 border-amber-200`}>
              <tr>
                <td className="px-3 py-2 text-amber-900 font-medium" colSpan={7}>
                  <button
                    type="button"
                    onClick={() => setCcExpanded((o) => !o)}
                    className="flex items-center gap-2 hover:text-black"
                    title="Show the credit-card charges in this view"
                  >
                    <span className="inline-block w-3">{ccExpanded ? "▾" : "▸"}</span>
                    Credit Card Payoff{" "}
                    <span className="text-xs text-amber-700 font-normal normal-case">
                      (projected — current {creditAccount.name} balance)
                    </span>
                  </button>
                </td>
                <td className={`px-3 py-2 text-right font-semibold tabular-nums ${ccPayoff < 0 ? "text-red-700" : "text-amber-900"}`}>
                  {fmtUSD(ccPayoff)}
                </td>
                <td className={`px-3 py-2 text-right font-semibold tabular-nums ${ccPinnedRunning < 0 ? "text-red-700" : "text-amber-900"}`}>
                  {fmtUSD(ccPinnedRunning)}
                </td>
                <td colSpan={2} />
              </tr>
              {ccExpanded &&
                (ccCharges.length === 0 ? (
                  <tr className="bg-amber-50/60">
                    <td colSpan={NUM_COLS} className="px-3 py-2 pl-10 text-xs text-amber-800/70 italic">
                      No credit-card charges in {range.label}.
                    </td>
                  </tr>
                ) : (
                  ccCharges.map((c) => (
                    <tr key={`ccp-${c.id}`} className="bg-amber-50/50 text-xs text-amber-900/80">
                      <td className="px-3 py-1" />
                      <td className="px-3 py-1 pl-3 whitespace-nowrap">{fmtDate(c.date)}</td>
                      <td className="px-3 py-1 truncate" colSpan={5}>
                        <span className="line-clamp-1" title={c.description}>
                          {c.title ?? c.description}
                        </span>
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-red-700">{fmtUSD(c.amount)}</td>
                      <td className="px-3 py-1 text-right text-[10px] text-amber-700/60 italic whitespace-nowrap" colSpan={3}>
                        on {creditAccount.name}
                      </td>
                    </tr>
                  ))
                ))}
            </tfoot>
          )}
        </table>
      </div>

      {splitTarget && <SplitModal txn={splitTarget} onClose={() => setSplitTarget(null)} />}
      <ImportModal open={importOpen} onOpenChange={setImportOpen} />
    </div>
    </CategoryColorContext.Provider>
  );
}

// Everything a row needs, bundled so group components stay thin.
type RowCtx = {
  categories: ReturnType<typeof asTree>;
  accountName: (id: number) => string;
  bankAccountId: number;
  selected: Set<number>;
  toggleSelect: (id: number) => void;
  onEdit: (
    t: Transaction,
    label: string,
    next: Omit<Parameters<typeof api.updateTransaction>[0], "id">,
    prev: Omit<Parameters<typeof api.updateTransaction>[0], "id">,
  ) => void;
  onDelete: (t: Transaction) => void;
  onSplit: (t: Transaction) => void;
  ghost: GhostHandlers;
};

// Collapsible year wrapper: a header tbody followed (when open) by its
// pay-period tbodies. Rendered as a fragment so the period <tbody>s remain
// siblings (a tbody can't contain tbodies).
function YearGroup({
  year,
  total,
  groupKey,
  defaultOpen,
  children,
}: {
  year: string;
  total: number;
  groupKey: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, toggle] = useCollapsed(groupKey, defaultOpen);
  return (
    <>
      <tbody>
        <tr className="bg-gray-100 border-y border-gray-300">
          <td colSpan={7} className="px-3 py-2 text-sm font-semibold text-gray-900">
            <button type="button" onClick={toggle} className="flex items-center gap-2 hover:text-black">
              <span className="inline-block w-3">{open ? "▾" : "▸"}</span>
              {year}
            </button>
          </td>
          <td
            className={`px-3 py-2 text-right text-sm font-semibold tabular-nums ${
              total < 0 ? "text-red-700" : "text-green-700"
            }`}
          >
            {fmtUSD(total)}
          </td>
          <td colSpan={3} />
        </tr>
      </tbody>
      {open && children}
    </>
  );
}

function PeriodBody({
  label,
  rows,
  groupKey,
  ctx,
  defaultOpen = true,
}: {
  label: string;
  rows: LedgerItem[];
  groupKey: string;
  ctx: RowCtx;
  defaultOpen?: boolean;
}) {
  const [open, toggle] = useCollapsed(groupKey, defaultOpen);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <tbody>
      <tr className="bg-gray-50 border-y border-gray-200">
        <td colSpan={7} className="px-3 py-1.5 text-xs font-semibold text-gray-800 uppercase tracking-wide">
          <button
            type="button"
            onClick={toggle}
            className="flex items-center gap-2 hover:text-black"
          >
            <span className="inline-block w-3">{open ? "▾" : "▸"}</span>
            {label} <span className="text-gray-500 normal-case font-normal">({rows.length})</span>
          </button>
        </td>
        <td className={`px-3 py-1.5 text-right text-xs font-semibold tabular-nums ${total < 0 ? "text-red-700" : "text-green-700"}`}>
          {fmtUSD(total)}
        </td>
        <td colSpan={3} />
      </tr>
      {open && rows.map((t) => <LedgerRow key={t.id} t={t} ctx={ctx} />)}
    </tbody>
  );
}

const SOURCE_OPTIONS: TxnSource[] = ["recurring", "imported", "manual", "budgeted"];

function LedgerRow({ t, ctx }: { t: LedgerItem; ctx: RowCtx }) {
  const colorOf = useCategoryColor();
  const isBank = t.account_id === ctx.bankAccountId;

  // Projected (ghost) row: a recurring occurrence or a budgeted item. Faint,
  // with an editable amount and an unchecked "lock in" box.
  if (isGhost(t)) {
    return (
      <tr className="border-t border-dashed border-gray-200 bg-blue-50/20 text-gray-500 italic">
        <td className="px-3 py-1.5" />
        <td className="px-3 py-1.5 whitespace-nowrap truncate">{fmtDate(t.date)}</td>
        <td className="px-3 py-1.5 whitespace-nowrap truncate text-gray-400">
          {ctx.accountName(t.account_id)}
        </td>
        <td className="px-3 py-1.5 truncate">
          <span className="line-clamp-1" title={t.description}>
            {t.description}
          </span>
        </td>
        <td className="px-3 py-1.5 text-gray-400">—</td>
        <td className="px-3 py-1.5">
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block w-2 h-2 rounded-sm shrink-0"
              style={{ background: colorOf(t.category_id) ?? "transparent" }}
            />
            <span className="text-xs truncate not-italic text-gray-600">
              {t.category_name ?? "(uncategorized)"}
            </span>
          </div>
        </td>
        <td className="px-3 py-1.5 overflow-hidden">
          <span className="block truncate not-italic text-[10px] uppercase tracking-wide text-blue-600/70">
            {t.ghostBudgetKey != null ? "Budgeted" : "Recurring"} · upcoming
          </span>
        </td>
        <td className={`px-3 py-1.5 text-right tabular-nums ${t.amount < 0 ? "text-red-600/80" : "text-green-700/80"}`}>
          <GhostAmount
            value={t.amount}
            onCommit={(amount) => t.ghostKey && ctx.ghost.setAmount(t.ghostKey, amount)}
          />
        </td>
        <td className="px-3 py-1.5 text-right tabular-nums text-gray-400 truncate">
          {t.running_balance != null ? fmtUSD(t.running_balance) : ""}
        </td>
        <td className="px-3 py-1.5" />
        <td className="px-3 py-1.5 whitespace-nowrap">
          <div className="flex items-center justify-center gap-3">
            <input
              type="checkbox"
              checked={false}
              onChange={() => ctx.ghost.lockIn(t)}
              title="Lock this in as a real transaction"
              className="cursor-pointer align-middle"
            />
            <button
              type="button"
              onClick={() => ctx.ghost.dismiss(t)}
              title="Remove this projected item from the ledger"
              className="text-xs not-italic text-gray-400 hover:text-red-700"
            >
              Delete
            </button>
          </div>
        </td>
      </tr>
    );
  }

  const locked = isLockedProjection(t);
  const isChild = t.split_of_id !== null;
  // Unreviewed rows are grayed + italic so they read as "not yet balanced".
  const muted = t.needs_review;
  return (
    <tr
      className={`border-t border-gray-100 hover:bg-gray-50 ${isChild ? "bg-gray-50/50" : ""} ${
        t.flagged ? "ring-1 ring-amber-300/40" : ""
      } ${muted ? "text-gray-400 italic" : ""}`}
    >
      <td className="px-3 py-1.5 text-center">
        <input
          type="checkbox"
          checked={ctx.selected.has(t.id)}
          onChange={() => ctx.toggleSelect(t.id)}
          className="cursor-pointer align-middle"
        />
      </td>
      <td className={`px-3 py-1.5 whitespace-nowrap truncate ${muted ? "" : "text-gray-800"}`}>
        {isChild && <span className="text-gray-400 mr-1">↳</span>}
        <InlineDate
          value={t.date}
          onSave={(date) => ctx.onEdit(t, "date edit", { date }, { date: t.date })}
        />
      </td>
      <td className={`px-3 py-1.5 whitespace-nowrap truncate ${muted ? "" : "text-gray-700"}`}>
        {ctx.accountName(t.account_id)}
      </td>
      <td className="px-3 py-1.5 truncate">
        <InlineText
          value={t.title ?? t.description}
          onSave={(v) =>
            ctx.onEdit(t, "description edit", { title: v || null }, { title: t.title })
          }
        />
      </td>
      <td className="px-3 py-1.5">
        <MemoCell
          value={t.memo}
          onSave={(v) => ctx.onEdit(t, "memo edit", { memo: v }, { memo: t.memo })}
        />
      </td>
      <td className="px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <span
            className="inline-block w-2 h-2 rounded-sm shrink-0"
            style={{ background: colorOf(t.category_id) ?? "transparent" }}
          />
          <select
            className="border border-gray-200 rounded px-1.5 py-0.5 text-xs bg-white w-full not-italic"
            value={t.category_id ?? ""}
            onChange={(e) =>
              ctx.onEdit(
                t,
                "category change",
                { categoryId: e.target.value ? Number(e.target.value) : null },
                { categoryId: t.category_id, needsReview: t.needs_review },
              )
            }
          >
            <option value="">(uncategorized)</option>
            {ctx.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </td>
      <td className="px-3 py-1.5">
        <select
          className="border border-gray-200 rounded px-1.5 py-0.5 text-xs bg-white w-full not-italic text-gray-700"
          value={txnSource(t)}
          onChange={(e) =>
            ctx.onEdit(
              t,
              "source change",
              { sourceOverride: e.target.value },
              { sourceOverride: t.source_override },
            )
          }
          title="How this transaction entered the ledger"
        >
          {SOURCE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {TXN_SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
      </td>
      <td
        className={`px-3 py-1.5 text-right tabular-nums truncate ${
          t.amount < 0
            ? muted
              ? "text-red-400"
              : "text-red-700"
            : muted
              ? "text-green-600/60"
              : "text-green-700"
        }`}
      >
        <InlineNumber
          value={t.amount}
          onSave={(amount) => ctx.onEdit(t, "amount edit", { amount }, { amount: t.amount })}
        />
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums text-gray-700 truncate">
        {isBank && t.running_balance != null ? fmtUSD(t.running_balance) : ""}
      </td>
      <td className="px-3 py-1.5 text-center whitespace-nowrap not-italic overflow-hidden">
        {t.needs_review && (
          <button
            title="Auto-categorized — click to mark reviewed"
            onClick={() =>
              ctx.onEdit(t, "review", { needsReview: false }, { needsReview: true })
            }
            className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 hover:bg-amber-200 mr-1.5"
          >
            Review
          </button>
        )}
        <button
          title={t.cleared ? "Cleared" : "Mark cleared"}
          onClick={() =>
            ctx.onEdit(
              t,
              t.cleared ? "un-clear" : "clear",
              { cleared: !t.cleared },
              { cleared: t.cleared },
            )
          }
          className={`text-base font-bold leading-none mr-1.5 align-middle ${
            t.cleared ? "text-green-700" : "text-gray-400 hover:text-gray-700"
          }`}
        >
          ✓
        </button>
        <button
          title={t.flagged ? "Flagged" : "Flag"}
          onClick={() =>
            ctx.onEdit(
              t,
              t.flagged ? "un-flag" : "flag",
              { flagged: !t.flagged },
              { flagged: t.flagged },
            )
          }
          className={`text-base font-bold leading-none align-middle ${
            t.flagged ? "text-amber-600" : "text-gray-400 hover:text-gray-700"
          }`}
        >
          ⚑
        </button>
      </td>
      <td className="px-3 py-1.5 text-right whitespace-nowrap not-italic">
        {locked ? (
          <input
            type="checkbox"
            checked
            onChange={() => ctx.ghost.unlock(t)}
            title="Locked in from a projection — uncheck to undo"
            className="cursor-pointer align-middle"
          />
        ) : (
          <>
            {!isChild && (
              <button
                onClick={() => ctx.onSplit(t)}
                className="text-xs text-gray-500 hover:text-black mr-3"
              >
                Split
              </button>
            )}
            <button
              onClick={() => ctx.onDelete(t)}
              title="Delete (⌘Z to undo)"
              className="text-xs text-gray-600 hover:text-red-700"
            >
              Delete
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

function InlineText({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing) {
    return (
      <span
        className="line-clamp-1 cursor-text"
        onDoubleClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        title="Double-click to edit"
      >
        {value || <span className="text-gray-400">—</span>}
      </span>
    );
  }
  return (
    <input
      autoFocus
      className="w-full border rounded px-1 py-0.5 text-sm bg-white not-italic"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft !== value) onSave(draft);
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

function InlineNumber({ value, onSave }: { value: number; onSave: (n: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value.toFixed(2));
  if (!editing) {
    return (
      <span
        className="cursor-text tabular-nums"
        onDoubleClick={() => {
          setDraft(value.toFixed(2));
          setEditing(true);
        }}
        title="Double-click to edit"
      >
        {fmtUSD(value)}
      </span>
    );
  }
  return (
    <input
      autoFocus
      type="number"
      step="0.01"
      className="w-24 border rounded px-1 py-0.5 text-sm bg-white text-right tabular-nums not-italic"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const n = parseFloat(draft);
        if (!Number.isNaN(n) && n !== value) onSave(n);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value.toFixed(2));
          setEditing(false);
        }
      }}
    />
  );
}

function InlineDate({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <span
        className="cursor-text"
        onDoubleClick={() => setEditing(true)}
        title="Double-click to edit"
      >
        {fmtDate(value)}
      </span>
    );
  }
  return (
    <input
      autoFocus
      type="date"
      className="border rounded px-1 py-0.5 text-sm bg-white not-italic"
      defaultValue={value}
      onBlur={(e) => {
        setEditing(false);
        if (e.target.value && e.target.value !== value) onSave(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

function MemoCell({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  if (!editing) {
    return (
      <span
        className="line-clamp-1 cursor-text text-xs block min-h-[1.2em]"
        onDoubleClick={() => {
          setDraft(value ?? "");
          setEditing(true);
        }}
        title="Double-click to add/edit a memo"
      >
        {value || <span className="text-gray-400 italic">add memo…</span>}
      </span>
    );
  }
  return (
    <input
      autoFocus
      className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs bg-white not-italic"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        // Save anything different — empty string is a valid "clear" intent.
        if (draft !== (value ?? "")) onSave(draft === "" ? null : draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value ?? "");
          setEditing(false);
        }
      }}
    />
  );
}

// Editable amount for a projected ghost row. Editing stores a forecast
// override with the entered magnitude, preserving the expense/income sign.
function GhostAmount({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(Math.abs(value).toFixed(2));
  if (!editing) {
    return (
      <span
        className="cursor-text"
        onDoubleClick={() => {
          setDraft(Math.abs(value).toFixed(2));
          setEditing(true);
        }}
        title="Double-click to adjust the projected amount"
      >
        {fmtUSD(value)}
      </span>
    );
  }
  const sign = value < 0 ? -1 : 1;
  return (
    <input
      autoFocus
      type="number"
      step="0.01"
      className="w-24 border rounded px-1 py-0.5 text-sm bg-white text-right tabular-nums not-italic"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const mag = parseFloat(draft);
        if (!Number.isNaN(mag)) {
          const signed = sign * Math.abs(mag);
          if (signed !== value) onCommit(signed);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

function StartingBalanceRow({
  label,
  balance,
  date,
  onBalanceChange,
  onDateChange,
}: {
  label: string;
  balance: number;
  date: string;
  onBalanceChange: (n: number) => void;
  onDateChange: (d: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-xs text-gray-700 w-40 truncate">{label}</span>
      <OpeningBalanceInput initial={balance} onSave={onBalanceChange} />
      <span className="text-xs text-gray-600">as of</span>
      <input
        type="date"
        className="border border-gray-200 rounded px-2 py-1 text-sm bg-white"
        defaultValue={date}
        key={date}
        onBlur={(e) => {
          if (e.target.value && e.target.value !== date) onDateChange(e.target.value);
        }}
      />
    </div>
  );
}

function OpeningBalanceInput({
  initial,
  onSave,
}: {
  initial: number;
  onSave: (n: number) => void;
}) {
  const [v, setV] = useState(initial.toFixed(2));
  return (
    <input
      type="number"
      step="0.01"
      className="w-32 text-right border border-gray-200 rounded px-2 py-1 text-sm bg-white tabular-nums"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const n = parseFloat(v);
        if (!Number.isNaN(n) && Math.abs(n - initial) > 0.005) onSave(n);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
