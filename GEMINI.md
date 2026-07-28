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

### Global Exit Rules
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
| `strategies/value_imbalance/` | [`strategy.md`](strategies/value_imbalance/strategy.md) — Advanced imbalance, legacy straddle/strangle, VWAP straddle |
| `strategies/expiry/` | [`strategy.md`](strategies/expiry/strategy.md) — 0DTE expiry strategy |
| `strategies/spread_trend/` | [`strategy.md`](strategies/spread_trend/strategy.md) — Trend-following vertical spread |
| `strategies/st_oi_bearcall/` | [`strategy.md`](strategies/st_oi_bearcall/strategy.md) — Dual Supertrend (index + option) + OI short-buildup bear call spread |
| `strategies/crudeoil/` | [`strategy.md`](strategies/crudeoil/strategy.md) — CRUDEOILM Supertrend & Renko stop-and-reverse futures |

### Quick-start

```powershell
# Activate venv (once per terminal session)
c:\dhan_algo\dhan_algo\venv\Scripts\activate
```

### Strategy commands & parameter tables

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
