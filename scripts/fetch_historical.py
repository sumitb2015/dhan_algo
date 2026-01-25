from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from datetime import datetime, timedelta
import pandas as pd

def fetch_nifty_candles():
    print("Initializing Dhan Client...")
    dhan_client = get_dhan_client()
    
    if not dhan_client:
        print("Failed to initialize client.")
        return

    helper = DhanHelper(dhan_client)
    
    # Nifty 50 Index: Security ID 13, Segment IDX_I
    security_id = "13"
    exchange_segment = "IDX_I"
    instrument_type = "INDEX"
    
    # Calculate dates (past 5 days)
    to_date = datetime.now().strftime("%Y-%m-%d")
    from_date = (datetime.now() - timedelta(days=5)).strftime("%Y-%m-%d")

    print(f"Fetching 5-minute candles for Nifty 50 from {from_date} to {to_date}...")
    
    # Use our new helper method
    df = helper.get_historical_data(
        security_id=security_id,
        exchange_segment=exchange_segment,
        instrument_type=instrument_type,
        from_date=from_date,
        to_date=to_date,
        interval="5" # 5-minute interval
    )

    if not df.empty:
        print("\nSuccess! Historical Data Fetched:")
        # Convert start_Time if it exists to human readable
        if 'start_Time' in df.columns:
            df['timestamp'] = df['start_Time'].apply(helper.epoch_to_datetime)
        
        print(df[['timestamp', 'open', 'high', 'low', 'close', 'volume']].tail(10))
    else:
        print("\nFailed to fetch data or no data returned.")
        print("Note: If you get DH-902 error, please ensure 'Data APIs' are enabled on your Dhan Dashboard.")

if __name__ == "__main__":
    fetch_nifty_candles()
