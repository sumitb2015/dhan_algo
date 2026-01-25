
"""
Test 04: Option Chain and Future Lookup
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def run(helper=None):
    print("\n" + "="*60)
    print("TEST 04: OPTION CHAIN & FNO")
    print("="*60)
    
    try:
        if helper is None:
            dhan = get_dhan_client()
            helper = DhanHelper(dhan)
        
        # 1. Get Expiry List
        expiries = helper.get_expiries("NIFTY 50")
        if not expiries:
            print("[FAIL] Could not fetch expiries for NIFTY 50")
            return False
        
        nearest = expiries[0]
        print(f"[OK] Found Expiries: {len(expiries)} (Nearest: {nearest})")
        
        # 2. Find Future
        fut = helper.find_future("NIFTY", nearest)
        if fut:
             print(f"[OK] Found Future: {fut['SYMBOL_NAME']}")
        else:
             print("[WARN] Could not find NIFTY Future (Check expiry alignment)")
             
        # 3. Option Chain DF
        df = helper.get_option_chain_df("NIFTY 50", nearest)
        if not df.empty:
            print(f"[OK] Option Chain Fetched: {len(df)} strikes")
            
            # Check ATM
            atm = helper.get_atm_strike(df)
            print(f"[OK] ATM Strike: {atm}")
            
            # Check PCR
            pcr = helper.get_pcr_data(df)
            print(f"[OK] PCR Data: OI_PCR={pcr.get('oi_pcr')}")
        else:
            print("[FAIL] Option Chain DF is empty")
            return False
            
        return True
        
    except Exception as e:
        print(f"[ERROR] Exception during F&O test: {e}")
        return False

if __name__ == "__main__":
    run()
