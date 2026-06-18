# Strategy Creation Guidelines

This document provides a detailed guide for creating new trading strategies within the `dhan_algo` framework.

## 1. Strategy Architecture

All strategies should follow a consistent structure to ensure reliability and ease of maintenance.

### Basic Template
Always start with `templates/strategy_template.py`. It includes:
- Initialization of `DhanHelper`.
- Market open/close checks.
- A main loop with error handling.
- Position management logic using net quantity.

## 2. Technical Indicators
Use `helper.get_indicators()` for all technical analysis. It supports:
- **EMA/SMA**: `EMA20`, `SMA50`.
- **RSI**: `RSI14`.
- **ATR**: `ATR10`.
- **Supertrend**: Custom implementation integrated for TradingView accuracy.

```python
df = helper.get_indicators(SYMBOL, indicators=['EMA20', 'RSI14', 'ATR10'])
```

## 3. Order Management

### Entry & Exit
- **Entry**: Use `helper.place_entry(symbol, qty, direction)`.
- **Exit**: Use `helper.close_position(symbol)` for market exits.
- **Stop Loss**: Always place an SL-M order immediately after entry using `helper.place_sl_market()`.

## 4. TODOs & DONTs

### TODOs (Best Practices)
- [x] **Check Market Hours**: Use `helper.is_market_open()` to avoid API errors during off-market hours.
- [x] **Use Logging**: Log every significant event (Signal, Order, Error) with `logger.info()`.
- [x] **Handle Multi-Day Data**: Use `get_historical_minute_data_long` if your strategy needs backtesting with more than 90 days of data.
- [x] **Dynamic Quantity**: Use `helper.get_lot_size(symbol)` to handle F&O lot sizes correctly.
- [x] **Use WebSocket for Prices**: Use `helper.start_websocket()` for sub-second price updates. The helper automatically prioritizes `live_data` in `get_ltp()`.
- [x] **After-Hours Operation**: Strategies can run after market hours for testing; `DhanHelper` automatically falls back to cached data from `master_list.csv` when API calls fail.

### DONTs (Pitfalls)
- [ ] **DON'T** poll faster than 1 second; use the WebSocket for high-frequency data instead.
- [ ] **DON'T** restart the WebSocket manager manually; the helper handles reconnections and rate-limit backoffs (HTTP 429).
- [ ] **DON'T** use `feed.run_forever()`; it is incompatible with the current background thread manager (use `run()` inside the helper).
- [ ] **DON'T** hardcode strike steps or expiries; use `helper.get_expiries()` and `helper.select_strike()`.
- [ ] **DON'T** assume an order is filled; use `helper.wait_for_fill(order_id)` if subsequent logic depends on it.
- [ ] **DON'T** ignore the `Datetime` index in DataFrames; ensure calculations are time-aware.
- [ ] **DON'T** confuse index security ID with options underlying ID (e.g., NIFTY 50 index has ID 13, but NIFTY options use underlying ID 26000).
- [ ] **DON'T** assume API calls will always succeed; `DhanHelper` has built-in fallbacks for after-hours operation.

## 5. Verification Checklist
Before running a live strategy:
1. Verify symbol resolution with `helper.find_equity()` or `helper.find_index()`.
2. Test the logic on historical data using `get_latest_candles`.
3. Monitor the first few trades manually in the Dhan app.

## 6. After-Hours Development & Testing

### Fallback Mechanisms
`DhanHelper` includes automatic fallbacks for after-hours operation:
- **Expiry Lists**: `get_expiry_list()` extracts from `master_list.csv` when API fails
- **Symbol Resolution**: All lookups use cached master list data
- **Testing**: Strategies can be developed and tested after market hours

### Data Availability
When market is closed:
- ✅ **Available**: Symbol lookups, expiry lists, contract details, lot sizes
- ⚠️ **Limited**: Live quotes (LTP may be 0 or stale)
- ❌ **Unavailable**: Order placement, position updates, live WebSocket data

### Best Practices
```python
# Always check market status
if not helper.is_market_open():
    logger.warning("Market is closed. Running in observation mode.")

# Handle missing quote data gracefully
ltp = quote.get('last_price', 0) or quote.get('LTP', 0)
if ltp == 0:
    logger.warning("LTP is 0, market may be closed")
```
