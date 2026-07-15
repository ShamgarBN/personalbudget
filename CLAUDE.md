# Family Budget — project guide

A single-household budgeting desktop app. Tauri 2 (Rust) backend + React/TypeScript frontend + local SQLite. Runs only on Sarah's Mac Mini; distributed as an adhoc-signed `.dmg`. Apple Silicon only.

- **Repo:** https://github.com/ShamgarBN/personalbudget (branch `main`)
- **Current version:** 1.3.4 (see `git tag` / GitHub Releases for history + per-release notes)
- **Live DB:** `~/Library/Application Support/com.niemann.familybudget/budget.sqlite3` (SQLite, WAL). Never place the live DB in iCloud (WAL/SHM sync hazard). Backups are atomic `VACUUM INTO` snapshots.

## Build, verify, ship

```bash
pnpm install
pnpm typecheck                                  # tsc -b --noEmit (frontend)
cargo test --lib --manifest-path src-tauri/Cargo.toml   # 9 tests (pay_period + parsers)
pnpm tauri dev                                  # hot-reload dev
pnpm build:dmg                                  # release DMG, copied to repo root (gitignored)
```

**Release flow used all session** (bump all three version files together): `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` → `pnpm build:dmg` → commit → `git tag vX.Y.Z && git push --tags` → `gh release create vX.Y.Z "Family Budget_X.Y.Z_aarch64.dmg" --title … --notes …`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Install quirk (important):** the app is adhoc-signed, not notarized. macOS blocks it with a misleading "damaged" error on launch. Every release's notes include the fix — the load-bearing line is `xattr -dr com.apple.quarantine "/Applications/Family Budget.app"` after copying. Tell users to reinstall over prior builds when shipping a fix.

## Architecture map

Frontend (`src/`):
- `routes/` — one file per tab: `Dashboard`, `Ledger`, `AccountBank`/`AccountCredit`/`AccountSavings` (Bank/Credit share `AccountLedger.tsx`; Savings is standalone), `Budgets`, `Bills` (titled "Recurring Transactions"), `Forecast`, `Goals`, `Settings`. `Import.tsx` is now a **modal** hosted on the Ledger (no Import tab).
- `api/index.ts` + `api/types.ts` — all `invoke()` wrappers and shared DTOs. Tauri maps JS camelCase args → Rust snake_case params.
- `lib/` — `formatting`, `categories` (tree + `makeColorResolver` + `CategoryColorContext`), `columns`, `recurrence` (shared occurrence math, mirrors Rust), `collapse` (zustand+localStorage persistent group open/closed state), `ghostOverrides` (zustand+localStorage: per-projection amount edits + dismissals).

Backend (`src-tauri/src/`):
- `commands/` — grouped by feature (`transactions`, `accounts`, `categories`, `budgets`, `bills`, `goals`, `pay_periods`, `dashboard`, `imp`, `legacy_import`, `forecast_cmd`, `backup`, `export`). Register new commands in `lib.rs`.
- `pay_period.rs` — cadence math (has unit tests). `forecast.rs` — projection engine. `parsers/` — per-bank CSV adapters (BoA checking, Apple Card, Capital One savings) + legacy-app importer. `migrations/` — refinery, `V1`..`V8`.

## Domain concepts / conventions

- **Accounts** are "Bank Account" (checking), "Credit Card" (credit), "Savings". Renamed from Joint Checking/Apple Card in V4; CSV import resolves the target account by **kind** (from the detected format), so account renames don't break import.
- **Pay-period schedules** are append-only with `effective_from`/`effective_to`; never rewrite historical periods. Semimonthly day fields are period *start* anchors; `-1` = last day of month (also used by recurring transactions).
- **Signed amounts everywhere:** negative = expense/outflow, positive = income/inflow. Recurring transactions store signed amounts (migrated to negative in V6).
- **"Transfer" category is protected** and excluded from spend/income/forecast aggregations; savings-account activity is also excluded from household totals.
- **Categories** carry `color`, `is_budgeted`, and `budget_basis` ('monthly' | 'per_pay_period'). Only budgeted categories appear on the Budgets tab (two sections by basis; no rollover).
- **Bank Account projections (the big feature):** recurring transactions + per-pay-period budgeted categories render as editable **ghost rows** ~2 years forward, extending the **running balance as a forecast**. Ghosts sort expenses-before-income within a day; the running balance is computed in one top-to-bottom pass over the exact display order (real rows keep backend `running_balance`; ghosts continue from the row above). Ghost actions: **checkbox** = lock in (materialize a real cleared txn, tagged `from_bill_id` or `from_budget_key` so it dedupes; uncheck = delete/undo), **Delete** = dismiss just that occurrence (persisted in `ghostOverrides`). The pinned **Credit Card Payment** footer accordions open to itemize the visible month's card charges and its running continues from the last ledger row.

## Known limitations / open follow-ups (candidates, not committed)

- Budget projections only cover **per-pay-period** basis categories; monthly-basis budgets aren't projected into the ledger (ambiguous month→period mapping).
- Cross-month forecast continuity: a *fully future* month with no real rows baselines its running off today's actual balance rather than carrying the prior month's projected end balance.
- Ghost dismissals have no "un-dismiss" UI; a dismissed occurrence reappears only if the underlying recurring/budget item changes.
- CC-payment detection for the (removed) inline expansion used a name heuristic; the footer rollup instead uses all credit-account charges in the visible range.
