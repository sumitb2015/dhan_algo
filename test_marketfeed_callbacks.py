from dhanhq import marketfeed
import inspect

class MockContext:
    def get_client_id(self): return "100"
    def get_access_token(self): return "token"

def on_msg(instance, data): pass

try:
    print("Instantiating MarketFeed without callbacks...")
    feed = marketfeed.MarketFeed(MockContext(), [(1, "123")])
    
    print("Setting callbacks as attributes...")
    feed.on_connect = on_msg
    feed.on_message = on_msg
    feed.on_error = on_msg
    feed.on_close = on_msg
    
    print("Success! Attributes set.")
    
    print("\nInspecting connect() signature:")
    # Check if connect accepts callbacks
    if hasattr(feed, 'connect'):
        print(inspect.signature(feed.connect))
    
    print("\nInspecting run_forever() signature:")
    if hasattr(feed, 'run_forever'):
        print(inspect.signature(feed.run_forever))

except Exception as e:
    print(f"Error: {e}")
