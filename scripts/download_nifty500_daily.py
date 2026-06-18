
"""
Script to download 2 years of Daily Historical Data for NIFTY 500 stocks.
Reads symbols from MW-NIFTY-500-25-Jan-2026.csv and saves directly to CSV.
"""
import sys
import os
import pandas as pd
import time
from datetime import datetime

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def main():
    # 1. Setup Configuration
    csv_path = "MW-NIFTY-500-25-Jan-2026.csv"
    save_dir = "Stocks Daily Historical Data"
    os.makedirs(save_dir, exist_ok=True)
    
    # 2 Years = ~730 days
    DAYS_BACK = 730 
    
    print(f"\n" + "="*60)
    print("NIFTY 500 DAILY DATA DOWNLOADER (2 YEARS)")
    print("="*60)
    
    # 2. Parse CSV and extract symbols
    if not os.path.exists(csv_path):
        print(f"[FAIL] CSV file not found: {csv_path}")
        return
        
    try:
        # Based on file inspection, skip 16 rows metadata
        df_list = pd.read_csv(csv_path, skiprows=16)
        # First column is SYMBOL
        symbols = df_list.iloc[:, 0].str.strip().tolist()
        
        # Filter unwanted symbols
        symbols = [s for s in symbols if s != "NIFTY 500" and isinstance(s, str) and len(s) > 0]
        
    except Exception as e:
        print(f"[FAIL] Could not parse CSV symbols: {e}")
        return

    print(f">>> Found {len(symbols)} stocks to process.")
    
    # 3. Setup Dhan Client
    try:
        dhan = get_dhan_client()
        helper = DhanHelper(dhan)
    except Exception as e:
        print(f"[CRITICAL] Failed to initialize Dhan Client: {e}")
        return
    
    # 4. Processing Loop
    success_count = 0
    
    for i, symbol in enumerate(symbols):
        file_path = os.path.join(save_dir, f"{symbol}_Daily_2Y.csv")
        
        # Check if already downloaded (Resume capability)
        if os.path.exists(file_path):
            print(f"[{i+1}/{len(symbols)}] Skipping {symbol} - File already exists.")
            continue
            
        print(f"[{i+1}/{len(symbols)}] Fetching Daily Data: {symbol}")
        
        try:
            # Fetch Daily Data
            df = helper.get_latest_candles(symbol, interval="D", days=DAYS_BACK)
            
            if not df.empty:
                df.to_csv(file_path)
                print(f"      [SUCCESS] Saved {len(df)} rows.")
                success_count += 1
            else:
                print(f"      [SKIP] No data returned for {symbol}.")
                
        except Exception as e:
            print(f"      [ERROR] Failed to fetch {symbol}: {e}")
            
        # Small delay to be polite to the API
        time.sleep(0.2) 

    print(f"\n" + "="*60)
    print(f"DOWNLOAD COMPLETE! Successfully downloaded: {success_count}/{len(symbols)}")
    print(f"Data saved to: {os.path.abspath(save_dir)}")
    print("="*60)

if __name__ == "__main__":
    main()
