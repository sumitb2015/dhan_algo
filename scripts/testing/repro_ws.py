import time
import threading
import sys
import os
import asyncio

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from dhanhq.marketfeed import MarketFeed

dhan = get_dhan_client()

class DhanContextAdapter:
    def __init__(self, dhan_client):
        self.client = dhan_client
    def get_client_id(self):
        return getattr(self.client.dhan_http, 'client_id', "") if hasattr(self.client, 'dhan_http') else getattr(self.client, 'client_id', "")
    def get_access_token(self):
        return getattr(self.client.dhan_http, 'access_token', "") if hasattr(self.client, 'dhan_http') else getattr(self.client, 'access_token', "")

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

def run_it():
    print("Background thread: Calling feed.run()...")
    feed.run()
    print("Background thread: feed.run() RETURNED!")

t = threading.Thread(target=run_it)
t.start()

print("Main thread: Sleeping for 20 seconds...")
time.sleep(20)
print("Main thread: Done.")
if t.is_alive():
    print("Background thread is STILL ALIVE.")
else:
    print("Background thread HAS DIED.")
