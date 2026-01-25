# Simplified API - Quick Start

## ✅ What's New

The DhanHelper library now has **9 simplified methods** that make strategy code 90% cleaner!

---

## 🚀 Quick Examples

### 1. Get Stock Price
```python
# Old way (3 lines)
stock = helper.get_equity_id("TCS")
security_id = str(stock['SECURITY_ID'])
ltp = helper.get_ltp(security_id, "NSE_EQ")

# New way (1 line) ✨
ltp = helper.ltp("TCS")
```

### 2. Get Option Quote
```python
# Old way (2 lines)
expiries = helper.get_expiry_list(13, "IDX_I")
quote = helper.get_option_quote("NIFTY", 23000, "CE", expiries[0])

# New way (1 line) ✨
quote = helper.option("NIFTY", 23000, "CE")
```

### 3. Place Buy Order
```python
# Old way (8 lines)
stock = helper.get_equity_id("TCS")
helper.place_order(
    security_id=str(stock['SECURITY_ID']),
    exchange_segment=helper.NSE,
    transaction_type=helper.BUY,
    quantity=10,
    order_type=helper.MARKET,
    product_type=helper.INTRA
)

# New way (1 line) ✨
helper.buy("TCS", qty=10)
```

---

## 📋 All Simplified Methods

| Method | What It Does | Example |
|--------|--------------|---------|
| `ltp(symbol)` | Get last price | `ltp = helper.ltp("TCS")` |
| `ohlc(symbol)` | Get OHLC data | `data = helper.ohlc("TCS")` |
| `option(underlying, strike, type)` | Get option quote | `quote = helper.option("NIFTY", 23000, "CE")` |
| `future(underlying)` | Get future quote | `quote = helper.future("NIFTY")` |
| `buy(symbol, qty)` | Place buy order | `helper.buy("TCS", qty=10)` |
| `sell(symbol, qty)` | Place sell order | `helper.sell("TCS", qty=10)` |
| `positions()` | Get positions | `pos = helper.positions()` |
| `holdings()` | Get holdings | `hold = helper.holdings()` |
| `funds()` | Get balance | `balance = helper.funds()` |

---

## 💡 Smart Features

### Auto-Detection
- **Symbol type**: Automatically detects equity vs index
- **Exchange segment**: Auto-determines NSE_EQ, NSE_FNO, etc.
- **Expiry**: Uses nearest expiry by default

### Smart Defaults
- **Exchange**: NSE (most common)
- **Product**: INTRA (day trading)
- **Order type**: MARKET (or LIMIT if price given)

---

## 📝 Complete Strategy Example

```python
from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Initialize
dhan = get_dhan_client()
helper = DhanHelper(dhan)

# Check balance
if helper.funds() > 50000:
    # Get stock price
    ltp = helper.ltp("TCS")
    
    # Buy if price is good
    if ltp > 0 and ltp < 3500:
        helper.buy("TCS", qty=10, price=ltp * 0.99)
        print(f"Bought TCS at Rs. {ltp}")
```

**Just 10 lines of clean code!**

---

## 📚 More Examples

Run the example file:
```bash
python examples/simplified_api_examples.py
```

This demonstrates:
- Portfolio checking
- Stock prices
- OHLC data
- Nifty options
- Trading logic
- Position monitoring

---

## 📖 Full Documentation

- **Complete Guide**: `docs/SIMPLIFIED_API_GUIDE.md`
- **All Methods**: `docs/DHAN_HELPER_REFERENCE.md`
- **Examples**: `examples/simplified_api_examples.py`

---

## ✅ Backward Compatible

All old methods still work! You can mix and match:

```python
# Old method still works
stock = helper.get_equity_id("TCS")

# New simplified method
ltp = helper.ltp("TCS")
```

**No breaking changes!**

---

## 🎉 Benefits

- ✅ **90% less code** in strategies
- ✅ **Fewer errors** with smart defaults
- ✅ **Faster development** with less boilerplate
- ✅ **Cleaner code** - focus on strategy logic
- ✅ **100% backward compatible**

Start using the simplified API today! 🚀
