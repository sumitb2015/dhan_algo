# DhanHelper Core Library - API Documentation

This document provides a detailed reference for all functions available in the `DhanHelper` class within `lib/dhan_helper.py`. This library abstracts the complex DhanHQ SDK into high-level, strategy-ready functions.

---

## 1. Initialization & Core
### `DhanHelper(dhan_client)`
Initializes the helper with an active Dhan SDK client. Automatically loads/downloads the `master_list.csv` and validates the session.

### `validate_session()`
Checks if the current session is active. Returns `True` if valid.

---

## 2. Security & Symbol Resolution
### `find_equity(symbol, exchange='NSE')`
Finds an Equity instrument by symbol. Returns a dictionary of security details.

### `find_index(symbol, exchange='NSE')`
Finds an Index instrument (e.g., "NIFTY", "BANKNIFTY"). 

### `find_future(underlying, expiry=None, ...)`
Finds a Future contract for the given underlying and expiry.

### `find_option(underlying, expiry, strike, option_type, ...)`
Finds an Option contract by parameters. `option_type` is "CE" or "PE".

---

## 3. Market Data (Snapshot)
### `get_ltp(symbol, ...)`
Fetches the Last Traded Price. Smart-resolves symbols for Equities, Indices, and Derivatives.

### `get_ohlc(symbol, ...)`
Fetches Open, High, Low, Close for a symbol.

### `bulk_ltp(symbols)`
Fetches LTP for multiple symbols at once (optimized).

---

## 4. Market Data (Historical & Candles)
### `get_latest_candles(symbol, interval='5', days=5)`
Fetches historical or intraday candles and returns a clean Pandas DataFrame with columns: `Open`, `High`, `Low`, `Close`, `Volume` and `Datetime` index.
- **Intervals**: "1", "5", "15", "25", "60", "D".

### `get_historical_data(security_id, exchange_segment, instrument_type, from_date, to_date, interval='DAILY')`
Direct access to historical data API.

---

## 5. Technical Indicators
### `get_indicators(symbol, interval='5', indicators=['EMA20', 'RSI14'], days=5)`
Fetches candles and appends requested indicators to the DataFrame.
- **Supported**: `EMA` (any period), `SMA` (any period), `RSI` (any period), `ATR` (any period).
- **Example**: `helper.get_indicators("TCS", indicators=['EMA20', 'EMA50', 'RSI14'])`.

---

## 5. Options & F&O Specials
### `get_lot_size(symbol)`
Fetches the tradable lot size for a symbol. Automatically returns `1` for Equities.

### `get_expiries(symbol)`
Returns a chronologically sorted list of available expiry dates for an underlying.

### `get_nearest_expiry(symbol)`
Convenience method to get the closest upcoming expiry date.

### `days_to_expiry(symbol)`
Returns the number of days until the nearest expiry (integer). `0` means today is expiry day.

### `select_strike(ltp, offset=0, step=50)`
Calculates a strike price based on LTP.
- `offset`: `1` for OTM+1 Call, `-1` for ITM-1 Call.
- `step`: Strike interval (e.g., 50 for Nifty, 100 for BankNifty).

### `get_option_chain_df(symbol, expiry)`
Returns a full Option Chain as a Pandas DataFrame, including flattened CE/PE data, Greeks, and calculated % changes.

### `get_atm_strike(df, underlying_ltp=None)`
Finds the At-The-Money strike from an Option Chain DataFrame.

### `get_pcr_data(df, window=10)`
Calculates Put-Call Ratio (OI and Volume) for a strike window around ATM.

---

## 6. Order Management
### `place_order(security_id, exchange_segment, transaction_type, quantity, ...)`
The primary order placement engine. 
- **Workaround Included**: Automatically fixes a known SDK bug for **After Market Orders (AMO)**.
- **Parameters**: `price`, `trigger_price`, `order_type`, `product_type`, `after_market_order=True`.

### `modify_order(order_id, quantity, order_type, price, trigger_price)`
Modifies a pending order.

### `cancel_order(order_id)` / `cancel_all_orders()`
Cancels specific or all pending orders for the day.

### `is_order_filled(order_id)`
**Non-blocking**: Returns `True` or `False` based on current status.

### `wait_for_fill(order_id, timeout=30)`
**Blocking**: Loops and waits until the order status is `TRADED` (Filled) or the timeout occurs.

---

## 7. Portfolio & Funds
### `funds()`
Returns available margin as a float.

### `positions()`
Returns a DataFrame of today's positions.

### `holdings()`
Returns a DataFrame of total holdings.

### `get_margin_required(symbol, quantity, direction, ...)`
**Margin Calculator**: Returns a dictionary with detailed margin requirements (Total, SPAN, Exposure, etc.) for a potential trade.
- **Parameters**: `symbol`, `quantity`, `direction`, `order_type`, `product_type`, `price`, `trigger_price`.
- **Note**: Auto-fetches current LTP for MARKET orders if price is `0.0`.

---

## 8. Strategy Abstractions (High-Level)
### `place_entry(symbol, quantity, direction, ...)`
Unified entry point. Automatically resolves symbols and places an order (default: MARGIN).

### `place_exi_limit(symbol, quantity, price, direction)`
Places a Limit target exit order for an existing position.

### `place_sl_market(symbol, quantity, trigger_price, direction)`
Places an Emergency Stop Loss Market (SL-M) order.

### `update_trailing_sl(symbol, current_sl_id, new_trigger_price, quantity, direction)`
**Trailing Utility**: Cancels the old SL order and places a new SL-M order at the updated price. Returns new `order_id`.

### `place_spread(leg1_config, leg2_config)`
Sends two orders to the API as rapidly as possible. Useful for hedges or spreads.

### `get_net_quantity(symbol)`
Returns the current net quantity for a symbol across all products (Long is Positive, Short is Negative).

### `close_position(symbol)`
**Panic/Exit Button**: Fetches all open chunks of a symbol and places market orders to go flat.

### `emergency_stop()`
The **Ultimate Nuclear Option**. It sequentially calls `cancel_all_orders()`, `close_all_positions()`, and finally activates the account **Kill Switch** to disable trading for the rest of the day.

### `toggle_kill_switch(activate=True)`
Directly activates or deactivates the Dhan Kill Switch for the account.
- **Note**: Activating Kill Switch requires all positions to be closed first.

### `get_kill_switch_status()`
Returns the current status of the Kill Switch (e.g., `INACTIVE`).

---

## 9. Maintenance & Tools
### `fetch_security_list(segments=[...])`
Redownloads the latest master security list from Dhan servers.

### `is_market_open()`
Returns `True` if the current time is within Indian Equity Market hours (09:15 - 15:30 IST, Mon-Fri).
