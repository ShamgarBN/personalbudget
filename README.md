# Family Budget

A personal/family budget desktop app built for our household.

Single-user, single-machine (lives on one Mac), local-only SQLite storage. No accounts, no cloud sync, no telemetry — everything stays on the device.

Built with Tauri 2 (Rust backend, React + TypeScript frontend) so the install is a single notarizable `.app` bundle and the runtime cost is negligible.

---

## What it does

- **Ledger** — flat or pay-period-grouped transaction view across all accounts. Inline edit description, memo, category, amount. Split transactions across multiple categories.
- **Per-account views** — Bank Account, Credit Card, and Savings each have a focused ledger. Bank Account also shows a projected credit-card payoff row.
- **Import** — drag CSV exports from Bank of America (checking), Apple Card, or Capital One 360 Savings. Auto-detects format, suggests categories from merchant memory, flags duplicates, lets you review before committing.
- **Budgets** — set per-category allocations per pay period. Track spent vs allocated with rollover handling.
- **Bills** — declare recurring bills (weekly, biweekly, monthly, quarterly, semiannual, annual). The dashboard surfaces what's due in the next 7 / 14 days.
- **Forecast** — projects daily balances forward using trailing averages and scheduled paydays + bills.
- **Goals** — track savings/payoff goals with progress bars.
- **Dashboard** — customizable widget grid (drag/drop, hide/restore, persist layout). Pay-period or month/year time scope with prev/next navigation. Trend charts, category drift, savings rate, largest transactions, free-cash KPI, action callouts for things needing attention.
- **Settings** — manage categories, pay-period schedules (biweekly, semimonthly, monthly, custom dates), and database backups/restores.

---

## File structure

```
family-budget/
├── src/                          # React frontend (TypeScript)
│   ├── api/                      # Typed Tauri command wrappers + shared types
│   │   ├── index.ts              # All invoke() calls live here
│   │   └── types.ts              # DTOs shared with the Rust backend
│   ├── components/               # Reusable UI (QuickAdd, SplitModal)
│   ├── lib/                      # Tiny helpers (formatting, category trees, column widths)
│   ├── routes/                   # One file per tab (Dashboard, Ledger, Bills, etc.)
│   ├── App.tsx                   # Router + sidebar nav
│   └── main.tsx                  # React entrypoint
│
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── commands/             # Tauri commands grouped by feature
│   │   │   ├── accounts.rs       # CRUD + balance-as-of
│   │   │   ├── transactions.rs   # List/create/update/delete/split
│   │   │   ├── categories.rs     # Category tree management
│   │   │   ├── budgets.rs        # Pay-period budget allocations + summary
│   │   │   ├── bills.rs          # Recurring bills
│   │   │   ├── goals.rs          # Savings/payoff goals
│   │   │   ├── pay_periods.rs    # Schedule CRUD + period generation
│   │   │   ├── dashboard.rs      # Summary, cash flow / net worth time series, category drift
│   │   │   ├── imp.rs            # CSV import (preview + commit)
│   │   │   ├── legacy_import.rs  # One-shot import from a prior tool
│   │   │   ├── forecast_cmd.rs   # Forward projection
│   │   │   ├── backup.rs         # Snapshot + restore the SQLite file
│   │   │   └── export.rs         # JSON export of all tables
│   │   ├── db/                   # Connection bootstrap + migrations runner
│   │   ├── parsers/              # Per-bank CSV format adapters
│   │   ├── pay_period.rs         # Cadence math (biweekly, semimonthly, etc.)
│   │   ├── forecast.rs           # Trailing-average + bill projection engine
│   │   ├── merchant.rs           # Description -> category memory
│   │   ├── models.rs             # Serializable DTOs
│   │   ├── error.rs              # AppError + AppResult
│   │   └── lib.rs                # Tauri builder + command registration
│   ├── migrations/               # Refinery-managed schema versions
│   ├── tauri.conf.json           # Bundle id, version, capabilities
│   └── Cargo.toml
│
├── package.json                  # Frontend deps + scripts
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
└── README.md
```

---

## Install

Grab the latest `.dmg` from [Releases](https://github.com/ShamgarBN/personalbudget/releases) — Apple Silicon only.

The app is **adhoc-signed** (not Apple-notarized). When the DMG arrives via browser download, macOS attaches a quarantine flag to it, and Gatekeeper refuses to launch with a misleading "app is damaged" message. The fix is one Terminal command. After downloading the DMG:

```bash
open ~/Downloads/Family\ Budget_*.dmg

# Copy and strip the quarantine attribute — the xattr line is the load-bearing one
rm -rf "/Applications/Family Budget.app"
cp -R "/Volumes/Family Budget/Family Budget.app" /Applications/
xattr -dr com.apple.quarantine "/Applications/Family Budget.app"

# Eject
hdiutil detach "/Volumes/Family Budget"
```

After that, double-click `Family Budget.app` in `/Applications` and it'll launch normally. Repeat the same recipe for every future release.

The SQLite database lives at `~/Library/Application Support/com.niemann.familybudget/budget.sqlite3`. Use the Settings → Backups section to snapshot it; backups are stored alongside the DB.

---

## Build from source

Requires:

- Node 20+ and `pnpm`
- Rust 1.77+ (`rustup`)
- macOS (Apple Silicon) for the DMG target — adjust `--target` in `package.json` if building for Intel

```bash
pnpm install
pnpm tauri dev      # hot-reload dev server
pnpm build:dmg      # release DMG, copied to the project root
pnpm typecheck      # tsc -b --noEmit
cargo test --manifest-path src-tauri/Cargo.toml
```

The `build:dmg` script wraps `tauri build` and copies the produced artifact to the repo root so it doesn't get lost under `src-tauri/target/...`.

---

## Architecture notes

- **All persistent state is SQLite.** Schema is versioned via Refinery migrations. No ORM — just typed Rust functions returning DTOs.
- **No backend server, no auth.** Tauri marshals function calls between the React renderer and the Rust process. Each command is a `#[tauri::command]` returning `AppResult<T>`.
- **Running balances** are computed by SQL window functions in the `list_transactions` query, joined post-filter so the displayed balance is always cumulative, not range-local.
- **Transfers** between owned accounts are excluded from cash-flow / spend / income aggregations by filtering on the protected "Transfer" category, plus excluding savings-account activity from household totals (savings interest etc. shouldn't pollute spend).
- **Pay-period semantics**: the generator emits `[start, end)` half-open intervals. Schedule transitions split a period mid-way; the request window doesn't (a recent bug fix — the last period naturally extends past the request `to`).
- **Frontend caching** via TanStack Query. Mutations invalidate the relevant keys. Pay-period queries cache per `(from, to)` so prev/next navigation through pre-loaded windows is instant.
- **Dashboard layout** persists to `localStorage` under `family-budget:dashboard-layout-v1`. New widgets auto-append to the user's order so future updates don't break customization.

---

## License

Personal project. No license declared — code is here as an artifact, not a redistribution.
