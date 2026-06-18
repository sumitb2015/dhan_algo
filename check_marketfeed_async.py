import inspect
import asyncio
from dhanhq import marketfeed

class MockContext:
    def get_client_id(self): return "123"
    def get_access_token(self): return "abc"

mf = marketfeed.MarketFeed(MockContext(), [])
print(f"Is run_forever a coroutine function? {asyncio.iscoroutinefunction(mf.run_forever)}")
