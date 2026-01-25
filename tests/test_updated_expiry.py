from login import get_dhan_client
from lib.dhan_helper import DhanHelper
import json

# Initialize
dhan = get_dhan_client()
helper = DhanHelper(dhan)

print("Testing Updated get_expiry_list Helper Function")
print("=" * 80)

# Test 1: Direct SDK call (your way)
print("\n1. Direct SDK Call:")
print("-" * 80)
expiry_data = dhan.expiry_list(under_security_id=13, under_exchange_segment="IDX_I")
print("Full Response:")
print(json.dumps(expiry_data, indent=2))

if expiry_data.get('status') == 'success':
    expiries_list = expiry_data['data']['data']
    print(f"\nExpiries extracted: {len(expiries_list)}")
    print(f"Expiries: {expiries_list}")

# Test 2: Using helper function (updated)
print("\n\n2. Using DhanHelper (Updated):")
print("-" * 80)
expiries = helper.get_expiry_list(under_security_id=13, under_exchange_segment="IDX_I")
print(f"Expiries found: {len(expiries)}")
print(f"Expiries: {expiries}")

# Test 3: Bank Nifty
print("\n\n3. Bank Nifty Expiries:")
print("-" * 80)
banknifty_expiries = helper.get_expiry_list(under_security_id=25, under_exchange_segment="IDX_I")
print(f"Expiries found: {len(banknifty_expiries)}")
if banknifty_expiries:
    print(f"First expiry: {banknifty_expiries[0]}")
    print(f"Last expiry: {banknifty_expiries[-1]}")

# Test 4: Fin Nifty
print("\n\n4. Fin Nifty Expiries:")
print("-" * 80)
finnifty_expiries = helper.get_expiry_list(under_security_id=27, under_exchange_segment="IDX_I")
print(f"Expiries found: {len(finnifty_expiries)}")
if finnifty_expiries:
    print(f"First expiry: {finnifty_expiries[0]}")

print("\n" + "=" * 80)
print("Testing Complete!")
