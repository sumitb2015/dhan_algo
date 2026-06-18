import inspect
from dhanhq import dhanhq

try:
    print("Inspecting dhanhq.quote_data signature:")
    # Note: method might be named quote or get_quote, checking instance
    # Creating a dummy client to check method existence
    print(inspect.signature(dhanhq.quote_data))
except Exception as e:
    print(f"Error inspecting signature: {e}")

# Check docstring
try:
    print("\nDocstring:")
    print(dhanhq.quote_data.__doc__)
except:
    pass
