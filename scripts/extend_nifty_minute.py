
"""
Script to extend NIFTY 1-minute data from 3 years to 5 years.
Fetches the missing 2 years (2021-2023) and merges with existing data.
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
    existing_3y_path = os.path.join(save_dir, "NIFTY_50_1Min_3Y.csv")
    final_5y_path = os.path.join(save_dir, "NIFTY_50_1Min_5Y.csv")
    
    print(f"\n" + "="*60)
    print("EXTENDING TO 5-YEAR 1-MINUTE DATA: NIFTY 50")
    print("="*60)
    
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)
    
    symbol = "NIFTY 50"
    
    # 1. Load Existing 3Y Data
    if not os.path.exists(existing_3y_path):
        print(f"[FAIL] Existing 3Y file not found at {existing_3y_path}")
        return
    
    print(f">>> Loading existing 3-year data...")
    df_existing = pd.read_csv(existing_3y_path, index_col='Datetime', parse_dates=True)
    first_existing_date = df_existing.index.min()
    print(f"    - Existing data starts: {first_existing_date}")
    
    # 2. Determine target start date (5 years ago)
    target_start = datetime.now() - timedelta(days=5*365)
    print(f">>> Need data from {target_start.date()} up to {first_existing_date.date()}")
    
    # 3. Fetch missing 2 years in chunks
    current_start = target_start
    target_end = first_existing_date - timedelta(days=1)
    
    all_new_chunks = []
    chunk_size = 85 
    
    while current_start <= target_end:
        current_end = min(current_start + timedelta(days=chunk_size), target_end)
        
        from_str = current_start.strftime("%Y-%m-%d")
        to_str = current_end.strftime("%Y-%m-%d")
        
        print(f"    - Fetching: {from_str} to {to_str}...")
        
        sec = helper._resolve_symbol(symbol)
        try:
            df_chunk = helper.get_intraday_minute_data(
                security_id=int(sec['SECURITY_ID']),
                exchange_segment="IDX_I",
                instrument_type="INDEX",
                interval="1",
                from_date=from_str,
                to_date=to_str
            )
            
            if not df_chunk.empty:
                # Normalize
                rename_map = {
                    "start_time": "Datetime", "start_Time": "Datetime", "kline_time": "Datetime",
                    "timestamp": "Datetime",
                    "open": "Open", "high": "High", "low": "Low", "close": "Close", "volume": "Volume"
                }
                df_chunk = df_chunk.rename(columns=rename_map)
                if "Datetime" in df_chunk.columns:
                    df_chunk["Datetime"] = pd.to_datetime(df_chunk["Datetime"], unit='s').dt.tz_localize('UTC').dt.tz_convert('Asia/Kolkata').dt.tz_localize(None)
                    df_chunk = df_chunk.set_index("Datetime").sort_index()
                
                desired_cols = ["Open", "High", "Low", "Close", "Volume"]
                df_chunk = df_chunk[[c for c in desired_cols if c in df_chunk.columns]]
                
                all_new_chunks.append(df_chunk)
                print(f"      [OK] Received {len(df_chunk)} rows.")
            else:
                print(f"      [SKIP] No data for this range.")
                
        except Exception as e:
            print(f"      [ERROR] Chunk failed: {e}")
            
        current_start = current_end + timedelta(days=1)
        time.sleep(0.5)

    # 4. Merge and Save
    if all_new_chunks:
        df_new = pd.concat(all_new_chunks)
        print(f"\n>>> Merging with existing data...")
        final_df = pd.concat([df_new, df_existing])
        # Sort and deduplicate
        final_df = final_df[~final_df.index.duplicated(keep='first')].sort_index()
        
        final_df.to_csv(final_5y_path)
        print(f"\n" + "="*60)
        print(f"[SUCCESS] Extension Complete!")
        print(f"Total Rows (5Y): {len(final_df)}")
        print(f"Save Path: {os.path.abspath(final_5y_path)}")
        print("="*60)
    else:
        print("[FAIL] Could not fetch additional data.")

if __name__ == "__main__":
    main()
