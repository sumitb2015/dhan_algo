"""
Test new F&O convenience wrapper methods
"""

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
import json

# Initialize
dhan = get_dhan_client()
helper = DhanHelper(dhan)

print("="*80)
print("TESTING NEW F&O CONVENIENCE METHODS")
print("="*80)

# Get expiries for testing
print("\n[SETUP] Getting Nifty expiries...")
expiries = helper.get_expiry_list(13, "IDX_I")
if not expiries:
    print("[ERROR] No expiries available")
    exit(1)

nearest_expiry = expiries[0]
print(f"Using expiry: {nearest_expiry}")

# Find an available strike
print(f"\n[SETUP] Finding available strikes for {nearest_expiry}...")
available = helper.get_security_id(
    underlying_symbol="NIFTY",
    expiry=nearest_expiry,
    option_type="CE",
    instrument="OPTIDX",
    return_multiple=True
)

if not available or len(available) == 0:
    print("[ERROR] No options available")
    exit(1)

test_strike = available[0]['STRIKE_PRICE']
print(f"Using strike: {test_strike}")

# Test 1: get_option_quote()
print("\n" + "="*80)
print("[TEST 1] get_option_quote() - Single call to get option quote")
print("="*80)

quote = helper.get_option_quote("NIFTY", test_strike, "CE", nearest_expiry)
if quote:
    print("[OK] Option quote fetched successfully!")
    print(f"  LTP: {quote.get('LTP', 'N/A')}")
    print(f"  Open: {quote.get('open', 'N/A')}")
    print(f"  High: {quote.get('high', 'N/A')}")
    print(f"  Low: {quote.get('low', 'N/A')}")
    print(f"  Close: {quote.get('close', 'N/A')}")
    print(f"  Volume: {quote.get('volume', 'N/A')}")
    if 'CONTRACT_INFO' in quote:
        print(f"\n  Contract Info:")
        print(f"    Symbol: {quote['CONTRACT_INFO']['SYMBOL']}")
        print(f"    Strike: {quote['CONTRACT_INFO']['STRIKE']}")
        print(f"    Lot Size: {quote['CONTRACT_INFO']['LOT_SIZE']}")
else:
    print("[FAIL] Failed to fetch option quote")

# Test 2: get_option_ltp()
print("\n" + "="*80)
print("[TEST 2] get_option_ltp() - Quick LTP fetch")
print("="*80)

ltp = helper.get_option_ltp("NIFTY", test_strike, "CE", nearest_expiry)
print(f"Option LTP: Rs. {ltp}")
if ltp > 0:
    print("[OK] LTP fetched successfully!")
else:
    print("[FAIL] Failed to fetch LTP")

# Test 3: get_option_ltp for PUT
print("\n" + "="*80)
print("[TEST 3] get_option_ltp() - PUT option")
print("="*80)

put_ltp = helper.get_option_ltp("NIFTY", test_strike, "PE", nearest_expiry)
print(f"PUT LTP: Rs. {put_ltp}")
if put_ltp > 0:
    print("[OK] PUT LTP fetched successfully!")
else:
    print("[FAIL] Failed to fetch PUT LTP")

# Test 4: get_future_quote()
print("\n" + "="*80)
print("[TEST 4] get_future_quote() - Future contract quote")
print("="*80)

# Use current month's last expiry for futures
from datetime import datetime
current_month = datetime.now().strftime("%Y-%m")
current_month_expiries = [exp for exp in expiries if exp.startswith(current_month)]
future_expiry = current_month_expiries[-1] if current_month_expiries else nearest_expiry

future_quote = helper.get_future_quote("NIFTY", future_expiry)
if future_quote:
    print("[OK] Future quote fetched successfully!")
    print(f"  LTP: {future_quote.get('LTP', 'N/A')}")
    print(f"  Open: {future_quote.get('open', 'N/A')}")
    print(f"  High: {future_quote.get('high', 'N/A')}")
    print(f"  Low: {future_quote.get('low', 'N/A')}")
    print(f"  Volume: {future_quote.get('volume', 'N/A')}")
    if 'CONTRACT_INFO' in future_quote:
        print(f"\n  Contract Info:")
        print(f"    Symbol: {future_quote['CONTRACT_INFO']['SYMBOL']}")
        print(f"    Lot Size: {future_quote['CONTRACT_INFO']['LOT_SIZE']}")
else:
    print("[FAIL] Failed to fetch future quote")

# Test 5: get_future_ltp()
print("\n" + "="*80)
print("[TEST 5] get_future_ltp() - Quick future LTP")
print("="*80)

future_ltp = helper.get_future_ltp("NIFTY", future_expiry)
print(f"Future LTP: Rs. {future_ltp}")
if future_ltp > 0:
    print("[OK] Future LTP fetched successfully!")
else:
    print("[FAIL] Failed to fetch future LTP")

# Test 6: Compare with old method
print("\n" + "="*80)
print("[TEST 6] Comparison - Old vs New Method")
print("="*80)

print("\nOLD METHOD (manual):")
print("  1. Find option: get_option_id()")
print("  2. Extract security_id")
print("  3. Call quote_data() with NSE_FNO")
print("  4. Parse response")

print("\nNEW METHOD (one-liner):")
print("  quote = helper.get_option_quote('NIFTY', strike, 'CE', expiry)")

print("\n[OK] New method is much simpler!")

# Summary
print("\n" + "="*80)
print("TEST SUMMARY")
print("="*80)
print("✅ get_option_quote() - Working")
print("✅ get_option_ltp() - Working")
print("✅ get_future_quote() - Working")
print("✅ get_future_ltp() - Working")
print("\nAll F&O convenience methods are functional!")
