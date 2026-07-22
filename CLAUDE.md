# Family Budget — project guide

A single-household budgeting desktop app. Tauri 2 (Rust) backend + React/TypeScript frontend + local SQLite. Runs only on Sarah's Mac Mini; distributed as an adhoc-signed `.dmg`. Apple Silicon only.

- **Repo:** https://github.com/ShamgarBN/personalbudget (branch `main`)
- **Current version:** 1.7.0 (see `git tag` / GitHub Releases for history + per-release notes)
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
- `routes/` — one file per tab: `Dashboard`, `Ledger` (THE page — see below), `Forecast`, `Goals`, `Settings`. Since **v1.6** Budgets & Categories and Recurring Transactions are **modals on the Ledger** (`components/BudgetsPanel.tsx`, `components/RecurringPanel.tsx` — the former routes redirect to `/ledger`, as do the v1.4-removed account tabs). `Import.tsx` is a **modal** hosted on the Ledger.
- `api/index.ts` + `api/types.ts` — all `invoke()` wrappers and shared DTOs. Tauri maps JS camelCase args → Rust snake_case params. `types.ts` also has `txnSource()` — derives a row's Source (recurring | imported | manual | budgeted) from `from_bill_id`/`from_budget_key`/`import_batch_id`, unless `source_override` is set.
- `lib/` — `formatting`, `categories` (tree + `makeColorResolver` + `CategoryColorContext`), `columns` (resizable ledger columns; pass `fluidTotal` to `ResizableTh` for proportional fit-to-window sizing), `recurrence` (shared occurrence math, mirrors Rust), `collapse` (zustand+localStorage persistent group open/closed state), `ghostOverrides` (zustand+localStorage: per-projection amount edits + dismissals + `undismiss`), `ledgerView` (zustand+localStorage: the Ledger's range/filters/search/grouping, so the page looks the way it was left), `undo` (in-memory global undo stack — see below).
- `components/UndoHost.tsx` — global ⌘Z handler + "Undid …" toast, mounted once in `App`. Steps aside while a text input is focused (native undo wins).

Backend (`src-tauri/src/`):
- `commands/` — grouped by feature (`transactions`, `accounts`, `categories`, `budgets`, `bills`, `goals`, `pay_periods`, `dashboard`, `imp`, `legacy_import`, `forecast_cmd`, `backup`, `export`). Register new commands in `lib.rs`.
- `pay_period.rs` — cadence math (has unit tests). `forecast.rs` — projection engine. `parsers/` — per-bank CSV adapters (BoA checking, Apple Card, Capital One savings) + legacy-app importer. `migrations/` — refinery, `V1`..`V11` (V9 = `txn.source_override`, V10 = `txn.amount_color`, V11 = `txn.cc_payment_id`).

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

## v1.5 ledger behaviors (on top of v1.4)

- **Recurring ghosts project for bank AND credit** accounts (savings never). Only bank ghosts move the Running; credit ghosts show blank Running. Budget ghosts stay bank-only.
- **Future-dated real rows** render gray+italic (like unreviewed), count under the "Needs review only" filter, and `txnSource(t, today)` never reports a future row as "Imported CSV" (impossible — banks export the past); it falls back to Manual unless overridden.
- **Amount cell color** = `txn.amount_color` override ?? category color ?? red/green. Hover the cell for the color-dot picker + reset (undoable).
- **Credit Card Payoff** renders inline directly beneath the current pay period's group (falls back to a pinned footer when grouping is off or no current period is in view). Payoff = `account_balance_as_of(credit, today)` — actual balance, not inflated by future rows. The accordion lists only UNPAID charges (v1.5.1): FIFO — payments (plus any negative opening balance first) cover the oldest charges; fully covered charges drop out, a partially covered charge still shows whole. Each row is inline-editable (date/description/amount) and deletable, with select-all + bulk delete. All undoable. Computed over the visible range, so exact in the default All-time view.
- **Year AND pay-period headers** show the end-of-span bank running balance to the right of the group total (v1.5.1 added the period headers).
- **Expand all / Collapse all** buttons bulk-set every year+period group (`useCollapseStore.setMany`).

## v1.5.2 — the infinite-loop hotfix (the "70GB" incident)

`fixed_step_period` (weekly/biweekly) had an off-by-one: dates exactly N steps BEFORE the anchor got the period *ending* on them, so `generate`'s cursor stopped advancing — an infinite Vec-growing loop that held the DB mutex (app wedged, memory ballooned to tens of GB). Triggered by the Dashboard's 3-years-back pay-period window once Sarah's edited schedule put a biweekly anchor (2026-01-02) *after* its effective_from. Fixed by deleting the bogus `k -= 1`; `generate` also now has a cursor-progress guard and a 20,000-period cap that turn any future degeneracy into a clean error. Regression tests cover both.

## v1.6 — the spreadsheet revamp (Ledger IS the app)

- **Spreadsheet mode** (grouped + All accounts + no search/review filter): real credit-card rows leave the main flow. Each pay period renders its card payments as amber **"Credit Card Payment" dropdowns** — expanding one itemizes the charges that payment covered (FIFO attribution in `ccModel`; a planned FUTURE payment's dropdown shows what it *will* cover, but the projected payoff only credits payments ≤ today). Bank rows alone carry the Running (like Sarah's sheet). Filtering to the Credit Card account / searching / needs-review shows raw card rows again.
- **SOON block**: each period's budget ghosts cluster into a collapsible "Soon — remaining budgets" subsection with an *edit budgets* link; every period's amounts are allocation − categorized spend **in that period** (her future-planned rows make future periods live too).
- **Modals on the Ledger**: Budgets & Categories and Recurring panels open from toolbar buttons; recurring ghost rows have **Edit…** that opens the recurring editor prefilled (`RecurringPanel initialEditBillId`).
- Nav is just Dashboard / Ledger / Forecast / Goals / Settings + the global Quick Add.

## v1.7 — cc dropdowns become first-class (Sarah-controlled)

- **`txn.cc_payment_id`** (V11, app-managed, no FK): NULL = auto FIFO, >0 = explicitly assigned to that payment txn's dropdown, -1 = held for the payoff. Explicit wins over FIFO; each payment's FIFO pool is reduced by its explicit members' total.
- **A charge lives in exactly ONE dropdown**: explicit assignment > the payment (past OR planned-future) whose FIFO claims it > the payoff (unclaimed, dated ≤ today). Payoff AMOUNT stays balance-as-of-today regardless.
- **Dropdown headers total their contents** (sum of charges inside = what the bank pays), with an `≠` marker + tooltip when that differs from the recorded payment amount.
- **Drag & drop** a charge row onto any payment header or the payoff header to move it; every charge row also has a "Move to…" menu (payoff / auto / any payment). Undoable.
- **Credit Card account view** shows the same per-period dropdowns with all card txns nested (raw rows via search/needs-review). Future-dated charges stay inline (muted) until their date passes.
- **Quick Add** with the Credit Card account: Charge vs "Payment (new dropdown)" toggle; charges pick their dropdown (Auto / hold for payoff / specific payment) and never create dropdowns.
- **Monthly view = all months** (calendar-month buckets under year groups, every month listed; arrows now only serve Yearly mode). Collapse keys: `ledger:month:<start>` vs `ledger:pp:<start>`.
- **Ghost horizon is 5 years** (was 2) so recurring/budget projections populate future years.

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
