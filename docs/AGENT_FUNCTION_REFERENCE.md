# Agent Function Reference

This document is the primary reference for all important functions in the `dhan_algo` codebase. **Agents MUST refer to this file before implementing or calling functions.**

---

## 1. Authentication & Initialization (`login.py`)

### `get_dhan_client()`
- **Usage**: `dhan = get_dhan_client()`
- **Info**: Initializes the Dhan SDK client. Handles token caching (valid for 1 day) and OAuth login if the token is missing or expired.
- **Returns**: `dhanhq` client object or `None`.

---

## 2. Core Helper (`lib/dhan_helper.py`)

### Initialization
- **`DhanHelper(dhan_client)`**: Initializes the helper. Loads `master_list.csv` (15MB) automatically.
- **`validate_session()`**: Returns `True` if the session is alive.

### Security Lookup
- **`find_equity(symbol)`**: Returns dict of equity details.
- **`find_index(symbol)`**: Returns dict of index details (e.g., "NIFTY").
- **`find_future(underlying, expiry)`**: Returns dict of future contract.
- **`find_option(underlying, expiry, strike, type)`**: Returns dict of option contract.
- **`get_lot_size(symbol)`**: Returns tradable lot size (e.g., 50 for NIFTY, 1 for Equity).

### Market Data
- **`get_ltp(symbol)`**: Fetches Last Traded Price. Smart-resolves any instrument.
- **`get_latest_candles(symbol, interval='5', days=5)`**: Returns DataFrame of candles.
- **`get_indicators(symbol, indicators=['EMA20', 'RSI14'])`**: Returns DataFrame with technical indicators.
- **`get_historical_minute_data_long(symbol, from_date, to_date)`**: Fetches years of 1-min data using auto-chunking (bypasses 90-day limit).

### Order Management
- **`place_entry(symbol, qty, direction)`**: Unified entry function. Uses `MARGIN` product by default.
- **`place_sl_market(symbol, qty, trigger_price, direction)`**: Unified SL-M placement.
- **`place_exi_limit(symbol, qty, price, direction)`**: Unified Limit exit placement.
- **`cancel_all_orders()` / `close_all_positions()`**: Panic buttons.
- **`get_net_quantity(symbol)`**: Returns current position size (Long is positive, Short is negative).
- **`wait_for_fill(order_id, timeout=30)`**: Blocking wait for order execution.

### F&O Specifics
- **`get_expiries(symbol)`**: Returns sorted list of expiry dates.
- **`get_option_chain_df(symbol, expiry)`**: Returns full option chain with Greeks.
- **`select_strike(ltp, offset, step)`**: Utility to find OTM/ITM strikes based on LTP and step size.
- **Guide**: See [OPTION_CHAIN_QUICK_REF.md](file:///c:/dhan_algo/docs/OPTION_CHAIN_QUICK_REF.md) for detailed F&O nesting logic.

---

## 3. Simplified API (High-Level)
These methods wrap complex logic into single-line calls. Use these for 90% cleaner strategy code.

- **`ltp(symbol)`**: Smart-resolves any symbol and returns float. Example: `ltp = helper.ltp("TCS")`.
- **`buy(symbol, qty, price=None, product="MARGIN")`**: Direct buy. If `price` is omitted, places a **MARKET** order.
- **`sell(symbol, qty, price=None, product="MARGIN")`**: Direct sell.
- **`funds()`**: Returns available margin as a float.
- **`positions()` / `holdings()`**: Returns DataFrames directly.
- **`option(underlying, strike, type)`**: Gets nearest expiry quote automatically.

---

## 4. Maintenance Scripts (`scripts/`)
See the [SCRIPTS_DIRECTORY_GUIDE.md](file:///C:/Users/sumit/.gemini/antigravity/brain/93efc1c6-11d2-47c1-92bd-99dbaf905549/SCRIPTS_DIRECTORY_GUIDE.md) for a full list of all 24 scripts.

### Data Production (Essential)
- **`download_nifty500_bulk.py`**: **Primary Sync**. Syncs 1-min data (Parquet) for all Nifty 500 stocks.
- **`download_nifty_minute.py`**: Downloads 1-minute data for NIFTY index.
- **`download_nifty_futures_1min.py`**: Downloads continuous futures data for the index.
- **`download_nifty500_daily_fresh.py`**: Downloads 2-year daily data for Nifty 500.

### Reporting & Analysis
- **`generate_portfolio_report.py`**: Generates holding performance and SIP plan excel.
- **`generate_nifty500_report_1min.py`**: Advanced scan (Mansfield RS, VCP, Breadth) using 1-min data.
- **`stock_analysis_repot.py`**: Simple absolute returns report (matching user dashboard).

---

## 4. Important Constants & Mappings
- **Segments**: `NSE_EQ` (Cash), `NSE_FNO` (Derivatives), `IDX_I` (Indices).
- **Intervals**: `"1"`, `"5"`, `"15"`, `"60"`, `"D"`.
- **Product Types**: `MARGIN` (Intraday/Carry), `CNC` (Delivery).

---

## 5. Quick Reference Tables

### Common Index Security IDs
| Index | Security ID | Segment |
| :--- | :--- | :--- |
| Nifty 50 | 13 | `IDX_I` |
| Bank Nifty | 25 | `IDX_I` |
| Fin Nifty | 27 | `IDX_I` |
| Nifty Midcap Select | 35 | `IDX_I` |
| Sensex | 51 | `IDX_I` |

### Performance Tips
- **Caching**: The master list (15MB) is loaded once on `DhanHelper` init (~1.5s). Subsequent lookups are instant (<1ms).
- **Batching**: Use `get_quote_data()` or `get_ticker_data()` for multi-symbol LTP instead of looping `get_ltp()`.
