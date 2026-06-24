import sys
import os
import inspect

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from dhanhq import dhanhq, DhanContext
    print("dhanhq imported successfully.")
    
    # Initialize client
    context = DhanContext("client_id", "access_token")
    d = dhanhq(context)
    
    print("\nAttributes in dhanhq client instance:")
    for attr in dir(d):
        if not attr.startswith('_') and attr.isupper():
            print(f"  {attr} = {getattr(d, attr)}")
            
except Exception as e:
    print("Error:", e)
