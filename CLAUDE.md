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

# CrudeOil Mini Supertrend (directional MCX futures)
venv\Scripts\python.exe strategies/crudeoil/crudeoilm_supertrend.py --lots 1 --interval 5

# CrudeOil Mini Renko SAR (always-in stop-and-reverse MCX futures)
venv\Scripts\python.exe strategies/crudeoil/crudeoilm_renko_sar.py --lots 1 --box-size 5 --reverse-bricks 3
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
  crudeoil/                 # MCX CRUDEOILM Supertrend-following futures strategy
  Archives/                 # Retired/superseded strategies (kept for reference)
templates/strategy_template.py  # Starting point for new strategies
docs/
  AGENT_FUNCTION_REFERENCE.md  # Full DhanHelper method reference
  STRATEGY_GUIDELINES.md       # How to structure a new strategy
  OPTION_CHAIN_QUICK_REF.md    # Option chain response shape cheat sheet
scripts/
  downloader/               # Historical data downloaders + dashboard data refresh scripts
    download_indices.py     # Downloads 5Y daily OHLCV for NSE indices (Nifty 50, 500 + 9 sector indices)
    refresh_dashboard_data.py
    fetch_today_quotes.py
  analysis/                 # Backtests, report generators, and screeners
    backtest_nifty50_rs_v*.py   # 9-version RS-ranked equity backtest suite (v1–v9 + v6_excel)
    backtest_ema_breakout.py
    backtest_ab_test.py
    backtest_supertrend_flip.py
    generate_nifty50_stock_analysis_report.py
    generate_nifty500_report.py
    generate_market_regime_report.py
    breakout_momentum_screener.py
    portfolio_risk_screener.py
    nifty_distribution_analysis.py
  data_utils/               # Parquet conversion, resampling, indicator append
  tools/                    # Live WebSocket bridges and data utilities
    live_equity_ws.py       # Streams Nifty 50 equity ticks → debug/live_equity_quotes.json
    live_options_ws.py      # Streams FNO option ticks → debug/live_options_quotes.json
    options_straddle_candles.py  # 1-min CE+PE straddle candle data for dashboard
    options_data_fetch.py   # One-off options chain/expiry/LTP fetch for API routes
    get_portfolio_pnl.py    # Portfolio P&L calculator
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

App Router layout under `app/`. ~27 pages, ~39 API routes — grown well past the original RS-leaderboard scope. Grouped by domain (component names match page folder unless noted):

- **Relative strength / screening**: `/` (StockDashboard — RS leaderboard), `/movers` (MarketMovers), `/movers-plus` (MoversPlusDashboard — streak persistence), `/scanner` (Scanner — EMA/RSI/MACD/ADX/Supertrend/Bollinger/NR), `/rrg` (RRGDashboard — relative rotation graph), `/normalized` (NormalizedChart), `/distribution` (DistributionChart), `/breadth` (BreadthAnalysis), `/performance` (PerformancePage — sector indices).
- **Options**: `/options` (OptionsCharts — chain/Greeks/IV), `/iv-charts` (IVChartsPage), `/straddle-analysis` / `/strangle-analysis` (StraddleAnalysis / StrangleAnalysis), `/expiry-analysis` (ExpiryAnalysis), `/diffusion` (DiffusionDashboard).
- **Live / intraday**: `/live` (LiveDashboard — equity WebSocket bridge), `/premarket` (PremarketDashboard), `/scalper` (Scalper), `/futures` (FuturesDashboard — MCX).
- **Strategy ops**: `/strategies` (StrategiesPage — start/stop, live P&L, logs), `/strategies-plus` (StrategyRowWide — wide multi-strategy view), `/strategy-builder` (StrategyBuilder), `/backtest` (backtest runner UI).
- **Portfolio & reporting**: `/portfolio` (PortfolioDashboard), `/portfolio-new` (PortfolioNewDashboard), `/reports` (ReportsPage — trigger Python analysis scripts, download XLSX/CSV).
- **Auth**: `/login`.

Run `find rs_dashboard/app -maxdepth 1 -type d` for the authoritative current list rather than trusting this table as pages get added often.

**Key API routes** (`app/api/`, one subfolder per page above unless noted):
- `breadth/route.ts` — regime label, % above EMA 20/50/200, bull/bear power, participation score (0–100), A/D ratio, RSI zones from Nifty 500 CSV data.
- `live-equity/`, `live-indices/`, `live-normalized-1min/`, `live-normalized-1min-stocks/` — manage the Python WebSocket bridges; POST `{action:"stop"}` writes the matching `debug/*_stop.trigger`.
- `indices-performance/route.ts` — performance for all sector indices (standard + 9 new: Media, Healthcare, Oil & Gas, Consumer Durables, FinServices 25/50, MidSmall variants).
- `scanner/route.ts` — full indicator matrix: EMA alignment, RSI, MACD, ADX, Supertrend, Bollinger, ATR, NR4/NR7, RS scoring.
- `options/` — sub-routes: `expiries`, `chain`, `spot`, `candles`, `live`.
- `strategies/route.ts` / `saved-strategies/route.ts` — start/stop strategy processes via `spawn`; reads state files and PIDs.
- `refresh/route.ts`, `futures-refresh/route.ts`, `options-refresh/route.ts` — spawn the matching Python refresh script, poll its `debug/*_status.json`.
- `exit-all/route.ts`, `pnl-exit/route.ts` — square off open positions from the dashboard.
- `portfolio/`, `portfolio-holdings/`, `portfolio-settings/` — portfolio data and user-configurable settings.
- `movers/route.ts`, `movers-plus/route.ts` — top/bottom movers, volume surges, 52W proximity, MA alignment, RSI, and consecutive-day streaks.

**lib/ files:**
- `rs.ts` — core RS computation and score assignment
- `dataLoader.ts` — `readStockCSV()`, `readNifty50Index()`, `readNifty500Index()`; patches today's row from `debug/today_quotes.json` before EOD CSVs are available
- `sectors.ts` — `getSector(symbol)` and sector color map
- `scannerTypes.ts` — `ScannerParams`, `ScannerResult`, `ScannerResponse` TypeScript types
- `nifty50.ts` — `NIFTY50_SYMBOLS` export
- `indicators.ts` — shared TA indicator math for scanner/breadth routes
- `optionsStrategy.ts` — options payoff/strategy helpers
- `auth.ts` — login/session handling for `/login`
- `utils.ts` — misc shared helpers

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
- **CrudeOil Mini Supertrend** (`strategies/crudeoil/`): directional MCX CRUDEOILM futures strategy — buys/sells the nearest futures contract on Supertrend confirmation, trails SL via the Supertrend band, daily profit/loss caps, default 09:00–23:30 IST session covering both MCX sessions. See `strategies/crudeoil/strategy.md` for full logic.
- **CrudeOil Mini Renko SAR** (`strategies/crudeoil/crudeoilm_renko_sar.py`): always-in stop-and-reverse on close-only Renko bricks from 5-min candles (default 5-pt box, 2×box reversal rule); flips after 3 consecutive opposite bricks; no daily P&L caps, EOD flatten at 23:30. See `strategies/crudeoil/strategy.md` for full logic.

## Environment

Required in `.env` (at project root):
```
client_id=...
api_key=...
api_secret=...
```

Token is cached to `access_token.json` and reused until `expiryTime`. Run `login.py` to refresh it.
