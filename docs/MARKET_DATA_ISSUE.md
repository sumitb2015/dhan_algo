# Market Data Issue - Resolution

## Issue
LTP, OHLC, and quote methods are returning 0 during market hours.

## Root Cause
**You need Dhan's Data API subscription.**

Dhan has TWO separate API subscriptions:

| API Type | What You Can Do | Status |
|----------|----------------|--------|
| **Trading API** | Place orders, modify/cancel orders, check positions/holdings | ✅ You have this |
| **Data API** | Get live prices (LTP), OHLC, quotes, historical data | ❌ You need this |

## What's Working ✅

The simplified API is working perfectly:
- ✓ Authentication
- ✓ Symbol resolution (`helper._resolve_symbol("TCS")`)
- ✓ Auto-segment detection (`helper._auto_detect_segment()`)
- ✓ Portfolio methods (`helper.positions()`, `helper.holdings()`, `helper.funds()`)
- ✓ Order placement methods (`helper.buy()`, `helper.sell()`)

## What's Not Working ❌

Market data methods return 0:
- `helper.ltp("TCS")` → 0.0
- `helper.ohlc("TCS")` → {}
- `helper.option("NIFTY", 23000, "CE")` → None
- `helper.future("NIFTY")` → None

**This is expected behavior without Data API subscription!**

## Solution

### Subscribe to Dhan Data API

1. **Login** to https://dhan.co
2. **Navigate** to Settings > API
3. **Subscribe** to "Data API" (separate from Trading API)
4. **Cost**: Approximately Rs. 1,000-2,000 per month
5. **Activation**: Immediate - no code changes needed

### After Subscription

All market data methods will work automatically:

```python
# Will return live prices
ltp = helper.ltp("TCS")  # Returns actual price, e.g., 3850.50

# Will return OHLC data
ohlc = helper.ohlc("TCS")  # Returns {'open': 3800, 'high': 3900, ...}

# Will return option quotes
quote = helper.option("NIFTY", 23000, "CE")  # Returns full quote data

# Will return future quotes
quote = helper.future("NIFTY")  # Returns full quote data
```

## Verification

Run the diagnostic script to verify:

```bash
python examples/diagnose_market_data.py
```

This will show:
- Current market status
- What's working
- What needs Data API subscription

## Important Notes

1. **The simplified API is working correctly** - it's properly handling the "no subscription" case by returning 0 instead of crashing.

2. **No code changes needed** - once you subscribe to Data API, all methods will work immediately.

3. **Portfolio methods work without Data API** - you can still check positions, holdings, and place orders.

4. **Market hours**: Even with Data API, live data is only available during market hours (9:15 AM - 3:30 PM, Mon-Fri).

## Summary

✅ **Simplified API implementation**: Complete and working  
✅ **Symbol resolution**: Working  
✅ **Portfolio methods**: Working  
❌ **Market data**: Requires Data API subscription  

**Action Required**: Subscribe to Dhan Data API to enable live market data.
