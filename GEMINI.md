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
