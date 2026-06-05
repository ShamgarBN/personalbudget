import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "@/api";
import { fmtUSD, todayISO } from "@/lib/formatting";

const HORIZONS = [
  { label: "1 mo", days: 30 },
  { label: "3 mo", days: 90 },
  { label: "6 mo", days: 180 },
  { label: "12 mo", days: 365 },
  { label: "24 mo", days: 730 },
  { label: "5 yr", days: 365 * 5 },
];

export default function Forecast() {
  const [horizon, setHorizon] = useState(365);
  const [customMode, setCustomMode] = useState(false);
  const [customEnd, setCustomEnd] = useState<string>(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 12);
    return d.toISOString().slice(0, 10);
  });

  const effectiveDays = useMemo(() => {
    if (!customMode) return horizon;
    const end = new Date(customEnd + "T00:00:00");
    const today = new Date(todayISO() + "T00:00:00");
    return Math.max(1, Math.round((end.getTime() - today.getTime()) / 86400000));
  }, [customMode, customEnd, horizon]);

  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  const fc = useQuery({
    queryKey: ["forecast", effectiveDays],
    queryFn: () => api.runForecast({ horizon_days: effectiveDays }),
  });

  const daily = (fc.data?.daily ?? []).filter((_, i) => i % 7 === 0 || i === (fc.data!.daily.length - 1));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-semibold text-gray-900">Forecast</h1>
        <div className="flex items-center gap-1 text-sm flex-wrap">
          {HORIZONS.map((h) => (
            <button
              key={h.days}
              onClick={() => {
                setCustomMode(false);
                setHorizon(h.days);
              }}
              className={`px-2.5 py-1 rounded ${
                !customMode && horizon === h.days
                  ? "bg-gray-900 text-white"
                  : "border border-gray-200 bg-white text-gray-800 hover:bg-gray-50"
              }`}
            >
              {h.label}
            </button>
          ))}
          <button
            onClick={() => setCustomMode(true)}
            className={`px-2.5 py-1 rounded ${
              customMode
                ? "bg-gray-900 text-white"
                : "border border-gray-200 bg-white text-gray-800 hover:bg-gray-50"
            }`}
          >
            Custom
          </button>
          {customMode && (
            <>
              <span className="text-xs text-gray-600 ml-1">until</span>
              <input
                type="date"
                className="border border-gray-200 rounded px-2 py-1 text-sm bg-white"
                value={customEnd}
                min={todayISO()}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
              <span className="text-xs text-gray-500">({effectiveDays} days)</span>
            </>
          )}
        </div>
      </div>

      {fc.isLoading && <p className="text-sm text-gray-500">Computing…</p>}
      {fc.error && <p className="text-sm text-red-600">{String(fc.error)}</p>}

      {fc.data && (
        <>
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">Projected net worth</h2>
            <div className="rounded-xl border bg-white p-3">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={daily}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} />
                  <Tooltip formatter={(v: number) => fmtUSD(v)} />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="net_worth"
                    name="Net worth"
                    stroke="#1e40af"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">Pay-period cash flow</h2>
            <div className="rounded-xl border bg-white p-3">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={fc.data.pay_periods.slice(0, 12)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="start" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} />
                  <Tooltip formatter={(v: number) => fmtUSD(v)} />
                  <Legend />
                  <Bar dataKey="projected_income" name="Income" fill="#10b981" />
                  <Bar dataKey="projected_bills" name="Bills" fill="#f97316" />
                  <Bar dataKey="projected_discretionary" name="Discretionary" fill="#ef4444" />
                  <Bar dataKey="projected_leftover" name="Leftover" fill="#3b82f6" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">Category trajectory (current pay period)</h2>
            <div className="rounded-xl border bg-white overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2 text-right">Spent to date</th>
                    <th className="px-3 py-2 text-right">Projected period total</th>
                    <th className="px-3 py-2 text-right">Allocated</th>
                    <th className="px-3 py-2 text-right">Over / under</th>
                  </tr>
                </thead>
                <tbody>
                  {fc.data.categories.slice(0, 15).map((c) => (
                    <tr key={c.category_id ?? c.category_name} className="border-t">
                      <td className="px-3 py-1.5">{c.category_name}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtUSD(c.spent_to_date)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtUSD(c.projected_period_total)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {c.allocated != null ? fmtUSD(c.allocated) : "—"}
                      </td>
                      <td
                        className={`px-3 py-1.5 text-right tabular-nums ${
                          c.over_under != null && c.over_under < 0 ? "text-red-600" : "text-green-700"
                        }`}
                      >
                        {c.over_under != null ? fmtUSD(c.over_under) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {accounts.data && accounts.data.length > 0 && (
            <p className="text-xs text-gray-500">
              Daily projection uses the trailing 90 days for income / discretionary averages and
              projects recurring bills and pay-schedule paydays forward. Internal Transfer-category
              activity is excluded.
            </p>
          )}
        </>
      )}
    </div>
  );
}
