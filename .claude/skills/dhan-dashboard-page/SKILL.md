---
name: dhan-dashboard-page
description: Use when adding a new page or API route to rs_dashboard, wiring a Next.js API route to spawn a Python script with progress/stop-trigger polling, or building a data table component for the dashboard.
---

# Dhan Dashboard Page & API Route

## Overview
`rs_dashboard` (Next.js App Router) has ~27 pages and ~39 API routes that all
follow the same handful of conventions. Copying an existing route/page and
missing one of these conventions is the most common source of "works but looks
wrong" or "path resolves to nowhere" bugs.

## When to Use
- Adding a new `app/<page>/page.tsx` + matching `components/<Name>.tsx`.
- Adding a new `app/api/<name>/route.ts`, especially one that spawns a Python
  script (refresh jobs, live WebSocket bridges, backtests).
- Building any data table in a dashboard component.

## Path Resolution
Every API route that touches the Python side computes:
```ts
const PROJECT_ROOT = path.resolve(process.cwd(), '..');   // one level above rs_dashboard/
const DEBUG_DIR    = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE   = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
```
Never hardcode `../../` or an absolute Windows path — `process.cwd()` is
`rs_dashboard/` when Next.js runs, so `PROJECT_ROOT` is always one `resolve('..')` up.

## Spawn-a-Python-Script Pattern
Long-running or scriptable Python work (refresh, live bridges, backtests) is
started via `spawn(PYTHON_EXE, [SCRIPT_PATH, ...args], {detached: true})` from a
POST handler, not run synchronously in the route. The script writes its own
progress to a status JSON in `debug/` (e.g. `refresh_status.json`,
`<strategy_key>_state.json`); the route's GET handler (or the page, polling on
an interval) just reads that file back — it does not track the child process's
stdout. To stop it, the route writes a `debug/<name>_stop.trigger` (or
`_shutdown.trigger` for strategies) file; the Python side polls for that file
and exits on its own. See `app/api/refresh/route.ts` and
`app/api/strategies/route.ts` for the canonical shape, and
`scripts/downloader/refresh_dashboard_data.py` / `lib/strategy_state_helper.py`
for the Python side.

## One-Click Order Buttons (Buy/Sell from a dashboard tile)
Several components (`Scalper.tsx`, `CrudeOilOptions.tsx`, `OptionsSmartChainTab.tsx`,
`QuikTradeQuadrants.tsx`) place live orders directly from a table row or tile.
Two endpoints exist — pick based on whether you already have a security ID:
- **`POST /api/scalper/order`** (`underlying, expiry, strike, option, side, lots, type`) —
  spawns `scripts/tools/scalper_api.py`, does the symbol/security-ID lookup itself.
  Simplest option when the component only has strike/expiry/CE-PE from a chain
  response (no `security_id`).
- **`POST /api/scalper/fast-order`** (`securityId, quantity, side, orderType, price`) —
  direct REST call to Dhan (`/v2/orders`), no Python spawn. Faster; use when the
  component already has `security_id` per-strike (e.g. from `strikeMap` or the
  option chain's `ce.security_id`/`pe.security_id`).
Order type is always `'MARKET'` or `'LIMIT'` — Dhan's API has no market-protection
%/slippage-band parameter; to cap slippage, place a `LIMIT` at `LTP × (1 ± pct)`
instead of `MARKET`.
Pair the button with a per-row/tile `pending` flag (disable while in flight) and a
toast overlay (`fixed top-4 right-4 z-50`, 3s auto-dismiss) showing the returned
`order_id` on success or `error` on failure — copy the `addToast`/toast-render
pattern from `Scalper.tsx` rather than inventing a new one.

## Table & Text Styling (enforced repo-wide, not optional)
- Table headers: `<thead>`/`TH` get `text-xs font-bold text-white` on a solid
  `bg-zinc-800` — at 10px (`text-[10px]`) white anti-aliases to gray, so 12px
  (`text-xs`) + `font-bold` is the floor for headers to read as truly white.
- **Never** use slash-opacity on text color (`text-white/70`, `text-zinc-400/50`).
  Use solid steps instead: `text-zinc-100` (near-white) → `text-zinc-600` (very
  dim). Opacity modifiers are fine on *backgrounds* (`bg-emerald-500/10`), just
  not on text.
- Any page showing stock/market data needs a `DATA: YYYY-MM-DD` chip in the
  sticky header (grep `DATA:` in `components/*.tsx` for ~10 examples — pattern
  is usually `<span className="text-amber-300 font-bold uppercase tracking-wide">DATA: {data.dataDate || '—'}</span>`).

## Quick Reference

| Task | Where |
|---|---|
| New page | `app/<route>/page.tsx` importing a `components/<Name>.tsx` client component |
| New API route | `app/api/<name>/route.ts`, `PROJECT_ROOT` at top |
| Spawn Python job | `spawn(PYTHON_EXE, [...])`, status file in `debug/`, `_stop.trigger` to cancel |
| One-click Buy/Sell button | `POST /api/scalper/order` (strike/expiry) or `/api/scalper/fast-order` (security ID) |
| Read CSV data | `lib/dataLoader.ts` (`readStockCSV`, `readNifty50Index`, `readNifty500Index`) — patches today's row from `debug/today_quotes.json` |
| Shared TA math | `lib/indicators.ts` |
| Sector labels/colors | `lib/sectors.ts` |

## Common Mistakes

- Running the Python script inline in the route handler (blocks the request) —
  spawn it detached and let the client poll a status file instead.
- Forgetting the trailing `<name>_stop.trigger` write on a Stop/Cancel action —
  the Python process has no other way to know to exit.
- Using `text-zinc-400/60` etc. for readability tweaks instead of the solid
  zinc scale — inconsistent rendering across light/dark and flagged in review.
- Hardcoding a relative path like `../../debug/foo.json` instead of building it
  from `PROJECT_ROOT` — breaks as soon as the route file moves.
- `find rs_dashboard/app -maxdepth 1 -type d` for the current page list rather
  than trusting any doc's page table, since pages get added often.
