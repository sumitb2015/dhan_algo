from dhanhq import marketfeed
import inspect

print("MarketFeed MRO:")
print(marketfeed.MarketFeed.mro())

print("\nHas start method?", hasattr(marketfeed.MarketFeed, 'start'))
print("Has run_forever method?", hasattr(marketfeed.MarketFeed, 'run_forever'))
