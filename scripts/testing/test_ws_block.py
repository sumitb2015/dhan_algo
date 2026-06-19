import time
import threading
import sys
import os

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from dhanhq.marketfeed import MarketFeed

dhan = get_dhan_client()

class DhanContextAdapter:
    def __init__(self, dhan_client):
        self.client = dhan_client
    def get_client_id(self):
        if hasattr(self.client, 'dhan_http'):
            return getattr(self.client.dhan_http, 'client_id', "")
        return getattr(self.client, 'client_id', "")
    def get_access_token(self):
        if hasattr(self.client, 'dhan_http'):
            return getattr(self.client.dhan_http, 'access_token', "")
        return getattr(self.client, 'access_token', "")

context = DhanContextAdapter(dhan)

def on_connect(instance):
    print("CONNECTED!")

def on_message(instance, msg):
    print(f"MSG: {msg}")

feed = MarketFeed(
    dhan_context=context,
    instruments=[("IDX_I", "13", 15)],
    on_connect=on_connect,
    on_message=on_message
)

print("Calling run()...")
feed.run()
print("run() RETURNED!")
