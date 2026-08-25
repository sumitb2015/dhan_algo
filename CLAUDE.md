# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

### Python Backend

```
login.py                    # OAuth flow + token caching (access_token.json)
lib/
  dhan_helper.py            # Core DhanHelper class — all strategies use this
  strategy_state_helper.py  # save_strategy_state() / check_shutdown_trigger()
  zerodha/                  # Kite session + margin/basket-margin helpers
  kotak/                    # Kotak Neo session (TOTP+MPIN), response unwrapping, margin/positions
strategies/
  value_imbalance/          # Straddle, Strangle, Advanced Imbalance, VWAP straddle, and Delta Neutral strategies
  spread_trend/             # Trend-following Bear Call / Bull Put spread strategy (EMA20 + Supertrend)
  st_oi_bearcall/           # Dual Supertrend (index + option) + OI short-buildup bear call spread only
  oi_directional/           # OI imbalance + PCR-driven naked PE/CE sell strategy
  crudeoil/                 # MCX CRUDEOILM: Supertrend, Renko SAR, VWAP+Supertrend, and ORB futures strategies
  intraday_equity/          # Nifty-50 cash-equity VWAP+RS auto-trader — NOT VALIDATED, dry-run only
  momentum_investing/       # Nifty-500 positional (CNC, multi-day) relative-strength momentum portfolio
  Archives/                 # Retired/superseded strategies (kept for reference)
templates/strategy_template.py  # Starting point for new strategies
docs/
  AGENT_FUNCTION_REFERENCE.md  # Full DhanHelper method reference
  STRATEGY_GUIDELINES.md       # How to structure a new strategy
  OPTION_CHAIN_QUICK_REF.md    # Option chain response shape cheat sheet
  PIVOT_DETECTION.md           # lib/pivots.py — swing high/low detection + confirmation lag
scripts/
  downloader/               # Historical data downloaders + refresh_dashboard_data.py / fetch_today_quotes.py
  analysis/                 # Backtests (backtest_nifty50_rs*.py suite, backtest_short_straddle.py),
                            # report generators, screeners — `ls scripts/analysis` for full list
  data_utils/               # Parquet conversion, resampling, indicator append
  tools/                    # `ls scripts/tools` for full list. Tick streamers live_{equity,indices,options,positions}_ws.py
                            # → debug/live_*_quotes.json (stop via debug/*_stop.trigger); crudeoil_oi_collector.py;
                            # options_data_fetch.py (one-off fetches for API routes); get_portfolio_pnl.py
  testing/                  # WebSocket and data validation checks
Historical Data/            # Index CSVs: NIFTY_50_Daily_5Y.csv, NIFTY_500_Daily.csv
Daily_Historical_Data_Fresh/ # Per-stock daily CSVs (<SYMBOL>_Daily_2Y.csv) for RS dashboard
debug/                      # Runtime state JSON files, log files, trigger files (auto-created)
master_list.csv             # 288K-row security master list (~15 MB, cached)
MW-NIFTY-500-25-Jan-2026.csv  # Nifty 500 constituent list used by refresh and quote scripts
Options Data/nifty_options.db  # SQLite cache of historical/expired option chain data, built by
                                # scripts/analysis/convert_options_to_sqlite.py; read by backtests
                                # (e.g. backtest_short_straddle.py) and tests/test_18_expired_options.py
```

### DhanHelper (`lib/dhan_helper.py`)

The central abstraction over the `dhanhq` SDK. Every strategy instantiates it once:

```python
dhan = get_dhan_client()
helper = DhanHelper(dhan)
```

- Loads `master_list.csv` on init (~1.5 s). Subsequent lookups are O(1) in-memory.
- Manages a background WebSocket thread with singleton lock and auto-reconnect.
- Implements 1-second LTP cache and 30-second backoff on HTTP 429.
- Exposes `helper.live_data` dict (populated by WebSocket); `get_ltp()` prioritises this over REST.
- `_on_ws_message` uses a **merge strategy** — combines multiple binary packets per tick (Full + OI + PrevClose) to prevent an OI-only packet from overwriting LTP/OHLC in `live_data`.
- v2 API compliant for orders/forever and funds/margin endpoints.

Key method families (see [docs/AGENT_FUNCTION_REFERENCE.md](docs/AGENT_FUNCTION_REFERENCE.md) for full reference):
- **Security lookup**: `find_equity`, `find_index`, `find_option`, `find_future`, `get_lot_size`
- **Market data**: `get_ltp`, `get_latest_candles`, `get_option_chain_df`, `get_expiries`, `get_prev_day_levels`
- **Technical indicators**: `get_indicators_ta(symbol, interval, indicators, days)` — uses `pandas_ta`
- **Orders**: `place_entry`, `place_sl_market`, `close_position`, `cancel_all_orders`, `wait_for_fill`
- **Market feed WebSocket**: `start_websocket([(exchange, security_id, feed_type)])`
- **Order-update WebSocket**: `start_order_update_websocket(on_update?)`, `stop_order_update_websocket()`, `get_order_update(order_id)` — connects to `wss://api-order-update.dhan.co`; stores fills/rejections/cancellations in `self.order_updates[order_id]`; calls optional `on_update` callback per event.

### Strategy State Bridge

Strategies write their live state to `debug/<strategy_key>_state.json` every loop iteration via `save_strategy_state()`. The Next.js dashboard polls `/api/strategies` (GET) which reads these files and cross-checks PIDs with `tasklist` to determine running/stopped status. To stop a strategy gracefully, the dashboard writes `debug/<strategy_key>_shutdown.trigger`; the strategy checks this file in `check_shutdown_trigger()` and exits cleanly.

### Next.js Dashboard (`rs_dashboard/`)

App Router layout under `app/`. ~30 pages, ~48 API routes, still growing — **run `ls rs_dashboard/app` and `ls rs_dashboard/app/api` for the authoritative current list before assuming a page/route does or doesn't exist.** API route folders generally match page folders. Domains: RS/screening (`/`, movers, scanner, rrg, breadth, …), options (in the `app/(options)` route group on disk — URLs unchanged), live/intraday (live, scalper, advanced-scalper, futures), strategy ops (strategies, strategy-builder, backtest), portfolio/reports, `/login`.

Non-obvious route behaviors:
- `live-equity/`, `live-indices/`, `live-normalized-1min*/` — manage the Python WebSocket bridges; POST `{action:"stop"}` writes the matching `debug/*_stop.trigger`.
- `strategies/` / `saved-strategies/` — start/stop strategy processes via `spawn`; read state files and cross-check PIDs.
- `refresh/`, `futures-refresh/`, `options-refresh/`, `backfill/`, `crudeoil-oi-collector/` — spawn the matching Python script, poll its `debug/*_status.json`, stop via `debug/*_stop.trigger`.
- `copy-trade/` — start/stop/status UI for `scripts/tools/copy_trade_bridge.py` (the Multi-broker copy-trade bridge below): POST `{action:"start"}` spawns it detached, POST `{action:"stop"}` writes `debug/copy_trade_stop.trigger`, GET reports RUNNING/STARTING/STALE/STOPPED off a 20s heartbeat staleness check against `debug/copy_trade_status.json`.
- `kotak-pnl/` — the Trader's Diary's Kotak source. Kotak Neo has **no historical trade endpoint** (`trade_report()` takes no dates and returns only the current day), so unlike the Dhan side this is not a broker sync: the user drops statement exports into `debug/kotak_pnl_reports/` and POST `{action:"import"}` runs `scripts/tools/import_kotak_pnl_reports.py` over them. Two formats, and the precedence matters: a **Transaction Statement** (sheet `On Market`) is one row per fill and is FIFO-matched into exact daily P&L; a **Gain/Loss** export is per-scrip over a date range with no per-trade date, so it collapses to one end-stamped point. Where both cover the same dates the transaction statement wins — not just for granularity, but because **the Gain/Loss F&O export omits the commodity segment entirely** (on the first real pair it hid −₹5,048 of MCX crude). Read that script's docstring before touching either parser: the Gain/Loss "Realised P&L" column is already net of GST/brokerage/misc (true gross is the separate `Gross P&L (T + (C + D + E))` column), and the transaction statement's "Total Charges" *excludes* STT while the Gain/Loss column of the same name includes it.
- `exit-all/`, `pnl-exit/`, `quiktrade/`, `crudeoil/kotak-order/` — square off positions / place quick trades: real-money endpoints.
- `csp-scan/` — spawns `scripts/tools/csp_scanner.py` (screening only, no orders); `csp-tracked/sell` and `csp-watchlist/exit` place and exit **real** cash-secured-put orders via `scripts/tools/csp_watchlist.py`, then track fills/strike-rolls in `lib/cspTracked.ts`'s JSON store — reconciled against broker truth by `csp-tracked/reconcile` and `csp-tracked/sync`.

**lib/ files** (`rs_dashboard/lib/`) — the ones with non-obvious behavior:
- `pyExec.ts` — `runPythonJson()` (async venv-Python spawn, parses last stdout line as JSON) + `dedupe()` in-flight dedup + `PROJECT_ROOT`/`PYTHON_EXE`. Use this from API routes; don't hand-roll `spawnSync` (blocks the Node event loop)
- `processCheck.ts` — `isPidRunning()` with a 3 s per-PID cache (raw `tasklist` on every poll starves the event loop)
- `dhanToken.ts` — `getDhanCredentials()`: cached read of `.env` client_id + `access_token.json` for direct Dhan REST calls from Node
- `dataLoader.ts` — CSV readers; patches today's row from `debug/today_quotes.json` before EOD CSVs are available
- `clientCache.ts` — client-side stale-while-revalidate cache for page mount fetches
- Others (`rs.ts`, `indicators.ts`, `sectors.ts`, `nifty50.ts`, `scannerTypes.ts`, `optionsStrategy.ts`, `auth.ts`, hooks) do what their names say.

**`PROJECT_ROOT`** in API routes is `path.resolve(process.cwd(), '..')` (one level up from `rs_dashboard/`).

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

These are not obvious and have caused runtime errors in the past (see [GEMINI.md](GEMINI.md)):

- **Use `get_ltp()`, not `ltp()`**. The simplified `ltp()` wrapper does not accept `instrument` or `exchange` keyword args.
- **Keyword is `exchange=`, not `exchange_segment=`**. Using the wrong name raises `TypeError`.
- **Always pass `instrument=`** (e.g. `"INDEX"`, `"EQUITY"`, `"OPTIDX"`) to `get_ltp()` / `find_*` to prevent the helper from defaulting to `"EQUITY"` and logging "Security not found" warnings.
- **NIFTY symbol**: use `"NIFTY"` (not `"NIFTY 50"`). Exchange `"IDX_I"` is mapped internally to `"NSE"` for master list lookups.
- **NIFTY options underlying ID is `26000`**, not `13` (which is the Nifty 50 index security ID used for spot price and expiry list calls).
- **SENSEX splits three ways and every wrong combination fails silently.** Option chain + expiry list key on security id **`1` / `BSE_FNO`**; the index's own id `51` is only for spot/candles, and those are served under **`IDX_I`** — `BSE_IDX` returns `DH-905` for history and an empty payload for quotes, so `get_ltp("SENSEX", exchange="BSE")` returns `0.0`. Pass the numeric id, never the bare symbol (which resolves to `51` and yields an empty chain). The tables in `scripts/tools/options_data_fetch.py` and `options_chart_fetch.py` encode this. When re-probing, note `get_option_chain` caches 5 s on `(security_id, expiry)` — a bad combination can appear to work off a prior call's cache entry.
- **Market feed WebSocket**: use `feed.run()` inside the background thread. `feed.run_forever()` returns immediately in the current SDK, causing a reconnection loop.
- **Lot sizes are dynamic** — fetch with `helper.get_lot_size("NIFTY")`. For index symbols, this automatically queries derivative contracts to return the option lot size, not the index placeholder of `1`.
- **Previous day levels**: use `helper.get_prev_day_levels("NIFTY")` — do not inline `get_historical_data()` calls for PDH/PDL/PDC. (It reads the returned row's actual date rather than assuming row-count offsets — Dhan's DAILY endpoint doesn't publish today's row until the session closes, so a fixed "step back N rows" offset returns the wrong day intraday.)
- **Data API failures are silent by default** — historical/intraday data methods return empty results on API errors (e.g. `DH-902` when the Data API subscription lapses). Check `helper.last_api_error` after an empty response before concluding "no data" / "up to date"; scripts that report freshness must surface it.
- **`find_future()` must filter out expired contracts before picking nearest.** Dhan's master list keeps expired futures rows for days after expiry, sorted by expiry date — picking the earliest-sorted match without an `SM_EXPIRY_DATE >= today` filter can resolve a dead security ID with no live OHLC/quote data.
- **`get_option_chain()`'s per-strike `oc[strike]['ce'/'pe']` dict names the previous-day close field `previous_close_price`, not `previous_close`.** `previous_oi` (OI) is spelled as you'd expect — only the close field has the `_price` suffix. Reading `previous_close` silently returns `None`/0 with no error, which then reads as "no previous close" everywhere downstream (e.g. a buildup-classifier's prev-day fallback going permanently 0%). This exact typo has been copied between scripts more than once (`live_options_ws.py`, `focus_tool_ws.py`) — verify the field name against a live response before trusting it in new code.

## Strategy Conventions

- All strategies start with `--live` disabled (dry run) by default — no real orders are placed without the flag.
- After-hours development: symbol lookups and expiry resolution work via the cached master list; live quotes and order placement are unavailable.
- Intraday auto-exit is hardcoded at **15:17 IST** across all strategies.
- Straddle/strangle inversion guard: `CE strike > PE strike` is enforced at entry and after each adjustment; violation triggers an emergency exit + 5-minute pause + fresh cycle. **Exception**: `nifty_delta_neutral.py` deliberately does not enforce this — strikes are chosen purely by delta-proximity, so an inverted strangle (CE strike < PE strike) is a valid, expected outcome, not an error.
- New strategies must use `templates/strategy_template.py` as the starting point and must call `save_strategy_state()` and `check_shutdown_trigger()` in the main loop to integrate with the dashboard.
- **Exit sizing must never trust the raw broker net quantity.** Dhan nets every position by security ID, so two strategy instances short of the same strike share ONE broker position — sizing an exit off `helper.get_net_quantity()` lets whichever instance exits first flatten a sibling instance's leg too (this happened for real on 2026-07-30). Use `lib/strategy_risk.py`'s `resolve_exit_qty(helper, security_id, own_qty, side)` instead: it exits what *this* strategy opened, clamped by what the broker still shows in that direction. Already adopted across `value_imbalance/`, `oi_directional/`, and `intraday_equity/` — use it in any new strategy that can share a security ID with another running instance.
- Per-strategy trading logic lives in each group's `strategy.md` (`strategies/<group>/strategy.md`) — read it before modifying that strategy. One-line map: `value_imbalance/` premium mean-reversion straddles/strangles (VWAP variant, plus a delta-neutral 0.5-delta variant with no inversion guard and no entry-balance gate); `spread_trend/` EMA20+Supertrend credit spreads; `st_oi_bearcall/` bear-call-only entry gated by dual Supertrend (index 3-min + candidate option's own 3-min) plus OI short-buildup confirmation; `oi_directional/` OI-diff/PCR naked option sell; `crudeoil/` MCX futures (Supertrend trailing, always-in Renko SAR, VWAP+Supertrend, and pivot-gated ORB); `intraday_equity/` Nifty-50 cash VWAP+RS auto-trader, rule set NOT validated by backtest — dry-run only, `--live` requires `--i-understand-the-backtest-failed`; `momentum_investing/` the repo's only multi-day/CNC-delivery strategy — Nifty-500 composite-RS ranking, trailing-stop ladder + weekly rank rotation, portfolio persisted to `debug/nifty500_momentum_portfolio.json` across restarts.

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

Dhan is the primary account. Zerodha and Kotak are supported both as selectable brokers in
the scalper terminals and as copy-trade children that mirror Dhan fills.

- **Dashboard**: `hooks/useBrokerSelector.ts` owns the `Broker` union; use `scalperRoute(broker,
  endpoint)` rather than hand-building `/api/scalper/...` paths, and `brokerRoute(broker, {…})`
  for irregular ones — it takes a **map**, because a positional pair silently routed a third
  broker to Dhan's endpoint (i.e. traded the wrong account). Dhan is the only broker with a
  numeric `securityId`; every other broker joins positions and places orders by trading symbol,
  so branch on `broker !== 'dhan'`, not on a specific broker name.
- **Bridge**: `scripts/tools/child_brokers.py` defines `ChildBroker` plus `ZerodhaChild` /
  `KotakChild`; `copy_trade_bridge.py` is broker-agnostic and drives them through that interface.
  Each broker owns its own instrument cache, margin state, position snapshot and replication
  scope. The safety invariants live in `ChildBroker` so the two cannot drift: a reducing order is
  never margin-blocked, unknown margin fails OPEN, a stale position snapshot fails OPEN, and the
  fast path (WS callback thread) never makes an HTTP call.
- **Kotak quirks** (all handled in `lib/kotak/`): auth failures and "no data" arrive as 200-OK
  bodies (`stCode 5203` = empty book, not an error); positions report no net quantity (compute it
  from the four `cf*`/`fl*` legs); strikes are ×100 scaled in the scrip master; the REST base URL
  is per-user and comes from the login response; the SDK issues every HTTP call with **no
  timeout**, so `lib.kotak.authentication.install_timeouts()` must run before any API use.
- **Kotak expiry epochs differ per segment.** `nse_fo`/`bse_fo` use a **1980-based epoch** (add 10
  calendar years). `mcx_fo` does **not** — its timestamps are a genuine epoch and must be read in
  **UTC** (Kotak stamps 23:59:59 UTC, so local parsing rolls every expiry forward a day). Applying
  the NSE rule to commodities returns 2036. Both branches live in
  `scripts/tools/kotak_instruments_cache.py`.
- **MCX quantity semantics are broker-specific and differ by 100x.** Dhan takes MCX order quantity
  in **lots** (its master reports `LOT_SIZE=1`); Kotak's `qt` is **absolute** (100 per CRUDEOIL
  lot, 10 per CRUDEOILM). Always send a position's reported `netQty` verbatim when squaring off.
  MCX options are `OPTFUT` in both masters — the equity `OPTIDX`/`OPTSTK` filter drops them.
- The startup OTM hedge (`copy_trade_hedge.py`) is **Zerodha-only** by design.
