"""
Consolidated script to download various historical datasets for NIFTY 500 stocks.
Offers an interactive menu to download daily stock data (bulk-optimized),
incremental 1-minute data (Parquet format with resume capability), and custom intervals.
"""
import sys
import os
import time
import glob
import logging
import warnings
import pandas as pd
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional, Tuple

# Suppress warnings
warnings.filterwarnings("ignore")

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- SYMBOLS UTILS ---

def parse_nifty500_symbols(csv_path: str) -> List[str]:
    """Parse MW-NIFTY-500 CSV file and extract symbols robustly."""
    if not os.path.exists(csv_path):
        print(f"[FAIL] CSV file not found: {csv_path}")
        return []
    try:
        df = pd.read_csv(csv_path)
        symbol_col = next((c for c in df.columns if str(c).strip().upper() == "SYMBOL"), None)
        if symbol_col is None:
            first_col = str(df.columns[0]).upper().strip()
            if "SYMBOL" not in first_col:
                df = pd.read_csv(csv_path, skiprows=16)
            symbol_col = df.columns[0]
            
        symbols = df[symbol_col].astype(str).str.strip().tolist()
        # Filter unwanted symbols
        symbols = [s for s in symbols if s and s != "NIFTY 500" and not s.startswith("Note") and len(s) > 0 and s != 'nan']
        return symbols
    except Exception as e:
        print(f"[FAIL] Could not parse CSV symbols: {e}")
        return []

def resolve_securities(helper: DhanHelper, symbols: List[str]) -> Tuple[Dict[str, Dict], List[int], List[int]]:
    """Resolves list of symbols to security ID maps and segment filters."""
    security_map = {}
    nse_ids = []
    bse_ids = []
    
    for symbol in symbols:
        sec = helper.get_security_id(symbol=symbol, instrument="EQUITY")
        if sec:
            security_id = int(sec['SECURITY_ID'])
            exch_id = sec.get('EXCH_ID', 'NSE')
            instrument = sec.get('INSTRUMENT', 'EQUITY')
            
            segment = "NSE_EQ"
            if exch_id == "NSE":
                if instrument == "INDEX": segment = "IDX_I"
                elif instrument == "EQUITY": segment = "NSE_EQ"
                else: segment = "NSE_FNO"
            elif exch_id == "BSE":
                if instrument == "INDEX": segment = "BSE_IDX" 
                elif instrument == "EQUITY": segment = "BSE_EQ"
                else: segment = "BSE_FNO"
                
            security_map[symbol] = {
                'security_id': security_id,
                'segment': segment,
                'exch_id': exch_id,
                'instrument': instrument
            }
            if segment == "NSE_EQ":
                nse_ids.append(security_id)
            elif segment == "BSE_EQ":
                bse_ids.append(security_id)
                
    return security_map, nse_ids, bse_ids

def fetch_bulk_quotes(helper: DhanHelper, segment: str, ids: List[int]) -> Dict:
    """Fetch quotes in chunks of 100 to avoid hitting API rate limits."""
    quotes = {}
    chunk_size = 100
    for i in range(0, len(ids), chunk_size):
        chunk = ids[i:i+chunk_size]
        retries = 3
        success = False
        while retries > 0 and not success:
            try:
                res = helper.get_quote_data(securities={segment: chunk})
                if isinstance(res, dict) and segment in res and res[segment]:
                    quotes.update(res[segment])
                    success = True
                else:
                    retries -= 1
                    if retries > 0:
                        time.sleep(2.0)
            except Exception:
                retries -= 1
                if retries > 0:
                    time.sleep(2.0)
        time.sleep(1.0)
    return quotes

# --- DOWNLOAD OPTIONS ---

def download_daily_bulk(helper: DhanHelper, symbols: List[str], save_dir: str):
    """Download daily Nifty 500 stock data (bulk-optimized)."""
    print("\n--- NIFTY 500 Daily Spot Downloader (Bulk Optimized) ---")
    years_input = input("Enter number of lookback years [Default: 2]: ").strip()
    years = float(years_input) if years_input else 2.0
    
    force_update_input = input("Force update existing files? (y/n) [Default: n]: ").strip().lower()
    force_update = force_update_input == 'y'
    
    output_dir = os.path.join(save_dir, "Daily_Historical_Data_Fresh")
    os.makedirs(output_dir, exist_ok=True)
    
    # Dhan historical API does not publish same-day EOD data — cap at yesterday.
    _d = datetime.now().date() - timedelta(days=1)
    while _d.weekday() >= 5:
        _d -= timedelta(days=1)
    to_date = _d.strftime("%Y-%m-%d")
    from_date = (datetime.now() - timedelta(days=int(years * 365))).strftime("%Y-%m-%d")
    today_str = datetime.now().strftime("%Y-%m-%d")  # kept for same-day quote append logic
    
    print("\nResolving symbols and fetching bulk quotes to handle same-day data...")
    security_map, nse_ids, bse_ids = resolve_securities(helper, symbols)
    
    print(f"Fetching quotes in bulk for {len(nse_ids)} NSE and {len(bse_ids)} BSE stocks...")
    all_quotes = {}
    if nse_ids:
        all_quotes.update(fetch_bulk_quotes(helper, "NSE_EQ", nse_ids))
    if bse_ids:
        all_quotes.update(fetch_bulk_quotes(helper, "BSE_EQ", bse_ids))
    print(f"Fetched quotes for {len(all_quotes)} securities.")
    
    success_count = 0
    fail_count = 0
    
    for i, symbol in enumerate(symbols):
        csv_file = os.path.join(output_dir, f"{symbol}_Daily_2Y.csv")
        parquet_file = os.path.join(output_dir, f"{symbol}_Daily_2Y.parquet")
        
        # Resume capability - check if file already exists
        if not force_update and (os.path.exists(csv_file) or os.path.exists(parquet_file)):
            print(f"[{i+1}/{len(symbols)}] Skipping {symbol} - Already exists.")
            success_count += 1
            continue
            
        print(f"[{i+1}/{len(symbols)}] Fetching: {symbol}...", end="", flush=True)
        if symbol not in security_map:
            print(" Not Found in Master List")
            fail_count += 1
            continue
            
        sec_info = security_map[symbol]
        security_id = sec_info['security_id']
        segment = sec_info['segment']
        instrument = sec_info['instrument']
        
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
                
                # Fetch today's real-time quote to append today's candle (if EOD historical API doesn't have it yet)
                try:
                    quote_data = all_quotes.get(str(security_id), {})
                    if quote_data:
                        ohlc = quote_data.get('ohlc', {})
                        last_trade_time_str = quote_data.get('last_trade_time', '')
                        if last_trade_time_str:
                            trade_dt = datetime.strptime(last_trade_time_str, "%d/%m/%Y %H:%M:%S")
                            trade_date_str = trade_dt.strftime("%Y-%m-%d")
                            if trade_date_str == today_str and trade_date_str not in df.index.strftime("%Y-%m-%d"):
                                new_row = pd.DataFrame({
                                    'open': [ohlc.get('open')],
                                    'high': [ohlc.get('high')],
                                    'low': [ohlc.get('low')],
                                    'close': [ohlc.get('close')],
                                    'volume': [quote_data.get('volume')],
                                    'timestamp': [trade_dt.timestamp()]
                                }, index=pd.to_datetime([trade_date_str]))
                                new_row.index.name = 'Datetime'
                                df = pd.concat([df, new_row])
                                print(" (Appended today's quote)", end="")
                except Exception as ex:
                    print(f" (Quote error: {ex})", end="")
                
                df.to_parquet(parquet_file)
                print(f" Success ({len(df)} days)")
                success_count += 1
            else:
                print(" No Data")
                fail_count += 1
        except Exception as e:
            print(f" Error: {e}")
            fail_count += 1
            
        time.sleep(0.3)
        
    print("\nConverting Parquet files to CSV...")
    parquet_files = glob.glob(os.path.join(output_dir, "*.parquet"))
    if parquet_files:
        converted_count = 0
        for f in parquet_files:
            try:
                df = pd.read_parquet(f)
                if df.index.name is None:
                    df.index.name = 'Datetime'
                else:
                    df.index.name = df.index.name.capitalize()
                    
                df_save = df.reset_index()
                df_save.columns = [str(c).capitalize() for c in df_save.columns]
                
                csv_path_file = f.replace(".parquet", ".csv")
                df_save.to_csv(csv_path_file, index=False)
                os.remove(f)
                converted_count += 1
            except Exception as e:
                print(f"Error converting {f}: {e}")
        print(f"Converted {converted_count} parquet files to CSV successfully.")
        
    print(f"\n[DOWNLOAD COMPLETE] Success: {success_count} | Failed: {fail_count}")

def download_intraday_parquet_sync(helper: DhanHelper, symbols: List[str], save_dir: str):
    """Download 1-minute historical data for all stocks in Parquet format (Incremental Sync)."""
    print("\n--- NIFTY 500 1-Minute Data Downloader (Parquet Sync) ---")
    years_input = input("Enter number of lookback years [Default: 3]: ").strip()
    years = float(years_input) if years_input else 3.0
    
    output_dir = os.path.join(save_dir, "Stocks Historical Data Parquet")
    os.makedirs(output_dir, exist_ok=True)
    
    base_start_date = (datetime.now() - timedelta(days=int(years * 365))).strftime("%Y-%m-%d")
    today_date = datetime.now().strftime("%Y-%m-%d")
    
    def get_existing_data(file_path):
        try:
            if not os.path.exists(file_path):
                return None, pd.DataFrame()
            df = pd.read_parquet(file_path)
            if df.empty:
                return None, pd.DataFrame()
            if 'Datetime' in df.columns:
                df['Datetime'] = pd.to_datetime(df['Datetime'])
                df = df.set_index('Datetime').sort_index()
            elif df.index.name == 'Datetime':
                df.index = pd.to_datetime(df.index)
                df = df.sort_index()
            return df.index[-1], df
        except Exception:
            pass
        return None, pd.DataFrame()
        
    success_count = 0
    
    for i, symbol in enumerate(symbols):
        safe_symbol = symbol.replace('&', '_').replace('-', '_')
        file_path = os.path.join(output_dir, f"{safe_symbol}_1Min_5Y.parquet")
        
        start_date = base_start_date
        last_ts, df_old = get_existing_data(file_path)
        
        if last_ts:
            start_date = last_ts.strftime("%Y-%m-%d")
            print(f"[{i+1}/{len(symbols)}] Syncing {symbol}: Last record {last_ts}")
        else:
            print(f"[{i+1}/{len(symbols)}] Processing: {symbol} (New Parquet Download)")
            
        try:
            df_new = helper.get_historical_minute_data_long(
                symbol=symbol,
                from_date=start_date,
                to_date=today_date,
                interval="1"
            )
            
            if not df_new.empty:
                if df_new.index.name != 'Datetime':
                    if 'Datetime' in df_new.columns:
                        df_new['Datetime'] = pd.to_datetime(df_new['Datetime'])
                        df_new.set_index('Datetime', inplace=True)
                df_new = df_new.sort_index()
                
                if last_ts:
                    df_new = df_new[df_new.index > last_ts]
                    
                if not df_new.empty:
                    if not df_old.empty:
                        common_cols = [c for c in df_new.columns if c in df_old.columns]
                        df_old = df_old[common_cols]
                        df_new = df_new[common_cols]
                        final_df = pd.concat([df_old, df_new])
                    else:
                        final_df = df_new
                        
                    final_df = final_df[~final_df.index.duplicated(keep='last')].sort_index()
                    final_df.to_parquet(file_path)
                    print(f"      [SUCCESS] Added {len(df_new)} rows. Total: {len(final_df)}")
                    success_count += 1
                else:
                    print("      [SKIP] Already up to date.")
                    success_count += 1
            else:
                print("      [SKIP] No new data returned.")
        except Exception as e:
            print(f"      [ERROR] Failed to process {symbol}: {e}")
            
        time.sleep(0.4)
        
    print(f"\n[DOWNLOAD COMPLETE] Successfully synced: {success_count}/{len(symbols)}")

def download_custom_interval(helper: DhanHelper, symbols: List[str], save_dir: str):
    """Download daily/intraday data for custom intervals (5m, 15m, 60m) as CSVs."""
    print("\n--- NIFTY 500 Custom Interval Downloader (CSV) ---")
    interval = input("Enter interval (1, 5, 15, 25, 60) [Default: 5]: ").strip() or "5"
    days_input = input("Enter lookback days [Default: 30]: ").strip()
    days = int(days_input) if days_input else 30
    
    output_dir = os.path.join(save_dir, f"Stocks_{interval}Min_Data")
    os.makedirs(output_dir, exist_ok=True)
    
    success_count = 0
    
    for i, symbol in enumerate(symbols):
        file_path = os.path.join(output_dir, f"{symbol}_{interval}Min_{days}Days.csv")
        
        # Resume capability
        if os.path.exists(file_path):
            print(f"[{i+1}/{len(symbols)}] Skipping {symbol} - Already exists.")
            success_count += 1
            continue
            
        print(f"[{i+1}/{len(symbols)}] Fetching {interval}m: {symbol}...", end="", flush=True)
        try:
            df = helper.get_latest_candles(symbol, interval=interval, days=days)
            if not df.empty:
                df.to_csv(file_path)
                print(f" Success ({len(df)} rows)")
                success_count += 1
            else:
                print(" No Data")
        except Exception as e:
            print(f" Error: {e}")
            
        time.sleep(0.3)
        
    print(f"\n[DOWNLOAD COMPLETE] Successfully downloaded: {success_count}/{len(symbols)}")

# --- MAIN CONTROLLER ---

def show_menu():
    print("\n" + "="*55)
    print(" NIFTY 500 HISTORICAL DATA DOWNLOAD HUB ")
    print("="*55)
    print(" 1. NIFTY 500 Stocks - Daily Data (CSV - Bulk Optimized)")
    print(" 2. NIFTY 500 Stocks - 1-Minute Data (Parquet - Resume Sync)")
    print(" 3. NIFTY 500 Stocks - Custom Interval Data (CSV)")
    print(" 4. Exit")
    print("="*55)

def main():
    PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    csv_path = os.path.join(PROJECT_ROOT, "MW-NIFTY-500-25-Jan-2026.csv")
    save_dir = PROJECT_ROOT
    os.makedirs(save_dir, exist_ok=True)
    
    # 1. Parse symbols first to verify
    print("Parsing Nifty 500 symbol list...")
    symbols = parse_nifty500_symbols(csv_path)
    if not symbols:
        return
    print(f"Found {len(symbols)} symbols in {csv_path}.")
    
    # 2. Setup Dhan Helper
    print("Initializing Dhan Client...")
    dhan = get_dhan_client()
    if not dhan:
        print("[FAIL] Failed to authenticate with Dhan. Check credentials.")
        return
    helper = DhanHelper(dhan)
    
    while True:
        show_menu()
        choice = input("Enter choice [1-4]: ").strip()
        
        if choice == "1":
            download_daily_bulk(helper, symbols, save_dir)
        elif choice == "2":
            download_intraday_parquet_sync(helper, symbols, save_dir)
        elif choice == "3":
            download_custom_interval(helper, symbols, save_dir)
        elif choice == "4":
            print("\nExiting Nifty 500 Downloader. Happy Trading!")
            break
        else:
            print("\n[INVALID] Choice must be between 1 and 4. Try again.")
            
        input("\nPress Enter to return to menu...")

if __name__ == "__main__":
    main()
