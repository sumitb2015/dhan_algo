# Security ID Lookup - Complete Usage Guide

The DhanHelper library now includes powerful security ID lookup functions that search the master_list.csv (288K+ securities) with in-memory caching for performance.

---

## Quick Start

```python
from login import get_dhan_client
from lib.dhan_helper import DhanHelper

dhan = get_dhan_client()
helper = DhanHelper(dhan)

# First call loads CSV (~1-2 seconds)
# Subsequent calls are cached and instant
```

---

## 1. Equity Lookup

### Basic Usage
```python
# Find HDFC Bank
hdfc = helper.get_equity_id("HDFC")
print(f"Security ID: {hdfc['SECURITY_ID']}")
print(f"Symbol: {hdfc['SYMBOL_NAME']}")
```

### Specify Exchange
```python
# NSE (default)
stock = helper.get_equity_id("RELIANCE", exchange="NSE")

# BSE
stock_bse = helper.get_equity_id("RELIANCE", exchange="BSE")
```

### Case Insensitive
```python
tcs = helper.get_equity_id("tcs")  # Works with lowercase
```

---

## 2. Index Lookup

```python
# Find Nifty 50
nifty = helper.get_index_id("NIFTY 50")
print(f"Nifty ID: {nifty['SECURITY_ID']}")  # Returns: 13

# Bank Nifty
banknifty = helper.get_index_id("BANKEX")  # On BSE

# Fin Nifty
finnifty = helper.get_index_id("FIN NIFTY")
```

---

## 3. Option Lookup

```python
# Find Nifty 23000 CE expiring on 2026-01-30
option = helper.get_option_id(
    underlying="NIFTY",
    strike=23000,
    option_type="CE",  # or "PE" for Put
    expiry="2026-01-30"
)

if option:
    print(f"Option ID: {option['SECURITY_ID']}")
    print(f"Symbol: {option['SYMBOL_NAME']}")
    print(f"Lot Size: {option['LOT_SIZE']}")
```

### Stock Options
```python
# For stock options, use OPTSTK instrument
stock_option = helper.get_option_id(
    underlying="HDFC",
    strike=1600,
    option_type="CE",
    expiry="2026-02-27",
    instrument="OPTSTK"  # Stock option
)
```

---

## 4. Future Lookup

```python
# Find Nifty future expiring on 2026-01-30
future = helper.get_future_id(
    underlying="NIFTY",
    expiry="2026-01-30"
)

if future:
    print(f"Future ID: {future['SECURITY_ID']}")
    print(f"Symbol: {future['SYMBOL_NAME']}")
```

### Stock Futures
```python
# For stock futures, use FUTSTK instrument
stock_future = helper.get_future_id(
    underlying="RELIANCE",
    expiry="2026-02-27",
    instrument="FUTSTK"
)
```

---

## 5. Fuzzy Search

### Search by Pattern
```python
# Find all securities containing "BANK"
results = helper.search_symbols("BANK", limit=10)

for sec in results:
    print(f"{sec['SYMBOL_NAME']} - {sec['INSTRUMENT']} (ID: {sec['SECURITY_ID']})")
```

### Filter by Instrument
```python
# Find only indices containing "NIFTY"
indices = helper.search_symbols("NIFTY", limit=5, instrument="INDEX")

# Find only equities containing "TECH"
equities = helper.search_symbols("TECH", limit=5, instrument="EQUITY")
```

### Filter by Exchange
```python
# Find only NSE securities
nse_results = helper.search_symbols("HDFC", exchange="NSE", limit=5)
```

---

## 6. Advanced Search (get_security_id)

The main `get_security_id()` function supports all combinations of parameters:

```python
# Find all Nifty options expiring on a specific date
options = helper.get_security_id(
    underlying_symbol="NIFTY",
    option_type="CE",
    expiry="2026-01-30",
    instrument="OPTIDX",
    return_multiple=True  # Get all matches
)

print(f"Found {len(options)} Nifty CE options")
```

### All Available Parameters
```python
result = helper.get_security_id(
    symbol="TCS",                    # Symbol name/pattern
    exchange="NSE",                  # Exchange (NSE/BSE)
    segment="E",                     # Segment (E/D/C/etc)
    instrument="EQUITY",             # Instrument type
    strike=None,                     # Strike price
    option_type=None,                # CE/PE
    expiry=None,                     # YYYY-MM-DD
    underlying_symbol=None,          # For F&O
    return_multiple=False            # True for all matches
)
```

---

## 7. Return Multiple Results

```python
# Get all securities matching "HDFC"
all_hdfc = helper.get_security_id("HDFC", return_multiple=True)

print(f"Found {len(all_hdfc)} securities with HDFC")
for sec in all_hdfc[:5]:  # Show first 5
    print(f"{sec['SYMBOL_NAME']} - {sec['INSTRUMENT']}")
```

---

## 8. Accessing Return Data

All functions return a dictionary with these key fields:

```python
security = helper.get_equity_id("TCS")

# Common fields
security_id = security['SECURITY_ID']
symbol = security['SYMBOL_NAME']
display_name = security['DISPLAY_NAME']
exchange = security['EXCH_ID']
segment = security['SEGMENT']
instrument = security['INSTRUMENT']
isin = security['ISIN']

# For F&O contracts
underlying = security.get('UNDERLYING_SYMBOL')
underlying_id = security.get('UNDERLYING_SECURITY_ID')
strike = security.get('STRIKE_PRICE')
option_type = security.get('OPTION_TYPE')  # CE/PE
expiry = security.get('SM_EXPIRY_DATE')
lot_size = security.get('LOT_SIZE')

# Trading info
tick_size = security.get('TICK_SIZE')
series = security.get('SERIES')
```

---

## 9. Error Handling

```python
# Returns None if not found
result = helper.get_equity_id("FAKESYMBOL")
if result is None:
    print("Symbol not found")

# Returns empty list for multiple results
results = helper.search_symbols("XYZABC", limit=10)
if len(results) == 0:
    print("No matches found")
```

---

## 10. Performance Tips

### Caching
The CSV is loaded once and cached in memory:
- **First call**: ~1-2 seconds (loads 288K records)
- **Subsequent calls**: ~0.001 seconds (instant)

```python
import time

# First call - loads CSV
start = time.time()
result1 = helper.get_equity_id("HDFC")
print(f"First call: {time.time() - start:.2f}s")  # ~1-2s

# Cached call - instant
start = time.time()
result2 = helper.get_equity_id("TCS")
print(f"Cached call: {time.time() - start:.4f}s")  # <0.01s
```

### Reload Cache
```python
# Force reload the CSV file
helper._load_master_list(reload=True)
```

---

## 11. Common Use Cases

### Find Security ID for Order Placement
```python
# Get security ID for placing order
stock = helper.get_equity_id("INFY")
if stock:
    order_id = helper.place_order(
        security_id=stock['SECURITY_ID'],
        exchange_segment=helper.NSE,
        transaction_type=helper.BUY,
        quantity=10,
        order_type=helper.MARKET,
        product_type=helper.INTRA
    )
```

### Build Option Chain
```python
# Get all strikes for a specific expiry
expiry = "2026-01-30"
strikes = helper.get_security_id(
    underlying_symbol="NIFTY",
    expiry=expiry,
    instrument="OPTIDX",
    return_multiple=True
)

print(f"Found {len(strikes)} option contracts for {expiry}")
```

### Search and Discover
```python
# Discover available symbols
bank_stocks = helper.search_symbols("BANK", instrument="EQUITY", limit=20)
print("Available BANK stocks:")
for stock in bank_stocks:
    print(f"  {stock['SYMBOL_NAME']} (ID: {stock['SECURITY_ID']})")
```

---

## 12. Instrument Types

Available instrument types in master list:

| Instrument | Description | Count |
|------------|-------------|-------|
| OPTSTK | Stock Options | 127K |
| OPTFUT | Futures Options | 95K |
| OPTCUR | Currency Options | 24K |
| EQUITY | Equities/Stocks | 22K |
| OPTIDX | Index Options | 18K |
| FUTSTK | Stock Futures | 1.2K |
| FUTCUR | Currency Futures | 290 |
| INDEX | Indices | 194 |
| FUTCOM | Commodity Futures | 139 |
| FUTIDX | Index Futures | 32 |

---

## 13. Example: Complete Workflow

```python
from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Initialize
dhan = get_dhan_client()
helper = DhanHelper(dhan)

# Step 1: Find stock
stock = helper.get_equity_id("TCS", exchange="NSE")
if not stock:
    print("Stock not found!")
    exit()

print(f"Found {stock['SYMBOL_NAME']} (ID: {stock['SECURITY_ID']})")

# Step 2: Get current LTP
ltp = helper.get_ltp(str(stock['SECURITY_ID']), "NSE_EQ")
print(f"Current Price: {ltp}")

# Step 3: Place order
if ltp > 0:
    order_id = helper.place_order(
        security_id=str(stock['SECURITY_ID']),
        exchange_segment=helper.NSE,
        transaction_type=helper.BUY,
        quantity=1,
        order_type=helper.LIMIT,
        product_type=helper.CNC,
        price=ltp * 0.99  # 1% below market
    )
    print(f"Order placed: {order_id}")
```

---

## Summary

✅ **6 New Helper Functions** added to `lib/dhan_helper.py`:
1. `get_security_id()` - Main flexible lookup
2. `get_equity_id()` - Quick equity lookup
3. `get_index_id()` - Quick index lookup
4. `get_option_id()` - Option contract lookup
5. `get_future_id()` - Future contract lookup
6. `search_symbols()` - Fuzzy search

✅ **Features**:
- In-memory caching (fast after first load)
- Case-insensitive search
- Partial/fuzzy matching
- 288K+ securities from master_list.csv
- Support for all instrument types

✅ **Ready to use** in your trading strategies and Jupyter notebooks!
