# DhanHelper - Complete API Reference

A comprehensive wrapper library for the DhanHQ Python SDK, providing easy-to-use helper functions for all API endpoints.

## Installation & Setup

```python
from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Initialize
dhan = get_dhan_client()
helper = DhanHelper(dhan)
```

## Available Functions

### 1. Fund Management

#### `get_available_funds() -> float`
Fetch available margin in the account.

```python
funds = helper.get_available_funds()
print(f"Available: ₹{funds:,.2f}")
```

---

### 2. Portfolio Management

#### `get_positions() -> pd.DataFrame`
Fetch current day positions as a DataFrame.

```python
positions = helper.get_positions()
print(positions[['tradingSymbol', 'netQty', 'realizedProfit']])
```

#### `get_holdings() -> pd.DataFrame`
Fetch current holdings as a DataFrame.

```python
holdings = helper.get_holdings()
print(holdings[['tradingSymbol', 'totalQty', 'avgCostPrice']])
```

---

### 3. Order Management

#### `place_order(security_id, exchange_segment, transaction_type, quantity, order_type, product_type, price, trigger_price) -> Optional[str]`
Place a new order. Returns order_id if successful.

```python
order_id = helper.place_order(
    security_id='1333',
    exchange_segment=helper.NSE,
    transaction_type=helper.BUY,
    quantity=10,
    order_type=helper.MARKET,
    product_type=helper.INTRA,
    price=0
)
```

#### `get_order_list() -> List[Dict]`
Fetch all orders for the day.

```python
orders = helper.get_order_list()
for order in orders:
    print(order['orderId'], order['orderStatus'])
```

#### `get_order_by_id(order_id: str) -> Optional[Dict]`
Fetch details of a specific order.

```python
order = helper.get_order_by_id("123456789")
print(order['orderStatus'])
```

#### `get_order_by_correlation_id(correlation_id: str) -> Optional[Dict]`
Fetch order by correlation ID.

```python
order = helper.get_order_by_correlation_id("my_correlation_id")
```

#### `get_order_status(order_id: str) -> Optional[str]`
Get just the status of an order.

```python
status = helper.get_order_status("123456789")
print(status)  # "TRADED", "PENDING", "REJECTED", etc.
```

#### `modify_order(order_id, quantity, order_type, price, trigger_price) -> bool`
Modify a pending order.

```python
success = helper.modify_order(
    order_id="123456789",
    quantity=20,
    order_type=helper.LIMIT,
    price=1500.50
)
```

#### `cancel_order(order_id: str) -> bool`
Cancel a pending order.

```python
success = helper.cancel_order("123456789")
```

#### `cancel_all_orders() -> int`
Cancel all pending orders. Returns count of cancelled orders.

```python
cancelled_count = helper.cancel_all_orders()
print(f"Cancelled {cancelled_count} orders")
```

---

### 4. Trade Book

#### `get_trade_book(order_id: str = None) -> List[Dict]`
Fetch trade book. If order_id provided, fetches trades for that order only.

```python
# All trades
all_trades = helper.get_trade_book()

# Trades for specific order
order_trades = helper.get_trade_book("123456789")
```

#### `get_trade_history(from_date: str, to_date: str, page_number: int = 0) -> pd.DataFrame`
Fetch trade history for a date range.

```python
trades = helper.get_trade_history("2025-01-01", "2025-01-23")
print(trades[['tradingSymbol', 'transactionType', 'quantity', 'tradedPrice']])
```

---

### 5. Market Data

#### `get_ltp(security_id: str, exchange_segment: str = "NSE_EQ") -> float`
Get Last Traded Price.

```python
# Nifty 50
nifty_ltp = helper.get_ltp("13", "IDX_I")

# HDFC Bank
hdfc_ltp = helper.get_ltp("1333", "NSE_EQ")
```

#### `get_ohlc(security_id: int, exchange_segment: str = "NSE_EQ") -> Dict`
Fetch OHLC data for a security.

```python
ohlc = helper.get_ohlc(1333, "NSE_EQ")
print(ohlc['open'], ohlc['high'], ohlc['low'], ohlc['close'])
```

#### `get_ticker_data(securities: Dict[str, List[int]]) -> Dict`
Fetch LTP for multiple securities.

```python
data = helper.get_ticker_data({
    "NSE_EQ": [1333, 11915],
    "NSE_FNO": [52175]
})
```

#### `get_quote_data(securities: Dict[str, List[int]]) -> Dict`
Fetch quote data (OHLC + LTP + Volume) for multiple securities.

```python
data = helper.get_quote_data({
    "NSE_EQ": [1333, 11915]
})
```

---

### 6. Historical Data

#### `get_historical_data(security_id, exchange_segment, instrument_type, from_date, to_date, interval="DAILY") -> pd.DataFrame`
Fetch historical data. Interval can be "DAILY" or minute intervals ("1", "5", "15", "60").

```python
# Daily data
daily = helper.get_historical_data(
    security_id="13",
    exchange_segment="IDX_I",
    instrument_type="INDEX",
    from_date="2025-01-01",
    to_date="2025-01-23",
    interval="DAILY"
)

# 5-minute intraday data
intraday = helper.get_historical_data(
    security_id="13",
    exchange_segment="IDX_I",
    instrument_type="INDEX",
    from_date="2025-01-23",
    to_date="2025-01-23",
    interval="5"
)
```

#### `get_historical_daily_data(security_id, exchange_segment, instrument_type, from_date, to_date) -> pd.DataFrame`
Dedicated method for daily historical data.

```python
data = helper.get_historical_daily_data(
    security_id=13,
    exchange_segment="IDX_I",
    instrument_type="INDEX",
    from_date="2025-01-01",
    to_date="2025-01-23"
)
```

#### `get_intraday_minute_data(security_id, exchange_segment, instrument_type, interval, from_date, to_date) -> pd.DataFrame`
Dedicated method for intraday minute data.

```python
data = helper.get_intraday_minute_data(
    security_id=13,
    exchange_segment="IDX_I",
    instrument_type="INDEX",
    interval="5",  # "1", "5", "15", "25", "60"
    from_date="2025-01-23",
    to_date="2025-01-23"
)
```

#### `get_expired_options_data(security_id, exchange_segment, instrument_type, expiry_flag, expiry_code, strike, drv_option_type, required_data, from_date, to_date) -> pd.DataFrame`
Fetch historical data for expired options.

```python
data = helper.get_expired_options_data(
    security_id=13,
    exchange_segment="NSE_FNO",
    instrument_type="INDEX",
    expiry_flag="WEEK",  # "WEEK" or "MONTH"
    expiry_code=1,  # 1-5 for weekly, 1-3 for monthly
    strike="ATM",  # "ATM", "OTM1", "OTM2", "ITM1", "ITM2", or specific price
    drv_option_type="CALL",  # "CALL" or "PUT"
    required_data=["open", "high", "low", "close", "volume", "oi"],
    from_date="2025-01-01",
    to_date="2025-01-23"
)
```

---

### 7. Option Chain

#### `get_expiry_list(under_security_id: int, under_exchange_segment: str = "IDX_I") -> List[str]`
Fetch available expiry dates for an underlying.

```python
expiries = helper.get_expiry_list(under_security_id=13)
print(expiries)  # ['2025-01-30', '2025-02-06', ...]
```

#### `get_option_chain(under_security_id: int, expiry: str, under_exchange_segment: str = "IDX_I") -> pd.DataFrame`
Fetch complete option chain for an expiry.

```python
chain = helper.get_option_chain(
    under_security_id=13,
    expiry="2025-01-30",
    under_exchange_segment="IDX_I"
)
print(chain[['strike_price', 'call_options', 'put_options']])
```

---

### 8. Security / Instrument List

#### `fetch_security_list(list_type: str = "compact") -> pd.DataFrame`
Fetch security/instrument master list.

```python
# Compact list
securities = helper.fetch_security_list("compact")

# Full list
securities_full = helper.fetch_security_list("full")

print(securities[['SEM_SMST_SECURITY_ID', 'SEM_TRADING_SYMBOL']])
```

---

### 9. Forever Orders (GTT)

#### `place_forever_order(security_id, exchange_segment, transaction_type, quantity, price, trigger_price, order_type, product_type) -> Optional[str]`
Place a Forever (Good Till Triggered) order.

```python
order_id = helper.place_forever_order(
    security_id="1333",
    exchange_segment=helper.NSE,
    transaction_type=helper.BUY,
    quantity=10,
    price=1900,
    trigger_price=1950,
    order_type=helper.LIMIT,
    product_type=helper.CNC
)
```

---

### 10. eDIS / TPIN

#### `generate_tpin() -> bool`
Trigger TPIN generation request from CDSL.

```python
success = helper.generate_tpin()
```

#### `open_browser_for_tpin(isin: str, qty: int, exchange: str = 'NSE') -> bool`
Open browser for TPIN entry in eDIS form.

```python
success = helper.open_browser_for_tpin(
    isin='INE00IN01015',
    qty=1,
    exchange='NSE'
)
```

#### `get_edis_status() -> Dict`
Check status of eDIS authorizations.

```python
status = helper.get_edis_status()
print(status)
```

---

### 11. Bulk Operations

#### `close_all_positions() -> int`
Close all open positions by placing market orders. Returns count of positions closed.

```python
closed_count = helper.close_all_positions()
print(f"Closed {closed_count} positions")
```

---

### 12. Utility Functions

#### `epoch_to_datetime(epoch: int) -> str`
Convert Dhan's epoch time to human-readable format.

```python
time_str = helper.epoch_to_datetime(1706000000)
print(time_str)
```

---

## Constants Available

All exchange and order constants are available directly on the helper instance:

```python
# Exchange Segments
helper.NSE
helper.BSE
helper.NSE_FNO

# Transaction Types
helper.BUY
helper.SELL

# Order Types
helper.MARKET
helper.LIMIT

# Product Types
helper.INTRA
helper.CNC
helper.MARGIN
```

---

## Error Handling

All methods include built-in error handling and logging. Failed operations return:
- `None` for single object returns
- `[]` (empty list) for list returns
- `{}` (empty dict) for dict returns
- `pd.DataFrame()` (empty DataFrame) for DataFrame returns
- `False` for boolean returns
- `0` or `0.0` for numeric returns

Check logs for detailed error messages.

---

## Complete Example

```python
from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Initialize
dhan = get_dhan_client()
helper = DhanHelper(dhan)

# Check funds
funds = helper.get_available_funds()
print(f"Available: ₹{funds:,.2f}")

# Get Nifty LTP
nifty_ltp = helper.get_ltp("13", "IDX_I")
print(f"Nifty: {nifty_ltp}")

# Get option chain
expiries = helper.get_expiry_list(13)
chain = helper.get_option_chain(13, expiries[0])
print(f"Option Chain: {len(chain)} strikes")

# Place order
order_id = helper.place_order(
    security_id='52175',
    exchange_segment=helper.NSE_FNO,
    transaction_type=helper.BUY,
    quantity=50,
    order_type=helper.MARKET,
    product_type=helper.INTRA
)

# Check order status
status = helper.get_order_status(order_id)
print(f"Order Status: {status}")

# Get positions
positions = helper.get_positions()
print(positions[['tradingSymbol', 'netQty', 'realizedProfit']])
```

---

## Testing

Run the comprehensive test script:

```bash
python test_dhan_helper.py
```

This will test all available functions and display sample outputs.
