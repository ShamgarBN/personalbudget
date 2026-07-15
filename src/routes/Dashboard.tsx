import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api } from "@/api";
import { fmtDate, fmtUSD, todayISO } from "@/lib/formatting";
import type {
  CategoryDrift,
  MonthlyCashFlow,
  MonthlyNetWorth,
  PayPeriod,
  RecurringBill,
  Transaction,
} from "@/api/types";

// =============================================================================
// Widget catalog
// =============================================================================

type WidgetId =
  | "net-worth"
  | "free-cash"
  | "this-period"
  | "cash-flow"
  | "net-worth-trend"
  | "category-donut"
  | "category-drift"
  | "savings-rate"
  | "largest-txns"
  | "upcoming-bills"
  | "goals";

interface WidgetMeta {
  title: string;
  size: 4 | 6 | 12; // grid column span on 12-col grid
}

const WIDGETS: Record<WidgetId, WidgetMeta> = {
  "net-worth": { title: "Net worth", size: 4 },
  "free-cash": { title: "Free cash", size: 4 },
  "this-period": { title: "This pay period", size: 4 },
  "cash-flow": { title: "Cash flow · last 12 months", size: 6 },
  "net-worth-trend": { title: "Net worth · last 12 months", size: 6 },
  "category-donut": { title: "Spending by category", size: 6 },
  "category-drift": { title: "Category drift", size: 6 },
  "savings-rate": { title: "Savings rate", size: 6 },
  "largest-txns": { title: "Largest transactions", size: 6 },
  "upcoming-bills": { title: "Upcoming bills", size: 6 },
  goals: { title: "Goals", size: 6 },
};

const ALL_IDS = Object.keys(WIDGETS) as WidgetId[];
const DEFAULT_ORDER: WidgetId[] = [...ALL_IDS];

// Pack widgets into rows greedily: keep adding to the current row until the
// next widget's declared size would push the row past 12 "slots", then start
// a new row. Within each row every card flexes to equal width — so three
// "small" (size-4) widgets each take 1/3, but if you hide one the remaining
// two spread to 1/2 each. The declared size is only used to decide where the
// row breaks; it doesn't pin actual widths.
function packRows(order: WidgetId[]): WidgetId[][] {
  const rows: WidgetId[][] = [];
  let current: WidgetId[] = [];
  let total = 0;
  for (const id of order) {
    const s = WIDGETS[id].size;
    if (total + s > 12 && current.length > 0) {
      rows.push(current);
      current = [id];
      total = s;
    } else {
      current.push(id);
      total += s;
    }
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

interface Layout {
  order: WidgetId[];
  hidden: WidgetId[];
}

const LAYOUT_KEY = "family-budget:dashboard-layout-v1";

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Layout>;
      const known = new Set<WidgetId>(ALL_IDS);
      const order = (parsed.order ?? []).filter((id): id is WidgetId =>
        known.has(id as WidgetId),
      );
      const hidden = (parsed.hidden ?? []).filter((id): id is WidgetId =>
        known.has(id as WidgetId),
      );
      // Any newly-introduced widget that isn't in saved state defaults to visible.
      const present = new Set<WidgetId>([...order, ...hidden]);
      for (const id of ALL_IDS) {
        if (!present.has(id)) order.push(id);
      }
      return { order, hidden };
    }
  } catch {
    // Fall through to default.
  }
  return { order: [...DEFAULT_ORDER], hidden: [] };
}

function saveLayout(layout: Layout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // localStorage full or disabled — silently drop.
  }
}

// =============================================================================
// Period model — pay period (offset), month (y/m), year (y), trailing windows
// =============================================================================

type Period =
  | { kind: "pp"; offset: number } // 0 = current pay period, -1 = previous, +1 = next, etc.
  | { kind: "month"; year: number; month: number /* 1-12 */ }
  | { kind: "year"; year: number }
  | { kind: "last30" }
  | { kind: "last90" }
  | { kind: "custom"; from: string; to: string };

function calendarRange(p: Period): { from: string; to: string; label: string } {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const at = (y: number, m: number, d: number) => new Date(y, m, d);
  switch (p.kind) {
    case "month": {
      const from = at(p.year, p.month - 1, 1);
      const to = at(p.year, p.month, 0); // last day of month
      const label = from.toLocaleDateString("en-US", { month: "long", year: "numeric" });
      return { from: iso(from), to: iso(to), label };
    }
    case "year": {
      const isCurrent = p.year === today.getFullYear();
      const to = isCurrent ? today : at(p.year, 11, 31);
      return {
        from: `${p.year}-01-01`,
        to: iso(to),
        label: isCurrent ? `${p.year} · year to date` : String(p.year),
      };
    }
    case "last30": {
      const from = new Date(today);
      from.setDate(from.getDate() - 30);
      return { from: iso(from), to: iso(today), label: "Last 30 days" };
    }
    case "last90": {
      const from = new Date(today);
      from.setDate(from.getDate() - 90);
      return { from: iso(from), to: iso(today), label: "Last 90 days" };
    }
    case "custom":
      return { from: p.from, to: p.to, label: `${fmtDate(p.from)} – ${fmtDate(p.to)}` };
    case "pp":
      // Resolved separately from the loaded pay-period list.
      return { from: iso(today), to: iso(today), label: "Pay period" };
  }
}

function isNavigable(p: Period): boolean {
  return p.kind === "pp" || p.kind === "month" || p.kind === "year";
}

function shiftPeriod(p: Period, dir: -1 | 1): Period {
  switch (p.kind) {
    case "pp":
      return { kind: "pp", offset: p.offset + dir };
    case "month": {
      let { year, month } = p;
      month += dir;
      if (month < 1) {
        month = 12;
        year -= 1;
      } else if (month > 12) {
        month = 1;
        year += 1;
      }
      return { kind: "month", year, month };
    }
    case "year":
      return { kind: "year", year: p.year + dir };
    default:
      return p;
  }
}

// =============================================================================
// Dashboard
// =============================================================================

export default function Dashboard() {
  const [layout, setLayoutState] = useState<Layout>(loadLayout);
  const setLayout = useCallback((next: Layout) => {
    setLayoutState(next);
    saveLayout(next);
  }, []);

  const [period, setPeriod] = useState<Period>({ kind: "pp", offset: 0 });
  const [customFrom, setCustomFrom] = useState<string>(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 10);
  });
  const [customTo, setCustomTo] = useState<string>(todayISO());

  // Pre-load a wide pay-period window so prev/next can scroll years back
  // without re-querying. Window is fixed at mount; only the offset moves.
  const ppWindow = useMemo(() => {
    const t = new Date();
    const from = new Date(t.getFullYear() - 3, t.getMonth(), 1).toISOString().slice(0, 10);
    const to = new Date(t.getFullYear(), t.getMonth() + 3, 0).toISOString().slice(0, 10);
    return { from, to };
  }, []);
  const payPeriods = useQuery({
    queryKey: ["pay-periods", "dashboard", ppWindow.from, ppWindow.to],
    queryFn: () => api.generatePayPeriods(ppWindow.from, ppWindow.to),
    retry: false,
  });
  const today = todayISO();
  const currentPpIdx = useMemo(() => {
    const arr = payPeriods.data ?? [];
    return arr.findIndex((p) => p.start <= today && today < p.end);
  }, [payPeriods.data, today]);
  const selectedPp: PayPeriod | null = useMemo(() => {
    if (period.kind !== "pp") return null;
    const arr = payPeriods.data ?? [];
    if (currentPpIdx < 0) return null;
    const target = currentPpIdx + period.offset;
    if (target < 0 || target >= arr.length) return null;
    return arr[target];
  }, [period, payPeriods.data, currentPpIdx]);

  // When the user picks "pp" but has no schedule, fall through to the current
  // month so the dashboard never blocks on configuration.
  const effective: Period = useMemo(() => {
    if (period.kind === "custom") return { kind: "custom", from: customFrom, to: customTo };
    if (period.kind === "pp" && !selectedPp && !payPeriods.isLoading) {
      const t = new Date();
      return { kind: "month", year: t.getFullYear(), month: t.getMonth() + 1 };
    }
    return period;
  }, [period, customFrom, customTo, selectedPp, payPeriods.isLoading]);

  const range = useMemo(() => {
    if (effective.kind === "pp" && selectedPp) {
      return {
        from: selectedPp.start,
        // PayPeriod.end is exclusive; existing endpoints use inclusive `to`.
        to: shiftIso(selectedPp.end, -1),
        label: `Pay period · ${selectedPp.label}`,
      };
    }
    return calendarRange(effective);
  }, [effective, selectedPp]);

  // Days remaining in the SELECTED pay period — only meaningful when looking
  // at the current pp (offset 0); past periods are already over.
  const daysLeft = useMemo(() => {
    if (
      effective.kind !== "pp" ||
      !selectedPp ||
      period.kind !== "pp" ||
      period.offset !== 0
    ) {
      return null;
    }
    const end = new Date(selectedPp.end + "T00:00:00");
    const t = new Date(today + "T00:00:00");
    return Math.max(0, Math.ceil((end.getTime() - t.getTime()) / 86400000));
  }, [effective.kind, selectedPp, period, today]);
  const ppLengthDays = useMemo(() => {
    if (!selectedPp) return null;
    const s = new Date(selectedPp.start + "T00:00:00");
    const e = new Date(selectedPp.end + "T00:00:00");
    return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000));
  }, [selectedPp]);

  // ---------------------------- data queries ----------------------------

  const summary = useQuery({
    queryKey: ["dashboard", range.from, range.to],
    queryFn: () => api.dashboardSummary(range.from, range.to),
  });
  const cashFlow = useQuery({
    queryKey: ["cash-flow-monthly", 12],
    queryFn: () => api.cashFlowMonthly(12),
  });
  const netWorthSeries = useQuery({
    queryKey: ["net-worth-monthly", 12],
    queryFn: () => api.netWorthMonthly(12),
    // Savings isn't tracked in this tool anymore (v1.4) — recompute each
    // month's total as bank + credit so every widget stays consistent.
    select: (rows) => rows.map((m) => ({ ...m, total: m.checking + m.credit })),
  });
  const drift = useQuery({
    queryKey: ["category-drift", range.from, range.to],
    queryFn: () => api.categoryDrift(range.from, shiftIso(range.to, 1), 3),
    enabled: !!range.from && !!range.to,
  });
  const bills = useQuery({ queryKey: ["recurring-bills"], queryFn: api.listRecurringBills });
  const goals = useQuery({ queryKey: ["goals"], queryFn: api.listGoals });
  const needsReview = useQuery({
    queryKey: ["transactions", "needs-review-count"],
    queryFn: () => api.listTransactions({ needs_review: true, limit: 1 }),
  });
  const largestTxns = useQuery({
    queryKey: ["transactions", "largest", range.from, range.to],
    queryFn: () =>
      api.listTransactions({ date_from: range.from, date_to: range.to, limit: 500 }),
  });
  // Calendar-month window containing the selected range start — used so
  // monthly-basis budget categories measure spend against their month.
  const monthBounds = useMemo(() => {
    const d = new Date(range.from + "T00:00:00");
    const ms = new Date(d.getFullYear(), d.getMonth(), 1);
    const me = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const iso = (x: Date) => x.toISOString().slice(0, 10);
    return { start: iso(ms), end: iso(me) };
  }, [range.from]);
  const budgetSummary = useQuery({
    queryKey: ["budget-summary", range.from, range.to, monthBounds.start, monthBounds.end],
    queryFn: () =>
      api.budgetSummary(range.from, shiftIso(range.to, 1), monthBounds.start, monthBounds.end),
  });

  // ---------------------------- derived ----------------------------

  // Now-focused account balances drive Net worth and Free cash widgets,
  // which always reflect the present regardless of period selection.
  const liveAccounts = useQuery({
    queryKey: ["accounts"],
    queryFn: api.listAccounts,
  });
  const liveByKind = useMemo(() => {
    const out = { checking: 0, savings: 0, credit: 0 };
    for (const a of liveAccounts.data ?? []) {
      if (a.archived) continue;
      if (a.kind === "checking") out.checking += a.current_balance;
      else if (a.kind === "savings") out.savings += a.current_balance;
      else if (a.kind === "credit") out.credit += a.current_balance;
    }
    return out;
  }, [liveAccounts.data]);
  // Savings isn't tracked in this tool anymore (v1.4) — the household position
  // is bank minus what's owed on the card.
  const liveNetWorth = liveByKind.checking + liveByKind.credit;

  const upcoming14 = useMemo(() => projectUpcoming(bills.data ?? [], 14), [bills.data]);
  const upcoming7 = useMemo(() => projectUpcoming(bills.data ?? [], 7), [bills.data]);
  // Only expense occurrences (signed negative) reduce free cash; recurring
  // income is ignored here so the "spendable" number stays conservative.
  const upcoming14Total = upcoming14.reduce((s, b) => s + (b.amount < 0 ? -b.amount : 0), 0);

  const freeCash = liveByKind.checking - upcoming14Total - Math.abs(liveByKind.credit);

  // Pay-period burn from budget allocations (works for any period scope).
  const burn = useMemo(() => {
    if (!budgetSummary.data) return null;
    // budget_summary now returns every category; the burn widget only tracks
    // the ones actually being budgeted.
    const budgetedRows = budgetSummary.data.rows.filter((r) => r.is_budgeted);
    const allocated = budgetedRows.reduce((s, r) => s + r.allocated, 0);
    const spent = budgetedRows.reduce((s, r) => s + r.spent, 0);
    return { allocated, spent };
  }, [budgetSummary.data]);
  const projectedEnd = useMemo(() => {
    if (!burn || daysLeft == null || ppLengthDays == null) return null;
    const elapsed = ppLengthDays - daysLeft;
    if (elapsed <= 0) return burn.spent;
    const dailyRate = burn.spent / elapsed;
    return burn.spent + dailyRate * daysLeft;
  }, [burn, daysLeft, ppLengthDays]);

  // Savings rate uses cash-flow data which is always trailing 12 months,
  // so it's stable across period selection.
  const savingsRate = useMemo(() => {
    const months = cashFlow.data ?? [];
    if (months.length === 0) return null;
    const completed = months.slice(0, -1); // skip current partial month
    const recent3 = completed.slice(-3);
    const sum = (arr: MonthlyCashFlow[]) => ({
      income: arr.reduce((s, m) => s + m.income, 0),
      expense: arr.reduce((s, m) => s + m.expense, 0),
    });
    const current = months[months.length - 1];
    const trailing = sum(recent3);
    const rateOf = (income: number, expense: number) =>
      income > 0 ? (income - expense) / income : null;
    return {
      current: rateOf(current.income, current.expense),
      trailing: rateOf(trailing.income, trailing.expense),
    };
  }, [cashFlow.data]);

  const topTxns = useMemo(() => {
    const rows = largestTxns.data?.rows ?? [];
    return rows
      .filter((t) => t.split_of_id === null && (t.category_name ?? "") !== "Transfer")
      .slice()
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      .slice(0, 7);
  }, [largestTxns.data]);

  const nwDelta30 = useMemo(() => {
    const arr = netWorthSeries.data ?? [];
    if (arr.length < 2) return null;
    return arr[arr.length - 1].total - arr[arr.length - 2].total;
  }, [netWorthSeries.data]);

  // ---------------------------- layout ops ----------------------------

  const hideWidget = useCallback(
    (id: WidgetId) => {
      const order = layout.order.filter((x) => x !== id);
      const hidden = layout.hidden.includes(id) ? layout.hidden : [...layout.hidden, id];
      setLayout({ order, hidden });
    },
    [layout, setLayout],
  );
  const restoreWidget = useCallback(
    (id: WidgetId) => {
      const hidden = layout.hidden.filter((x) => x !== id);
      const order = layout.order.includes(id) ? layout.order : [...layout.order, id];
      setLayout({ order, hidden });
    },
    [layout, setLayout],
  );
  const resetLayout = useCallback(() => {
    setLayout({ order: [...DEFAULT_ORDER], hidden: [] });
  }, [setLayout]);

  const sensors = useSensors(
    // Small activation distance so a click on the drag handle isn't immediately
    // interpreted as a drag — keeps the close X easy to click.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const oldIdx = layout.order.indexOf(active.id as WidgetId);
      const newIdx = layout.order.indexOf(over.id as WidgetId);
      if (oldIdx < 0 || newIdx < 0) return;
      const next = layout.order.slice();
      next.splice(oldIdx, 1);
      next.splice(newIdx, 0, active.id as WidgetId);
      setLayout({ ...layout, order: next });
    },
    [layout, setLayout],
  );

  // ---------------------------- widget renderer ----------------------------

  const renderWidget = (id: WidgetId): React.ReactNode => {
    switch (id) {
      case "net-worth":
        return (
          <NetWorthWidget
            netWorth={liveNetWorth}
            delta30={nwDelta30}
            series={netWorthSeries.data ?? []}
          />
        );
      case "free-cash":
        return (
          <FreeCashWidget
            freeCash={freeCash}
            byKind={liveByKind}
            upcoming14Total={upcoming14Total}
          />
        );
      case "this-period":
        return (
          <ThisPeriodWidget
            label={range.label}
            burn={burn}
            projectedEnd={projectedEnd}
            daysLeft={daysLeft}
          />
        );
      case "cash-flow":
        return <CashFlowWidget data={cashFlow.data ?? []} loading={cashFlow.isLoading} />;
      case "net-worth-trend":
        return (
          <NetWorthTrendWidget
            data={netWorthSeries.data ?? []}
            loading={netWorthSeries.isLoading}
          />
        );
      case "category-donut":
        return (
          <CategoryDonutWidget
            categories={summary.data?.categories ?? []}
            rangeLabel={range.label}
          />
        );
      case "category-drift":
        return <CategoryDriftWidget data={drift.data ?? []} />;
      case "savings-rate":
        return <SavingsRateWidget data={savingsRate} />;
      case "largest-txns":
        return <LargestTxnsWidget txns={topTxns} rangeLabel={range.label} />;
      case "upcoming-bills":
        return <UpcomingBillsWidget upcoming={upcoming14} />;
      case "goals":
        return <GoalsWidget goals={goals.data ?? []} />;
    }
  };

  // ---------------------------- render ----------------------------

  return (
    <div className="p-6 space-y-6 text-gray-900">
      <Header
        rangeLabel={range.label}
        period={period}
        setPeriod={setPeriod}
        customFrom={customFrom}
        setCustomFrom={setCustomFrom}
        customTo={customTo}
        setCustomTo={setCustomTo}
        ppAvailable={(payPeriods.data?.length ?? 0) > 0 && currentPpIdx >= 0}
        canPrev={canShift(period, -1, payPeriods.data ?? [], currentPpIdx)}
        canNext={canShift(period, 1, payPeriods.data ?? [], currentPpIdx)}
      />

      <ActionCallouts
        needsReviewCount={needsReview.data?.total ?? 0}
        upcoming7={upcoming7}
        bills={bills.data ?? []}
        creditBalance={liveByKind.credit}
      />

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={layout.order} strategy={rectSortingStrategy}>
          <div className="space-y-4">
            {packRows(layout.order).map((row, ri) => (
              <div key={ri} className="flex flex-col md:flex-row gap-4">
                {row.map((id) => (
                  <SortableCard key={id} id={id} onClose={() => hideWidget(id)}>
                    {renderWidget(id)}
                  </SortableCard>
                ))}
              </div>
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <HiddenWidgetsStrip
        hidden={layout.hidden}
        onRestore={restoreWidget}
        onResetAll={resetLayout}
      />
    </div>
  );
}

// =============================================================================
// Header — period selector with prev/next arrows
// =============================================================================

function Header({
  rangeLabel,
  period,
  setPeriod,
  customFrom,
  setCustomFrom,
  customTo,
  setCustomTo,
  ppAvailable,
  canPrev,
  canNext,
}: {
  rangeLabel: string;
  period: Period;
  setPeriod: (p: Period) => void;
  customFrom: string;
  setCustomFrom: (s: string) => void;
  customTo: string;
  setCustomTo: (s: string) => void;
  ppAvailable: boolean;
  canPrev: boolean;
  canNext: boolean;
}) {
  const today = new Date();
  // Each entry: label, the action that switches to that kind's "current"
  // default, and whether that kind is currently active.
  const buttons: Array<[string, () => void, boolean]> = [
    ["Pay period", () => setPeriod({ kind: "pp", offset: 0 }), period.kind === "pp"],
    [
      "Month",
      () => setPeriod({ kind: "month", year: today.getFullYear(), month: today.getMonth() + 1 }),
      period.kind === "month",
    ],
    ["Last 30", () => setPeriod({ kind: "last30" }), period.kind === "last30"],
    ["Last 90", () => setPeriod({ kind: "last90" }), period.kind === "last90"],
    ["Year", () => setPeriod({ kind: "year", year: today.getFullYear() }), period.kind === "year"],
    [
      "Custom",
      () => setPeriod({ kind: "custom", from: customFrom, to: customTo }),
      period.kind === "custom",
    ],
  ];
  const navigable = isNavigable(period);
  return (
    <div className="flex items-end justify-between flex-wrap gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Dashboard</h1>
        <p className="text-xs text-gray-700 mt-1">{rangeLabel}</p>
      </div>
      <div className="flex items-center gap-1 text-sm flex-wrap">
        <button
          aria-label="Previous"
          onClick={() => setPeriod(shiftPeriod(period, -1))}
          disabled={!navigable || !canPrev}
          title={navigable ? "Previous" : "Only pay period / month / year can be navigated"}
          className="px-2 py-1 rounded border border-gray-200 bg-white text-gray-800 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          ←
        </button>
        <button
          aria-label="Next"
          onClick={() => setPeriod(shiftPeriod(period, 1))}
          disabled={!navigable || !canNext}
          title={navigable ? "Next" : "Only pay period / month / year can be navigated"}
          className="px-2 py-1 rounded border border-gray-200 bg-white text-gray-800 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          →
        </button>
        <div className="w-px h-6 bg-gray-200 mx-1" />
        {buttons.map(([label, onClick, active], i) => {
          const disabled = label === "Pay period" && !ppAvailable;
          return (
            <button
              key={i}
              onClick={onClick}
              disabled={disabled}
              title={disabled ? "No pay-period schedule configured yet" : undefined}
              className={`px-2.5 py-1 rounded text-gray-800 ${
                active
                  ? "bg-gray-900 text-white"
                  : "border border-gray-200 bg-white hover:bg-gray-50"
              } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
            >
              {label}
            </button>
          );
        })}
        {period.kind === "custom" && (
          <>
            <input
              type="date"
              className="border border-gray-200 rounded px-2 py-1 text-sm bg-white"
              value={customFrom}
              onChange={(e) => {
                setCustomFrom(e.target.value);
                setPeriod({ kind: "custom", from: e.target.value, to: customTo });
              }}
            />
            <span className="text-gray-600 text-xs">to</span>
            <input
              type="date"
              className="border border-gray-200 rounded px-2 py-1 text-sm bg-white"
              value={customTo}
              onChange={(e) => {
                setCustomTo(e.target.value);
                setPeriod({ kind: "custom", from: customFrom, to: e.target.value });
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

function canShift(p: Period, dir: -1 | 1, pps: PayPeriod[], currentIdx: number): boolean {
  if (!isNavigable(p)) return false;
  if (p.kind === "pp") {
    if (pps.length === 0 || currentIdx < 0) return false;
    const target = currentIdx + p.offset + dir;
    return target >= 0 && target < pps.length;
  }
  // month and year scroll freely; data may be empty at extremes and the UI
  // handles that with empty states.
  return true;
}

// =============================================================================
// SortableCard — drag/drop + close X wrapper
// =============================================================================

function SortableCard({
  id,
  onClose,
  children,
}: {
  id: WidgetId;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Equal-width flex within the row. The packing logic upstream decides how
    // many widgets share a row based on declared sizes; here, every card in a
    // row gets the same fraction (1/N). minWidth:0 lets long inner content
    // truncate instead of overflowing the row.
    flex: "1 1 0",
    minWidth: 0,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} className="relative group">
      {/* Drag handle + close X. Fade in on hover so card content stays clean. */}
      <div className="absolute top-2 right-2 z-20 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder"
          title="Drag to reorder"
          className="px-1.5 py-0.5 text-xs text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded cursor-grab active:cursor-grabbing"
        >
          ⋮⋮
        </button>
        <button
          onClick={onClose}
          aria-label="Hide widget"
          title="Hide widget"
          className="px-1.5 py-0.5 text-xs text-gray-400 hover:text-red-700 hover:bg-gray-100 rounded"
        >
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}

// =============================================================================
// Action callouts (always-on, not movable — they're situational alerts)
// =============================================================================

function ActionCallouts({
  needsReviewCount,
  upcoming7,
  bills,
  creditBalance,
}: {
  needsReviewCount: number;
  upcoming7: UpcomingBill[];
  bills: RecurringBill[];
  creditBalance: number;
}) {
  const ccBillsSoon = useMemo(() => {
    return upcoming7.filter((b) => {
      const lower = (bills.find((x) => x.id === b.id)?.name ?? b.name).toLowerCase();
      return (
        lower.includes("apple card") ||
        lower.includes("credit card") ||
        lower.includes("card payment")
      );
    });
  }, [upcoming7, bills]);
  // "Bills due" means expense occurrences only — recurring income isn't a bill.
  const expensesSoon = upcoming7.filter((b) => b.amount < 0);
  const upcoming7Total = expensesSoon.reduce((s, b) => s + -b.amount, 0);
  const anything = needsReviewCount > 0 || expensesSoon.length > 0;
  if (!anything && creditBalance >= 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {needsReviewCount > 0 && (
        <Link
          to="/ledger"
          className="flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
        >
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />
          {needsReviewCount} transaction{needsReviewCount === 1 ? "" : "s"} need review →
        </Link>
      )}
      {expensesSoon.length > 0 && (
        <Link
          to="/bills"
          className="flex items-center gap-2 rounded-full border border-gray-300 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-800 hover:bg-gray-100"
        >
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-500" />
          {expensesSoon.length} bill{expensesSoon.length === 1 ? "" : "s"} due in 7 days ·{" "}
          {fmtUSD(upcoming7Total)} →
        </Link>
      )}
      {ccBillsSoon.length > 0 && (
        <Link
          to="/credit-card"
          className="flex items-center gap-2 rounded-full border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-900 hover:bg-red-100"
        >
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500" />
          Credit card payment due {fmtDate(ccBillsSoon[0].next)} →
        </Link>
      )}
    </div>
  );
}

// =============================================================================
// Hidden widgets footer
// =============================================================================

function HiddenWidgetsStrip({
  hidden,
  onRestore,
  onResetAll,
}: {
  hidden: WidgetId[];
  onRestore: (id: WidgetId) => void;
  onResetAll: () => void;
}) {
  if (hidden.length === 0) return null;
  return (
    <div className="pt-4 mt-2 border-t border-gray-200">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs uppercase tracking-wide text-gray-500 font-semibold">
            Hidden
          </span>
          {hidden.map((id) => (
            <button
              key={id}
              onClick={() => onRestore(id)}
              className="flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
              title="Bring back"
            >
              <span className="text-gray-500">+</span> {WIDGETS[id].title}
            </button>
          ))}
        </div>
        <button
          onClick={onResetAll}
          className="text-xs text-gray-600 hover:text-gray-900 underline"
        >
          Reset layout
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Card chrome — title bar + body. SortableCard overlays drag/close on top.
// =============================================================================

function Card({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm h-full">
      <div className="flex items-start justify-between gap-3 mb-3 pr-12">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900 truncate">{title}</h2>
          {subtitle && <p className="text-xs text-gray-600 mt-0.5 truncate">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

// =============================================================================
// Widget bodies
// =============================================================================

function NetWorthWidget({
  netWorth,
  delta30,
  series,
}: {
  netWorth: number;
  delta30: number | null;
  series: MonthlyNetWorth[];
}) {
  return (
    <Card title="Net worth">
      <div className="flex items-end justify-between gap-3">
        <div className="text-2xl font-semibold tabular-nums">{fmtUSD(netWorth)}</div>
        {delta30 != null && (
          <span
            className={`text-xs font-medium tabular-nums ${
              delta30 >= 0 ? "text-green-700" : "text-red-700"
            }`}
          >
            {delta30 >= 0 ? "▲" : "▼"} {fmtUSD(Math.abs(delta30))}
            <span className="text-gray-500 font-normal ml-1">last month</span>
          </span>
        )}
      </div>
      {series.length > 1 && (
        <div className="mt-3 h-10">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series}>
              <Line
                type="monotone"
                dataKey="total"
                stroke="#374151"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function FreeCashWidget({
  freeCash,
  byKind,
  upcoming14Total,
}: {
  freeCash: number;
  byKind: { checking: number; savings: number; credit: number };
  upcoming14Total: number;
}) {
  return (
    <Card title="Free cash" subtitle="spendable without going into debt">
      <div
        className={`text-2xl font-semibold tabular-nums ${
          freeCash < 0 ? "text-red-700" : "text-gray-900"
        }`}
      >
        {fmtUSD(freeCash)}
      </div>
      <div className="text-xs text-gray-700 mt-2 leading-relaxed">
        <span className="text-gray-500">checking</span>{" "}
        <span className="tabular-nums">{fmtUSD(byKind.checking)}</span>{" "}
        <span className="text-gray-400">−</span>{" "}
        <span className="text-gray-500">bills 14d</span>{" "}
        <span className="tabular-nums">{fmtUSD(upcoming14Total)}</span>{" "}
        <span className="text-gray-400">−</span>{" "}
        <span className="text-gray-500">CC owed</span>{" "}
        <span className="tabular-nums">{fmtUSD(Math.abs(byKind.credit))}</span>
      </div>
    </Card>
  );
}

function ThisPeriodWidget({
  label,
  burn,
  projectedEnd,
  daysLeft,
}: {
  label: string;
  burn: { allocated: number; spent: number } | null;
  projectedEnd: number | null;
  daysLeft: number | null;
}) {
  return (
    <Card title="This pay period" subtitle={label}>
      {burn ? (
        <>
          <div className="flex items-end justify-between gap-3">
            <div>
              <span className="text-2xl font-semibold tabular-nums">{fmtUSD(burn.spent)}</span>
              <span className="text-sm text-gray-500 ml-1">/ {fmtUSD(burn.allocated)}</span>
            </div>
            {daysLeft != null && (
              <span className="text-xs text-gray-700">
                <span className="font-medium">{daysLeft}</span> days left
              </span>
            )}
          </div>
          <BurnBar spent={burn.spent} allocated={burn.allocated} />
          {projectedEnd != null && burn.allocated > 0 && daysLeft != null && (
            <div className="text-xs text-gray-700 mt-1.5">
              <span className="text-gray-500">projected end:</span>{" "}
              <span
                className={`tabular-nums font-medium ${
                  projectedEnd > burn.allocated ? "text-red-700" : "text-green-700"
                }`}
              >
                {fmtUSD(projectedEnd)}
              </span>
            </div>
          )}
        </>
      ) : (
        <div className="text-sm text-gray-700">
          No budget allocations configured.{" "}
          <Link to="/budgets" className="underline">
            Set them up →
          </Link>
        </div>
      )}
    </Card>
  );
}

function BurnBar({ spent, allocated }: { spent: number; allocated: number }) {
  if (allocated <= 0) return null;
  const pct = Math.min(100, (spent / allocated) * 100);
  const over = spent > allocated;
  return (
    <div className="mt-2 h-2 bg-gray-100 rounded overflow-hidden">
      <div
        className={`h-full ${over ? "bg-red-600" : pct > 80 ? "bg-amber-500" : "bg-green-600"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function CashFlowWidget({ data, loading }: { data: MonthlyCashFlow[]; loading: boolean }) {
  const chartData = data.map((m) => ({
    month: m.month,
    income: m.income,
    expense: m.expense,
    net: m.income - m.expense,
  }));
  return (
    <Card title="Cash flow · last 12 months">
      <div className="h-64">
        {loading ? (
          <div className="h-full bg-gray-100 rounded animate-pulse" />
        ) : chartData.length === 0 ? (
          <EmptyChart text="No transactions in the last 12 months." />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} tickFormatter={shortMonth} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={kUsd} />
              <Tooltip formatter={(v: number) => fmtUSD(v)} labelFormatter={shortMonth} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="income" name="Income" fill="#16a34a" radius={[2, 2, 0, 0]} />
              <Bar dataKey="expense" name="Expense" fill="#dc2626" radius={[2, 2, 0, 0]} />
              <Line
                type="monotone"
                dataKey="net"
                name="Net"
                stroke="#374151"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

function NetWorthTrendWidget({
  data,
  loading,
}: {
  data: MonthlyNetWorth[];
  loading: boolean;
}) {
  const [mode, setMode] = useState<"total" | "by-kind">("total");
  return (
    <Card
      title="Net worth · last 12 months"
      right={
        <div className="flex gap-1 text-xs">
          {(["total", "by-kind"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2 py-0.5 rounded ${
                mode === m
                  ? "bg-gray-900 text-white"
                  : "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
              }`}
            >
              {m === "total" ? "Total" : "By account"}
            </button>
          ))}
        </div>
      }
    >
      <div className="h-64">
        {loading ? (
          <div className="h-full bg-gray-100 rounded animate-pulse" />
        ) : data.length === 0 ? (
          <EmptyChart text="No history yet." />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} tickFormatter={shortMonth} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={kUsd} />
              <Tooltip formatter={(v: number) => fmtUSD(v)} labelFormatter={shortMonth} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {mode === "total" ? (
                <Line
                  type="monotone"
                  dataKey="total"
                  name="Net worth"
                  stroke="#374151"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              ) : (
                <>
                  <Line
                    type="monotone"
                    dataKey="checking"
                    name="Checking"
                    stroke="#0ea5e9"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="credit"
                    name="Credit"
                    stroke="#dc2626"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </>
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

const CATEGORY_PALETTE = [
  "#16a34a", "#0ea5e9", "#f59e0b", "#8b5cf6", "#ec4899",
  "#14b8a6", "#f97316", "#6366f1", "#10b981", "#ef4444",
];

function CategoryDonutWidget({
  categories,
  rangeLabel,
}: {
  categories: { category_id: number | null; category_name: string; spent: number }[];
  rangeLabel: string;
}) {
  const top = categories.slice(0, 8);
  const otherSum = categories.slice(8).reduce((s, c) => s + c.spent, 0);
  const data =
    otherSum > 0
      ? [...top, { category_id: null, category_name: "Other", spent: otherSum }]
      : top;
  const total = data.reduce((s, d) => s + d.spent, 0);
  return (
    <Card title="Spending by category" subtitle={rangeLabel}>
      {data.length === 0 ? (
        <EmptyChart text="No spending in this range." />
      ) : (
        <div className="grid grid-cols-5 gap-3 items-center">
          <div className="col-span-2 h-52">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="spent"
                  nameKey="category_name"
                  innerRadius="60%"
                  outerRadius="95%"
                  paddingAngle={1}
                  isAnimationActive={false}
                >
                  {data.map((_, i) => (
                    <Cell key={i} fill={CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => fmtUSD(v)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="col-span-3 space-y-1">
            {data.map((c, i) => {
              const pct = total > 0 ? (c.spent / total) * 100 : 0;
              const swatch = CATEGORY_PALETTE[i % CATEGORY_PALETTE.length];
              return (
                <Link
                  key={`${c.category_id ?? "other"}-${i}`}
                  to="/ledger"
                  className="flex items-center gap-2 text-sm text-gray-900 hover:bg-gray-50 px-1.5 py-0.5 rounded"
                >
                  <span
                    className="inline-block w-2 h-2 rounded-sm shrink-0"
                    style={{ backgroundColor: swatch }}
                  />
                  <span className="flex-1 truncate">{c.category_name}</span>
                  <span className="text-xs text-gray-500 tabular-nums">{pct.toFixed(0)}%</span>
                  <span className="tabular-nums font-medium w-20 text-right">
                    {fmtUSD(c.spent)}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

function CategoryDriftWidget({ data }: { data: CategoryDrift[] }) {
  const movers = data.filter((d) => Math.abs(d.delta_abs) > 1).slice(0, 6);
  return (
    <Card title="Category drift" subtitle="vs trailing 3-period average">
      {movers.length === 0 ? (
        <p className="text-sm text-gray-700 py-6 text-center">
          Spending is steady across categories.
        </p>
      ) : (
        <div className="divide-y divide-gray-100">
          {movers.map((m) => {
            const up = m.delta_abs > 0;
            return (
              <div key={m.category_id} className="flex items-center gap-3 py-1.5">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">
                    {m.category_name}
                  </div>
                  <div className="text-xs text-gray-600">
                    <span className="tabular-nums">{fmtUSD(m.current)}</span>{" "}
                    <span className="text-gray-400">vs avg</span>{" "}
                    <span className="tabular-nums">{fmtUSD(m.trailing_avg)}</span>
                  </div>
                </div>
                <div className={`text-right ${up ? "text-red-700" : "text-green-700"}`}>
                  <div className="text-sm font-semibold tabular-nums">
                    {up ? "+" : ""}
                    {fmtUSD(m.delta_abs)}
                  </div>
                  {m.delta_pct != null && (
                    <div className="text-xs tabular-nums">
                      {up ? "+" : ""}
                      {Math.round(m.delta_pct * 100)}%
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function SavingsRateWidget({
  data,
}: {
  data: { current: number | null; trailing: number | null } | null;
}) {
  return (
    <Card title="Savings rate" subtitle="(income − expense) ÷ income">
      {!data ? (
        <p className="text-sm text-gray-700 py-6 text-center">Not enough history yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <SavingsRateBlock label="This month" value={data.current} />
          <SavingsRateBlock label="Trailing 3 months" value={data.trailing} />
        </div>
      )}
    </Card>
  );
}

function SavingsRateBlock({ label, value }: { label: string; value: number | null }) {
  const pct = value != null ? value * 100 : null;
  const color =
    pct == null
      ? "text-gray-500"
      : pct >= 20
      ? "text-green-700"
      : pct >= 0
      ? "text-amber-700"
      : "text-red-700";
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-gray-600">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums mt-1 ${color}`}>
        {pct == null ? "—" : `${pct.toFixed(0)}%`}
      </div>
      {pct != null && (
        <div className="text-xs text-gray-700 mt-1">
          {pct >= 20
            ? "Strong — keeping a meaningful slice."
            : pct >= 0
            ? "Net positive but tight."
            : "Spending exceeded income."}
        </div>
      )}
    </div>
  );
}

function LargestTxnsWidget({
  txns,
  rangeLabel,
}: {
  txns: Transaction[];
  rangeLabel: string;
}) {
  return (
    <Card title="Largest transactions" subtitle={rangeLabel}>
      {txns.length === 0 ? (
        <p className="text-sm text-gray-700 py-6 text-center">No transactions yet.</p>
      ) : (
        <div className="divide-y divide-gray-100">
          {txns.map((t) => (
            <Link
              to="/ledger"
              key={t.id}
              className="flex items-center gap-3 py-1.5 hover:bg-gray-50 -mx-2 px-2 rounded"
            >
              <div className="text-xs text-gray-600 w-16 tabular-nums shrink-0">
                {fmtDate(t.date)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-900 truncate">{t.title ?? t.description}</div>
                <div className="text-xs text-gray-600 truncate">
                  {t.category_name ?? "(uncategorized)"}
                </div>
              </div>
              <div
                className={`text-sm font-semibold tabular-nums ${
                  t.amount < 0 ? "text-red-700" : "text-green-700"
                }`}
              >
                {fmtUSD(t.amount)}
              </div>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

function UpcomingBillsWidget({ upcoming }: { upcoming: UpcomingBill[] }) {
  return (
    <Card title="Upcoming bills" subtitle="Next 14 days">
      {upcoming.length === 0 ? (
        <p className="text-sm text-gray-700 py-6 text-center">Nothing scheduled.</p>
      ) : (
        <div className="divide-y divide-gray-100">
          {upcoming.map((b) => (
            <div key={`${b.id}-${b.next}`} className="flex items-center gap-3 py-1.5">
              <div className="text-xs text-gray-600 w-16 tabular-nums shrink-0">
                {fmtDate(b.next)}
              </div>
              <div className="flex-1 min-w-0 text-sm text-gray-900 truncate">{b.name}</div>
              <div
                className={`text-sm font-medium tabular-nums ${b.amount < 0 ? "text-red-700" : "text-green-700"}`}
              >
                {fmtUSD(b.amount)}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function GoalsWidget({
  goals,
}: {
  goals: {
    id: number;
    name: string;
    target_amount: number;
    current_amount: number;
    target_date: string | null;
  }[];
}) {
  if (goals.length === 0) {
    return (
      <Card title="Goals">
        <p className="text-sm text-gray-700 py-6 text-center">
          No goals set up.{" "}
          <Link to="/goals" className="underline">
            Add one →
          </Link>
        </p>
      </Card>
    );
  }
  return (
    <Card title="Goals">
      <div className="space-y-2">
        {goals.slice(0, 4).map((g) => {
          const pct = Math.max(
            0,
            Math.min(100, (g.current_amount / Math.max(g.target_amount, 1)) * 100),
          );
          return (
            <div key={g.id}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <div className="font-medium text-gray-900 truncate">{g.name}</div>
                <div className="text-xs text-gray-700 tabular-nums whitespace-nowrap">
                  {fmtUSD(g.current_amount)} / {fmtUSD(g.target_amount)}
                </div>
              </div>
              <div className="mt-1 h-2 bg-gray-100 rounded overflow-hidden">
                <div className="h-full bg-green-600" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function EmptyChart({ text }: { text: string }) {
  return (
    <div className="h-full flex items-center justify-center text-sm text-gray-500">{text}</div>
  );
}

function shortMonth(m: string): string {
  if (!m || m.length < 7) return m;
  const year = m.slice(2, 4);
  const month = parseInt(m.slice(5, 7), 10);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[month - 1] ?? m} '${year}`;
}

function kUsd(v: number): string {
  if (Math.abs(v) >= 1000) return `$${Math.round(v / 1000)}k`;
  return `$${Math.round(v)}`;
}

function shiftIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

interface UpcomingBill {
  id: number;
  name: string;
  amount: number;
  next: string;
}

function projectUpcoming(bills: RecurringBill[], withinDays: number): UpcomingBill[] {
  const out: UpcomingBill[] = [];
  const today = new Date(todayISO() + "T00:00:00");
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + withinDays);
  for (const b of bills) {
    if (!b.active) continue;
    if (b.start_date) {
      const s = new Date(b.start_date + "T00:00:00");
      if (s > horizon) continue;
    }
    if (b.end_date) {
      const e = new Date(b.end_date + "T00:00:00");
      if (e < today) continue;
    }
    const next = nextHit(b, today, horizon);
    if (next) {
      out.push({
        id: b.id,
        name: b.name,
        amount: b.amount,
        next: next.toISOString().slice(0, 10),
      });
    }
  }
  out.sort((a, b) => a.next.localeCompare(b.next));
  return out;
}

function nextHit(b: RecurringBill, from: Date, horizon: Date): Date | null {
  const cur = new Date(from);
  while (cur <= horizon) {
    if (billHitsOn(b, cur)) return new Date(cur);
    cur.setDate(cur.getDate() + 1);
  }
  return null;
}

function billHitsOn(b: RecurringBill, date: Date): boolean {
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  switch (b.cadence_kind) {
    case "monthly":
      return b.day_of_month != null && dom === clampDay(date, b.day_of_month);
    case "quarterly":
      return (
        b.day_of_month != null &&
        dom === clampDay(date, b.day_of_month) &&
        [1, 4, 7, 10].includes(month)
      );
    case "semiannual":
      return (
        b.day_of_month != null &&
        dom === clampDay(date, b.day_of_month) &&
        [1, 7].includes(month)
      );
    case "annual":
      return b.day_of_month != null && dom === clampDay(date, b.day_of_month) && month === 1;
    case "weekly":
    case "biweekly": {
      if (!b.anchor_date) return false;
      const a = new Date(b.anchor_date + "T00:00:00");
      const diff = Math.round((date.getTime() - a.getTime()) / 86400000);
      const step = b.cadence_kind === "weekly" ? 7 : 14;
      return diff >= 0 && diff % step === 0;
    }
    case "custom_days": {
      const anchor = b.anchor_date ?? b.start_date;
      if (!anchor || !b.interval_days || b.interval_days <= 0) return false;
      const a = new Date(anchor + "T00:00:00");
      const diff = Math.round((date.getTime() - a.getTime()) / 86400000);
      return diff >= 0 && diff % b.interval_days === 0;
    }
    default:
      return false;
  }
}

function clampDay(date: Date, day: number): number {
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return Math.min(day, last);
}
