from login import get_dhan_client
import json

# Initialize Dhan client
dhan = get_dhan_client()

print("Testing different exchange segment formats for expiry_list...")
print("=" * 80)

# Test different exchange segment formats
test_cases = [
    {"under_security_id": 13, "under_exchange_segment": "IDX_I"},
    {"under_security_id": 13, "under_exchange_segment": "NSE_FNO"},
    {"under_security_id": 13, "under_exchange_segment": "NSE"},
    {"under_security_id": 25, "under_exchange_segment": "IDX_I"},  # Bank Nifty
    {"under_security_id": 25, "under_exchange_segment": "NSE_FNO"},
]

for i, params in enumerate(test_cases, 1):
    print(f"\nTest {i}: {params}")
    print("-" * 80)
    
    try:
        result = dhan.expiry_list(**params)
        
        if result.get('status') == 'success':
            data = result.get('data', [])
            print(f"[OK] Success! Found {len(data)} expiries")
            if data:
                print(f"  First expiry: {data[0]}")
                print(f"  Last expiry: {data[-1]}")
        else:
            print(f"[FAIL] Failed: {result.get('remarks')}")
            
    except Exception as e:
        print(f"[ERROR] Exception: {type(e).__name__}: {str(e)}")

print("\n" + "=" * 80)
print("Testing complete!")
