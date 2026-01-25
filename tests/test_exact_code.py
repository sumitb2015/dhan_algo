"""
Simple test to replicate the exact code you're running
"""
from login import get_dhan_client
import json

# Initialize
dhan = get_dhan_client()

# Exact code from your notebook
expiry_list = dhan.expiry_list(under_security_id=13, under_exchange_segment="IDX_I")
print(json.dumps(expiry_list, indent=2))

# Also test with helper
print("\n" + "="*80)
print("Testing with DhanHelper:")
print("="*80)

from lib.dhan_helper import DhanHelper
helper = DhanHelper(dhan)

expiries = helper.get_expiry_list(under_security_id=13, under_exchange_segment="IDX_I")
print(f"Expiries found: {len(expiries)}")
if expiries:
    print(f"First expiry: {expiries[0]}")
    print(f"Last expiry: {expiries[-1]}")
    print(f"\nAll expiries: {expiries}")
else:
    print("No expiries returned")
