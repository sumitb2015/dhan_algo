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
  crudeoil/                 # MCX CRUDEOILM Supertrend-following futures strategy
  Archives/                 # Retired/superseded strategies (kept for reference)
templates/strategy_template.py  # Starting point for new strategies
docs/
  AGENT_FUNCTION_REFERENCE.md  # Full DhanHelper method reference
  STRATEGY_GUIDELINES.md       # How to structure a new strategy
  OPTION_CHAIN_QUICK_REF.md    # Option chain response shape cheat sheet
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
- `refresh/`, `futures-refresh/`, `options-refresh/`, `backfill/` — spawn the matching Python script, poll its `debug/*_status.json`.
- `exit-all/`, `pnl-exit/`, `quiktrade/` — square off positions / place quick trades: real-money endpoints.

**lib/ files** (`rs_dashboard/lib/`) — the ones with non-obvious behavior:
- `pyExec.ts` — `runPythonJson()` (async venv-Python spawn, parses last stdout line as JSON) + `dedupe()` in-flight dedup + `PROJECT_ROOT`/`PYTHON_EXE`. Use this from API routes; don't hand-roll `spawnSync` (blocks the Node event loop)
- `processCheck.ts` — `isPidRunning()` with a 3 s per-PID cache (raw `tasklist` on every poll starves the event loop)
- `dhanToken.ts` — `getDhanCredentials()`: cached read of `.env` client_id + `access_token.json` for direct Dhan REST calls from Node
- `dataLoader.ts` — CSV readers; patches today's row from `debug/today_quotes.json` before EOD CSVs are available
- `clientCache.ts` — client-side stale-while-revalidate cache for page mount fetches
- Others (`rs.ts`, `indicators.ts`, `sectors.ts`, `nifty50.ts`, `scannerTypes.ts`, `optionsStrategy.ts`, `auth.ts`, hooks) do what their names say.

**`PROJECT_ROOT`** in API routes is `path.resolve(process.cwd(), '..')` (one level up from `rs_dashboard/`).

**Table header style**: use `text-xs font-bold text-white` and solid `bg-zinc-800` for `<thead>` / `TH` components in all dashboard tables. At 10px, white text anti-aliases to gray — 12px (`text-xs`) with `font-bold` is the minimum for headers to appear truly white on dark backgrounds.

**No text color opacity modifiers**: never use Tailwind's slash-opacity notation on text colors (e.g. `text-white/70`, `text-zinc-400/50`). Use solid zinc colors instead: `text-zinc-100` (near-white), `text-zinc-200`, `text-zinc-300` (body), `text-zinc-400` (secondary), `text-zinc-500` (muted), `text-zinc-600` (very dim). Opacity modifiers are fine on backgrounds (`bg-emerald-500/10`) but not on text.

**Data date in page headers**: pages that display stock/market data must show a `DATA: YYYY-MM-DD` chip in the sticky header so users always know the currency of the data on screen.

---

## Critical API Conventions

These are not obvious and have caused runtime errors in the past (see [GEMINI.md](GEMINI.md)):

- **Use `get_ltp()`, not `ltp()`**. The simplified `ltp()` wrapper does not accept `instrument` or `exchange` keyword args.
- **Keyword is `exchange=`, not `exchange_segment=`**. Using the wrong name raises `TypeError`.
- **Always pass `instrument=`** (e.g. `"INDEX"`, `"EQUITY"`, `"OPTIDX"`) to `get_ltp()` / `find_*` to prevent the helper from defaulting to `"EQUITY"` and logging "Security not found" warnings.
- **NIFTY symbol**: use `"NIFTY"` (not `"NIFTY 50"`). Exchange `"IDX_I"` is mapped internally to `"NSE"` for master list lookups.
- **NIFTY options underlying ID is `26000`**, not `13` (which is the Nifty 50 index security ID used for spot price and expiry list calls).
- **Market feed WebSocket**: use `feed.run()` inside the background thread. `feed.run_forever()` returns immediately in the current SDK, causing a reconnection loop.
- **Lot sizes are dynamic** — fetch with `helper.get_lot_size("NIFTY")`. For index symbols, this automatically queries derivative contracts to return the option lot size, not the index placeholder of `1`.
- **Previous day levels**: use `helper.get_prev_day_levels("NIFTY")` — do not inline `get_historical_data()` calls for PDH/PDL/PDC.
- **Data API failures are silent by default** — historical/intraday data methods return empty results on API errors (e.g. `DH-902` when the Data API subscription lapses). Check `helper.last_api_error` after an empty response before concluding "no data" / "up to date"; scripts that report freshness must surface it.

## Strategy Conventions

- All strategies start with `--live` disabled (dry run) by default — no real orders are placed without the flag.
- After-hours development: symbol lookups and expiry resolution work via the cached master list; live quotes and order placement are unavailable.
- Intraday auto-exit is hardcoded at **15:17 IST** across all strategies.
- Straddle/strangle inversion guard: `CE strike > PE strike` is enforced at entry and after each adjustment; violation triggers an emergency exit + 5-minute pause + fresh cycle. **Exception**: `nifty_delta_neutral.py` deliberately does not enforce this — strikes are chosen purely by delta-proximity, so an inverted strangle (CE strike < PE strike) is a valid, expected outcome, not an error.
- New strategies must use `templates/strategy_template.py` as the starting point and must call `save_strategy_state()` and `check_shutdown_trigger()` in the main loop to integrate with the dashboard.
- Per-strategy trading logic lives in each group's `strategy.md` (`strategies/<group>/strategy.md`) — read it before modifying that strategy. One-line map: `value_imbalance/` premium mean-reversion straddles/strangles (VWAP variant, plus a delta-neutral 0.5-delta variant with no inversion guard and no entry-balance gate); `spread_trend/` EMA20+Supertrend credit spreads; `st_oi_bearcall/` bear-call-only entry gated by dual Supertrend (index 3-min + candidate option's own 3-min) plus OI short-buildup confirmation; `oi_directional/` OI-diff/PCR naked option sell; `crudeoil/` MCX futures (Supertrend trailing, and always-in Renko SAR).

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
  from the four `cf*`/`fl*` legs); expiry timestamps use a **1980-based epoch** and strikes are
  ×100 scaled in the scrip master; the REST base URL is per-user and comes from the login
  response; the SDK issues every HTTP call with **no timeout**, so
  `lib.kotak.authentication.install_timeouts()` must run before any API use.
- The startup OTM hedge (`copy_trade_hedge.py`) is **Zerodha-only** by design.
