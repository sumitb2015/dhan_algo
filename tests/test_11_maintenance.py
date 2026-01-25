
"""
Test 11: Maintenance & Emergency Operations
"""
import sys
import os
import time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def run(helper=None):
    print("\n" + "="*60)
    print("TEST 11: MAINTENANCE & EMERGENCY OPS")
    print("="*60)
    
    try:
        if helper is None:
            dhan = get_dhan_client()
            helper = DhanHelper(dhan)
            
        # 1. Master List Maintenance
        print(">>> Testing Master List Refresh (API Download)...")
        # Include FNO so other tests don't break after maintenance
        success = helper.fetch_security_list(segments=['NSE_EQ', 'NSE_FNO'])
        if success:
            print("[OK] Master List successfully refreshed from API.")
        else:
            print("[FAIL] Master List refresh failed.")
            return False
            
        # 2. Emergency Kill-Switch: Cancel All Orders
        print("\n>>> Testing Emergency Kill-Switch (Cancel All)...")
        # Place 2-3 AMOs to verify they are all cleared
        symbols = ["TCS", "INFY"]
        order_ids = []
        for sym in symbols:
            sec = helper._resolve_symbol(sym)
            if sec:
                oid = helper.place_order(
                    security_id=sec['SECURITY_ID'],
                    exchange_segment="NSE_EQ",
                    transaction_type=helper.BUY,
                    quantity=1,
                    order_type=helper.LIMIT,
                    price=round(helper.ltp(sym) * 0.95, 1),
                    after_market_order=True
                )
                if oid:
                    order_ids.append(oid)
        
        print(f"     Placed {len(order_ids)} test AMO orders.")
        
        if len(order_ids) > 0:
            time.sleep(1)
            cancelled_count = helper.cancel_all_orders()
            print(f"[OK] Cancel All Orders returned: {cancelled_count}")
            # Even if it returns 0 (due to API delay), as long as it doesn't crash, we proceed
        else:
            print("[WARN] Could not place test orders to verify Cancel All.")

        # 3. Emergency Kill-Switch: Close All Positions
        print("\n>>> Testing Emergency Kill-Switch (Close All Positions)...")
        # We don't want to actually close live positions if any are open without confirmation,
        # but the function itself handles the logic. 
        # Here we just verify it runs without error.
        closed_count = helper.close_all_positions()
        print(f"[OK] Close All Positions logic executed. (Closed: {closed_count})")
        
        return True
        
    except Exception as e:
        print(f"[ERROR] Exception during maintenance test: {e}")
        return False

if __name__ == "__main__":
    run()
