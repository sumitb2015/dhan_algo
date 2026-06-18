import sys
import os
import time

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def test_ws_segments():
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)
    
    # We'll use the low-level MarketFeed if possible, or just helper
    # 0 = Index, 1 = NSE, 2 = FNO
    # But some documentation says 0 = INDEX
    
    print("Testing WebSocket with 'INDEX' segment (id: 0)...")
    def on_tick(instance, data):
        print(f"WS TICK: {data}")

    # Use 'INDEX' instead of IDX_I for the mapping
    instruments = [("INDEX", "13", 15)] # (Exchange, SID, Code)
    
    # We need to see how the SDK handles "INDEX"
    # In helper.start_websocket, it takes the instruments as is.
    
    ws = helper.start_websocket(instruments, on_message=on_tick)
    
    print("Waiting 10 seconds for ticks...")
    time.sleep(10)
    print("Done.")

if __name__ == "__main__":
    test_ws_segments()
