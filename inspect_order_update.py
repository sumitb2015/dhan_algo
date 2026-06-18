import inspect
from dhanhq import OrderUpdate

try:
    print("Inspecting OrderUpdate signature:")
    # Check init signature
    print(inspect.signature(OrderUpdate.__init__))
except Exception as e:
    print(f"Error inspecting OrderUpdate init: {e}")

try:
    print("\nOrderUpdate Attributes/Methods:")
    for x in dir(OrderUpdate):
        if not x.startswith('__'):
            print(x)
except Exception as e:
    print(f"Error inspecting OrderUpdate dir: {e}")
