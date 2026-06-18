import inspect
from dhanhq import dhanhq

try:
    print("Inspecting dhanhq.option_chain signature:")
    sig = inspect.signature(dhanhq.option_chain)
    print(sig)
except Exception as e:
    print(f"Error inspecting signature: {e}")

# Check docstring if available
try:
    print("\nDocstring:")
    print(dhanhq.option_chain.__doc__)
except:
    pass
