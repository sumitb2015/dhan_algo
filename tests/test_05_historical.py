
"""
Test 05: Historical Data
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def run(helper=None):
    print("\n" + "="*60)
    print("TEST 05: HISTORICAL DATA")
    print("="*60)
    
    try:
        if helper is None:
            dhan = get_dhan_client()
            helper = DhanHelper(dhan)
        
        # 1. Daily Candles
        df = helper.get_latest_candles("RELIANCE", interval="D", days=10)
        if df.empty:
             print("[WARN] Failed to fetch Daily candles for RELIANCE. Retrying with TCS...")
             df = helper.get_latest_candles("TCS", interval="D", days=10)
             
        if not df.empty and len(df) > 0:
            print(f"[OK] Fetched {len(df)} Daily candles")
            print(f"     Last Date: {df.index[-1]}")
        else:
            print("[FAIL] Failed to fetch Daily candles")
            return False
            
        # 2. Intraday Candles (15min)
        df_intra = helper.get_latest_candles("NIFTY 50", interval="15", days=2)
        if not df_intra.empty:
             print(f"[OK] Fetched {len(df_intra)} Intraday (15m) candles for NIFTY 50")
        else:
             print("[WARN] Failed to fetch Intraday candles (Market might be closed/no data)")
             
        return True
        
    except Exception as e:
        print(f"[ERROR] Exception during historical data test: {e}")
        return False

if __name__ == "__main__":
    run()
