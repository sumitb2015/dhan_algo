"""
Script to download 3 years of 1-minute data for a sample of NIFTY 500 stocks.
Reads symbols from MW-NIFTY-500-25-Jan-2026.csv.
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
    csv_path = "MW-NIFTY-500-25-Jan-2026.csv"
    save_dir = "Stocks Historical Data"
    os.makedirs(save_dir, exist_ok=True)
    
    print(f"\n" + "="*60)
    print("STOCKS SAMPLE 1-MINUTE DATA DOWNLOADER (3 YEARS)")
    print("="*60)
    
    # 1. Parse CSV and extract symbols
    if not os.path.exists(csv_path):
        print(f"[FAIL] CSV file not found: {csv_path}")
        return
        
    try:
        # Adjusted for the cleaner CSV format found in the workspace
        # Header is on the first line (index 0)
        df_list = pd.read_csv(csv_path)
        
        # Column 0 is "SYMBOL \n" (based on `Get-Content` output showing newlines in headers)
        # We'll just grab the first column by index to be safe
        symbols = df_list.iloc[:, 0].astype(str).str.strip().tolist()
        
        # Filter out "NIFTY 500" if it's in the list
        symbols = [s for s in symbols if s != "NIFTY 500"]
        
        # LIMIT TO TOP 5 FOR DEMO
        print(f">>> Found {len(symbols)} stocks. Limiting to top 5 for demonstration.")
        symbols = symbols[:5]
        
    except Exception as e:
        print(f"[FAIL] Could not parse CSV symbols: {e}")
        return

    print(f">>> Processing: {symbols}")
    
    # 2. Setup Dhan Client
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)
    
    # 3. Define Date Range (Last 3 Years)
    to_date = datetime.now().strftime("%Y-%m-%d")
    from_date = (datetime.now() - timedelta(days=3*365)).strftime("%Y-%m-%d")
    
    # 4. Processing Loop
    for i, symbol in enumerate(symbols):
        file_path = os.path.join(save_dir, f"{symbol}_1Min_3Y.csv")
        
        # Check if already downloaded (Resume capability)
        if os.path.exists(file_path):
            print(f"[{i+1}/{len(symbols)}] Skipping {symbol} - File already exists.")
            continue
            
        print(f"\n[{i+1}/{len(symbols)}] Processing: {symbol}")
        
        try:
            # Use the core library's long-range fetcher
            df = helper.get_historical_minute_data_long(
                symbol=symbol,
                from_date=from_date,
                to_date=to_date,
                interval="1"
            )
            
            if not df.empty:
                df.to_csv(file_path)
                print(f"      [SUCCESS] Saved {len(df)} rows to {file_path}")
            else:
                print(f"      [SKIP] No data returned for {symbol}.")
                
        except Exception as e:
            print(f"      [ERROR] Failed to fetch {symbol}: {e}")
            
        # Give a small cooling period
        time.sleep(1)

    print(f"\n" + "="*60)
    print("DOWNLOAD COMPLETE!")
    print("="*60)

if __name__ == "__main__":
    main()
