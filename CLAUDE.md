# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This file is deliberately kept short — it's loaded in full on every session. Detailed
reference material lives in `docs/` and is meant to be read on demand (via the `Read`
tool) only when a task actually touches that area. Don't pre-read the linked docs
"just in case" — read the one that matches what you're about to change.

## Project Overview

Dhan Algo Trading: a Python library wrapping the DhanHQ broker SDK for live F&O strategy execution, plus a Next.js dashboard (`rs_dashboard/`) for monitoring, analysis, and controlling running strategies.

---

## Running Commands

All Python commands must be run from the project root (`c:\dhan_algo\dhan_algo`) using the venv interpreter.

```powershell
# Activate venv (once per terminal session)
.\venv\Scripts\activate

# After activation, use plain `python`; or use the full path:
venv\Scripts\python.exe <script>
```

### Authentication

Run this first whenever the access token has expired (expires after ~24 hours):

```powershell
venv\Scripts\python.exe login.py
```

### Running Strategies

```powershell
# Dry run by default — add --live to place real orders
venv\Scripts\python.exe strategies/value_imbalance/nifty_advanced_imbalance.py --entry-type strangle --mode winner_roll_atm
venv\Scripts\python.exe strategies/spread_trend/nifty_spread_trend.py --live --lots 1
```

All strategies follow this pattern (`strategies/<group>/<name>.py` + flags). Full CLI references for every strategy are in [GEMINI.md](GEMINI.md); each strategy's logic is in its `strategy.md`.

### Dashboard Data Refresh

```powershell
# Full incremental refresh (Nifty 50 index + Nifty 500 index + all stocks)
venv\Scripts\python.exe scripts/downloader/refresh_dashboard_data.py

# Refresh specific target only
venv\Scripts\python.exe scripts/downloader/refresh_dashboard_data.py --target nifty50
venv\Scripts\python.exe scripts/downloader/refresh_dashboard_data.py --target nifty500-index
venv\Scripts\python.exe scripts/downloader/refresh_dashboard_data.py --target stocks

# Fetch live intraday quotes (patches today's row before EOD CSVs are available)
venv\Scripts\python.exe scripts/downloader/fetch_today_quotes.py
```

The refresh script writes progress to `debug/refresh_status.json`; the dashboard polls this file and shows a progress panel. Write `debug/refresh_stop.trigger` to abort mid-run.

### Live WebSocket Bridges

```powershell
# Stream Nifty 50 equity ticks → debug/live_equity_quotes.json
venv\Scripts\python.exe scripts/tools/live_equity_ws.py

# Stream FNO option ticks → debug/live_options_quotes.json
venv\Scripts\python.exe scripts/tools/live_options_ws.py
```

Write `debug/live_equity_stop.trigger` or `debug/live_options_stop.trigger` to stop the respective bridge gracefully (same pattern as `refresh_stop.trigger`).

### Tests

```powershell
# Full test suite
cd tests && venv\Scripts\python.exe run_all_tests.py

# Single test module
venv\Scripts\python.exe tests/test_04_option_chain.py
```

Each test module exposes a `run(helper)` function. The orchestrator in `tests/run_all_tests.py` initialises a single `DhanHelper` and passes it to each module.

**⚠️ The suite has real side effects — do not run it casually against a live account.** `test_06_orders.py` places a real AMO limit order (deep below LTP, then cancels), and `test_11_maintenance.py` / `test_13_advanced_logic.py` call `cancel_all_orders()`, which kills any pending orders from live strategies. Run individual read-only modules (e.g. `test_04_option_chain.py`) when you just need to verify data plumbing. The Dhan quote API is rate-limited to ~1 req/s — expect 429 backoff during the suite.

### Dashboard (Next.js)

```powershell
cd rs_dashboard
npm run dev   # http://localhost:3000
```

**Important**: The `rs_dashboard/` AGENTS.md warns that this Next.js version has breaking API changes. Read `node_modules/next/dist/docs/` before writing any code in that directory.

**Auth gate is `rs_dashboard/proxy.ts`** (Next 16 renamed `middleware.ts` → `proxy.ts`; it runs on the Node runtime, and the runtime is not configurable). It verifies the HMAC-signed `dhan_session` cookie, 401s unauthenticated `/api/*` requests and redirects unauthenticated page requests to `/login`. Without a session cookie, `curl` sees **307 on pages and 401 on API routes** — neither is a bug, so mint a cookie before concluding a route is broken.

**Stale Turbopack dev cache → phantom 404s.** `next dev` can serve 404 for routes that plainly exist on disk, because the running server's route tree lost them — anything from one nested API subtree up to *every* route except `/login`. Recognise it by: 404 rather than 500 (a 500 means the route compiled and threw), a whole directory level affected uniformly, and a clean `git status`. Fix, cheapest first:

```powershell
# 1. Touch any file in the affected directory — the watcher rescans that subtree.
# 2. Restart `npm run dev`.
# 3. Whole-app 404s: stop the server, then clear only the dev cache and restart.
Remove-Item -Recurse -Force rs_dashboard\.next\dev
```

Delete `.next\dev`, **not** all of `.next` — the latter also holds the production build that `next start` serves.

---

## Architecture

- **Python backend**: `lib/dhan_helper.py`'s `DhanHelper` class is the central abstraction every strategy uses (`helper = DhanHelper(dhan)`); strategies live under `strategies/<group>/`; scripts under `scripts/{downloader,analysis,data_utils,tools,testing}/`.
- **Strategy ↔ dashboard bridge**: strategies write `debug/<strategy_key>_state.json` via `save_strategy_state()`; the dashboard reads it for status and writes `debug/<strategy_key>_shutdown.trigger` to stop a strategy, which `check_shutdown_trigger()` picks up.
- **Dashboard**: Next.js App Router under `rs_dashboard/app/` (~30 pages, ~48 API routes — run `ls rs_dashboard/app` / `ls rs_dashboard/app/api` for the current list, don't assume). `rs_dashboard/lib/` holds shared helpers (`pyExec.ts` for spawning Python, `processCheck.ts` for PID checks, `dhanToken.ts`, `dataLoader.ts`, `clientCache.ts`).

**→ Full directory tree, `DhanHelper` internals, and per-route dashboard behaviors are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).** Read it when working in a part of the codebase you haven't touched recently — not needed for a small change to a file you already understand.

### Theming (dark + white mode) — applies to every UI edit

The dashboard ships a 2-way dark/white theme. It works by re-pointing the palette
itself: `--color-zinc-N` resolves to a `--z-N` variable that flips per theme, so the
~4,600 existing `zinc-*` utilities theme themselves. That only holds if new code stays
inside the token system.

- **Never hardcode a colour in a component** — no `#rrggbb`, no `rgb()/rgba()`, no
  `bg-[#0a0a0a]`. Use the zinc ramp or a token. Saturated *data* colours (emerald/red
  P&L, series colours) are the exception; chrome is not.
- **`text-white` and `bg-black` are tokens, and they flip.** They mean "brightest
  text" and "page ground", not literal white and black. When you genuinely need a
  fixed colour — a label on a saturated `bg-emerald-600` fill, or a modal scrim — use
  `text-oncolor` / `bg-oncolor` (always white) or `text-oncolor-dark` /
  `bg-oncolor-dark/NN` (always near-black). **Every modal and drawer backdrop must be
  `bg-oncolor-dark/NN`**; `bg-black/70` becomes a near-white wash in light mode and
  stops dimming anything.
- **Recharts chrome is themed globally** in `app/globals.css` by class name. Don't
  pass `stroke`/`fill`/`contentStyle` hexes for grid, axis, legend or tooltip — they
  are overridden anyway. Series colours you do pass.
- **Table header style**: `text-xs font-bold text-white` on solid `bg-zinc-800` for
  `<thead>` / `TH` in all dashboard tables. At 10px the text anti-aliases to gray;
  12px (`text-xs`) with `font-bold` is the minimum for a header to read as a header.
- **No text-colour opacity modifiers**: never use slash-opacity on text
  (`text-white/70`, `text-zinc-400/50`). Use solid steps: `text-zinc-100` (near-white),
  `text-zinc-200`, `text-zinc-300` (body), `text-zinc-400` (secondary), `text-zinc-500`
  (muted), `text-zinc-600` (very dim). Opacity is fine on backgrounds
  (`bg-emerald-500/10`).
- Changing the palette, adding a themed surface or an injected `<style>` block, or
  chasing a component that won't flip? Use the **`dhan-theme-tokens`** skill — it
  covers why `@theme inline` must reference a var, the `--lc-*` panel tokens, and the
  canvas-vs-SVG split.

**Data date in page headers**: pages that display stock/market data must show a `DATA: YYYY-MM-DD` chip in the sticky header so users always know the currency of the data on screen.

**Skills for recurring work** — read the matching skill before starting, each is
distilled from 7-10 repeat bug-fix commits:
`dhan-broker-positions` (scalper terminals, broker payloads, P&L, close/exit orders),
`dhan-live-chart` (lightweight-charts canvas charts and polled series),
`dhan-polling-guards` (poll loops, caches, JSON read-modify-write, process spawns),
`dhan-theme-tokens` (the theme system), `dhan-commit-on-blur` (free-typed inputs
must commit on blur/Enter so mid-edit values cannot fire live rules), plus
`dhan-dashboard-page`, `dhan-new-strategy` and `dhan-quant-terminal-page`.

**"Quant-terminal" chart pages**: several pages (Options Premium Bar, Futures, IV Charts, Straddle/Strangle Analysis, Breadth, Live Charts) share a chart-driven dark-glass redesign built around `recharts`. Use the `dhan-quant-terminal-page` skill when building or redesigning a page into this style — it documents the sticky-header shell, chart-panel/tooltip conventions, and the reference implementation to copy from.

---

## Critical API Conventions

Working with `DhanHelper`, strategies, or orders? **Read
[docs/API_GOTCHAS.md](docs/API_GOTCHAS.md) first** — it lists non-obvious SDK/API
behaviors (wrong kwargs, wrong security IDs, silent-failure field names) that have
caused real runtime bugs. Not needed for dashboard-only or docs-only changes.

## Strategy Conventions

- All strategies start with `--live` disabled (dry run) by default — no real orders are placed without the flag.
- After-hours development: symbol lookups and expiry resolution work via the cached master list; live quotes and order placement are unavailable.
- Intraday auto-exit is hardcoded at **15:17 IST** across all strategies.
- Straddle/strangle inversion guard: `CE strike > PE strike` is enforced at entry and after each adjustment; violation triggers an emergency exit + 5-minute pause + fresh cycle. **Exception**: `nifty_delta_neutral.py` deliberately does not enforce this — strikes are chosen purely by delta-proximity, so an inverted strangle (CE strike < PE strike) is a valid, expected outcome, not an error.
- New strategies must use `templates/strategy_template.py` as the starting point and must call `save_strategy_state()` and `check_shutdown_trigger()` in the main loop to integrate with the dashboard.
- **Exit sizing must never trust the raw broker net quantity.** Dhan nets every position by security ID, so two strategy instances short of the same strike share ONE broker position — sizing an exit off `helper.get_net_quantity()` lets whichever instance exits first flatten a sibling instance's leg too (this happened for real on 2026-07-30). Use `lib/strategy_risk.py`'s `resolve_exit_qty(helper, security_id, own_qty, side)` instead: it exits what *this* strategy opened, clamped by what the broker still shows in that direction. Already adopted across `value_imbalance/`, `oi_directional/`, and `intraday_equity/` — use it in any new strategy that can share a security ID with another running instance.
- Per-strategy trading logic lives in each group's `strategy.md` (`strategies/<group>/strategy.md`) — **read it before modifying that strategy**, not summarized here.

## Environment

Required in `.env` (at project root):
```
client_id=...
api_key=...
api_secret=...
```

Token is cached to `access_token.json` and reused until `expiryTime`. Run `login.py` to refresh it.

Zerodha credentials live in `.env.zerodha` (token cached to `zerodha_access_token.json`);
Kotak Neo credentials in `.env.kotak` (see `.env.kotak.example`; session cached to
`kotak_access_token.json`). Refresh either from the dashboard's Autologin, or:

```powershell
venv\Scripts\python.exe scripts/tools/zerodha_autologin.py
venv\Scripts\python.exe scripts/tools/kotak_autologin.py   # --force to re-login
```

**Kotak SDK install** — `neo-api-client` MUST be installed with `--no-deps` (it hard-pins
pandas 2.2.3 / numpy 2.1.0 / urllib3 1.26.14 against this venv's much newer versions and
would break the dashboard data stack). See the comment block in `requirements.txt`.

## Multi-broker

Dhan is the primary account; Zerodha and Kotak are supported as selectable brokers in
the scalper terminals and as copy-trade children that mirror Dhan fills. **Before
touching broker-selector UI, `child_brokers.py`, `copy_trade_bridge.py`, or any
Kotak/Zerodha-specific code, read [docs/MULTIBROKER.md](docs/MULTIBROKER.md)** — it
covers routing helpers, the `ChildBroker` safety invariants, and several broker-specific
quirks (Kotak epoch/quantity scaling, 200-OK error bodies) that are easy to get wrong.
Not needed for Dhan-only work.
