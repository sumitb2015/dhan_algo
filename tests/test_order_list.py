from login import get_dhan_client
import json

# Initialize Dhan client
dhan = get_dhan_client()

print("Testing dhan.get_order_list()...")
print("=" * 50)

try:
    # Fetch all orders
    orders = dhan.get_order_list()
    
    # Check if we got a response
    if orders:
        print("[OK] Successfully fetched orders!")
        print(f"Total orders: {len(orders) if isinstance(orders, list) else 'N/A'}")
        print("\nResponse:")
        print(json.dumps(orders, indent=2))
    else:
        print("[ERROR] No orders found or empty response")
        print(f"Response: {orders}")
        
except Exception as e:
    print(f"[ERROR] Error occurred: {type(e).__name__}")
    print(f"Error message: {str(e)}")
    import traceback
    traceback.print_exc()
