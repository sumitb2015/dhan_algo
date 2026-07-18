import sys
import os
import logging
from datetime import datetime, timedelta
import pandas as pd
import time

# Ensure project root is in path
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.append(PROJECT_ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

import json
DEBUG_DIR = os.path.join(PROJECT_ROOT, "debug")
STATUS_FILE = os.path.join(DEBUG_DIR, "options_refresh_status.json")

def _write_status(message: str, done: bool = False, error: str | None = None) -> None:
    try:
        os.makedirs(DEBUG_DIR, exist_ok=True)
        status = {
            "done": done,
            "message": message,
            "error": error,
            "pid": os.getpid(),
            "updated_at": datetime.now().isoformat(),
        }
        with open(STATUS_FILE, "w") as f:
            json.dump(status, f)
    except Exception:
        pass

# Configure Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# NSE Holidays (2021-2026) - needed for correct expiry calculation
# Wednesday exceptions in 2021: 10-Mar, 12-May, 18-Aug, 3-Nov → Thursday holidays on 11-Mar, 13-May, 19-Aug, 4-Nov
# Wednesday exception in 2022: 13-Apr → Thursday holiday on 14-Apr
# Wednesday exceptions in 2023: 25-Jan, 29-Mar → Thursday holidays on 26-Jan, 30-Mar
NSE_HOLIDAYS = {
    # 2021
    "2021-01-26", "2021-03-11", "2021-03-29", "2021-04-02", "2021-04-14", "2021-04-21",
    "2021-05-13", "2021-07-21", "2021-08-19", "2021-09-10", "2021-10-15", "2021-11-04",
    "2021-11-05", "2021-11-19",
    # 2022
    "2022-01-26", "2022-03-01", "2022-03-18", "2022-04-14", "2022-04-15", "2022-05-03",
    "2022-08-09", "2022-08-15", "2022-08-31", "2022-10-02", "2022-10-05", "2022-10-24",
    "2022-10-26", "2022-11-08",
    # 2023
    "2023-01-26", "2023-03-07", "2023-03-30", "2023-04-04", "2023-04-07", "2023-04-14",
    "2023-05-01", "2023-06-28", "2023-08-15", "2023-09-19", "2023-10-02", "2023-10-24",
    "2023-11-13", "2023-11-27", "2023-12-25",
    # 2024
    "2024-01-26", "2024-03-08", "2024-03-25", "2024-03-29", "2024-04-10", "2024-04-17",
    "2024-05-01", "2024-06-17", "2024-07-17", "2024-08-15", "2024-10-02", "2024-11-01",
    "2024-11-15", "2024-12-25",
    # 2025
    "2025-02-26", "2025-03-14", "2025-03-31", "2025-04-10", "2025-04-14", "2025-04-18",
    "2025-05-01", "2025-08-15", "2025-08-27", "2025-10-02", "2025-10-21", "2025-12-25",
    # 2026
    "2026-01-26", "2026-03-03", "2026-03-26", "2026-03-31", "2026-04-03", "2026-04-14",
    "2026-05-01", "2026-05-28", "2026-06-26", "2026-09-14", "2026-10-02", "2026-10-20",
    "2026-11-10", "2026-11-24", "2026-12-25"
}

def get_valid_expiry_date(expiry_date_str):
    """
    Adjusts the expiry date if it falls on a holiday.
    Checks previous day recursively.
    """
    date_obj = datetime.strptime(expiry_date_str, "%Y-%m-%d")
    while expiry_date_str in NSE_HOLIDAYS:
        # Move back one day
        date_obj -= timedelta(days=1)
        expiry_date_str = date_obj.strftime("%Y-%m-%d")
    return expiry_date_str

def get_target_weekday_for_index(helper, security_id, segment="NSE_FNO"):
    """
    Fetches the first future expiry from the API to determine the trading weekday.
    Returns: int (0=Mon, 1=Tue, ..., 6=Sun) or None if fails.
    """
    try:
        expiries = helper.get_expiry_list(security_id, segment)
        if expiries:
            # Parse the first date
            first_expiry = expiries[0]
            dt = datetime.strptime(first_expiry, "%Y-%m-%d")
            return dt.weekday()
    except Exception as e:
        logger.error(f"Failed to determine weekday for ID {security_id}: {e}")
    return 3 # Default to Thursday if fail

def generate_hybrid_expiries(start_date, end_date, symbol_name):
    """
    Generates expiries handling rule changes (e.g. NIFTY shift from Thu to Tue).
    """
    expiries = []
    current_date = start_date
    
    # Define rules
    # NIFTY: Thu (3) until Aug 31 2025, then Tue (1)
    # BANKNIFTY: Wed (2) (Changed in 2024, so constant for 2025)
    
    target_weekday = 3 # Default Thu
    if "NIFTY" in symbol_name and "BANK" not in symbol_name:
        # NIFTY 50
        pass # Logic handled inside loop
    elif "BANK" in symbol_name:
         target_weekday = 2 # Wed
    
    # Iterate day by day or week by week? 
    # Better: Iterate week chunks but check rule each time.
    # Actually, simpler loop: Jump to next occurrence of target.
    
    # Let's iterate by 1 day to be safe around transitions, or use a customized seeker.
    # Optimization: Just loop every day? No, inefficient.
    # Be aware: Transition week might have SHORT expiry (e.g. Thu then Tue next week).
    
    temp_date = start_date
    while temp_date <= end_date:
        # Determine target for THIS week/period
        day_target = 3 # Default Thu
        
        if "NIFTY" in symbol_name and "BANK" not in symbol_name:
            # Rule: Effective Sep 1 2025 = Tue
            # Cutoff: 2025-09-01
            if temp_date.date() >= datetime(2025, 9, 1).date():
                day_target = 1 # Tue
            else:
                day_target = 3 # Thu
        elif "BANK" in symbol_name:
            day_target = 2 # Wed
            
        # Check if today matches target
        if temp_date.weekday() == day_target:
            # It's a candidate
             # Check validity (holiday)
            date_str = temp_date.strftime("%Y-%m-%d")
            valid_expiry = get_valid_expiry_date(date_str)
            
            # Avoid duplicates if holiday shift pushed it to same day as previous (rare but possible)
            if not expiries or expiries[-1] != valid_expiry:
                 expiries.append(valid_expiry)
            
            # Advance 6 days to skip close ones, then loop day by day to find next
            temp_date += timedelta(days=6)
        else:
            temp_date += timedelta(days=1)
            
    # Filter to ensure we don't include future dates if end_date is strictly enforced (loop does <=)
    # And sort descending
    expiries.sort(reverse=True)
    return expiries

def main():
    _write_status("Initialising…")
    try:
        dhan = get_dhan_client()
        if not dhan: 
            logger.error("Dhan login failed.")
            _write_status("Failed: login failed", done=True, error="Dhan login failed")
            return
        helper = DhanHelper(dhan)

        watchlist = {
            "NIFTY": {"id": 13, "segment": "NSE_FNO", "instrument": "OPTIDX"}
        }
        
        # Generate relative strikes: ATM, ATM+1 to ATM+10, ATM-1 to ATM-10
        strikes = ["ATM"]
        for i in range(1, 11):
            strikes.append(f"ATM+{i}")
            strikes.append(f"ATM-{i}")
        
        required_data = ["open", "high", "low", "close", "volume", "oi", "strike", "iv", "spot"]
        
        for name, info in watchlist.items():
            logger.info(f"Processing {name}...")
            
            # 2. Calculate expiries between Jan 1, 2021 and Today using Hybrid Rules
            start_date = datetime(2021, 1, 1)
            end_date = datetime.now()
            
            expiries = generate_hybrid_expiries(start_date, end_date, name)
            logger.info(f"Target Weekly Expiries ({start_date.date()} to {end_date.date()}): {expiries}")
            
            total_exp = len(expiries)
            for idx, expiry in enumerate(expiries, 1):
                expiry_dt = datetime.strptime(expiry, "%Y-%m-%d")
                to_date = expiry
                # We fetch data for the week leading up to expiry
                from_date = (expiry_dt - timedelta(days=7)).strftime("%Y-%m-%d")
                
                logger.info(f"--- Processing Expiry: {expiry} (Data from {from_date}) ---")
                _write_status(f"Expiry {expiry} ({idx}/{total_exp})")

                for strike_rel in strikes:
                    # Folder structure example: Options Data/NIFTY/ATM/2025-01-23.csv
                    save_dir = os.path.join("Options Data", name, strike_rel)
                    os.makedirs(save_dir, exist_ok=True)
                    file_path = os.path.join(save_dir, f"{expiry}.csv")
                    
                    if os.path.exists(file_path):
                        logger.info(f"Skipping {name} {strike_rel} {expiry} - File exists.")
                        continue
                    
                    logger.info(f"Downloading: {name} | {strike_rel} | Expiry: {expiry}...")
                    _write_status(f"Downloading {name} {strike_rel} {expiry} ({idx}/{total_exp})")
                    
                    all_data = []
                    for o_type in ["CALL", "PUT"]:
                        df = helper.get_expired_options_data(
                            security_id=info["id"],
                            exchange_segment=info["segment"],
                            instrument_type=info["instrument"],
                            expiry_flag="WEEK",
                            expiry_code=1, # 1 = Near Week (Current Week relative to date range)
                            strike=strike_rel,
                            drv_option_type=o_type,
                            required_data=required_data,
                            from_date=from_date,
                            to_date=to_date,
                            interval=1
                        )
                        if df.empty and helper.is_fatal_error(helper.last_api_error):
                            # Auth/subscription failure — every remaining call will fail
                            # identically, so abort instead of grinding through the queue.
                            err = helper.last_api_error
                            msg = (f"Dhan API error {err.get('code') or '?'} "
                                   f"({err.get('type', '')}): {err.get('message', '')}")
                            logger.error(f"Fatal API error — aborting: {msg}")
                            _write_status(f"Error: {msg}", done=True, error=msg)
                            return
                        if not df.empty:
                            # Ensure we distinguish CE vs PE in the saved file
                            # The helper already adds 'option_type' column if found
                            # But let's enforce a clean column name if not present or standardize it
                            if 'option_type' not in df.columns:
                                df['option_type'] = "CE" if o_type == "CALL" else "PE"
                            else:
                                df['option_type'] = df['option_type'].apply(lambda x: "CE" if x == "CALL" else "PE")
                                
                            all_data.append(df)
                        time.sleep(0.2) # Small delay to respect rate limits
                    
                    if all_data:
                        final_df = pd.concat(all_data, ignore_index=True)
                        # Add simple column for easy filtering by user
                        final_df['strike_relative'] = strike_rel
                        
                        # Reorder columns slightly for better readability if possible, but not strictly required
                        cols = ['datetime', 'option_type', 'strike_relative'] + [c for c in final_df.columns if c not in ['datetime', 'option_type', 'strike_relative']]
                        final_df = final_df[cols]
                        
                        final_df.to_csv(file_path, index=False)
                        logger.info(f"Saved: {file_path} ({len(final_df)} rows)")
                    else:
                        logger.warning(f"No data for {name} {strike_rel} {expiry}")

        _write_status("Done", done=True)
    except Exception as e:
        logger.error(f"Downloader failed: {e}")
        _write_status(f"Error: {e}", done=True, error=str(e))

if __name__ == "__main__":
    main()
