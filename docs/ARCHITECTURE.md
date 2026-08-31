# Architecture Reference

Full directory layout, DhanHelper internals, the strategy/dashboard state bridge,
and the Next.js dashboard's non-obvious route/lib behaviors. Read this when you
need to orient in a part of the codebase you haven't touched yet — not required
for routine edits to a file you already know.

## Python Backend

```
login.py                    # OAuth flow + token caching (access_token.json)
lib/
  dhan_helper.py            # Core DhanHelper class — all strategies use this
  execution_broker.py       # ExecutionBroker front (dhan/zerodha/kotak) for option strategies
  strategy_risk.py          # resolve_exit_qty / resolve_exit_qty_broker safe exit sizing
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

Key method families (see [AGENT_FUNCTION_REFERENCE.md](AGENT_FUNCTION_REFERENCE.md) for full reference):
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
- `copy-trade/` — start/stop/status UI for `scripts/tools/copy_trade_bridge.py` (the Multi-broker copy-trade bridge, see [MULTIBROKER.md](MULTIBROKER.md)): POST `{action:"start"}` spawns it detached, POST `{action:"stop"}` writes `debug/copy_trade_stop.trigger`, GET reports RUNNING/STARTING/STALE/STOPPED off a 20s heartbeat staleness check against `debug/copy_trade_status.json`.
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
