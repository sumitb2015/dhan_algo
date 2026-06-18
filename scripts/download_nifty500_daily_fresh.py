import sys
import os
import pandas as pd
import time
from datetime import datetime, timedelta
import warnings

# Suppress warnings
warnings.filterwarnings("ignore")

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def main():
    csv_path = "MW-NIFTY-500-25-Jan-2026.csv"
    output_dir = "Daily_Historical_Data_Fresh"
    os.makedirs(output_dir, exist_ok=True)
    
    print(f"\n" + "="*60)
    print("NIFTY 500 DAILY DATA FRESH DOWNLOADER (2 YEARS)")
    print("="*60)
    
    # 1. Parse CSV and extract symbols
    if not os.path.exists(csv_path):
        print(f"[FAIL] CSV file not found: {csv_path}")
        return
        
    try:
        # Skip header metadata rows
        df_list = pd.read_csv(csv_path, skiprows=16)
        symbols = df_list.iloc[:, 0].str.strip().tolist()
        symbols = [s for s in symbols if s != "NIFTY 500"]
    except Exception as e:
        print(f"[FAIL] Could not parse CSV symbols: {e}")
        return

    print(f">>> Found {len(symbols)} stocks to process.")
    
    # 2. Setup Dhan Client
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)
    
    # 3. Define Date Range (Last 2 Years)
    to_date = datetime.now().strftime("%Y-%m-%d")
    from_date = (datetime.now() - timedelta(days=2*365)).strftime("%Y-%m-%d")
    
    # 4. Processing Loop
    success_count = 0
    fail_count = 0
    
    for i, symbol in enumerate(symbols):
        file_path = os.path.join(output_dir, f"{symbol}_Daily_2Y.parquet")
        
        # Resume capability
        if os.path.exists(file_path):
            print(f"[{i+1}/{len(symbols)}] Skipping {symbol} - Already exists.")
            success_count += 1
            continue
            
        print(f"[{i+1}/{len(symbols)}] Fetching: {symbol}...", end="", flush=True)
        
        try:
            # Resolve symbol to get security details
            sec = helper.get_security_id(symbol=symbol, instrument="EQUITY")
            if not sec:
                print(" Symbol Not Found")
                fail_count += 1
                continue
                
            security_id = int(sec['SECURITY_ID'])
            segment = sec['SEGMENT'] # e.g. NSE_EQ
            instrument = sec['INSTRUMENT'] # e.g. EQUITY
            
            # Fetch Daily Data
            df = helper.get_historical_daily_data(
                security_id=security_id,
                exchange_segment=segment,
                instrument_type=instrument,
                from_date=from_date,
                to_date=to_date
            )
            
            if not df.empty:
                # Standardize columns if needed (Dhan usually returns timestamp/open/high/low/close/volume)
                # Ensure it's sorted by date
                if 'timestamp' in df.columns:
                    df['Datetime'] = pd.to_datetime(df['timestamp'])
                    df.set_index('Datetime', inplace=True)
                    df.sort_index(inplace=True)
                
                df.to_parquet(file_path)
                print(f" Success ({len(df)} days)")
                success_count += 1
            else:
                print(" No Data")
                fail_count += 1
                
        except Exception as e:
            print(f" Error: {e}")
            fail_count += 1
            
        # Rate limit safety
        time.sleep(0.5)

    print(f"\n" + "="*60)
    print(f"DOWNLOAD COMPLETE!")
    print(f"Success: {success_count} | Failed: {fail_count}")
    print(f"Folder: {output_dir}")
    print("="*60)

if __name__ == "__main__":
    main()
