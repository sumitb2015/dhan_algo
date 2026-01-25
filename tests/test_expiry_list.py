from login import get_dhan_client
import json

# Initialize Dhan client
dhan = get_dhan_client()

print("Testing expiry_list function...")
print("=" * 80)

try:
    # Test expiry_list for Nifty
    result = dhan.expiry_list(
        under_security_id=13,
        under_exchange_segment="IDX_I"
    )
    
    print("Success!")
    print("\nResponse:")
    print(json.dumps(result, indent=2))
    
except Exception as e:
    print(f"Error Type: {type(e).__name__}")
    print(f"Error Message: {str(e)}")
    
    import traceback
    print("\nFull Traceback:")
    traceback.print_exc()
