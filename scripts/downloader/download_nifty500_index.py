"""
Script to download Nifty 500 Index historical daily data from Dhan API
and save it to "Historical Data/NIFTY_500_Daily.csv".
"""
import os
import sys
import pandas as pd
from datetime import datetime, timedelta

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def main():
    print("Initializing Dhan Client...")
    dhan = get_dhan_client()
    if not dhan:
        print("[FAIL] Failed to authenticate with Dhan. Check credentials.")
        return
        
    helper = DhanHelper(dhan)
    
    # Nifty 500 Index details:
    # Security ID = 19
    # Segment = IDX_I
    # Instrument = INDEX
    security_id = 19
    segment = "IDX_I"
    instrument = "INDEX"
    
    to_date = datetime.now().strftime("%Y-%m-%d")
    from_date = (datetime.now() - timedelta(days=5 * 365)).strftime("%Y-%m-%d")
    
    print(f"Downloading Nifty 500 Index daily data from {from_date} to {to_date}...")
    
    try:
        df = helper.get_historical_daily_data(
            security_id=security_id,
            exchange_segment=segment,
            instrument_type=instrument,
            from_date=from_date,
            to_date=to_date
        )
        
        if not df.empty:
            if 'timestamp' in df.columns:
                df['Datetime'] = pd.to_datetime(df['timestamp'], unit='s').dt.tz_localize('UTC').dt.tz_convert('Asia/Kolkata').dt.tz_localize(None)
                df.set_index('Datetime', inplace=True)
                df.sort_index(inplace=True)
            
            # Format columns to match NIFTY_50_Daily_5Y.csv
            df_save = df.reset_index()
            # Ensure proper capitalization of standard columns: Datetime, Open, High, Low, Close, Volume
            df_save.columns = [str(c).capitalize() for c in df_save.columns]
            
            # Keep only the required columns: Datetime, Open, High, Low, Close, Volume
            cols_to_keep = ['Datetime', 'Open', 'High', 'Low', 'Close', 'Volume']
            # If volume is missing or named differently, handle it
            if 'Volume' not in df_save.columns:
                df_save['Volume'] = 0
            df_save = df_save[cols_to_keep]
            
            output_path = os.path.join("Historical Data", "NIFTY_500_Daily.csv")
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            df_save.to_csv(output_path, index=False)
            print(f"[SUCCESS] Downloaded {len(df_save)} daily bars. Saved to: {output_path}")
            
            # Print last few records to verify
            print("\nLast 5 records:")
            print(df_save.tail(5))
        else:
            print("[FAIL] No data returned from Dhan API.")
            
    except Exception as e:
        print(f"[ERROR] Failed to fetch or process Nifty 500 Index data: {e}")

if __name__ == "__main__":
    main()
