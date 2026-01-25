
"""
Test 03: Market Data (LTP, OHLC, Quote)
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def run(helper=None):
    print("\n" + "="*60)
    print("TEST 03: MARKET DATA")
    print("="*60)
    
    try:
        if helper is None:
            dhan = get_dhan_client()
            helper = DhanHelper(dhan)
        
        # 1. LTP
        ltp = helper.ltp("TCS")
        print(f"[OK] LTP TCS: {ltp}")
        if ltp == 0:
            print("[WARN] LTP is 0 (Market might be closed or API issue)")
            
        # 2. OHLC
        # Note: Testing Equity first as Index data might be flaky/unavailable and cause connection state issues
        print("     [INFO] Fetching TCS OHLC...")
        ohlc_stk = helper.ohlc("TCS")
        if ohlc_stk:
             print(f"[OK] OHLC TCS: Open={ohlc_stk.get('open')}")
        else:
             print("[FAIL] Failed to fetch OHLC for TCS")
             return False

        print("     [INFO] Fetching NIFTY 50 OHLC...")
        ohlc = helper.ohlc("NIFTY 50")
        if ohlc:
            print(f"[OK] OHLC NIFTY 50: Open={ohlc.get('open')} Close={ohlc.get('close')}")
        else:
            print("[WARN] Failed to fetch OHLC for NIFTY (Market might be closed or API issue)")
            # Do not fail test if TCS worked
            
        # 3. Bulk LTP
        bulk = helper.bulk_ltp(["RELIANCE", "INFY", "SBIN"])
        if len(bulk) == 3:
            print(f"[OK] Bulk LTP: {bulk}")
        else:
             print(f"[FAIL] Bulk LTP incomplete: {bulk}")
             return False
             
        return True
        
    except Exception as e:
        print(f"[ERROR] Exception during market data test: {e}")
        return False

if __name__ == "__main__":
    run()
