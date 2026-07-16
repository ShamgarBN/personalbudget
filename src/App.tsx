import { useState } from "react";
import { NavLink, Route, Routes, Navigate } from "react-router-dom";
import Dashboard from "@/routes/Dashboard";
import Ledger from "@/routes/Ledger";
import Settings from "@/routes/Settings";
import Budgets from "@/routes/Budgets";
import Bills from "@/routes/Bills";
import Forecast from "@/routes/Forecast";
import Goals from "@/routes/Goals";
import QuickAdd, { useGlobalShortcut } from "@/components/QuickAdd";
import UndoHost from "@/components/UndoHost";

const sections: Array<{ path: string; label: string }> = [
  { path: "/dashboard", label: "Dashboard" },
  { path: "/ledger", label: "Ledger" },
  { path: "/budgets", label: "Budgets & Categories" },
  { path: "/bills", label: "Recurring Transactions" },
  { path: "/forecast", label: "Forecast" },
  { path: "/goals", label: "Goals" },
  { path: "/settings", label: "Settings" },
];

export default function App() {
  const [quickAdd, setQuickAdd] = useState(false);
  useGlobalShortcut(() => setQuickAdd(true));

  return (
    <div className="flex h-full text-gray-900">
      <aside className="w-56 shrink-0 bg-sidebar-bg border-r border-gray-200 p-3 flex flex-col">
        <div className="px-2 py-3 text-sm font-semibold tracking-tight text-gray-900">Family Budget</div>
        <button
          onClick={() => setQuickAdd(true)}
          className="w-full mb-3 px-3 py-1.5 text-sm rounded-md bg-gray-900 text-white text-left flex items-center justify-between hover:bg-gray-800"
        >
          Quick Add
          <kbd className="text-[10px] text-white/80">⌘N</kbd>
        </button>
        <nav className="flex flex-col gap-0.5">
          {sections.map((s) => (
            <NavLink
              key={s.path}
              to={s.path}
              className={({ isActive }) =>
                `block px-3 py-1.5 text-sm rounded-md transition-colors ${
                  isActive
                    ? "bg-gray-200 text-gray-900 font-medium"
                    : "text-gray-700 hover:bg-gray-100"
                }`
              }
            >
              {s.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto bg-white">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/ledger" element={<Ledger />} />
          {/* The per-account tabs folded into the unified Ledger in v1.4. */}
          <Route path="/bank-account" element={<Navigate to="/ledger" replace />} />
          <Route path="/credit-card" element={<Navigate to="/ledger" replace />} />
          <Route path="/savings" element={<Navigate to="/ledger" replace />} />
          <Route path="/budgets" element={<Budgets />} />
          <Route path="/bills" element={<Bills />} />
          <Route path="/forecast" element={<Forecast />} />
          <Route path="/goals" element={<Goals />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
      <QuickAdd open={quickAdd} onClose={() => setQuickAdd(false)} />
      <UndoHost />
    </div>
  );
}
