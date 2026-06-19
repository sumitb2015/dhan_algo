import inspect
from dhanhq import marketfeed

class MockContext:
    def get_client_id(self): return "123"
    def get_access_token(self): return "abc"

mf = marketfeed.MarketFeed(MockContext(), [])
print("Methods in MarketFeed:")
for name, member in inspect.getmembers(mf, predicate=inspect.ismethod):
    print(f"Method: {name}, Signature: {inspect.signature(member)}")
