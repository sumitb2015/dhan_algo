from dhanhq import marketfeed
import inspect

print("MarketFeed Attributes/Methods:")
for x in dir(marketfeed.MarketFeed):
    if x.startswith('on_'):
        print(f"Callback attribute found: {x}")
    elif not x.startswith('__'):
        print(x)
