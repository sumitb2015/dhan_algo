
"""
Test 18: Expired Options Data
Verifies fetching historical data for contracts that have already expired.
"""
import sys
import os
import pandas as pd
from datetime import datetime, timedelta
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def run(helper=None):
    print("\n" + "="*60)
    print("TEST 18: EXPIRED OPTIONS DATA")
    print("="*60)
    
    try:
        if helper is None:
            dhan = get_dhan_client()
            helper = DhanHelper(dhan)
            
        # Target: NIFTY 50 (ID 13)
        # We pick an expiry from Jan 2025
        # Note: ExpiryFlag "WEEK" and ExpiryCode 1 (Near Week relative to the date)
        
        # Test Case 1: Fetching ATM Call for Jan 23rd Expiry
        expiry = "2025-01-23"
        from_date = "2025-01-20"
        to_date = "2025-01-23"
        
        print(f">>> Fetching Expired ATM CALL for NIFTY (Expiry: {expiry}, From: {from_date})...")
        df = helper.get_expired_options_data(
            security_id=13,
            exchange_segment="NSE_FNO",
            instrument_type="OPTIDX",
            expiry_flag="WEEK",
            expiry_code=1,
            strike="ATM",
            drv_option_type="CALL",
            required_data=["open", "high", "low", "close", "volume", "oi"],
            from_date=from_date,
            to_date=to_date
        )
        
        if not df.empty:
            print(f"[OK] Successfully fetched {len(df)} rows of expired data.")
            print(df[['datetime', 'option_type', 'open', 'high', 'low', 'close', 'volume']].tail(5))
            
            # Basic validation
            if 'close' in df.columns and df['close'].iloc[-1] > 0:
                print(f"[OK] Final Close Price on expiry: {df['close'].iloc[-1]}")
            else:
                 print("[WARN] Data fetched but some values are zero or missing.")
        else:
            print("[FAIL] Failed to fetch expired options data. (Check API credentials or date range)")
            return False
            
        return True
        
    except Exception as e:
        print(f"[ERROR] Exception during expired options test: {e}")
        return False

if __name__ == "__main__":
    run()
