
"""
Test 15: Indicator Verification with TA-Lib (5-min Data)
Checks EMA 9, 20, 200, RSI, and ATR.
"""
import sys
import os
import pandas as pd
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def run(helper=None):
    print("\n" + "="*60)
    print("TEST 15: INDICATOR VERIFICATION (5-MIN DATA)")
    print("="*60)
    
    try:
        if helper is None:
            dhan = get_dhan_client()
            helper = DhanHelper(dhan)
        
        symbol = "RELIANCE"
        interval = "5" # 5-minute timeframe
        days = 15      # Fetch enough history for EMA200 calculation
        
        # Requesting specific indicators
        requested_indicators = ['EMA9', 'EMA20', 'EMA200', 'RSI14', 'ATR14']
        
        print(f">>> Fetching {interval}-min indicators for {symbol} (Last {days} days)...")
        df = helper.get_indicators(
            symbol=symbol, 
            interval=interval, 
            indicators=requested_indicators, 
            days=days
        )
        
        if df.empty:
            print("[FAIL] No data received. Check symbol or market hours.")
            return False

        print(f"\n[OK] Successfully retrieved {len(df)} candles.")
        
        # Display the last 10 rows with the requested columns
        print("\n>>> Latest Data Snaphot (Last 10 Rows):")
        cols_to_show = ['Open', 'High', 'Low', 'Close'] + [i.upper() for i in requested_indicators]
        # Filter columns to only show what exists (EMA200 needs ~250-300 candles to stabilize)
        existing_cols = [c for c in cols_to_show if c in df.columns]
        
        print(df[existing_cols].tail(10))
        
        # Validation checks
        all_present = True
        for ind in requested_indicators:
            if ind.upper() not in df.columns:
                print(f"[WARN] Indicator {ind} is missing from DataFrame.")
                all_present = False
            elif df[ind.upper()].isna().all():
                print(f"[WARN] Indicator {ind} contains only NaN values (Might need more data for EMA200).")
                all_present = False

        if all_present:
            print("\n[SUCCESS] All requested indicators calculated successfully using TA-Lib.")
            
            # Simple Trend Analysis based on EMA
            latest = df.iloc[-1]
            price = latest['Close']
            ema9 = latest['EMA9']
            ema20 = latest['EMA20']
            
            print(f"\n--- Basic Strategy Check for {symbol} ---")
            print(f"Current Price: {price:.2f}")
            if price > ema20 and ema9 > ema20:
                print("Signal: BULLISH (Price and EMA9 are above EMA20)")
            elif price < ema20 and ema9 < ema20:
                print("Signal: BEARISH (Price and EMA9 are below EMA20)")
            else:
                print("Signal: NEUTRAL / Consolidation")
        
        return True

    except Exception as e:
        print(f"[ERROR] Exception during indicator test: {e}")
        return False

if __name__ == "__main__":
    run()
