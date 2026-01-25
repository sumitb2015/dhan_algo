# F&O Convenience Methods - Quick Reference

## Summary of Refactoring

✅ **Added 4 New Convenience Methods** to `lib/dhan_helper.py`:

1. `get_option_quote()` - Get full quote for option (lookup + quote in one call)
2. `get_option_ltp()` - Get LTP for option (lookup + LTP in one call)
3. `get_future_quote()` - Get full quote for future (lookup + quote in one call)
4. `get_future_ltp()` - Get LTP for future (lookup + LTP in one call)

✅ **Fixed Data Structure**: Correctly handles nested `data.data.NSE_FNO` response format

---

## Usage Examples

### Before (Manual Method)
```python
# Step 1: Find option
option = helper.get_option_id("NIFTY", strike=23000, option_type="CE", expiry="2026-01-30")

# Step 2: Extract security ID
security_id = int(option['SECURITY_ID'])

# Step 3: Call quote_data
response = dhan.quote_data(securities={"NSE_FNO": [security_id]})

# Step 4: Parse nested response
data = response['data']['data']['NSE_FNO'][str(security_id)]
ltp = data['last_price']
```

### After (One-Line Method) ✨
```python
# Single call - everything done for you!
quote = helper.get_option_quote("NIFTY", 23000, "CE", "2026-01-30")
ltp = quote['last_price']

# Or even simpler for just LTP:
ltp = helper.get_option_ltp("NIFTY", 23000, "CE", "2026-01-30")
```

---

## Method Signatures

### get_option_quote()
```python
helper.get_option_quote(
    underlying="NIFTY",       # Underlying symbol
    strike=23000,             # Strike price
    option_type="CE",         # CE or PE
    expiry="2026-01-30",      # Expiry date YYYY-MM-DD
    exchange="NSE",           # NSE or BSE
    instrument="OPTIDX"       # OPTIDX or OPTSTK
)
```

**Returns**: Dict with quote data + CONTRACT_INFO, or None if not found

### get_option_ltp()
```python
ltp = helper.get_option_ltp(
    underlying="NIFTY",
    strike=23000,
    option_type="CE",
    expiry="2026-01-30"
)
```

**Returns**: float (LTP), 0.0 if not found

### get_future_quote()
```python
helper.get_future_quote(
    underlying="NIFTY",
    expiry="2026-01-30",
    exchange="NSE",
    instrument="FUTIDX"  # or FUTSTK for stock futures
)
```

**Returns**: Dict with quote data + CONTRACT_INFO, or None if not found

### get_future_ltp()
```python
ltp = helper.get_future_ltp(
    underlying="NIFTY",
    expiry="2026-01-30"
)
```

**Returns**: float (LTP), 0.0 if not found

---

## Quote Data Structure

The returned quote dictionary includes:

```python
{
    'last_price': 150.50,
    'ohlc': {
        'open': 145.00,
        'high': 155.00,
        'low': 140.00,
        'close': 148.00
    },
    'volume': 50000,
    '52_week_high': 300.00,
    '52_week_low': 50.00,
    'oi': 1000000,
    'average_price': 150.00,
    'depth': {...},  # Market depth data
    
    # Added by helper
    'CONTRACT_INFO': {
        'SYMBOL': 'NIFTY-Jan2026-23000-CE',
        'STRIKE': 23000,
        'OPTION_TYPE': 'CE',
        'EXPIRY': '2026-01-30',
        'LOT_SIZE': 25
    }
}
```

---

## Complete Example

```python
from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Initialize
dhan = get_dhan_client()
helper = DhanHelper(dhan)

# Get expiries
expiries = helper.get_expiry_list(13, "IDX_I")
nearest_expiry = expiries[0]

# Method 1: Get full quote data
quote = helper.get_option_quote(
    underlying="NIFTY",
    strike=23000,
    option_type="CE",
    expiry=nearest_expiry
)

if quote:
    print(f"Symbol: {quote['CONTRACT_INFO']['SYMBOL']}")
    print(f"LTP: {quote['last_price']}")
    print(f"Open: {quote['ohlc']['open']}")
    print(f"Volume: {quote['volume']}")
    print(f"OI: {quote['oi']}")

# Method 2: Get just LTP (faster)
ce_ltp = helper.get_option_ltp("NIFTY", 23000, "CE", nearest_expiry)
pe_ltp = helper.get_option_ltp("NIFTY", 23000, "PE", nearest_expiry)

print(f"23000 CE: Rs. {ce_ltp}")
print(f"23000 PE: Rs. {pe_ltp}")

# Futures
future_ltp = helper.get_future_ltp("NIFTY", nearest_expiry)
print(f"Nifty Future: Rs. {future_ltp}")
```

---

## Benefits

✅ **Simpler Code**: One line instead of multiple steps
✅ **Auto Security Lookup**: Finds security ID automatically
✅ **Correct Exchange Segment**: Uses NSE_FNO/BSE_FNO automatically
✅ **Enhanced Data**: Adds CONTRACT_INFO for context
✅ **Error Handling**: Returns None/0.0 on failure, no exceptions
✅ **Type Safety**: Returns proper types (Dict or float)

All existing methods still work! These are just convenient wrappers.
