
"""
Test 09: Expiry & Strike Arithmetic
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def run(helper=None):
    print("\n" + "="*60)
    print("TEST 09: EXPIRY & STRIKE ARITHMETIC")
    print("="*60)
    
    try:
        if helper is None:
            dhan = get_dhan_client()
            helper = DhanHelper(dhan)
        
        # 1. Fetch Expiries for NIFTY
        symbol = "NIFTY 50"
        print(f">>> Fetching expiries for {symbol}...")
        expiries = helper.get_expiries(symbol)
        
        if not expiries:
            print(f"[FAIL] No expiries found for {symbol}")
            return False
            
        print(f"[OK] Total Expiries: {len(expiries)}")
        
        # 2. Get Nearest Expiry
        nearest = helper.get_nearest_expiry(symbol)
        print(f"[OK] Nearest Expiry: {nearest}")
        
        if nearest != expiries[0]:
            print(f"[FAIL] get_nearest_expiry mismatch: {nearest} vs {expiries[0]}")
            return False
            
        # 3. Strike Arithmetic
        print("\n>>> Testing Strike Arithmetic...")
        ltp = helper.ltp(symbol)
        if ltp == 0:
            print("[WARN] LTP is 0, using mock price 25234.5 for math check")
            ltp = 25234.5
        
        # Calculation check:
        # ATM for 25234.5 (step 50) is 25250
        # +1 OTM Call strike: 25250 + 50 = 25300
        # -1 ITM Call strike: 25250 - 50 = 25200
        
        atm = helper.select_strike(ltp, offset=0, step=50)
        otm_1 = helper.select_strike(ltp, offset=1, step=50)
        itm_1 = helper.select_strike(ltp, offset=-1, step=50)
        
        print(f"     Base Price (LTP): {ltp}")
        print(f"     ATM Strike (Step 50): {atm}")
        print(f"     OTM+1 Strike (Step 50): {otm_1}")
        print(f"     ITM-1 Strike (Step 50): {itm_1}")
        
        # Validation
        expected_atm = round(ltp / 50) * 50
        if atm != expected_atm:
             print(f"[FAIL] ATM calculation mismatch: {atm} vs {expected_atm}")
             return False
             
        if otm_1 != atm + 50:
             print(f"[FAIL] OTM+1 calculation mismatch")
             return False
             
        print("[OK] Strike Arithmetic verified.")
        
        # 4. Bank Nifty Check (Step 100)
        bn_ltp = helper.ltp("BANKNIFTY")
        if bn_ltp == 0: bn_ltp = 52123.4
        
        bn_atm = helper.select_strike(bn_ltp, offset=0, step=100)
        print(f"\n     BANKNIFTY LTP: {bn_ltp}")
        print(f"     BANKNIFTY ATM (Step 100): {bn_atm}")
        
        if bn_atm % 100 != 0:
            print("[FAIL] Bank Nifty ATM not multiple of 100")
            return False
            
        return True
        
    except Exception as e:
        print(f"[ERROR] Exception during Expiry/Strike test: {e}")
        return False

if __name__ == "__main__":
    run()
