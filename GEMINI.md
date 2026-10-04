# Project Instructions: Dhan Algo Trading

This file contains architecture, conventions, and key learnings for the Dhan Algo Trading project.

## Architecture & Conventions

### DhanHelper Usage
- **Method Choice**: Prefer `get_ltp()` over the simplified `ltp()` wrapper. 
    - `ltp()` is a simplified alias and may not support all keyword arguments like `instrument` or `exchange`.
    - `get_ltp()` is the core method and should be used for production strategy logic.
- **Argument Naming**: Always use `exchange` (e.g., "NSE", "IDX_I", "NSE_FNO") as the keyword argument in `get_ltp()`. 
    - **ERROR REFERENCE**: Do NOT use `exchange_segment=`. This will cause a `TypeError`.
- **Lookups**: Explicitly pass `instrument` (e.g., "INDEX", "EQUITY", "FUTIDX", "OPTIDX") to avoid the helper defaulting to "EQUITY" and triggering "Security not found" warnings.
- **Numeric Symbol Resolution**: The helper's `get_security_id` resolves numeric identifiers (e.g., option ID `"56380"`) directly against the `SECURITY_ID` column. There is no need to query by name or handle exception blocks for these lookups.
- **Dynamic Lot Sizes via `get_lot_size`**: Use `helper.get_lot_size(symbol)` to fetch the actual lot size dynamically from the master list. It automatically checks the type of the resolved security; if the security is an `INDEX` (e.g., `"NIFTY"`), the function queries its associated derivative contracts (options/futures) to return the correct option lot size (e.g., `65`), instead of the index placeholder value of `1`.
- **Previous Day Key Levels via `get_prev_day_levels`**: Use `helper.get_prev_day_levels(symbol)` to fetch PDH, PDL, and PDC for any index or equity in a single call. It resolves the symbol automatically (no need to look up security IDs or set `exchange_segment` / `instrument_type` manually), normalizes column names from the API response, and logs a formatted banner. Returns a `dict` with `'high'`, `'low'`, `'close'` float keys, or `None` on failure. Strategy code should store the result at startup and fall back gracefully when `None`.
    ```python
    levels = helper.get_prev_day_levels("NIFTY")   # also works for "BANKNIFTY", "RELIANCE", etc.
    if levels:
        pdh, pdl, pdc = levels["high"], levels["low"], levels["close"]
    ```
    - **Do NOT** inline your own `get_historical_data()` calls to fetch PDH/PDL/PDC — use this method instead.
    - The `days_back` parameter (default `5`) controls how many calendar days to look back, ensuring data availability across long weekends and exchange holidays.
- **Technical Indicators via `pandas_ta`**: Use `helper.calculate_ta_indicators(df, indicators)` or `helper.get_indicators_ta(symbol, interval, indicators, days)` to perform technical analysis.
    - It leverages `pandas_ta` to calculate indicators on standard OHLCV DataFrames.
    - Columns are normalized dynamically, and computed indicator columns are cleanly appended.
    ```python
    # Fetch candles and calculate EMA and RSI in a single call
    df = helper.get_indicators_ta(
        symbol="NIFTY",
        interval="15",
        indicators=["EMA9", "RSI14", "MACD", "BB"],
        days=5
    )
    # The resulting DataFrame contains:
    # 'Open', 'High', 'Low', 'Close', 'Volume', 'EMA_9', 'RSI_14', 'MACD_12_26_9', etc.
    ```
    - Detailed configurations can also be passed as dictionaries for full param customization:
    ```python
    df = helper.get_indicators_ta(
        symbol="RELIANCE",
        indicators=[
            {"kind": "supertrend", "period": 7, "multiplier": 3.0},
            {"kind": "rsi", "length": 14}
        ]
    )
    ```



### WebSocket & Live Data
- **Stable Connection**: Always use `feed.run()` to start the WebSocket. 
    - **ERROR REFERENCE**: Do NOT use `feed.run_forever()`. It returns immediately in the current SDK version, causing a reconnection loop.
- **Background Threading**: `DhanHelper.start_websocket()` automatically manages a background thread with a singleton lock (`_ws_lock`).
- **Rate Limit Handling**: The helper implements a **30-second backoff** specifically for **HTTP 429** (Too Many Requests) errors.
- **Latency**: Use the `helper.live_data` dictionary for sub-second price updates. It is prioritized over REST API calls in `get_ltp()`.

### API Efficiency & Rate Limiting
- **Redundant Calls**: Fetch LTPs once per loop iteration and pass them as variables to P&L and logging functions.
- **Caching**: `DhanHelper` implements a 1-second memory cache for `get_ltp()` to protect against rate limits during rapid polling.
- **WebSocket**: The `live_data` dictionary (updated via WebSocket) is the highest priority source for prices.
- **Responsiveness**: Ensure no blocking `time.sleep()` calls exist within the `lib/` methods. Control polling frequency exclusively within the strategy's `while` loop.

## Troubleshooting & Key Learnings

### Symbol Resolution Errors
- **Nifty 50 Index**:
    - **Symbol**: Use `"NIFTY"` (Master list primary name), not `"NIFTY 50"`.
    - **Instrument**: Must be `"INDEX"`.
    - **Exchange**: Must be `"IDX_I"`.
    - **Warning**: "Security not found for NIFTY 50 (EQUITY)" indicates a missing `instrument="INDEX"` argument.
- **Bank Nifty Index**:
    - **Symbol**: Use `"BANKNIFTY"`.
    - **Exchange**: Must be `"IDX_I"`.
- **Exchange Mismatch (IDX_I vs NSE)**: The Dhan master list lists index records under the `"NSE"` exchange. When retrieving the index from the master list using `find_index(symbol, exchange="IDX_I")`, the helper internally maps `"IDX_I"` to `"NSE"` to ensure successful lookup without triggering `"Security not found"` warnings.


### Lot Size Handling
- **Dynamic Lot Sizes**: Always fetch the lot size from the contract's `CONTRACT_INFO` after resolving the security ID, rather than relying on hardcoded defaults.
    - Example: `nifty_lot_size = int(ce_quote['CONTRACT_INFO'].get('LOT_SIZE', 50))`
- **Nifty Lot Size**: Be aware that Nifty lot sizes can change (e.g., from 50 to 25 or 75). The code must handle this dynamically.

### Method Signature & TypeErrors
- **TypeError: DhanHelper.ltp() got an unexpected keyword argument 'instrument'**: 
    - Cause: Attempting to pass `instrument` to the simplified `ltp()` wrapper.
    - Fix: Change call to `get_ltp()`.
- **TypeError: DhanHelper.get_ltp() got an unexpected keyword argument 'exchange_segment'**:
    - Cause: Using `exchange_segment=` instead of `exchange=`.
    - Fix: Standardize on `exchange=`.

### API Response Anomalies
- **Empty Failure Remarks**: `{'status': 'failure', 'remarks': {'error_code': None, ...}}`
    - Often indicates a network timeout or an empty response from the broker during high-frequency polling.
    - Resolution: Reduced polling frequency to once per second and implemented a **2-second mandatory delay** for REST fallbacks when WebSocket is disconnected to prevent hitting the 120-250 calls/min limit.

### WebSocket Issues
- **Problem**: WebSocket reconnecting every 10 seconds with "Task was destroyed" errors.
- **Cause**: Incorrect use of `run_forever()` instead of `run()`.
- **Fix**: Switch to `feed.run()` in the background thread.

## Strategy Thresholds & Risk Management

The `ValueImbalanceStrategy` relies on several key thresholds to manage risk and performance.

### Adjustment Triggers
- **Lot Addition Threshold (`threshold_lot`)**: Default **25%**. 
    - Triggered when the value difference between CE and PE exceeds this threshold (adjusted by the initial entry imbalance).
    - Result: Adds 1 lot to the "Winner" (cheaper) side.
- **Strike Adjustment Threshold (`threshold_strike`)**: Default **40%**.
    - Triggered when the imbalance exceeds this limit and the strategy is already at `max_lots`.
    - Result: Shifts the "Loser" (expensive) leg to a further OTM strike.
- **Rebalance Frequency**: Limited to **once per minute** to avoid whipsaws in volatile markets.

### Position Limits
- **Max Lots**: Default **4 lots per leg**. Prevents excessive margin usage and over-exposure.
- **Initial Lots**: Typically **1 or 2 lots** per leg.

### Global Exit Rules & Scalp Locks
- **Scalp Lock / Premium Floor Exit (`--scalp-floor-pct`)**: Default **0.0%** (disabled). Exits all legs immediately when combined option premium decays by the target % (e.g. 30.0% decay captured).
- **Multi-Cycle Mode (`--multi-cycle`)**: Auto-restarts a fresh ATM cycle after a Scalp Lock or profit target exit, with a configurable `--cycle-cooldown` (default: 300s / 5m). Re-entry is strictly disabled on Stop Loss hits.
- **Profit Target**: Default **+₹4,000**. Hard exit once reached.
- **Stop Loss**: Default **-₹4,000**. Hard exit once reached.
- **Intraday Auto-Exit**: Fixed at **15:17 (3:17 PM)**. Ensures all positions are squared off before broker-level auto-square-off.

### Strangle Inversion Prevention
- **Inverted Strike Prevention**: Strangle strategies strictly enforce `CE strike > PE strike`.
  - **Initial Selection**: If the selected CE strike is equal to or less than the PE strike, the strategy logs a warning and bypasses the cycle entry.
  - **Rebalance Roll Adjustments**: If a required winner ATM roll or loser OTM roll would cause the strikes to cross or touch, the strategy triggers an **emergency exit** (squares off all active legs), pauses for 5 minutes (300 seconds), and restarts a fresh strangle cycle at the new spot.

## Strategy Phases

The strategy operates in five distinct phases to manage the lifecycle of a straddle.

### Phase 1: Initialization & ATM Selection
- Fetches the current Nifty spot price.
- Identifies the nearest ATM strike (e.g., if Nifty is 24063, ATM is 24050).
- Resolves the specific CE and PE contract IDs and fetches current lot sizes.

### Phase 2: Balanced Entry
- The strategy **waits** and does not enter immediately.
- Monitors the premium of the selected CE and PE.
- Entry is triggered only when the premium difference between the two is **< 15%**.
- This ensures the trade starts with a neutral Delta.

### Phase 3: Value Balancing (Lot Addition)
- If the market moves and the value imbalance exceeds **25%** (plus initial imbalance):
    - The strategy adds 1 lot to the **Winner** (the leg that has decreased in value).
    - This increases the Theta (decay) collection on the cheaper side to offset the losing side's move.
    - Continues until `max_lots` (Default 4) is reached.

### Phase 4: Single-Leg Strike Adjustment
- If `max_lots` are reached and the imbalance exceeds **40%**:
    - The strategy shifts the **Loser** (the leg that has increased in value) to a further OTM strike.
    - The target strike is chosen such that `New_Lots * New_Price` matches the current value of the winning leg.
    - This "resets" the risk of the losing leg without closing the entire trade.

### Phase 5: Straddle Shift (Cycle Reset)
- If the Nifty spot moves **> 100 points** away from the original entry strike:
    - The entire straddle is considered "dead" or too deep ITM/OTM.
    - The strategy **exits all positions** (CE and PE).
    - It triggers a **5-minute pause** and then restarts from **Phase 1** at the new ATM.
    - This prevents holding ITM options with low decay and high price sensitivity.

---

## Running Strategies & Tools

All commands run from the project root (`c:\dhan_algo\dhan_algo`) using `venv\Scripts\python.exe`.  
Full CLI references, parameter explanations, and examples live in each strategy folder:

| Strategy folder | Documentation |
|---|---|
| `strategies/value_imbalance/` | [`strategy.md`](strategies/value_imbalance/strategy.md) — Advanced imbalance, legacy straddle/strangle, VWAP straddle, delta-neutral (0.5 delta) |
| `strategies/spread_trend/` | [`strategy.md`](strategies/spread_trend/strategy.md) — Trend-following vertical spread |
| `strategies/st_oi_bearcall/` | [`strategy.md`](strategies/st_oi_bearcall/strategy.md) — Dual Supertrend (index + option) + OI short-buildup bear call spread |
| `strategies/oi_directional/` | [`strategy.md`](strategies/oi_directional/strategy.md) — OI-diff/PCR naked option sell |
| `strategies/crudeoil/` | [`strategy.md`](strategies/crudeoil/strategy.md) — CRUDEOILM Supertrend, Renko stop-and-reverse, VWAP+Supertrend, EMA+Supertrend, and pivot-gated ORB futures |
| `strategies/intraday_equity/` | [`strategy.md`](strategies/intraday_equity/strategy.md) — Nifty-50 cash VWAP+RS auto-trader (NOT VALIDATED, dry-run only) |
| `strategies/momentum_investing/` | [`strategy.md`](strategies/momentum_investing/strategy.md) — Nifty-500 positional (CNC) relative-strength momentum portfolio |
| `strategies/adaptive_strangle/` | [`strategy.md`](strategies/adaptive_strangle/strategy.md) — Bi-weekly far-OTM strangle with conditional Delta/Vega hedging & directional conversion |
| `strategies/diagonal_call/` | [`strategy.md`](strategies/diagonal_call/strategy.md) — Delta-controlled, low-gamma diagonal covered call (60-120 DTE long CE + 25-45 DTE short CE) |

### Quick-start

```powershell
# Activate venv (once per terminal session)
c:\dhan_algo\dhan_algo\venv\Scripts\activate
```

### Strategy commands & parameter tables

**Nifty Flyagonal** (`strategies/flyagonal/nifty_flyagonal.py`, NOT VALIDATED, dry-run default; `--live` places real orders). Call BWB + put diagonal, positional `MARGIN`. Full flag list and defaults in `strategies/flyagonal/strategy.md` §10; tests `venv/bin/python tests/test_flyagonal.py`.

**Nifty Volcano Calendar** (`strategies/volcano_calendar/nifty_volcano_calendar.py`, UNVALIDATED — no backtest, no losing-month example in its source evidence; dry-run default; `--live` requires `--i-understand-this-is-unvalidated`). Monthly-hold 5-leg combo: Put Butterfly (1×2×1: buy ATM PE, sell 2× ATM−400 PE, buy 1× ATM−800 PE) + Call Calendar (sell ATM+300 CE on the current monthly expiry, buy the same strike on a further monthly expiry — `--far-expiry {next-month,two-months}`). Entry once per month on the last trading Friday at `--entry-time` (default 15:16). Exit on a flat `--target-profit`/`--stop-loss` (default 2%/2%, resolved against **deployed margin**, not entry premium) or at the near leg's expiry-day EOD; otherwise held untouched with zero adjustment. Product `MARGIN`. Full flag list and defaults in `strategies/volcano_calendar/strategy.md`; research trail in the Obsidian vault's `wiki/strategies/volcano-calendar.md` (stage `analysed`).

```
python strategies/volcano_calendar/nifty_volcano_calendar.py [--live --i-understand-this-is-unvalidated]
    [--lots N] [--wing-points N] [--ce-offset-points N] [--strike-step N]
    [--far-expiry {next-month,two-months}]
    [--target-profit INR|%] [--stop-loss INR|%] [--fallback-margin-per-lot INR]
    [--entry-time HH:MM] [--entry-window-min MIN] [--eod-exit-time HH:MM]
    [--max-consecutive-stops N] [--instance-id ID] [--broker {dhan,zerodha,kotak}]
```

**Nifty Put Condor** (`strategies/put_condor/nifty_put_condor.py`, UNVALIDATED — no backtest, one static worked example in its source evidence; dry-run default; `--live` requires `--i-understand-this-is-unvalidated`). Monthly-hold 4-leg puts-only condor (BUY/SELL/SELL/BUY by strike, described in the source as two stacked bear put spreads): buy PE at spot−`--upper-long-offset` (default 150), sell PE at spot−`--upper-short-offset` (350), sell PE at spot−`--lower-short-offset` (550), buy PE at spot−`--lower-long-offset` (700), all rounded to `--strike-step` (default 50). One cycle per monthly expiry: when flat, enters the first monthly expiry with DTE in `--min-dte`..`--max-dte` (default 20..38), skipping the one last traded, between `--entry-time` and `--entry-end` (default 09:45-15:00). Exit order: full `--target-profit`/`--stop-loss` (default 10%/4% of deployed margin, resolved once at entry), expiry-day EOD, then a one-time partial booking of half the entry lots (`--lots >= 2` only) at `--partial-booking-profit` (default 2.5%); all exits close shorts before longs; otherwise held untouched with zero adjustment. Product `MARGIN`. Full flag list and defaults in `strategies/put_condor/strategy.md`.

```
python strategies/put_condor/nifty_put_condor.py [--live --i-understand-this-is-unvalidated]
    [--lots N] [--strike-step N]
    [--upper-long-offset PTS] [--upper-short-offset PTS]
    [--lower-short-offset PTS] [--lower-long-offset PTS]
    [--partial-booking-profit INR|%] [--target-profit INR|%] [--stop-loss INR|%]
    [--fallback-margin-per-lot INR] [--min-dte DAYS] [--max-dte DAYS]
    [--entry-time HH:MM] [--entry-end HH:MM] [--eod-exit-time HH:MM]
    [--max-consecutive-stops N] [--instance-id ID] [--broker {dhan,zerodha,kotak}]
```

**Nifty Iron Condor to Ratio Spread** (`strategies/condor_to_ratio/nifty_condor_ratio.py`, UNVALIDATED — dry-run default; `--live` requires `--i-understand-this-is-unvalidated`). Starts with a neutral monthly Iron Condor (sell 0.30 delta CE & PE, buy 0.10 delta CE & PE hedges). When a short leg decays to `<= 0.10` delta, transitions directly into a directional Ratio Spread: Call Ratio Spread if downward move (buy 0.50 delta call, sell 2x 0.40 delta calls, buy 0.10 delta call hedge) or Put Ratio Spread if upward move (buy 0.50 delta put, sell 2x 0.40 delta puts, buy 0.10 delta put hedge). If trend continues, shifts to less aggressive strikes (buy 0.40, sell 2x 0.30, buy 0.08 hedge) when sold leg delta drops to `<= 0.20` combined. If market sharply reverses, flips to opposite side when sold leg delta expands to `>= 1.20` combined. Product `MARGIN`. Full flag list and defaults in `strategies/condor_to_ratio/strategy.md`.

```
python strategies/condor_to_ratio/nifty_condor_ratio.py [--live --i-understand-this-is-unvalidated]
    [--lots N] [--condor-short-delta D] [--condor-hedge-delta D] [--condor-exit-delta D]
    [--ratio-long-delta D] [--ratio-short-delta D] [--ratio-hedge-delta D]
    [--ratio-shift-delta D] [--ratio-reversal-delta D]
    [--shift-long-delta D] [--shift-short-delta D] [--shift-hedge-delta D]
    [--max-shifts N] [--max-reversals N]
    [--target-profit INR|%] [--stop-loss INR|%] [--trail-start-rs INR] [--trail-gap-rs INR]
    [--expiry-type {monthly,nearest}] [--min-dte DAYS] [--max-dte DAYS]
    [--start-time HH:MM] [--entry-end HH:MM] [--eod-exit-time HH:MM]
    [--product {MARGIN,INTRADAY}] [--instance-id ID] [--broker {dhan,zerodha,kotak}]
```

**Nifty Bi-Weekly Adaptive Strangle** (`strategies/adaptive_strangle/nifty_adaptive_strangle.py`, dry-run default; `--live` places real orders). Sells far-OTM Nifty strangles on the 2nd weekly expiry (~8–15 DTE) at low delta (~0.10) with zero upfront hedge drag. Dynamically buys protective OTM wings on Greek threat triggers (short leg delta reaches `>= 0.22` or IV/Vega surge `>= 20%`). Optionally converts into a directional vehicle (`--enable-directional-conversion`) on confirmed Nifty index trends (`delta >= 0.30` + trend filter), harvesting winning decayed credit to fund the directional spread. Product `MARGIN`. Full flag list and defaults in `strategies/adaptive_strangle/strategy.md`.

```
python strategies/adaptive_strangle/nifty_adaptive_strangle.py [--live]
    [--lots N] [--entry-delta D] [--hedge-delta-trigger D] [--hedge-target-delta D]
    [--vega-surge-pct PCT] [--enable-directional-conversion]
    [--conversion-delta-trigger D] [--conversion-style {spread,ratio}]
    [--target-profit INR|%] [--stop-loss INR|%] [--trail-start-rs INR] [--trail-gap-rs INR]
    [--entry-time HH:MM] [--entry-end HH:MM] [--eod-exit-time HH:MM]
    [--product {MARGIN,INTRADAY}] [--instance-id ID] [--broker {dhan,zerodha,kotak}]
```

**Nifty Low-Gamma Diagonal Covered Call** (`strategies/diagonal_call/nifty_diagonal_call.py`, dry-run default; `--live` places real orders). Long-dated calls (60–120 DTE, 0.55–0.65 delta) provide convexity + vega. Medium-dated calls (25–45 DTE, 0.15–0.22 delta) provide theta. Sized dynamically from delta; short options selected by maximizing `Score = Theta / |Gamma|`. Normal delta zone: 0 to +20; defensive: < -40; gamma target: > -0.15; emergency halt: < -0.20. Product `MARGIN`. Full flag list and defaults in `strategies/diagonal_call/strategy.md`.

```
python strategies/diagonal_call/nifty_diagonal_call.py [--live]
    [--long-lots N] [--target-net-delta UNITS] [--long-target-delta D]
    [--long-min-dte DAYS] [--long-max-dte DAYS] [--long-roll-dte DAYS]
    [--short-target-delta D] [--short-min-dte DAYS] [--short-max-dte DAYS]
    [--short-roll-dte DAYS] [--short-roll-delta D] [--short-profit-pct PCT]
    [--capital INR] [--daily-loss-pct PCT] [--drawdown-halve-pct PCT] [--drawdown-exit-pct PCT]
    [--target-profit INR|%] [--stop-loss INR|%] [--start-time HH:MM]
    [--rebalance-times "10:00,12:00,14:00"] [--max-short-ratio RATIO] [--min-gamma-limit G]
    [--instance-id ID] [--broker {dhan,zerodha,kotak}]
```

See the per-folder `strategy.md` files linked in the table above. Each file contains full CLI flag tables, parameter tuning guidance, dry-run and live examples, and worked trade scenarios.

---

### Live Options Tracker (`scripts/tools/live_options_tracker.py`)

Opens an Excel workbook with 4 live sheets: **Live Options**, **Dashboard**, **Options Chain**, **Order Log**.

```powershell
# Start the live tracker (opens Excel automatically)
venv\Scripts\python.exe scripts/tools/live_options_tracker.py
```

- Stop with **Ctrl+C** in the terminal — the Excel file stays open.
- Requires Excel to be installed and xlwings addin to be configured.

---

### Login / Token Refresh (`login.py`)

Run this first if the access token has expired (usually after 24 hours):
```powershell
venv\Scripts\python.exe login.py
```

---

## Dashboard UI Conventions

### Dark-Mode Font Color Opacity (`rs_dashboard`)

All text in the `rs_dashboard` Next.js app must use the following opacity tiers so that text is always readable against the dark (`#080b14` / `#0a0e1a`) background:

| Role | Value | Usage |
|---|---|---|
| **Primary text** | `rgba(255,255,255,0.85)` | Headings, active labels, key values |
| **Secondary text** | `rgba(255,255,255,0.60)` | Sub-labels, group headers (SYMBOL / INDICATORS / VIEW), sidebar section titles |
| **Tertiary / muted text** | `rgba(255,255,255,0.40)` | Placeholders, timestamps, disabled states |
| **Disabled / decorative** | `rgba(255,255,255,0.20)` | Dividers, empty-state hints |

**Rules:**
- **Never use raw Tailwind/CSS gray shades** (e.g. `#374151`, `#4b5563`) for visible text — they are too dark on the project's near-black backgrounds and will fail contrast checks.
- Use `rgba(255,255,255,N)` (white with opacity) rather than a fixed hex gray, so the contrast automatically adapts if the background changes.
- Accent-coloured text (`#a5b4fc`, `#34d399`, `#f87171`, etc.) is exempt — those colours already encode sufficient luminance.

---

## Options Backtesting & Past Runs Architecture

### Historical Data Store
- **Store**: `Options Data/nifty_options.db` (SQLite, 7.60 GB, 22,213,440 rows, 298 expiries, 1,418 trading days from 2021-01-07 to 2026-09-22).
- **Strike Coverage**: 21 relative strikes (`ATM`, `ATM±1` to `ATM±10`, ±500 pts). Spot, Volume, OI, and IV available at 1-minute resolution.

### Regulatory & Quant Invariants
- **SEBI 2025 Tuesday Expiry**: In 2025 onwards, SEBI shifted NIFTY weekly index derivative expiries from Thursdays to Tuesdays. Backtesting scripts dynamically compute DTE via `(expiry - day).days == 0`. In backtesting, Tuesday 0-DTE is net profitable (+₹6.4k), while Wednesday and Thursday (4–5 DTE) bleed (-₹19.2k) due to sluggish theta decay failing to cover 40-pt SL hits and high STT.
- **Realistic Dhan F&O Friction Model**: Calibrated against 4,155 real Dhan broker trades (`debug/portfolio_trade_history.json`). Average friction is **~₹50.14 per executed order**:
  - Brokerage: ₹20 / order + 18% GST (₹3.60)
  - STT: **0.10% on option SELL premium turnover**
  - NSE Exchange Fee: 0.053% on premium turnover + GST
  - Stamp Duty + SEBI Fee: ₹3/cr

### Structured Run Archival (`debug/backtests/options/<id>/`)
Backtest results are never overwritten. Every completed simulation is archived in its own directory:
- `metadata.json`: Lightweight summary KPIs for fast listing.
- `result.json`: Full `BacktestResult` payload (summary, cycles, equity curve, monthly heatmap, params).
- `trades.csv`: Full cycle-by-cycle trade ledger with prices, P&L, slippage, and taxes.
- `tearsheet.html`: Standalone interactive HTML dashboard via OpenStatz (`ostz.dashboard`).
- `scans_summary.json`: Multi-parameter sensitivity scan grids and heatmaps.

### Dashboard Integration (`OptionsBacktester.tsx` & `/api/backtest/history`)
- **Auto-Archiving**: Every simulation run from the dashboard is automatically archived upon completion.
- **History Modal**: Searchable "Past Backtests" drawer/modal allowing operators to search runs, load parameters and results directly into performance charts, open interactive tearsheets, and download trades CSVs.
- **Detailed Features & Quirks Guide**: See [`docs/OPTIONS_BACKTESTER_GUIDE.md`](docs/OPTIONS_BACKTESTER_GUIDE.md) for full documentation on Re-Entry vs Re-Execute, Range Breakout, Positional multi-day holding, Protect Profits (Lock & Trail), gap-at-open slippage, and dynamic DTE.

