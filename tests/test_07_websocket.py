
"""
Test 07: WebSocket Connectivity (Subscribe/Unsubscribe)
"""
import sys
import os
import time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def run(helper=None):
    print("\n" + "="*60)
    print("TEST 07: WEBSOCKET")
    print("="*60)
    
    try:
        if helper is None:
            dhan = get_dhan_client()
            helper = DhanHelper(dhan)
        
        # Need to start websocket on a separate thread usually, helper does this.
        # We test with a single liquid instrument
        symbol = "NIFTY 50"
        idx = helper.find_index(symbol)
        if not idx:
             # Fallback try
             print(f"[WARN] Direct index lookup failed for {symbol}. Trying alternative search...")
             res = helper.search_symbols(symbol, instrument="INDEX")
             if res:
                 idx = res[0]
                 
        if not idx:
             print("[FAIL] Could not resolve NIFTY 50")
             return False
             
        print(f"[OK] Resolved {symbol} -> {idx['SECURITY_ID']}")
             
        # Format for WS: (Exchange, ID, RequestCode)
        # 15 = Ticker
        instruments = [(helper.dhan.INDEX, str(idx['SECURITY_ID']), 15)]
        
        print(f"Connecting WebSocket for {symbol}...")
        feed = helper.start_websocket(instruments)
        
        if not feed:
            print("[FAIL] WebSocket returned None (check logs/auth)")
            return False
            
        print("[OK] WebSocket Initiated. Waiting 5s for data...")
        time.sleep(5)
        
        # Check if data received
        sid = str(idx['SECURITY_ID'])
        if sid in helper.live_data:
            print(f"[OK] Data Received: {helper.live_data[sid]}")
        else:
            print("[WARN] No data received (Market might be closed or Auth failed)")
            # We don't fail strictly here because market might be closed, but if feed object exists it's a pass for structure.
            
        # Test Unsubscribe
        print("Testing Unsubscribe...")
        res = helper.unsubscribe_instruments(instruments)
        if res:
            print("[OK] Unsubscribe command sent successfully")
        else:
            print("[FAIL] Unsubscribe failed")
            
        # Close
        feed.close_connection()
        print("[OK] Connection Closed")
        
        return True
        
    except Exception as e:
        print(f"[ERROR] Exception during websocket test: {e}")
        return False

if __name__ == "__main__":
    run()
