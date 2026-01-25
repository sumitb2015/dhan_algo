# DhanHQ SDK Testing Notebook - Setup Guide

## 📓 Jupyter Notebook Created!

A comprehensive Jupyter notebook has been created: **`DhanHQ_SDK_Complete_Testing.ipynb`**

This notebook contains **13 organized sections** testing all DhanHQ API functions with detailed explanations and examples.

---

## 🚀 Quick Start

### Step 1: Install Jupyter (if not already installed)

```bash
.\venv\Scripts\python.exe -m pip install jupyter notebook ipykernel
```

### Step 2: Launch Jupyter Notebook

```bash
.\venv\Scripts\python.exe -m jupyter notebook
```

This will:
- Start the Jupyter server
- Open your default browser automatically
- Display the file browser

### Step 3: Open the Notebook

1. Navigate to `DhanHQ_SDK_Complete_Testing.ipynb` in the Jupyter file browser
2. Click to open it
3. Run cells sequentially using `Shift + Enter`

---

## 📋 Notebook Contents

### 13 Comprehensive Sections:

1. **Authentication & Setup** - Initialize Dhan client and helper
2. **Fund Management** - Check available funds and margins
3. **Portfolio Management** - View positions and holdings
4. **Order Management** - Place, modify, cancel, track orders
5. **Trade Book & History** - View executed trades
6. **Market Data (Real-time)** - LTP, OHLC, ticker, quote data
7. **Historical Data** - Daily and intraday candles, expired options
8. **Option Chain Analysis** - Complete option chain with Greeks
9. **Security/Instrument List** - Master list of tradable instruments
10. **Forever Orders (GTT)** - Good-Till-Triggered orders
11. **eDIS & TPIN** - Manage holdings authorization
12. **Bulk Operations** - Cancel all orders, close all positions
13. **Utility Functions** - Time conversion and constants

---

## 🎯 Features

- ✅ **Complete Coverage**: All 30+ DhanHelper functions tested
- ✅ **Well Organized**: Logical sections with clear headings
- ✅ **Safe Testing**: Order placement examples are commented out
- ✅ **Rich Output**: DataFrames, JSON, and formatted displays
- ✅ **Error Handling**: Graceful handling of API errors
- ✅ **Documentation**: Inline explanations and markdown cells
- ✅ **Interactive**: Modify and re-run cells as needed

---

## 💡 Usage Tips

### Running Cells
- **Run single cell**: `Shift + Enter`
- **Run all cells**: Menu → Cell → Run All
- **Restart kernel**: Menu → Kernel → Restart & Clear Output

### Safety Features
All potentially dangerous operations (order placement, cancellation, etc.) are **commented out** by default. To test them:

1. Uncomment the code
2. Adjust parameters (use safe values)
3. Run the cell
4. Re-comment after testing

### Data API Subscription
Some functions require Dhan's Data API subscription:
- Historical data (daily/intraday)
- Market quotes (OHLC, ticker, quote)
- Expired options data

If you see "requires Data API subscription" messages, these features need to be enabled in your Dhan account.

---

## 📊 Example Workflow

### 1. Start with Authentication
```python
# Run the first two cells to initialize
from login import get_dhan_client
from lib.dhan_helper import DhanHelper

dhan = get_dhan_client()
helper = DhanHelper(dhan)
```

### 2. Check Your Portfolio
```python
# Get positions and holdings
positions = helper.get_positions()
holdings = helper.get_holdings()
funds = helper.get_available_funds()
```

### 3. Fetch Market Data
```python
# Get live prices
nifty_ltp = helper.get_ltp("13", "IDX_I")
expiries = helper.get_expiry_list(13)
chain = helper.get_option_chain(13, expiries[0])
```

### 4. Analyze Historical Data
```python
# Get historical candles
daily_data = helper.get_historical_daily_data(
    security_id=13,
    exchange_segment="IDX_I",
    instrument_type="INDEX",
    from_date="2025-01-01",
    to_date="2025-01-23"
)
```

---

## 🔧 Troubleshooting

### Issue: Jupyter not found
**Solution**: Install Jupyter
```bash
.\venv\Scripts\python.exe -m pip install jupyter notebook
```

### Issue: Kernel not found
**Solution**: Install ipykernel
```bash
.\venv\Scripts\python.exe -m pip install ipykernel
```

### Issue: Module not found in notebook
**Solution**: Make sure you're using the correct kernel (venv)
- In Jupyter: Kernel → Change Kernel → Select your venv

### Issue: Data API errors
**Solution**: Subscribe to Dhan Data APIs or use functions that don't require subscription (orders, positions, holdings)

---

## 📚 Additional Resources

- **Complete API Reference**: `DHAN_HELPER_REFERENCE.md`
- **Quick Reference**: `dhan_helper_quick_ref.py`
- **Update Summary**: `DHAN_HELPER_UPDATE_SUMMARY.md`
- **Test Script**: `test_dhan_helper.py`

---

## 🎓 Learning Path

### Beginner
1. Run authentication cells
2. Check fund management
3. View portfolio (positions/holdings)
4. Fetch market data (LTP, OHLC)

### Intermediate
1. Explore option chain
2. Fetch historical data
3. Analyze trade history
4. Search security list

### Advanced
1. Test order placement (in paper trading)
2. Implement bulk operations
3. Build custom strategies
4. Integrate with algo framework

---

## ⚠️ Important Notes

1. **Paper Trading First**: Test order placement in a safe environment
2. **API Limits**: Be mindful of API rate limits
3. **Data Subscription**: Some features require paid subscription
4. **Error Handling**: All functions return safe defaults on errors
5. **Logging**: Check console for detailed error messages

---

## 🚀 Next Steps

1. **Install Jupyter**: Run the pip install command above
2. **Launch Notebook**: Start Jupyter server
3. **Run Cells**: Execute cells sequentially
4. **Experiment**: Modify parameters and explore
5. **Build Strategies**: Use these functions in your algo trading

---

## 📞 Support

- **DhanHQ Documentation**: https://dhanhq.co/docs/DhanHQ-py/
- **GitHub Repository**: https://github.com/dhan-oss/DhanHQ-py
- **API Reference**: https://api.dhan.co/v2/

---

**Happy Testing! 🎉**

The notebook is ready to use. Install Jupyter and start exploring all DhanHQ API functions interactively!
