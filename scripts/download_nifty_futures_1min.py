import sys
import os
import logging
import pandas as pd
import time
from datetime import datetime, timedelta
from typing import List, Dict

# Add project root to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# NSE Holidays (2024-2026)
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

def get_valid_expiry(date_obj: datetime) -> str:
    """Adjusts expiry if it falls on a holiday or weekend."""
    # Check weekends
    while date_obj.weekday() > 4: # 5=Sat, 6=Sun
        date_obj -= timedelta(days=1)
    
    # Check holidays
    curr_str = date_obj.strftime("%Y-%m-%d")
    while curr_str in NSE_HOLIDAYS:
        date_obj -= timedelta(days=1)
        # Re-check weekend after moving back
        while date_obj.weekday() > 4:
            date_obj -= timedelta(days=1)
        curr_str = date_obj.strftime("%Y-%m-%d")
    
    return curr_str

def get_last_weekday(year: int, month: int, weekday: int) -> datetime:
    """Returns the last specified weekday (0=Mon, 3=Thu) of a given month/year."""
    # Start at the last day of the month
    if month == 12:
        last_day = datetime(year + 1, 1, 1) - timedelta(days=1)
    else:
        last_day = datetime(year, month + 1, 1) - timedelta(days=1)
    
    # Calculate difference to target weekday
    diff = (last_day.weekday() - weekday) % 7
    return last_day - timedelta(days=diff)

def generate_nifty_expiry_list(start_year: int, start_month: int, end_year: int, end_month: int) -> List[str]:
    """Generates monthly expiry list based on NSE rules."""
    expiries = []
    
    curr_year = start_year
    curr_month = start_month
    
    while (curr_year < end_year) or (curr_year == end_year and curr_month <= end_month):
        # Rules:
        # Until Aug 2025 -> Last Thursday
        # From Sep 2025 -> Last Tuesday
        
        target_weekday = 3 # Thursday
        if curr_year > 2025 or (curr_year == 2025 and curr_month >= 9):
            target_weekday = 1 # Tuesday
            
        last_day = get_last_weekday(curr_year, curr_month, target_weekday)
        valid_expiry = get_valid_expiry(last_day)
        expiries.append(valid_expiry)
        
        # Increment month
        if curr_month == 12:
            curr_month = 1
            curr_year += 1
        else:
            curr_month += 1
            
    return expiries

def main():
    # 1. Initialize
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)
    save_dir = "Historical Data"
    os.makedirs(save_dir, exist_ok=True)
    
    # 2. Get Expiries for the last 1 year
    # Today is 2026-01-25. So from 2025-01 to 2026-01
    expiries = generate_nifty_expiry_list(2025, 1, 2026, 1)
    logger.info(f"Generated Expiries: {expiries}")
    
    # To download "Continuous" data, for each month's contract, 
    # we take data from (Previous Expiry + 1) to (Current Expiry)
    # For the first month (Jan 2025), we start from the previous expiry (Dec 2024)
    dec_2024_expiry = get_valid_expiry(get_last_weekday(2024, 12, 3))
    all_expiries = [dec_2024_expiry] + expiries
    
    final_data = []
    
    for i in range(1, len(all_expiries)):
        prev_expiry = all_expiries[i-1]
        curr_expiry = all_expiries[i]
        
        # Calculate fetch range
        from_date = (datetime.strptime(prev_expiry, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        to_date = curr_expiry
        
        logger.info(f"--- Processing Month: {curr_expiry} | Range: {from_date} to {to_date} ---")
        
        # Fetch 1-min data using the optimized long history helper
        try:
            df_chunk = helper.get_historical_minute_data_long(
                symbol=f"NIFTY {curr_expiry.upper()} FUT", # Helper expects a symbol to resolve
                from_date=from_date,
                to_date=to_date,
                interval="1"
            )
            
            # If standard resolution fails, try manual resolution and passing symbol name
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
                # Add contract info
                df_chunk['Contract'] = curr_expiry
                final_data.append(df_chunk)
                logger.info(f"  Downloaded {len(df_chunk)} rows.")
            else:
                logger.warning(f"  No data returned for contract {curr_expiry}")
        except Exception as e:
            logger.error(f"  Error fetching data for {curr_expiry}: {e}")
            
    if final_data:
        full_df = pd.concat(final_data)
        # Deduplicate just in case
        full_df = full_df[~full_df.index.duplicated(keep='first')].sort_index()
        
        output_file = os.path.join(save_dir, "NIFTY_Futures_1min_1Year_Continuous.csv")
        full_df.to_csv(output_file)
        
        print("\n" + "="*50)
        print(f"DOWNLOAD COMPLETE!")
        print(f"Target File: {output_file}")
        print(f"Total Rows: {len(full_df)}")
        print(f"Date Range: {full_df.index.min()} to {full_df.index.max()}")
        print("="*50)
    else:
        print("\n[FAIL] No data collected.")

if __name__ == "__main__":
    main()
