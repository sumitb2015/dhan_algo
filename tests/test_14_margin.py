
"""
Test 14: Margin Calculator Verification
"""
import sys
import os
import json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def run(helper=None):
    print("\n" + "="*60)
    print("TEST 14: MARGIN CALCULATOR")
    print("="*60)
    
    try:
        if helper is None:
            dhan = get_dhan_client()
            helper = DhanHelper(dhan)
            
        # 1. Equity Margin Calculation
        print(">>> Calculating Margin for RELIANCE (10 Shares, CNC)...")
        margin = helper.get_margin_required("RELIANCE", 10, "BUY", product_type="CNC")
        
        if margin:
            print(f"[OK] Margin Details: {json.dumps(margin, indent=2)}")
            print(f"     Total Margin Required: Rs. {margin.get('totalMargin', 0)}")
        else:
            print("[FAIL] Could not calculate margin for RELIANCE")
            return False
            
        # 2. F&O Margin Calculation (NIFTY Future)
        print("\n>>> Calculating Margin for NIFTY Future (1 Lot, MARGIN)...")
        fut = helper.find_current_month_future("NIFTY")
        if fut:
            sym = fut['SYMBOL_NAME']
            lot = helper.get_lot_size(sym)
            margin_fno = helper.get_margin_required(sym, lot, "BUY", product_type="MARGIN")
            
            if margin_fno:
                print(f"[OK] Margin Details: {json.dumps(margin_fno, indent=2)}")
                print(f"     SPAN Margin: Rs. {margin_fno.get('spanMargin', 0)}")
                print(f"     Exposure Margin: Rs. {margin_fno.get('exposureMargin', 0)}")
                print(f"     Total Margin Required: Rs. {margin_fno.get('totalMargin', 0)}")
            else:
                print(f"[FAIL] Could not calculate margin for {sym}")
        else:
            print("[WARN] Could not find NIFTY future for test")
            
        return True
        
    except Exception as e:
        print(f"[ERROR] Exception during margin test: {e}")
        return False

if __name__ == "__main__":
    run()
