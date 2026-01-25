from login import get_dhan_client
import json

# Initialize Dhan client
dhan = get_dhan_client()

print("Testing expiry_list - Verification")
print("=" * 80)

# Test 1: Nifty
print("\n1. Nifty 50 (Security ID: 13)")
print("-" * 80)
expiry_list = dhan.expiry_list(under_security_id=13, under_exchange_segment="IDX_I")
print(json.dumps(expiry_list, indent=2))

# Test 2: Bank Nifty
print("\n2. Bank Nifty (Security ID: 25)")
print("-" * 80)
banknifty_expiry = dhan.expiry_list(under_security_id=25, under_exchange_segment="IDX_I")
print(json.dumps(banknifty_expiry, indent=2))

# Test 3: Fin Nifty
print("\n3. Fin Nifty (Security ID: 27)")
print("-" * 80)
finnifty_expiry = dhan.expiry_list(under_security_id=27, under_exchange_segment="IDX_I")
print(json.dumps(finnifty_expiry, indent=2))

print("\n" + "=" * 80)
print("All tests completed successfully!")
