import sys
import os
import inspect

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from dhanhq import dhanhq
    print("dhanhq imported successfully.")
    
    # Print source code of place_order
    source = inspect.getsource(dhanhq.place_order)
    print("\nSource code of dhanhq.place_order:")
    print(source)
            
except Exception as e:
    print("Error:", e)
