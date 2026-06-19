"""
Consolidated script to download various historical datasets for NIFTY 50.
Offers an interactive menu to download Spot daily, Spot intraday (1m/5m/15m/60m),
and Continuous Futures data.
"""
import sys
import os
import time
import logging
import pandas as pd
from datetime import datetime, timedelta
from typing import List, Tuple, Dict, Any, Optional

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# NSE Holidays (2024-2026) for expiry date calculations
NSE_HOLIDAYS = {
    # 2024
    "2024-01-26", "2024-03-08", "2024-03-25", "2024-03-29", "2024-04-10", "2024-04-17",
    "2024-05-01", "2024-06-17", "2024-07-17", "2024-08-15", "2024-10-02", "2024-11-01",
    "2024-11-15", "2024-12-25",
    # 2025
    "2025-01-26", "2025-02-26", "2025-03-14", "2025-03-31", "2025-04-10", "2025-04-14", "2025-04-18",
    "2025-05-01", "2025-08-15", "2025-08-27", "2025-10-02", "2025-10-21", "2025-12-25",
    # 2026
    "2026-01-26", "2026-03-03", "2026-03-26", "2026-03-31", "2026-04-03", "2026-04-14",
    "2026-05-01", "2026-05-28", "2026-06-26", "2026-09-14", "2026-10-02", "2026-10-20",
    "2026-11-10", "2026-11-24", "2026-12-25"
}

# --- FUTURES EXPIRED DATE UTILS ---

def get_valid_expiry(date_obj: datetime) -> str:
    """Adjusts expiry if it falls on a holiday or weekend."""
    while date_obj.weekday() > 4: # 5=Sat, 6=Sun
        date_obj -= timedelta(days=1)
    
    curr_str = date_obj.strftime("%Y-%m-%d")
    while curr_str in NSE_HOLIDAYS:
        date_obj -= timedelta(days=1)
        while date_obj.weekday() > 4:
            date_obj -= timedelta(days=1)
        curr_str = date_obj.strftime("%Y-%m-%d")
    
    return curr_str

def get_last_weekday(year: int, month: int, weekday: int) -> datetime:
    """Returns the last specified weekday (0=Mon, 3=Thu) of a given month/year."""
    if month == 12:
        last_day = datetime(year + 1, 1, 1) - timedelta(days=1)
    else:
        last_day = datetime(year, month + 1, 1) - timedelta(days=1)
    
    diff = (last_day.weekday() - weekday) % 7
    return last_day - timedelta(days=diff)

def generate_nifty_expiry_list(start_year: int, start_month: int, end_year: int, end_month: int) -> List[str]:
    """Generates monthly expiry list based on NSE rules."""
    expiries = []
    curr_year = start_year
    curr_month = start_month
    
    while (curr_year < end_year) or (curr_year == end_year and curr_month <= end_month):
        # Rules:
        # Until Aug 2025 -> Last Thursday (3)
        # From Sep 2025 -> Last Tuesday (1)
        target_weekday = 3
        if curr_year > 2025 or (curr_year == 2025 and curr_month >= 9):
            target_weekday = 1
            
        last_day = get_last_weekday(curr_year, curr_month, target_weekday)
        valid_expiry = get_valid_expiry(last_day)
        expiries.append(valid_expiry)
        
        if curr_month == 12:
            curr_month = 1
            curr_year += 1
        else:
            curr_month += 1
            
    return expiries

# --- DATA DOWNLOAD OPTIONS ---

def download_spot_daily(helper: DhanHelper, save_dir: str):
    """Download daily Spot data."""
    print("\n--- NIFTY 50 Daily Spot Downloader ---")
    days_input = input("Enter number of calendar days to look back [Default: 1825 (5 years)]: ").strip()
    days = int(days_input) if days_input else 1825
    
    file_path = os.path.join(save_dir, "NIFTY_50_Daily_5Y.csv")
    print(f">>> Fetching Daily candles for NIFTY 50 (Last {days} days)...")
    
    df = helper.get_latest_candles("NIFTY 50", interval="D", days=days)
    if not df.empty:
        df.to_csv(file_path)
        print(f"\n[SUCCESS] Daily Spot downloaded successfully.")
        print(f"Total Rows: {len(df)}")
        print(f"File Path : {os.path.abspath(file_path)}")
        print("\n>>> Preview of last 5 rows:")
        print(df.tail(5))
    else:
        print("[FAIL] Failed to retrieve Daily Spot data.")

def download_spot_intraday_chunked(helper: DhanHelper, save_dir: str, interval: str = "1"):
    """Download Spot minute data with custom chunking for long history."""
    print(f"\n--- NIFTY 50 Spot Intraday {interval}m Downloader (Chunked) ---")
    years_input = input("Enter number of years to download [Default: 3]: ").strip()
    years = int(years_input) if years_input else 3
    
    file_path = os.path.join(save_dir, f"NIFTY_50_{interval}Min_{years}Y.csv")
    symbol = "NIFTY 50"
    end_total = datetime.now()
    start_total = end_total - timedelta(days=years * 365)
    
    current_start = start_total
    all_chunks = []
    chunk_size = 85 # API limit is 90 days
    
    print(f">>> Fetching {interval}m data from {start_total.date()} to {end_total.date()}...")
    sec = helper._resolve_symbol(symbol)
    if not sec:
        print(f"[FAIL] Could not resolve symbol: {symbol}")
        return
        
    security_id = int(sec['SECURITY_ID'])
    # segment detection
    exch_id = sec.get('EXCH_ID', 'NSE')
    instr = sec.get('INSTRUMENT', 'EQUITY')
    segment = "IDX_I" if instr == "INDEX" else "NSE_EQ"
    
    while current_start < end_total:
        current_end = min(current_start + timedelta(days=chunk_size), end_total)
        from_str = current_start.strftime("%Y-%m-%d")
        to_str = current_end.strftime("%Y-%m-%d")
        
        print(f"    - Fetching chunk: {from_str} to {to_str}...")
        try:
            df_chunk = helper.get_intraday_minute_data(
                security_id=security_id,
                exchange_segment=segment,
                instrument_type=instr,
                interval=interval,
                from_date=from_str,
                to_date=to_str
            )
            if not df_chunk.empty:
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
                all_chunks.append(df_chunk)
                print(f"      [OK] Received {len(df_chunk)} rows.")
            else:
                print("      [SKIP] No data in this range.")
        except Exception as e:
            print(f"      [ERROR] Failed to fetch chunk: {e}")
            
        current_start = current_end + timedelta(days=1)
        time.sleep(0.5)
        
    if all_chunks:
        final_df = pd.concat(all_chunks)
        final_df = final_df[~final_df.index.duplicated(keep='first')].sort_index()
        final_df.to_csv(file_path)
        print(f"\n[SUCCESS] Chunked download complete.")
        print(f"Total Rows: {len(final_df)}")
        print(f"File Path : {os.path.abspath(file_path)}")
        print("\n>>> Preview of last 5 rows:")
        print(final_df.tail(5))
    else:
        print("[FAIL] No data collected.")

def download_spot_custom(helper: DhanHelper, save_dir: str):
    """Download Spot custom interval (e.g. 5m, 15m, 60m) over custom days."""
    print("\n--- NIFTY 50 Spot Custom Interval Downloader ---")
    interval = input("Enter interval (1, 5, 15, 25, 60) [Default: 5]: ").strip() or "5"
    days_input = input("Enter number of calendar days to look back [Default: 30]: ").strip()
    days = int(days_input) if days_input else 30
    
    file_path = os.path.join(save_dir, f"NIFTY_50_{interval}Min_{days}Days.csv")
    print(f">>> Fetching {interval}m candles for NIFTY 50 (Last {days} days)...")
    
    df = helper.get_latest_candles("NIFTY 50", interval=interval, days=days)
    if not df.empty:
        df.to_csv(file_path)
        print(f"\n[SUCCESS] Custom Spot data downloaded successfully.")
        print(f"Total Rows: {len(df)}")
        print(f"File Path : {os.path.abspath(file_path)}")
        print("\n>>> Preview of last 5 rows:")
        print(df.tail(5))
    else:
        print("[FAIL] Failed to retrieve Spot data.")

def download_futures_continuous(helper: DhanHelper, save_dir: str):
    """Download continuous Nifty Futures 1-minute data by rolling over monthly expiries."""
    print("\n--- NIFTY Futures 1-Minute Continuous Downloader ---")
    years_input = input("Enter number of years to look back [Default: 1]: ").strip()
    years = float(years_input) if years_input else 1.0
    
    # Calculate start and end expiries
    today = datetime.now()
    end_year, end_month = today.year, today.month
    
    start_date = today - timedelta(days=int(years * 365))
    start_year, start_month = start_date.year, start_date.month
    
    print(f">>> Generating monthly expiry list from {start_year}-{start_month:02d} to {end_year}-{end_month:02d}...")
    expiries = generate_nifty_expiry_list(start_year, start_month, end_year, end_month)
    logger.info(f"Generated Expiries: {expiries}")
    
    # Dec 2024 previous starting index logic if starting in Jan 2025
    prev_year = start_year if start_month > 1 else start_year - 1
    prev_month = start_month - 1 if start_month > 1 else 12
    dec_prev_expiry = get_valid_expiry(get_last_weekday(prev_year, prev_month, 3 if prev_year < 2025 or (prev_year == 2025 and prev_month < 9) else 1))
    
    all_expiries = [dec_prev_expiry] + expiries
    final_data = []
    
    for i in range(1, len(all_expiries)):
        prev_expiry = all_expiries[i-1]
        curr_expiry = all_expiries[i]
        
        from_date = (datetime.strptime(prev_expiry, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        to_date = curr_expiry
        
        logger.info(f"--- Processing Month: {curr_expiry} | Range: {from_date} to {to_date} ---")
        
        try:
            df_chunk = helper.get_historical_minute_data_long(
                symbol=f"NIFTY {curr_expiry.upper()} FUT",
                from_date=from_date,
                to_date=to_date,
                interval="1"
            )
            
            # Fallback to manual resolution if needed
            if df_chunk.empty:
                future_sec = helper.get_future_id(underlying="NIFTY", expiry=curr_expiry, instrument="FUTIDX")
                if future_sec:
                    df_chunk = helper.get_historical_minute_data_long(
                        symbol=future_sec['SYMBOL_NAME'],
                        from_date=from_date,
                        to_date=to_date,
                        interval="1"
                    )
            
            if not df_chunk.empty:
                df_chunk['Contract'] = curr_expiry
                final_data.append(df_chunk)
                logger.info(f"  Downloaded {len(df_chunk)} rows.")
            else:
                logger.warning(f"  No data returned for contract {curr_expiry}")
        except Exception as e:
            logger.error(f"  Error fetching data for {curr_expiry}: {e}")
            
        time.sleep(0.5)
        
    if final_data:
        full_df = pd.concat(final_data)
        full_df = full_df[~full_df.index.duplicated(keep='first')].sort_index()
        
        file_path = os.path.join(save_dir, "NIFTY_Futures_1min_Continuous.csv")
        full_df.to_csv(file_path)
        
        print("\n" + "="*60)
        print(f"[SUCCESS] Futures Continuous Download Complete!")
        print(f"Total Rows: {len(full_df)}")
        print(f"File Path : {os.path.abspath(file_path)}")
        print(f"Date Range: {full_df.index.min()} to {full_df.index.max()}")
        print("="*60)
    else:
        print("\n[FAIL] No data collected.")

# --- MAIN CONTROLLER ---

def show_menu():
    print("\n" + "="*50)
    print(" NIFTY 50 HISTORICAL DATA DOWNLOAD HUB ")
    print("="*50)
    print(" 1. NIFTY 50 Index (Spot) - Daily Data")
    print(" 2. NIFTY 50 Index (Spot) - 1-Minute Data (Chunked)")
    print(" 3. NIFTY 50 Index (Spot) - Custom Interval (5m, 15m, 60m)")
    print(" 4. NIFTY 50 Futures     - 1-Minute Continuous Data")
    print(" 5. Exit")
    print("="*50)
    
def main():
    save_dir = "Historical Data"
    os.makedirs(save_dir, exist_ok=True)
    
    print("Initializing Dhan connection...")
    dhan = get_dhan_client()
    if not dhan:
        print("[FAIL] Failed to initialize Dhan Client. Check token validity.")
        return
    helper = DhanHelper(dhan)
    
    while True:
        show_menu()
        choice = input("Enter choice [1-5]: ").strip()
        
        if choice == "1":
            download_spot_daily(helper, save_dir)
        elif choice == "2":
            download_spot_intraday_chunked(helper, save_dir, interval="1")
        elif choice == "3":
            download_spot_custom(helper, save_dir)
        elif choice == "4":
            download_futures_continuous(helper, save_dir)
        elif choice == "5":
            print("\nExiting Download Hub. Happy Trading!")
            break
        else:
            print("\n[INVALID] Choice must be between 1 and 5. Try again.")
        
        input("\nPress Enter to return to menu...")

if __name__ == "__main__":
    main()
