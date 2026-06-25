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
# Value Imbalance — advanced (dry run by default)
venv\Scripts\python.exe strategies/value_imbalance/nifty_advanced_imbalance.py --entry-type straddle --mode winner_roll_atm

# Value Imbalance — advanced (live)
venv\Scripts\python.exe strategies/value_imbalance/nifty_advanced_imbalance.py --live --lots 2 --entry-type straddle --mode winner_roll_atm

# Value Imbalance — base straddle / strangle
venv\Scripts\python.exe strategies/value_imbalance/nifty_value_imbalance_straddle.py --lots 1
venv\Scripts\python.exe strategies/value_imbalance/nifty_value_imbalance_strangle.py --lots 1

# Premium mean-reversion straddles (tick TWAP and true 1-min VWAP)
venv\Scripts\python.exe strategies/value_imbalance/nifty_tick_mean_straddle.py --lots 1
venv\Scripts\python.exe strategies/value_imbalance/nifty_vwap_1min_straddle.py --lots 1

# Expiry-day straddle (0DTE)
venv\Scripts\python.exe strategies/expiry/nifty_expiry.py --lots 1 --entry-type straddle --adjustment c2c

# Spread trend (EMA20 + Supertrend — sells Bull Put or Bear Call spread)
venv\Scripts\python.exe strategies/spread_trend/nifty_spread_trend.py --lots 1 --spread-width 100

# OI Directional (PCR-based naked PE/CE sell)
venv\Scripts\python.exe strategies/oi_directional/nifty_oi_directional.py --lots 1 --pcr-threshold 1.5
```

Full CLI references for all strategies are in [GEMINI.md](GEMINI.md).

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
  value_imbalance/          # Straddle, Strangle, Advanced Imbalance, and VWAP straddle strategies
  expiry/                   # 0DTE expiry-day straddle/strangle with leg SL and adjustment modes
  spread_trend/             # Trend-following Bear Call / Bull Put spread strategy (EMA20 + Supertrend)
  oi_directional/           # OI imbalance + PCR-driven naked PE/CE sell strategy
  Archives/                 # Retired/superseded strategies (kept for reference)
templates/strategy_template.py  # Starting point for new strategies
scripts/
  downloader/               # Historical data downloaders + dashboard data refresh scripts
  analysis/                 # Report generators and scanners
  data_utils/               # Parquet conversion, resampling, indicator append
  tools/                    # Live options tracker, portfolio monitor (get_portfolio_pnl.py)
  testing/                  # WebSocket and data validation checks
Historical Data/            # Index CSVs: NIFTY_50_Daily_5Y.csv, NIFTY_500_Daily.csv
Daily_Historical_Data_Fresh/ # Per-stock daily CSVs (<SYMBOL>_Daily_2Y.csv) for RS dashboard
debug/                      # Runtime state JSON files, log files, refresh_status.json (auto-created)
master_list.csv             # 288K-row security master list (~15 MB, cached)
MW-NIFTY-500-25-Jan-2026.csv  # Nifty 500 constituent list used by refresh and quote scripts
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
- API routes:
  - `app/api/strategies/route.ts` — start/stop strategy processes via `spawn`; `app/api/strategies/logs/route.ts` — tail log files
  - `app/api/movers/route.ts` — computes top/bottom movers, volume surges, 52W proximity, MA alignment, RSI from stock CSVs
  - `app/api/refresh/route.ts` — spawns `refresh_dashboard_data.py`, polls `debug/refresh_status.json`, exposes stop endpoint
- Pages: `app/movers/` — Market Movers page
- Components: `StockDashboard` (root), `StrategyCard`, `LogConsole`, `RSChart`, `SectorHeatmap`, `Leaderboard`, `IndexSummary`, `MarketMovers`, `DataRefreshPanel`
- `PROJECT_ROOT` in API routes is `path.resolve(process.cwd(), '..')` (one level up from `rs_dashboard/`)
- `debug/today_quotes.json` — live intraday OHLCV snapshot written by `fetch_today_quotes.py`; `dataLoader.ts` merges this to patch the missing today-row in stock CSVs before market close

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
- **Premium mean-reversion straddle strategies**: sell ATM straddle when combined CE+PE premium is at/below a reference mean; exit when premium exceeds mean + exit_buffer.
  - `nifty_vwap_1min_straddle.py` — true volume-weighted VWAP: `Σ(TP×Vol)/Σ(Vol)` from 1-min OHLCV candles fetched via API.
  - `nifty_tick_mean_straddle.py` — running arithmetic mean of combined premium from WebSocket ticks (no volume weighting; effectively TWAP by tick).
- **Spread trend strategy** (`strategies/spread_trend/`): sells Bear Call or Bull Put spreads based on EMA20 + Supertrend(7,3) alignment. Both indicators must agree for entry. See `strategies/spread_trend/strategy.md` for full logic.
- **OI Directional strategy** (`strategies/oi_directional/`): polls the option chain every `--poll-interval` seconds and computes `diff = sum(CE_OI) - sum(PE_OI)` across ±5 ATM strikes (11 strikes, 50-pt spacing). Expanding negative diff → BULLISH → sell naked PE at the strike where PCR > `--pcr-threshold`; expanding positive diff → BEARISH → sell naked CE. Exit when the entry-strike PCR unwinds by `--exit-pcr-change` %. Requires `--expansion-window` consecutive confirming snapshots before entry. See `strategies/oi_directional/strategy.md` for full logic.
- **Expiry strategy** (`strategies/expiry/`): 0DTE straddle or strangle with per-leg SL (`--leg-sl-pct`) and configurable adjustment modes (`c2c`, `restrangle`, `roll_closer`, `winner_addition`, `none`). Supports delta-based (`--delta --target-delta`) or premium-based (`--premium --target-premium`) strike selection. See `strategies/expiry/strategy.md` for full logic.

## Environment

Required in `.env` (at project root):
```
client_id=...
api_key=...
api_secret=...
```

Token is cached to `access_token.json` and reused until `expiryTime`. Run `login.py` to refresh it.
