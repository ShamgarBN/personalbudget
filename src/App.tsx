import { useState } from "react";
import { NavLink, Route, Routes, Navigate } from "react-router-dom";
import Dashboard from "@/routes/Dashboard";
import Ledger from "@/routes/Ledger";
import AccountBank from "@/routes/AccountBank";
import AccountCredit from "@/routes/AccountCredit";
import AccountSavings from "@/routes/AccountSavings";
import Settings from "@/routes/Settings";
import Budgets from "@/routes/Budgets";
import Bills from "@/routes/Bills";
import Forecast from "@/routes/Forecast";
import Goals from "@/routes/Goals";
import QuickAdd, { useGlobalShortcut } from "@/components/QuickAdd";

const sections: Array<{ path: string; label: string; section?: "main" | "accounts" }> = [
  { path: "/dashboard", label: "Dashboard", section: "main" },
  { path: "/ledger", label: "Ledger", section: "main" },
  { path: "/bank-account", label: "Bank Account", section: "accounts" },
  { path: "/credit-card", label: "Credit Card", section: "accounts" },
  { path: "/savings", label: "Savings", section: "accounts" },
  { path: "/budgets", label: "Budgets", section: "main" },
  { path: "/bills", label: "Recurring Transactions", section: "main" },
  { path: "/forecast", label: "Forecast", section: "main" },
  { path: "/goals", label: "Goals", section: "main" },
  { path: "/settings", label: "Settings", section: "main" },
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
          {sections.map((s, i) => {
            const prevSection = i > 0 ? sections[i - 1].section : undefined;
            const showHeading = s.section !== prevSection;
            return (
              <div key={s.path}>
                {showHeading && s.section === "accounts" && (
                  <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
                    Accounts
                  </div>
                )}
                {showHeading && s.section === "main" && i > 0 && (
                  <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
                    Planning
                  </div>
                )}
                <NavLink
                  to={s.path}
                  className={({ isActive }) =>
                    `block px-3 py-1.5 text-sm rounded-md transition-colors ${
                      isActive
                        ? "bg-gray-900 text-white"
                        : "text-gray-800 hover:bg-gray-200"
                    }`
                  }
                >
                  {s.label}
                </NavLink>
              </div>
            );
          })}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto bg-white">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/ledger" element={<Ledger />} />
          <Route path="/bank-account" element={<AccountBank />} />
          <Route path="/credit-card" element={<AccountCredit />} />
          <Route path="/savings" element={<AccountSavings />} />
          <Route path="/budgets" element={<Budgets />} />
          <Route path="/bills" element={<Bills />} />
          <Route path="/forecast" element={<Forecast />} />
          <Route path="/goals" element={<Goals />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
      <QuickAdd open={quickAdd} onClose={() => setQuickAdd(false)} />
    </div>
  );
}
