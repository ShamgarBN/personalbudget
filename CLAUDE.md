# Family Budget — project guide

A single-household budgeting desktop app. Tauri 2 (Rust) backend + React/TypeScript frontend + local SQLite. Runs only on Sarah's Mac Mini; distributed as an adhoc-signed `.dmg`. Apple Silicon only.

- **Repo:** https://github.com/ShamgarBN/personalbudget (branch `main`)
- **Current version:** 1.4.0 (see `git tag` / GitHub Releases for history + per-release notes)
- **Live DB:** `~/Library/Application Support/com.niemann.familybudget/budget.sqlite3` (SQLite, WAL). Never place the live DB in iCloud (WAL/SHM sync hazard). Backups are atomic `VACUUM INTO` snapshots.

## Build, verify, ship

```bash
pnpm install
pnpm typecheck                                  # tsc -b --noEmit (frontend)
cargo test --lib --manifest-path src-tauri/Cargo.toml   # 9 tests (pay_period + parsers)
pnpm tauri dev                                  # hot-reload dev
pnpm build:dmg                                  # release DMG, copied to repo root (gitignored)
```

**Release flow used all session** (bump all three version files together): `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` → `pnpm build:dmg` → commit → `git tag vX.Y.Z && git push --tags` → `gh release create vX.Y.Z "Family Budget_X.Y.Z_aarch64.dmg" --title … --notes …`. Commit trailer: `Co-Authored-By: Claude <noreply@anthropic.com>` (or the current model's name).

**Install quirk (important):** the app is adhoc-signed, not notarized. macOS blocks it with a misleading "damaged" error on launch. Every release's notes include the fix — the load-bearing line is `xattr -dr com.apple.quarantine "/Applications/Family Budget.app"` after copying. Tell users to reinstall over prior builds when shipping a fix.

**UI verification trick:** the frontend can be driven in a plain browser against `pnpm tauri dev`'s vite server (port 1420) by injecting a mock `window.__TAURI_INTERNALS__.invoke` that serves canned command responses, then calling `window.__qc.resetQueries()` (the QueryClient is exposed on `window.__qc` in dev builds only — see `main.tsx`). Needed because react-query is configured with `refetchOnWindowFocus: false` and the `["accounts"]` query is held permanently by QuickAdd, so late-injected mocks never get refetched otherwise.

## Architecture map

Frontend (`src/`):
- `routes/` — one file per tab: `Dashboard`, `Ledger` (THE page — see below), `Budgets`, `Bills` (titled "Recurring Transactions"), `Forecast`, `Goals`, `Settings`. `Import.tsx` is a **modal** hosted on the Ledger. The per-account tabs (`AccountBank`/`AccountCredit`/`AccountSavings`/`AccountLedger`) were **deleted in v1.4** — old routes redirect to `/ledger`.
- `api/index.ts` + `api/types.ts` — all `invoke()` wrappers and shared DTOs. Tauri maps JS camelCase args → Rust snake_case params. `types.ts` also has `txnSource()` — derives a row's Source (recurring | imported | manual | budgeted) from `from_bill_id`/`from_budget_key`/`import_batch_id`, unless `source_override` is set.
- `lib/` — `formatting`, `categories` (tree + `makeColorResolver` + `CategoryColorContext`), `columns` (resizable ledger columns; pass `fluidTotal` to `ResizableTh` for proportional fit-to-window sizing), `recurrence` (shared occurrence math, mirrors Rust), `collapse` (zustand+localStorage persistent group open/closed state), `ghostOverrides` (zustand+localStorage: per-projection amount edits + dismissals + `undismiss`), `undo` (in-memory global undo stack — see below).
- `components/UndoHost.tsx` — global ⌘Z handler + "Undid …" toast, mounted once in `App`. Steps aside while a text input is focused (native undo wins).

Backend (`src-tauri/src/`):
- `commands/` — grouped by feature (`transactions`, `accounts`, `categories`, `budgets`, `bills`, `goals`, `pay_periods`, `dashboard`, `imp`, `legacy_import`, `forecast_cmd`, `backup`, `export`). Register new commands in `lib.rs`.
- `pay_period.rs` — cadence math (has unit tests). `forecast.rs` — projection engine. `parsers/` — per-bank CSV adapters (BoA checking, Apple Card, Capital One savings) + legacy-app importer. `migrations/` — refinery, `V1`..`V9` (V9 = `txn.source_override`).

## The unified Ledger (v1.4)

One page for everything, modeled on Sarah's spreadsheet (bank + credit interleaved, grouped by pay period, running balance forecast years ahead):

- **Bank + credit rows interleaved**; savings is *not tracked* in the app anymore (tab removed, rows filtered out everywhere, QuickAdd/Dashboard exclude it; the account + data still exist in the DB).
- **Running column is the bank account's balance only.** Real bank rows keep the backend `running_balance`; ghost rows continue the sum top-to-bottom in exact display order; credit rows show a blank Running (they hit budgets, not the bank balance).
- **Ghosts** (recurring occurrences + per-pay-period budget items, bank account only, ~2 years out) work as before: editable amount (override), checkbox = lock in/materialize, Delete = dismiss. All undoable now.
- **Pinned Credit Card Payoff footer** = the card's *current balance* (changed in v1.4 from "charges in visible range"); accordion itemizes the visible range's charges; its Running continues from the last ledger row.
- **Source column** per row (Recurring | Imported CSV | Manual | Budgeted) — derived, manually overridable via menu (stored in `txn.source_override`).
- **Multi-select** checkbox column + select-all header + bulk delete bar.
- **Global undo (⌘Z)**: field edits, category/source changes, clear/flag toggles, review, deletes (single + bulk, restored via `restore_transactions` command with full field snapshot), ghost lock-in/unlock/dismiss/amount edits. In-memory only; doesn't survive restart.
- Unreviewed rows render gray + italic; ghosts gray + italic + dashed. Default view is **All time** with only the current year + current pay period expanded (mount cost: never render all rows expanded — stateful inline editors freeze the tab).
- Table is `tableLayout: fixed; width: 100%` with proportional column widths → resizes to fit the window; drag-resize adjusts shares.

## Domain concepts / conventions

- **Accounts** are "Bank Account" (checking), "Credit Card" (credit), plus a legacy "Savings" row kept in the DB but hidden from the UI since v1.4. CSV import resolves the target account by **kind** (from the detected format), so account renames don't break import.
- **Pay-period schedules** are append-only with `effective_from`/`effective_to`; never rewrite historical periods. Semimonthly day fields are period *start* anchors; `-1` = last day of month (also used by recurring transactions).
- **Signed amounts everywhere:** negative = expense/outflow, positive = income/inflow. Recurring transactions store signed amounts (migrated to negative in V6).
- **"Transfer" category is protected** and excluded from spend/income/forecast aggregations; savings-account activity is also excluded from household totals.
- **Categories** carry `color`, `is_budgeted`, and `budget_basis` ('monthly' | 'per_pay_period'). Since v1.4 `budget_summary` returns **every** category with an `is_budgeted` flag; the Budgets tab shows three sections (per pay period / per month / not budgeted — typing an amount in the last one promotes the category to budgeted). Consumers of `budget_summary` must filter on `is_budgeted` where only budgeted rows make sense (Dashboard burn widget, Ledger budget ghosts do this).

## Known limitations / open follow-ups (candidates, not committed)

- Budget projections only cover **per-pay-period** basis categories; monthly-basis budgets aren't projected into the ledger (ambiguous month→period mapping).
- Cross-month forecast continuity: a *fully future* month with no real rows baselines its running off today's actual balance rather than carrying the prior month's projected end balance (only visible in Monthly range mode; the default All-time view is continuous).
- Undo stack is in-memory; quitting the app clears it. Ghost dismissals can only be un-done via ⌘Z in-session.
- Undo of a deleted **split parent** does not resurrect its children.
- Forecast tab and net-worth history still read savings rows from the DB in some backend aggregations; frontend hides savings but the backend `net_worth_monthly` still returns the series (Dashboard recomputes totals without it).
