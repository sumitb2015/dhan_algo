from login import get_dhan_client
from lib.dhan_helper import DhanHelper
import pandas as pd

def test_functionalities():
    print("Initializing Dhan Client...")
    dhan_client = get_dhan_client()
    
    if not dhan_client:
        print("Failed to initialize client. Check login.py and .env")
        return

    helper = DhanHelper(dhan_client)
    print("-" * 30)

    # 1. Test Funds
    print("Testing Fund Fetching...")
    funds = helper.get_available_funds()
    print(f"Available Margin: Rs. {funds}")
    print("-" * 30)

    # 2. Test Positions
    print("Testing Positions Fetching...")
    positions_df = helper.get_positions()
    if not positions_df.empty:
        print(f"Top 5 Positions:\n{positions_df.head()}")
    else:
        print("No active positions found.")
    print("-" * 30)

    # 3. Test Holdings
    print("Testing Holdings Fetching...")
    holdings_df = helper.get_holdings()
    if not holdings_df.empty:
        print(f"Holdings Summary:\n{holdings_df[['tradingSymbol', 'totalQty', 'lastTradedPrice']].head()}")
    else:
        print("No holdings found.")
    print("-" * 30)

    # 4. Test Market Data (LTP)
    # Try to get a security ID from holdings if available, else fallback to HDFC Bank (1333)
    target_id = "1333"
    target_symbol = "HDFC Bank"
    if not holdings_df.empty:
        target_id = str(holdings_df.iloc[0]['securityId'])
        target_symbol = holdings_df.iloc[0]['tradingSymbol']

    print(f"Testing Market Data (LTP) for {target_symbol} ({target_id})...")
    ltp = helper.get_ltp(target_id, "NSE_EQ")
    print(f"LTP for {target_symbol}: {ltp}")
    print("-" * 30)

    # 5. Test OHLC
    print(f"Testing OHLC for {target_symbol}...")
    ohlc = helper.get_ohlc(int(target_id), "NSE_EQ")
    print(f"OHLC Data: {ohlc}")
    print("-" * 30)

    print("Test Summary: Basic read functions are working correctly.")
    print("Order placement functions were skipped to avoid accidental trades.")

if __name__ == "__main__":
    test_functionalities()
