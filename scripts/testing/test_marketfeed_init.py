from dhanhq import marketfeed
import logging

# Mock context
class MockContext:
    def get_client_id(self): return "100"
    def get_access_token(self): return "token"

def on_msg(instance, data): pass

try:
    print("Attempting to instantiate MarketFeed with callbacks...")
    feed = marketfeed.MarketFeed(
        dhan_context=MockContext(),
        instruments=[(1, "123")],
        version="v2",
        on_message=on_msg
    )
    print("Success! MarketFeed accepted callback arguments.")
except TypeError as e:
    print(f"TypeError caught: {e}")
except Exception as e:
    print(f"Other error: {e}")
