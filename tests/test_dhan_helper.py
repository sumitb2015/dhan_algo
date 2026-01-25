"""
Comprehensive test script for DhanHelper library
Demonstrates all available helper functions from the DhanHQ API
"""

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
import json
from datetime import datetime, timedelta

# Initialize Dhan client and helper
dhan = get_dhan_client()
helper = DhanHelper(dhan)

print("=" * 80)
print("DHAN HELPER - COMPREHENSIVE API TEST")
print("=" * 80)

# --- 1. FUND MANAGEMENT ---
print("\n[1] FUND MANAGEMENT")
print("-" * 80)
available_funds = helper.get_available_funds()
print(f"Available Funds: Rs.{available_funds:,.2f}")

# --- 2. PORTFOLIO ---
print("\n[2] PORTFOLIO")
print("-" * 80)
positions = helper.get_positions()
print(f"Positions Count: {len(positions)}")
if not positions.empty:
    print(positions[['securityId', 'tradingSymbol', 'netQty', 'realizedProfit']].head())

holdings = helper.get_holdings()
print(f"\nHoldings Count: {len(holdings)}")
if not holdings.empty:
    print(holdings[['securityId', 'tradingSymbol', 'totalQty', 'avgCostPrice']].head())

# --- 3. ORDER BOOK & TRADE BOOK ---
print("\n[3] ORDER BOOK & TRADE BOOK")
print("-" * 80)
orders = helper.get_order_list()
print(f"Total Orders Today: {len(orders)}")
if orders:
    print(f"Sample Order: {json.dumps(orders[0], indent=2)}")

trade_book = helper.get_trade_book()
print(f"\nTotal Trades Today: {len(trade_book)}")
if trade_book:
    print(f"Sample Trade: {json.dumps(trade_book[0], indent=2)}")

# Get trade history for last 7 days
to_date = datetime.now().strftime("%Y-%m-%d")
from_date = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
trade_history = helper.get_trade_history(from_date, to_date)
print(f"\nTrade History (Last 7 Days): {len(trade_history)} trades")

# --- 4. MARKET DATA ---
print("\n[4] MARKET DATA")
print("-" * 80)

# LTP for Nifty 50 (Security ID: 13)
nifty_ltp = helper.get_ltp("13", "IDX_I")
print(f"Nifty 50 LTP: {nifty_ltp}")

# OHLC for HDFC Bank (Security ID: 1333)
hdfc_ohlc = helper.get_ohlc(1333, "NSE_EQ")
print(f"\nHDFC Bank OHLC: {json.dumps(hdfc_ohlc, indent=2)}")

# Ticker Data (Multiple securities)
ticker_data = helper.get_ticker_data({"NSE_EQ": [1333, 11915]})
print(f"\nTicker Data: {json.dumps(ticker_data, indent=2)}")

# Quote Data (Multiple securities)
quote_data = helper.get_quote_data({"NSE_EQ": [1333]})
print(f"\nQuote Data: {json.dumps(quote_data, indent=2)}")

# --- 5. OPTION CHAIN ---
print("\n[5] OPTION CHAIN")
print("-" * 80)

# Get expiry list for Nifty
expiry_list = helper.get_expiry_list(under_security_id=13, under_exchange_segment="IDX_I")
print(f"Nifty Expiry Dates: {expiry_list}")

if expiry_list:
    # Get option chain for nearest expiry
    nearest_expiry = expiry_list[0]
    option_chain = helper.get_option_chain(
        under_security_id=13,
        expiry=nearest_expiry,
        under_exchange_segment="IDX_I"
    )
    print(f"\nOption Chain for {nearest_expiry}: {len(option_chain)} strikes")
    if not option_chain.empty:
        print(option_chain[['strike_price', 'call_options', 'put_options']].head())

# --- 6. HISTORICAL DATA ---
print("\n[6] HISTORICAL DATA")
print("-" * 80)

# Daily historical data for Nifty (last 30 days)
to_date = datetime.now().strftime("%Y-%m-%d")
from_date = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")

daily_data = helper.get_historical_daily_data(
    security_id=13,
    exchange_segment="IDX_I",
    instrument_type="INDEX",
    from_date=from_date,
    to_date=to_date
)
print(f"Daily Historical Data (Last 30 Days): {len(daily_data)} candles")
if not daily_data.empty:
    print(daily_data[['timestamp', 'open', 'high', 'low', 'close', 'volume']].tail())

# Intraday 5-minute data (today)
today = datetime.now().strftime("%Y-%m-%d")
intraday_data = helper.get_intraday_minute_data(
    security_id=13,
    exchange_segment="IDX_I",
    instrument_type="INDEX",
    interval="5",
    from_date=today,
    to_date=today
)
print(f"\nIntraday 5-Min Data (Today): {len(intraday_data)} candles")

# --- 7. SECURITY LIST ---
print("\n[7] SECURITY / INSTRUMENT LIST")
print("-" * 80)
security_list = helper.fetch_security_list("compact")
print(f"Total Securities: {len(security_list)}")
if not security_list.empty:
    print(security_list[['SEM_SMST_SECURITY_ID', 'SEM_TRADING_SYMBOL', 'SEM_EXCH_INSTRUMENT_TYPE']].head())

# --- 8. EDIS / TPIN ---
print("\n[8] EDIS / TPIN STATUS")
print("-" * 80)
edis_status = helper.get_edis_status()
print(f"eDIS Status: {json.dumps(edis_status, indent=2)}")

# --- 9. FOREVER ORDERS (GTT) ---
print("\n[9] FOREVER ORDERS (GTT)")
print("-" * 80)
print("Forever order placement is available via helper.place_forever_order()")
print("Example: helper.place_forever_order(security_id='1333', exchange_segment=helper.NSE, ...)")

# --- 10. UTILITY FUNCTIONS ---
print("\n[10] UTILITY FUNCTIONS")
print("-" * 80)
epoch_time = 1706000000
human_time = helper.epoch_to_datetime(epoch_time)
print(f"Epoch {epoch_time} -> {human_time}")

print("\n" + "=" * 80)
print("TEST COMPLETED SUCCESSFULLY!")
print("=" * 80)
print("\nAll DhanHQ API helper functions are now available in lib/dhan_helper.py")
print("Import and use: from lib.dhan_helper import DhanHelper")
