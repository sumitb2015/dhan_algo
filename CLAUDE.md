# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dhan Algo Trading: a Python library wrapping the DhanHQ broker SDK for live F&O strategy execution, plus a Next.js dashboard (`rs_dashboard/`) for monitoring and controlling running strategies.

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

### Running Strategies (examples)

```powershell
# Dry run (no real orders) — always the default
venv\Scripts\python.exe strategies/value_imbalance/nifty_advanced_imbalance.py --entry-type straddle --mode winner_roll_atm

# Live trade
venv\Scripts\python.exe strategies/value_imbalance/nifty_advanced_imbalance.py --live --lots 2 --entry-type straddle --mode winner_roll_atm
```

Full CLI references for all strategies are in [GEMINI.md](GEMINI.md).

### Tests

```powershell
# Full test suite
cd tests && venv\Scripts\python.exe run_all_tests.py

# Single test module
venv\Scripts\python.exe tests/test_04_option_chain.py
```

Each test module exposes a `run(helper)` function. The orchestrator in `tests/run_all_tests.py` initialises a single `DhanHelper` and passes it to each module.

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
strategies/
  value_imbalance/          # Straddle, Strangle, and Advanced Imbalance strategies
  expiry/                   # 0DTE expiry-day strategy
  spread_trend/             # Trend-following spread strategy
templates/strategy_template.py  # Starting point for new strategies
scripts/
  downloader/               # Historical data downloaders
  analysis/                 # Report generators and scanners
  data_utils/               # Parquet conversion, resampling, indicator append
  tools/                    # Live options tracker, portfolio monitor
  testing/                  # WebSocket and data validation checks
debug/                      # Runtime state JSON files + log files (auto-created)
master_list.csv             # 288K-row security master list (~15 MB, cached)
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

Key method families (see [docs/AGENT_FUNCTION_REFERENCE.md](docs/AGENT_FUNCTION_REFERENCE.md) for full reference):
- **Security lookup**: `find_equity`, `find_index`, `find_option`, `find_future`, `get_lot_size`
- **Market data**: `get_ltp`, `get_latest_candles`, `get_option_chain_df`, `get_expiries`, `get_prev_day_levels`
- **Technical indicators**: `get_indicators_ta(symbol, interval, indicators, days)` — uses `pandas_ta`
- **Orders**: `place_entry`, `place_sl_market`, `close_position`, `cancel_all_orders`, `wait_for_fill`
- **WebSocket**: `start_websocket([(exchange, security_id, feed_type)])`

### Strategy State Bridge

Strategies write their live state to `debug/<strategy_key>_state.json` every loop iteration via `save_strategy_state()`. The Next.js dashboard polls `/api/strategies` (GET) which reads these files and cross-checks PIDs with `tasklist` to determine running/stopped status. To stop a strategy gracefully, the dashboard writes `debug/<strategy_key>_shutdown.trigger`; the strategy checks this file in `check_shutdown_trigger()` and exits cleanly.

### Next.js Dashboard (`rs_dashboard/`)

- App Router layout under `app/`
- API routes: `app/api/strategies/route.ts` — start/stop strategy processes via `spawn`; `app/api/strategies/logs/route.ts` — tail log files
- Components: `StockDashboard` (root), `StrategyCard`, `LogConsole`, `RSChart`, `SectorHeatmap`, `Leaderboard`, `IndexSummary`
- `PROJECT_ROOT` in API routes is `path.resolve(process.cwd(), '..')` (one level up from `rs_dashboard/`)

---

## Critical API Conventions

These are not obvious and have caused runtime errors in the past (see [GEMINI.md](GEMINI.md)):

- **Use `get_ltp()`, not `ltp()`**. The simplified `ltp()` wrapper does not accept `instrument` or `exchange` keyword args.
- **Keyword is `exchange=`, not `exchange_segment=`**. Using the wrong name raises `TypeError`.
- **Always pass `instrument=`** (e.g. `"INDEX"`, `"EQUITY"`, `"OPTIDX"`) to `get_ltp()` / `find_*` to prevent the helper from defaulting to `"EQUITY"` and logging "Security not found" warnings.
- **NIFTY symbol**: use `"NIFTY"` (not `"NIFTY 50"`). Exchange `"IDX_I"` is mapped internally to `"NSE"` for master list lookups.
- **NIFTY options underlying ID is `26000`**, not `13` (which is the Nifty 50 index security ID used for spot price and expiry list calls).
- **WebSocket**: use `feed.run()` inside the background thread. `feed.run_forever()` returns immediately in the current SDK, causing a reconnection loop.
- **Lot sizes are dynamic** — fetch with `helper.get_lot_size("NIFTY")`. For index symbols, this automatically queries derivative contracts to return the option lot size, not the index placeholder of `1`.
- **Previous day levels**: use `helper.get_prev_day_levels("NIFTY")` — do not inline `get_historical_data()` calls for PDH/PDL/PDC.

## Strategy Conventions

- All strategies start with `--live` disabled (dry run) by default — no real orders are placed without the flag.
- After-hours development: symbol lookups and expiry resolution work via the cached master list; live quotes and order placement are unavailable.
- Intraday auto-exit is hardcoded at **15:17 IST** across all strategies.
- Straddle/strangle inversion guard: `CE strike > PE strike` is enforced at entry and after each adjustment; violation triggers an emergency exit + 5-minute pause + fresh cycle.
- New strategies must use `templates/strategy_template.py` as the starting point and must call `save_strategy_state()` and `check_shutdown_trigger()` in the main loop to integrate with the dashboard.

## Environment

Required in `.env` (at project root):
```
client_id=...
api_key=...
api_secret=...
```

Token is cached to `access_token.json` and reused until `expiryTime`. Run `login.py` to refresh it.
