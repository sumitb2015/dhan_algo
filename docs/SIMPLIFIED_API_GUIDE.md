# Simplified API for Strategy Code

## Overview

The DhanHelper library now includes a simplified API layer that abstracts complexity and makes strategy code 90% cleaner.

---

## Quick Comparison

### Before (Old API)
```python
# Get LTP - 3 steps
stock = helper.get_equity_id("TCS")
security_id = str(stock['SECURITY_ID'])
ltp = helper.get_ltp(security_id, "NSE_EQ")

# Get option quote - 2 steps
expiries = helper.get_expiry_list(13, "IDX_I")
quote = helper.get_option_quote("NIFTY", 23000, "CE", expiries[0])

# Place buy order - complex
stock = helper.get_equity_id("TCS")
helper.place_order(
    security_id=str(stock['SECURITY_ID']),
    exchange_segment=helper.NSE,
    transaction_type=helper.BUY,
    quantity=10,
    order_type=helper.MARKET,
    product_type=helper.INTRA
)
```

### After (Simplified API) ✨
```python
# Get LTP - 1 line!
ltp = helper.ltp("TCS")

# Get option quote - 1 line!
quote = helper.option("NIFTY", 23000, "CE")

# Place buy order - 1 line!
helper.buy("TCS", qty=10)
```

---

## New Simplified Methods

### 1. `ltp(symbol, exchange="NSE")` - Get LTP

```python
# Equity
ltp = helper.ltp("TCS")

# Index
nifty_ltp = helper.ltp("NIFTY 50")

# Any symbol - auto-detects type
ltp = helper.ltp("RELIANCE")
```

**Features:**
- Auto-detects if equity or index
- Auto-determines exchange segment
- Returns 0.0 if not found (no exceptions)

---

### 2. `ohlc(symbol, exchange="NSE")` - Get OHLC

```python
# Get OHLC data
data = helper.ohlc("TCS")
print(f"Open: {data['open']}, High: {data['high']}")

# Works for any symbol
nifty_ohlc = helper.ohlc("NIFTY 50")
```

**Features:**
- Auto-detects symbol type
- Returns empty dict if not found
- No need to specify exchange segment

---

### 3. `option(underlying, strike, type, expiry_index=0)` - Get Option

```python
# Nearest expiry (default)
quote = helper.option("NIFTY", 23000, "CE")

# Next expiry
quote = helper.option("NIFTY", 23000, "PE", expiry_index=1)

# Access data
if quote:
    print(f"LTP: {quote['last_price']}")
    print(f"Symbol: {quote['CONTRACT_INFO']['SYMBOL']}")
    print(f"Expiry: {quote['CONTRACT_INFO']['EXPIRY']}")
```

**Features:**
- Uses nearest expiry by default
- No need to fetch expiry list manually
- Returns full quote with CONTRACT_INFO
- Returns None if not found

---

### 4. `future(underlying, expiry_index=0)` - Get Future

```python
# Nearest expiry
quote = helper.future("NIFTY")

# Next expiry
quote = helper.future("BANKNIFTY", expiry_index=1)

# Access data
if quote:
    print(f"LTP: {quote['last_price']}")
    print(f"Lot Size: {quote['CONTRACT_INFO']['LOT_SIZE']}")
```

**Features:**
- Uses nearest expiry by default
- Auto-detects underlying
- Returns full quote with CONTRACT_INFO

---

### 5. `buy(symbol, qty, price=None, product="INTRA")` - Buy Order

```python
# Market order, intraday (default)
order_id = helper.buy("TCS", qty=10)

# Limit order, intraday
order_id = helper.buy("TCS", qty=10, price=3500)

# Delivery order
order_id = helper.buy("TCS", qty=10, price=3500, product="CNC")

# Margin order
order_id = helper.buy("TCS", qty=10, product="MARGIN")
```

**Smart Defaults:**
- No price = MARKET order
- With price = LIMIT order
- Default product = INTRA
- Auto-detects exchange segment

---

### 6. `sell(symbol, qty, price=None, product="INTRA")` - Sell Order

```python
# Market order, intraday
order_id = helper.sell("TCS", qty=10)

# Limit order
order_id = helper.sell("TCS", qty=10, price=3600)

# Delivery sell
order_id = helper.sell("TCS", qty=10, product="CNC")
```

**Same smart defaults as buy()**

---

### 7. `positions()` - Get Positions

```python
# No parameters needed!
positions = helper.positions()

# Use the DataFrame
for _, pos in positions.iterrows():
    print(f"{pos['tradingSymbol']}: {pos['netQty']} @ {pos['realizedProfit']}")
```

**Features:**
- No parameters needed
- Returns DataFrame directly
- Cleaner than get_positions()

---

### 8. `holdings()` - Get Holdings

```python
# No parameters needed!
holdings = helper.holdings()

# Access data
for _, holding in holdings.iterrows():
    print(f"{holding['tradingSymbol']}: {holding['totalQty']} shares")
```

---

### 9. `funds()` - Get Available Funds

```python
# Returns just the number
balance = helper.funds()
print(f"Available: Rs. {balance}")

# Use in logic
if helper.funds() > 50000:
    helper.buy("TCS", qty=10)
```

**Features:**
- Returns float directly
- No need to extract from dict
- Simpler than get_available_funds()

---

## Complete Strategy Example

### Old Way (Complex)
```python
# Check funds
funds_data = helper.get_available_funds()
if funds_data > 50000:
    # Get stock info
    stock = helper.get_equity_id("TCS")
    security_id = str(stock['SECURITY_ID'])
    
    # Get LTP
    ltp = helper.get_ltp(security_id, "NSE_EQ")
    
    # Place order
    helper.place_order(
        security_id=security_id,
        exchange_segment=helper.NSE,
        transaction_type=helper.BUY,
        quantity=10,
        order_type=helper.LIMIT,
        product_type=helper.INTRA,
        price=ltp * 0.99
    )
```

### New Way (Simple) ✨
```python
# Check funds and buy
if helper.funds() > 50000:
    ltp = helper.ltp("TCS")
    helper.buy("TCS", qty=10, price=ltp * 0.99)
```

**90% less code!**

---

## F&O Strategy Example

### Old Way
```python
# Get expiries
expiries = helper.get_expiry_list(13, "IDX_I")
nearest_expiry = expiries[0]

# Get option quote
quote = helper.get_option_quote("NIFTY", 23000, "CE", nearest_expiry)
if quote:
    data = quote.get('data', {}).get('data', {}).get('NSE_FNO', {})
    # ... complex parsing
```

### New Way ✨
```python
# Get option quote
quote = helper.option("NIFTY", 23000, "CE")
if quote:
    ltp = quote['last_price']
    # Ready to use!
```

---

## Benefits

| Feature | Old API | New API |
|---------|---------|---------|
| **Lines of code** | 10-15 lines | 1-3 lines |
| **Security lookup** | Manual | Automatic |
| **Exchange segment** | Manual | Auto-detected |
| **Expiry handling** | Manual fetch | Auto-uses nearest |
| **Error handling** | Try/except needed | Returns None/0 |
| **Readability** | Complex | Clean |

---

## Backward Compatibility

✅ **All old methods still work!**

```python
# Old methods still available
stock = helper.get_equity_id("TCS")  # Still works
ltp = helper.get_ltp(security_id, "NSE_EQ")  # Still works

# New simplified methods
ltp = helper.ltp("TCS")  # New, simpler way
```

**No breaking changes!**

---

## Auto-Detection Features

### Symbol Resolution
- Tries equity first (most common)
- Falls back to index
- Searches all instruments if needed

### Exchange Segment Detection
- F&O instruments → NSE_FNO / BSE_FNO
- Equity → NSE_EQ / BSE_EQ
- Index → IDX_I / BSE_IDX

### Smart Defaults
- Exchange: NSE (most common)
- Product: INTRA (day trading)
- Order type: MARKET (unless price given)

---

## Summary

**9 New Simplified Methods:**
1. `ltp()` - Get LTP for any symbol
2. `ohlc()` - Get OHLC for any symbol
3. `option()` - Get option quote (auto-expiry)
4. `future()` - Get future quote (auto-expiry)
5. `buy()` - Place buy order (smart defaults)
6. `sell()` - Place sell order (smart defaults)
7. `positions()` - Get positions (no params)
8. `holdings()` - Get holdings (no params)
9. `funds()` - Get funds (returns number)

**Result:** 90% less code, cleaner strategies, fewer errors! 🎉
