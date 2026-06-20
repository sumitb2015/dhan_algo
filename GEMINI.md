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

## Strategy Phases

The strategy operates in five distinct phases to manage the lifecycle of a straddle.

### Phase 1: Initialization & ATM Selection
- Fetches the current Nifty spot price.
- Identifies the nearest ATM strike (e.g., if Nifty is 24063, ATM is 24050).
- Resolves the specific CE and PE contract IDs and fetches current lot sizes.

### Phase 2: Balanced Entry
- The strategy **waits** and does not enter immediately.
- Monitors the premium of the selected CE and PE.
- Entry is triggered only when the premium difference between the two is **< 10%**.
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

All commands must be run from the project root (`c:\dhan_algo\dhan_algo`) using the **venv Python interpreter**.

### Quick-start: activate venv (one-time per terminal session)
```powershell
# Activate the virtual environment
c:\dhan_algo\dhan_algo\venv\Scripts\activate
```
After activation, you can use plain `python` instead of the full path.

---

### 1. Nifty Value-Imbalance Strangle (`strategies/nifty_value_imbalance_strangle.py`)

#### Default dry-run (safe — no real orders)
```powershell
# 200-pt symmetric strangle, 1 lot per leg, dry run
venv\Scripts\python.exe strategies/nifty_value_imbalance_strangle.py
```

#### LIVE trading — distance mode (fixed point offset from spot)
```powershell
# 200-pt symmetric, 1 lot — LIVE
venv\Scripts\python.exe strategies/nifty_value_imbalance_strangle.py --live

# Wider 300-pt, 2 lots — LIVE
venv\Scripts\python.exe strategies/nifty_value_imbalance_strangle.py --live --lots 2 --ce-offset 300 --pe-offset 300

# Asymmetric: tighter CE (150 pts), wider PE (300 pts) — LIVE
venv\Scripts\python.exe strategies/nifty_value_imbalance_strangle.py --live --ce-offset 150 --pe-offset 300
```

#### LIVE trading — delta mode (strike chosen by target delta)
```powershell
# Standard ~1 SD strangle (delta 0.20) — LIVE
venv\Scripts\python.exe strategies/nifty_value_imbalance_strangle.py --live --delta --target-delta 0.20

# Wider/safer strangle (delta 0.15), 2 lots — LIVE
venv\Scripts\python.exe strategies/nifty_value_imbalance_strangle.py --live --lots 2 --delta --target-delta 0.15

# Aggressive near-ATM (delta 0.30) — LIVE
venv\Scripts\python.exe strategies/nifty_value_imbalance_strangle.py --live --delta --target-delta 0.30
```

#### Custom risk targets
```powershell
# 2 lots, profit target ₹6000, stop loss ₹3000 — LIVE
venv\Scripts\python.exe strategies/nifty_value_imbalance_strangle.py --live --lots 2 --target-profit 6000 --stop-loss 3000
```

#### Full CLI reference
| Flag | Default | Description |
|---|---|---|
| `--live` | off (dry run) | Enable real order placement |
| `--lots N` | `1` | Initial lots per leg |
| `--delta` | off | Use delta-based strike selection |
| `--distance` | on | Use fixed-point offset (default) |
| `--ce-offset PTS` | `200` | Points above spot for CE strike |
| `--pe-offset PTS` | `200` | Points below spot for PE strike |
| `--target-delta D` | `0.20` | Target absolute delta in delta mode |
| `--target-profit AMT` | `4000` | Global profit target in ₹ |
| `--stop-loss AMT` | `4000` | Global stop loss in ₹ |

---

### 2. Nifty Advanced Value-Imbalance Straddle & Strangle (`strategies/nifty_advanced_imbalance.py`)

Implements the core value-imbalance logic with four selectable adjustment modes designed to optimize yields and manage tail risk, supporting both **Straddle** and **Strangle** entries.

#### Selectable Modes
* **`winner_roll_atm`** (Default): Rolls the untested winner leg closer to the spot ATM strike, keeping a flat 1:1 lot ratio (eliminating margin inflation).
* **`loser_ratio_roll`**: Rolls the challenged loser leg further OTM and increments quantity (ratio spread) to maintain premium collections safely.
* **`hedged_addition`**: Adds short lots to the winner leg (like legacy) but buys further OTM wings (200 pts out) to hedge against market whipsaws.
* **`legacy`**: Original unhedged winner lot addition strategy.

#### Default dry-run execution
```powershell
# Straddle Entry, Winner Roll ATM mode, 1 lot, dry run
venv\Scripts\python.exe strategies/nifty_advanced_imbalance.py --entry-type straddle --mode winner_roll_atm

# Strangle Entry (Distance), Hedged Addition mode, 1 lot, dry run
venv\Scripts\python.exe strategies/nifty_advanced_imbalance.py --entry-type strangle --ce-offset 150 --pe-offset 250 --mode hedged_addition

# Strangle Entry (Delta), Winner Roll ATM mode, 1 lot, dry run
venv\Scripts\python.exe strategies/nifty_advanced_imbalance.py --entry-type strangle --delta --target-delta 0.15 --mode winner_roll_atm
```

#### LIVE trading execution
```powershell
# Live Straddle execution with 2 lots using winner roll ATM adjustment
venv\Scripts\python.exe strategies/nifty_advanced_imbalance.py --live --lots 2 --entry-type straddle --mode winner_roll_atm

# Live Strangle (Delta) execution with 2 lots using loser ratio rolling
venv\Scripts\python.exe strategies/nifty_advanced_imbalance.py --live --lots 2 --entry-type strangle --delta --target-delta 0.20 --mode loser_ratio_roll --target-profit 5000 --stop-loss 3000
```

#### Full CLI reference
| Flag | Default | Description |
|---|---|---|
| `--live` | off (dry run) | Enable real order placement |
| `--lots N` | `1` | Initial lots per leg |
| `--mode MODE` | `winner_roll_atm` | Adjustment mode (`winner_roll_atm`, `loser_ratio_roll`, `hedged_addition`, `legacy`) |
| `--entry-type TYPE`| `straddle` | Selects entry position type (`straddle`, `strangle`) |
| `--delta` | off | Use delta-based strike selection for strangle |
| `--target-delta D` | `0.20` | Target absolute delta in delta strangle mode |
| `--ce-offset PTS` | `200` | Points above spot for CE strike in distance strangle |
| `--pe-offset PTS` | `200` | Points below spot for PE strike in distance strangle |
| `--target-profit AMT` | `4000.0` | Global profit target in ₹ |
| `--stop-loss AMT` | `4000.0` | Global stop loss in ₹ |

---

### 3. Live Options Tracker (`scripts/tools/live_options_tracker.py`)

Opens an Excel workbook with 4 live sheets: **Live Options**, **Dashboard**, **Options Chain**, **Order Log**.

```powershell
# Start the live tracker (opens Excel automatically)
venv\Scripts\python.exe scripts/tools/live_options_tracker.py
```

- Stop with **Ctrl+C** in the terminal — the Excel file stays open.
- Requires Excel to be installed and xlwings addin to be configured.

---

### 4. Login / Token Refresh (`login.py`)

Run this first if the access token has expired (usually after 24 hours):
```powershell
venv\Scripts\python.exe login.py
```
