
from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from datetime import datetime, timedelta
import pandas as pd

def test_history_limit():
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)
    
    # Try fetching 1-min data from 1 year ago
    end_date = datetime.now() - timedelta(days=365)
    start_date = end_date - timedelta(days=5)
    
    from_str = start_date.strftime("%Y-%m-%d")
    to_str = end_date.strftime("%Y-%m-%d")
    
    print(f"Testing 1-min history limit for NIFTY 50...")
    print(f"Requesting range: {from_str} to {to_str}")
    
    df = helper.get_latest_candles("NIFTY 50", interval="1", days=370) 
    # Adjusting logic to target specific date range if helper allows, 
    # but get_latest_candles is relative.
    
    # Let's use the low level call to be precise
    res = helper.get_intraday_minute_data(
        security_id=13,
        exchange_segment="IDX_I",
        instrument_type="INDEX",
        interval="1",
        from_date=from_str,
        to_date=to_str
    )
    
    if not res.empty:
        print(f"[SUCCESS] Received {len(res)} candles from 1 year ago.")
        print(res.head())
    else:
        print("[FAIL] No data received for 1 year ago. Standard intraday API is likely limited (usually 30-90 days).")

if __name__ == "__main__":
    test_history_limit()
