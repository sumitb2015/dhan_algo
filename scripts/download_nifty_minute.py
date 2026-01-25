
"""
Script to download 3 years of 1-minute Historical Data for NIFTY 50.
Uses chunked requests to bypass the 90-day API limit.
"""
import sys
import os
import pandas as pd
import time
from datetime import datetime, timedelta
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def main():
    save_dir = "Historical Data"
    os.makedirs(save_dir, exist_ok=True)
    file_path = os.path.join(save_dir, "NIFTY_50_1Min_3Y.csv")
    
    print(f"\n" + "="*60)
    print("3-YEAR 1-MINUTE DATA DOWNLOAD: NIFTY 50")
    print("="*60)
    
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)
    
    symbol = "NIFTY 50"
    end_total = datetime.now()
    start_total = end_total - timedelta(days=3*365) # 3 years
    
    current_start = start_total
    all_chunks = []
    
    # We use 85-day chunks (API limit is 90)
    chunk_size = 85 
    
    print(f">>> Requesting data from {start_total.date()} to {end_total.date()}...")
    
    while current_start < end_total:
        current_end = min(current_start + timedelta(days=chunk_size), end_total)
        
        from_str = current_start.strftime("%Y-%m-%d")
        to_str = current_end.strftime("%Y-%m-%d")
        
        print(f"    - Fetching: {from_str} to {to_str}...")
        
        sec = helper._resolve_symbol(symbol)
        
        try:
            # Low-level call to handle specific dates
            df_chunk = helper.get_intraday_minute_data(
                security_id=int(sec['SECURITY_ID']),
                exchange_segment="IDX_I",
                instrument_type="INDEX",
                interval="1",
                from_date=from_str,
                to_date=to_str
            )
            
            if not df_chunk.empty:
                # Standardize this specific chunk
                rename_map = {
                    "start_time": "Datetime", "start_Time": "Datetime", "kline_time": "Datetime",
                    "timestamp": "Datetime",
                    "open": "Open", "high": "High", "low": "Low", "close": "Close", "volume": "Volume"
                }
                df_chunk = df_chunk.rename(columns=rename_map)
                
                if "Datetime" in df_chunk.columns:
                    df_chunk["Datetime"] = pd.to_datetime(df_chunk["Datetime"], unit='s').dt.tz_localize('UTC').dt.tz_convert('Asia/Kolkata').dt.tz_localize(None)
                    df_chunk = df_chunk.set_index("Datetime").sort_index()
                
                # Filter strictly standard columns
                desired_cols = ["Open", "High", "Low", "Close", "Volume"]
                df_chunk = df_chunk[[c for c in desired_cols if c in df_chunk.columns]]
                
                all_chunks.append(df_chunk)
                print(f"      [OK] Received {len(df_chunk)} rows.")
            else:
                print(f"      [SKIP] No data for this range.")
                
        except Exception as e:
            print(f"      [ERROR] Chunk failed: {e}")
            
        # Move to next chunk
        current_start = current_end + timedelta(days=1)
        time.sleep(0.5) 
        
    if all_chunks:
        final_df = pd.concat(all_chunks)
        final_df = final_df[~final_df.index.duplicated(keep='first')].sort_index()
        
        final_df.to_csv(file_path)
        print(f"\n" + "="*60)
        print(f"[SUCCESS] Download Complete!")
        print(f"Total Rows: {len(final_df)}")
        print(f"Save Path: {os.path.abspath(file_path)}")
        print("="*60)
    else:
        print("[FAIL] No data collected.")

if __name__ == "__main__":
    main()
