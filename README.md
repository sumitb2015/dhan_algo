# DhanHQ Python SDK - Complete Integration

A comprehensive Python library for DhanHQ trading with helper functions, security lookup, and F&O convenience methods.

---

## 📁 Project Structure

```
dhan_algo/
├── debug/                        # Debug and utility scripts
│   ├── debug_*.py               # Various debug utilities
│   ├── check_*.py               # Validation checks
│   └── inspect_*.py             # Inspection scripts
│
├── temp_data/                    # Temporary data (CSVs, Excel, Zips)
│   ├── Nifty500_Report*.csv     # Generated reports
│   ├── stock_analysis_report*.csv
│   └── *.zip                    # Large archives
│
├── docs/                         # Documentation
│   ├── DHAN_HELPER_REFERENCE.md        # Complete API reference
│   ├── SECURITY_LOOKUP_GUIDE.md        # Security ID lookup guide
│   ├── FNO_CONVENIENCE_METHODS.md      # F&O convenience methods
│   ├── OPTION_CHAIN_QUICK_REF.md       # Option chain usage
│   ├── JUPYTER_NOTEBOOK_GUIDE.md       # Jupyter setup guide
│   ├── NOTEBOOK_READY.md               # Quick start guide
│   └── DHAN_HELPER_UPDATE_SUMMARY.md   # Change log
│
├── tests/                        # Automated unit tests
│   ├── test_security_lookup.py         # Security lookup tests
│   ├── test_fno_convenience.py         # F&O convenience tests
│   └── test_dhan_helper.py             # General helper tests
│
├── examples/                     # Usage examples
│   ├── example_option_chain_workflow.py  # Complete option chain workflow
│   └── dhan_helper_quick_ref.py          # Quick reference snippets
│
├── scripts/                      # Integration and data scripts (organized by functionality)
│   ├── downloader/               # Spot Daily, Intraday, & Futures downloaders
│   ├── analysis/                 # Report generators and volatility distribution analysis
│   ├── data_utils/               # Indicator append, Parquet convert, & resampling tools
│   ├── tools/                    # Options trackers & portfolio tools
│   └── testing/                  # Websocket testing & validation checks
│
├── login.py                      # Authentication handler
├── master_list.csv              # Security master list (Cached)
├── .env                         # Environment variables
└── requirements.txt              # Project dependencies
```

---

## 🚀 Quick Start

### 1. Installation

```bash
# Install dependencies
pip install dhanhq pandas python-dotenv pyotp

# Or use the virtual environment
.\venv\Scripts\activate
```

### 2. Setup Environment

Create `.env` file:
```env
CLIENT_ID=your_client_id_here
```

### 3. Basic Usage

```python
from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Initialize
dhan = get_dhan_client()
helper = DhanHelper(dhan)

# Get fund balance
balance = helper.get_available_funds()
print(f"Available: Rs. {balance}")

# Find security ID
stock = helper.get_equity_id("TCS")
print(f"TCS Security ID: {stock['SECURITY_ID']}")

# Get option quote (one-liner!)
expiries = helper.get_expiry_list(13, "IDX_I")
ltp = helper.get_option_ltp("NIFTY", 23000, "CE", expiries[0])
print(f"Option LTP: Rs. {ltp}")
```

---

## 📚 Core Features

### 1. Security ID Lookup (288K+ Securities)
```python
# Equity lookup
hdfc = helper.get_equity_id("HDFC")

# Index lookup
nifty = helper.get_index_id("NIFTY 50")

# Option lookup
option = helper.get_option_id("NIFTY", 23000, "CE", "2026-01-30")

# Fuzzy search
results = helper.search_symbols("BANK", limit=10)
```

### 2. F&O Convenience Methods
```python
# Get option quote (combines lookup + quote fetch)
quote = helper.get_option_quote("NIFTY", 23000, "CE", expiry)

# Get option LTP (even simpler)
ltp = helper.get_option_ltp("NIFTY", 23000, "CE", expiry)

# Future quotes
future_ltp = helper.get_future_ltp("NIFTY", expiry)
```

### 3. Market Data
```python
# LTP
ltp = helper.get_ltp("1333", "NSE_EQ")

# OHLC
ohlc = helper.get_ohlc(1333, "NSE_EQ")

# Option chain
chain = helper.get_option_chain(13, expiry, "IDX_I")
```

### 4. Order Management
```python
# Place order
order_id = helper.place_order(
    security_id="1333",
    exchange_segment=helper.NSE,
    transaction_type=helper.BUY,
    quantity=10,
    order_type=helper.MARKET,
    product_type=helper.INTRA
)

# Get order status
status = helper.get_order_status(order_id)

# Cancel order
helper.cancel_order(order_id)
```

### 5. Portfolio & Positions
```python
# Get positions
positions = helper.get_positions()

# Get holdings
holdings = helper.get_holdings()

# Get trade book
trades = helper.get_trade_book()
```

---

## 📖 Documentation

| Document | Description |
|----------|-------------|
| [DHAN_HELPER_REFERENCE.md](docs/DHAN_HELPER_REFERENCE.md) | Complete API reference for all 40+ methods |
| [SECURITY_LOOKUP_GUIDE.md](docs/SECURITY_LOOKUP_GUIDE.md) | How to find security IDs |
| [FNO_CONVENIENCE_METHODS.md](docs/FNO_CONVENIENCE_METHODS.md) | F&O one-liner methods |
| [JUPYTER_NOTEBOOK_GUIDE.md](docs/JUPYTER_NOTEBOOK_GUIDE.md) | Jupyter setup and usage |

---

## 🧪 Testing

Run tests from the `tests/` directory:

```bash
# Test security lookup
python tests/test_security_lookup.py

# Test F&O convenience methods
python tests/test_fno_convenience.py

# Test all helper functions
python tests/test_dhan_helper.py
```

---

## 📓 Jupyter Notebook

Launch the comprehensive testing notebook:

```bash
.\venv\Scripts\python.exe -m jupyter notebook DhanHQ_SDK_Complete_Testing.ipynb
```

The notebook includes 13 sections covering all API functions with examples.

---

## 🎯 Key Methods Summary

### Security Lookup (6 methods)
- `get_security_id()` - Flexible search
- `get_equity_id()` - Quick equity lookup
- `get_index_id()` - Quick index lookup
- `get_option_id()` - Find option contracts
- `get_future_id()` - Find future contracts
- `search_symbols()` - Fuzzy search

### F&O Convenience (4 methods)
- `get_option_quote()` - Option quote in one call
- `get_option_ltp()` - Option LTP in one call
- `get_future_quote()` - Future quote in one call
- `get_future_ltp()` - Future LTP in one call

### Fund Management (1 method)
- `get_available_funds()` - Available margin

### Portfolio (3 methods)
- `get_positions()` - Current positions
- `get_holdings()` - Current holdings
- `get_trade_book()` - Trade history

### Order Management (5 methods)
- `place_order()` - Place new order
- `get_order_status()` - Get order details
- `modify_order()` - Modify existing order
- `cancel_order()` - Cancel order
- `get_order_list()` - All orders

### Market Data (6 methods)
- `get_ltp()` - Last traded price
- `get_ohlc()` - OHLC data
- `get_ticker_data()` - Ticker data
- `get_quote_data()` - Quote data
- `get_option_chain()` - Option chain
- `get_expiry_list()` - Available expiries

### Historical Data (3 methods)
- `get_historical_daily_data()` - Daily candles
- `get_intraday_minute_data()` - Intraday candles
- `get_expired_options_data()` - Expired options data

### Forever Orders (2 methods)
- `place_forever_order()` - Place GTT order
- `get_forever_orders()` - Get GTT orders

### Utilities (2 methods)
- `epoch_to_datetime()` - Convert timestamps
- `open_browser_for_tpin()` - eDIS authorization

**Total: 40+ helper methods**

---

## 🔑 Environment Variables

Required in `.env`:
```env
CLIENT_ID=your_dhan_client_id
```

Optional:
```env
REDIRECT_URI=http://localhost:8000
```

---

## 📦 Dependencies

- `dhanhq` - DhanHQ Python SDK
- `pandas` - Data manipulation
- `python-dotenv` - Environment variables
- `pyotp` - TOTP generation
- `jupyter` - Notebook interface (optional)

---

## 🎓 Examples

See `examples/` directory for:
- Complete option chain workflow
- Quick reference code snippets
- Common usage patterns

---

## 🐛 Debugging

Debug scripts in `tests/`:
- `debug_oc.py` - Debug option chain
- `debug_quote_response.py` - Debug quote API
- `debug_hist.py` - Debug historical data
- `debug_market.py` - Debug market data

---

## 📝 Notes

- **Master List**: 288,256 securities cached in memory for fast lookups
- **Exchange Segments**: NSE_EQ, NSE_FNO, BSE_EQ, BSE_FNO, etc.
- **Data API**: Some functions require Dhan Data API subscription
- **Caching**: First security lookup loads CSV (~1s), subsequent lookups are instant

---

## 🤝 Contributing

This is a personal project. Feel free to fork and customize for your needs.

---

## 📄 License

This project uses the DhanHQ Python SDK. Refer to DhanHQ's terms of service.

---

## 🔗 Links

- [DhanHQ Documentation](https://dhanhq.co/docs/DhanHQ-py/)
- [DhanHQ GitHub](https://github.com/dhan-oss/DhanHQ-py)
- [API Reference](https://api.dhan.co/v2/)

---

**Last Updated**: 2026-01-23  
**Version**: 2.0 (Complete Integration with Security Lookup & F&O Convenience Methods)
