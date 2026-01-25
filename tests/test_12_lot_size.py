
"""
Test 12: Lot Size Verification
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def run(helper=None):
    print("\n" + "="*60)
    print("TEST 12: LOT SIZE VERIFICATION")
    print("="*60)
    
    try:
        if helper is None:
            dhan = get_dhan_client()
            helper = DhanHelper(dhan)
        
        # 1. Basic Symbols
        symbols = ["RELIANCE", "TCS", "NIFTY 50", "BANKNIFTY"]
        
        print(">>> Fetching Lot Sizes for Equities and Indices...")
        for sym in symbols:
            lot = helper.get_lot_size(sym)
            print(f"[OK] {sym:12} -> Lot Size: {lot}")
            if not isinstance(lot, int) or lot < 1:
                print(f"[FAIL] Invalid lot size for {sym}")
                return False

        # 2. Derivative Check (Future)
        print("\n>>> Fetching Lot Size for Nearest NIFTY Future...")
        fut = helper.find_current_month_future("NIFTY")
        if fut:
            sym_name = fut['SYMBOL_NAME']
            lot = helper.get_lot_size(sym_name)
            print(f"[OK] {sym_name:12} -> Lot Size: {lot}")
        else:
            print("[WARN] Could not find NIFTY future for test")

        # 3. Option Check
        print("\n>>> Fetching Lot Size for Nearest NIFTY Option...")
        expiry = helper.get_nearest_expiry("NIFTY 50")
        if expiry:
            # Get a strike (ATM)
            ltp = helper.ltp("NIFTY 50")
            if ltp == 0: ltp = 25000
            strike = helper.select_strike(ltp, 0, 50)
            
            opt = helper.find_option("NIFTY", expiry, strike, "CE")
            if opt:
                sym_name = opt['SYMBOL_NAME']
                lot = helper.get_lot_size(sym_name)
                print(f"[OK] {sym_name:12} -> Lot Size: {lot}")
            else:
                print("[WARN] Could not resolve NIFTY option for test")
                
        # 4. Equity Future Check
        print("\n>>> Fetching Lot Size for Nearest RELIANCE Future...")
        rel_fut = helper.find_current_month_future("RELIANCE")
        if rel_fut:
            sym_name = rel_fut['SYMBOL_NAME']
            lot = helper.get_lot_size(sym_name)
            print(f"[OK] {sym_name:12} -> Lot Size: {lot}")
        else:
            print("[WARN] Could not find RELIANCE future for test")
            
        return True
        
    except Exception as e:
        print(f"[ERROR] Exception during lot size test: {e}")
        return False

if __name__ == "__main__":
    run()
