import inspect
from dhanhq import marketfeed

try:
    print("Inspecting marketfeed.MarketFeed signature:")
    sig = inspect.signature(marketfeed.MarketFeed)
    print(sig)
except Exception as e:
    print(f"Error inspecting signature: {e}")

# Check docstring if available
try:
    print("\nDocstring:")
    print(marketfeed.MarketFeed.__doc__)
except:
    pass
