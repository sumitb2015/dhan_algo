
"""
Script to download 1 year of Daily Historical Data for NIFTY 50.
"""
import sys
import os
import pandas as pd
from datetime import datetime
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def main():
    # 1. Setup Folder
    save_dir = "Historical Data"
    os.makedirs(save_dir, exist_ok=True)
    file_path = os.path.join(save_dir, "NIFTY_50_Daily_5Y.csv")
    
    print(f">>> Initializing Download...")
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)
    
    # 2. Fetch Data
    symbol = "NIFTY 50"
    days = 1825 # 5 years
    
    print(f">>> Fetching Daily Data for {symbol} (Last {days} days)...")
    df = helper.get_latest_candles(symbol, interval="D", days=days)
    
    if not df.empty:
        # 3. Save to CSV
        df.to_csv(file_path)
        print(f"\n[SUCCESS] Downloaded {len(df)} daily candles.")
        print(f"     Save Path: {os.path.abspath(file_path)}")
        print("\n>>> Sample of downloaded data (Last 5 Rows):")
        print(df.tail())
    else:
        print(f"[FAIL] Could not retrieve data for {symbol}.")

if __name__ == "__main__":
    main()
