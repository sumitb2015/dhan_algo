
"""
Script to download 5 years of 1-minute data for all NIFTY 500 stocks.
Reads symbols from MW-NIFTY-500-25-Jan-2026.csv and uses chunked requests.
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
    save_dir = "Stocks Historical Data Parquet"
    os.makedirs(save_dir, exist_ok=True)
    
    print(f"\n" + "="*60)
    print("NIFTY 500 1-MINUTE DATA DOWNLOADER (PARQUET)")
    print("="*60)
    
    # 1. Parse CSV and extract symbols
    if not os.path.exists(csv_path):
        print(f"[FAIL] CSV file not found: {csv_path}")
        return
        
    try:
        # The data starts from the first row (header)
        df_list = pd.read_csv(csv_path)
        # The first column is the symbol. Some might have leading/trailing spaces
        symbols = df_list.iloc[:, 0].str.strip().tolist()
        
        # Filter out "NIFTY 500" if it's in the list
        symbols = [s for s in symbols if s and s != "NIFTY 500" and not s.startswith("Note")]
    except Exception as e:
        print(f"[FAIL] Could not parse CSV symbols: {e}")
        return

    print(f">>> Found {len(symbols)} stocks to process.")
    
    # --- Symbol Mapping for Dhan ---
    # Map NSE symbol (from CSV) to Dhan symbol
    # Only map if they are DIFFERENT in master_list.csv
    SYMBOL_MAP = {
        # Empty! Let's try auto-resolution first.
    }
    
    # 2. Setup Dhan Client
    dhan = get_dhan_client()
    if not dhan:
        print("[CRITICAL] Failed to authenticate with Dhan. Please run 'python login.py' to setup credentials or ensure .env is correct.")
        return
        
    helper = DhanHelper(dhan)
    
    # Base 5-Year Start Date
    base_start_date = (datetime.now() - timedelta(days=3*365)).strftime("%Y-%m-%d")
    today_date = datetime.now().strftime("%Y-%m-%d")
    
    def get_existing_data(file_path):
        """Reads the existing Parquet file and returns the last timestamp and full DF."""
        try:
            if not os.path.exists(file_path):
                return None, pd.DataFrame()
            
            df = pd.read_parquet(file_path)
            if df.empty:
                return None, pd.DataFrame()
                
            # Ensure Datetime is index for sorting consistency
            if 'Datetime' in df.columns:
                df['Datetime'] = pd.to_datetime(df['Datetime'])
                df = df.set_index('Datetime').sort_index()
            elif df.index.name == 'Datetime':
                df.index = pd.to_datetime(df.index)
                df = df.sort_index()
                
            return df.index[-1], df
        except Exception as e:
            print(f"      [WARN] Could not read {file_path}: {e}")
            pass
        return None, pd.DataFrame()

    # 4. Processing Loop
    for i, raw_symbol in enumerate(symbols):
        # Handle Symbol Mapping
        symbol = SYMBOL_MAP.get(raw_symbol, raw_symbol)
        
        # Sanitize symbol for filename (ensure clean names for Parquet)
        safe_symbol = symbol.replace('&', '_').replace('-', '_')
        file_path = os.path.join(save_dir, f"{safe_symbol}_1Min_5Y.parquet")
        
        start_date = base_start_date
        last_ts, df_old = get_existing_data(file_path)
        
        if last_ts:
            # We have data. Fetch from the date of last timestamp to handle gaps
            start_date = last_ts.strftime("%Y-%m-%d")
            print(f"[{i+1}/{len(symbols)}] Syncing {symbol}: Last record {last_ts}")
        else:
            print(f"[{i+1}/{len(symbols)}] Processing: {symbol} (New Parquet Download)")
        
        try:
            # Fetch data from start_date to today
            df_new = helper.get_historical_minute_data_long(
                symbol=symbol,
                from_date=start_date,
                to_date=today_date,
                interval="1"
            )
            
            if not df_new.empty:
                # Standardize: Ensure Datetime is the index
                if df_new.index.name != 'Datetime':
                    if 'Datetime' in df_new.columns:
                        df_new['Datetime'] = pd.to_datetime(df_new['Datetime'])
                        df_new.set_index('Datetime', inplace=True)
                    else:
                        # Fallback if helper returned something else
                        pass
                
                df_new = df_new.sort_index()
                
                # STRICT FILTERING: Only rows GREATER than last_ts
                if last_ts:
                    df_new = df_new[df_new.index > last_ts]
                
                if not df_new.empty:
                    # Combine and Save
                    if not df_old.empty:
                        # Ensure columns match (excluding index)
                        # Parquet stores index but .columns only shows data columns
                        common_cols = [c for c in df_new.columns if c in df_old.columns]
                        if len(common_cols) < len(df_new.columns):
                            print(f"      [WARN] Column mismatch. New: {list(df_new.columns)}, Old: {list(df_old.columns)}")
                        
                        df_old = df_old[common_cols]
                        df_new = df_new[common_cols]
                        final_df = pd.concat([df_old, df_new])
                    else:
                        final_df = df_new
                        
                    # Final deduplication
                    final_df = final_df[~final_df.index.duplicated(keep='last')].sort_index()
                    
                    final_df.to_parquet(file_path)
                    print(f"      [SUCCESS] Added {len(df_new)} new rows. Total: {len(final_df)} rows")
                else:
                    print(f"      [SKIP] Up to date (No new minutes found since {last_ts}).")
            else:
                if last_ts:
                    print(f"      [SKIP] Up to date (No data returned).")
                else:
                    print(f"      [SKIP] No data returned for range.")
                
        except KeyError as ke:
            print(f"      [ERROR] KeyError {ke} for {symbol}. DF Cols: {list(df_new.columns if 'df_new' in locals() else 'N/A')}, Index: {df_new.index.name if 'df_new' in locals() else 'N/A'}")
        except Exception as e:
            print(f"      [ERROR] Failed to process {symbol}: {e}")
            
        # Give a small cooling period
        time.sleep(0.5)

    print(f"\n" + "="*60)
    print("INCREMENTAL PARQUET SYNC COMPLETE!")
    print("="*60)


if __name__ == "__main__":
    main()
