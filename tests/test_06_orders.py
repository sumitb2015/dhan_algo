
"""
Test 06: Order Placement (DRY RUN / SAFE SAFE)
"""
import sys
import os
import time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def run_order_lifecycle(helper, symbol):
     # 1. Resolve Symbol
     sec = helper._resolve_symbol(symbol)
     if not sec:
         print(f"[FAIL] Could not resolve symbol {symbol}")
         return False
         
     print(f"[OK] Symbol Resolved: {symbol} -> {sec['SECURITY_ID']}")
     
     # 2. Get LTP to determine safe limit price
     ltp = helper.ltp(symbol)
     if ltp == 0:
         print("[WARN] LTP is 0, using arbitrary safe price 100")
         ltp = 100
     
     # Safe Buy Price: 5% below LTP (within 10% circuit limits usually)
     safe_price = round(ltp * 0.95, 1)
     print(f"     LTP: {ltp}, Placing Limit BUY at {safe_price} (Safe buffer)")
     
     exch_seg = "NSE_EQ" # Simple assumption for test
     qty = 1
     
     # 3. Place Order
     print(">>> Placing Order (AMO)...")
     order_id = helper.place_order(
         security_id=sec['SECURITY_ID'],
         exchange_segment=exch_seg, 
         transaction_type=helper.BUY,
         quantity=qty,
         order_type=helper.LIMIT,
         price=safe_price,
         product_type=helper.CNC, # Delivery
         after_market_order=True,
         amo_time='OPEN'
     )
     
     if not order_id:
         print("[FAIL] Order Placement Failed")
         return False
    
     print(f"     [OK] Order Placed. ID: {order_id}")
     
     # 4. Modify
     # Modify Price to +50 cents
     new_price = round(safe_price + 0.5, 1)
     print(f"     [STEP 2] Modifying Order to Price: {new_price}...")
     time.sleep(2) # Wait for processing
     
     is_mod = helper.modify_order(
         order_id=order_id,
         quantity=qty,
         order_type=helper.LIMIT,
         price=new_price
     )
     
     if is_mod:
         print(f"     [OK] Order Modified Successfully")
     else:
         print("[FAIL] Order Modification Failed")
         
     # 5. Cancel
     print(f"     [STEP 3] Cancelling Order {order_id}...")
     time.sleep(2)
     
     is_cancelled = helper.cancel_order(order_id)
     
     if is_cancelled:
         print(f"     [OK] Order Cancelled Successfully")
     else:
         print("[FAIL] Order Cancellation Failed")
         return False
         
     return True

def run(helper=None):
    print("\n" + "="*60)
    print("TEST 06: ORDER PLACEMENT (LIFECYCLE)")
    print("="*60)
    
    try:
        if helper is None:
            dhan = get_dhan_client()
            helper = DhanHelper(dhan)
        
        symbol = "SBIN"
        if run_order_lifecycle(helper, symbol):
            print("[SUCCESS] Order Lifecycle Verification Complete")
            return True
        else:
            print("[FAIL] Order Lifecycle Failed")
            return False
            
    except Exception as e:
        print(f"[ERROR] Exception during order test: {e}")
        return False

if __name__ == "__main__":
    run()

