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
STOP_FILE = os.path.join(DEBUG_DIR, "options_refresh_stop.trigger")

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

def _check_stop() -> bool:
    if os.path.exists(STOP_FILE):
        try:
            os.unlink(STOP_FILE)
        except Exception:
            pass
        return True
    return False

def _is_valid_file(file_path: str) -> bool:
    """Check if file exists and has non-empty content."""
    return os.path.exists(file_path) and os.path.getsize(file_path) > 0

# Configure Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# NSE Holidays (2021-2026) — only needed for the hybrid historical generator.
# Dhan's master list covers all future expiries accurately, so this table
# only needs to be maintained through the current year.
# ---------------------------------------------------------------------------
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


def _valid_expiry(date_str: str) -> str:
    """Shift back past any NSE holiday."""
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    while date_str in NSE_HOLIDAYS:
        dt -= timedelta(days=1)
        date_str = dt.strftime("%Y-%m-%d")
    return date_str


def generate_historical_expiries(symbol: str, start_date: datetime, end_date: datetime) -> list[str]:
    """
    Generates weekly expiry dates using NSE weekday rules for the historical
    period (before expiries appear in the Dhan master list).

    NIFTY: Thursday until 31-Aug-2025, Tuesday from 01-Sep-2025 onwards.
    BANKNIFTY: Wednesday.
    """
    expiries = []
    temp = start_date

    while temp <= end_date:
        if "NIFTY" in symbol and "BANK" not in symbol:
            target = 1 if temp.date() >= datetime(2025, 9, 1).date() else 3  # Tue / Thu
        elif "BANK" in symbol:
            target = 2  # Wed
        else:
            target = 3  # Thu default

        if temp.weekday() == target:
            d_str = temp.strftime("%Y-%m-%d")
            valid = _valid_expiry(d_str)
            if not expiries or expiries[-1] != valid:
                expiries.append(valid)
            temp += timedelta(days=6)
        else:
            temp += timedelta(days=1)

    expiries.sort(reverse=True)
    return expiries


def get_expiries_from_master_list(helper: DhanHelper, symbol: str) -> list[str]:
    """
    Reads upcoming option expiry dates for `symbol` from the Dhan master list.
    The master list only contains currently-listed (future) contracts, so this
    supplements the historical generator for any expiries not yet expired.
    Returns a list of 'YYYY-MM-DD' strings, all >= today.
    """
    df = helper._load_master_list()
    if df.empty:
        logger.warning("Master list is empty — skipping master list expiry lookup.")
        return []

    mask = (
        (df["UNDERLYING_SYMBOL"] == symbol.upper()) &
        (df["INSTRUMENT"] == "OPTIDX") &
        (df["SM_EXPIRY_DATE"].notna()) &
        (df["SM_EXPIRY_DATE"] != "nan")
    )
    raw = df[mask]["SM_EXPIRY_DATE"].dropna().unique().tolist()

    parsed = []
    for d in raw:
        try:
            parsed.append(datetime.strptime(str(d).strip(), "%Y-%m-%d"))
        except ValueError:
            pass

    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    result = sorted(set(dt for dt in parsed), reverse=True)
    return [dt.strftime("%Y-%m-%d") for dt in result]


def build_expiry_list(helper: DhanHelper, symbol: str) -> list[str]:
    """
    Combines:
      1. Historical expiries from the rule-based generator (2021-01-01 to yesterday).
      2. Future/current expiries from the Dhan master list (authoritative, no hardcoding).

    Returns a deduplicated, descending-sorted list of all 'YYYY-MM-DD' expiry dates
    up to today.
    """
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    yesterday = today - timedelta(days=1)

    # Historical: rule-based generator for all dates that have already expired
    historical = generate_historical_expiries(symbol, datetime(2021, 1, 1), yesterday)

    # Future/current: authoritative from broker master list
    from_master = get_expiries_from_master_list(helper, symbol)

    # Merge, deduplicate, filter to <= today, sort descending
    all_expiries = set(historical) | set(from_master)
    all_dt = []
    for d in all_expiries:
        try:
            dt = datetime.strptime(d, "%Y-%m-%d")
            if dt <= today:
                all_dt.append(dt)
        except ValueError:
            pass

    all_dt.sort(reverse=True)
    result = [dt.strftime("%Y-%m-%d") for dt in all_dt]
    logger.info(
        f"[{symbol}] Total expiries: {len(result)} "
        f"({result[-1] if result else '—'} … {result[0] if result else '—'})"
    )
    return result




def main():
    if _check_stop():
        _write_status("Stopped by user", done=True)
        return

    _write_status("Initialising…")
    try:
        watchlist = {
            "NIFTY": {"id": 13, "segment": "NSE_FNO", "instrument": "OPTIDX"}
        }

        # Relative strikes: ATM, ATM±1 … ATM±10 (21 total relative strikes)
        strikes = ["ATM"]
        for i in range(1, 11):
            strikes.append(f"ATM+{i}")
            strikes.append(f"ATM-{i}")

        required_data = ["open", "high", "low", "close", "volume", "oi", "strike", "iv", "spot"]

        dhan = get_dhan_client()
        if not dhan:
            logger.error("Dhan login failed.")
            _write_status("Failed: login failed", done=True, error="Dhan login failed")
            return
        helper = DhanHelper(dhan)

        total_downloaded = 0
        total_skipped = 0

        for name, info in watchlist.items():
            if _check_stop():
                _write_status("Stopped by user", done=True)
                return

            logger.info(f"Checking options data for {name}...")
            _write_status(f"Checking existing files for {name}…")

            # Build the full expiry list: history (rule-based) + future (master list)
            expiries = build_expiry_list(helper, name)
            if not expiries:
                logger.error(f"No expiries found for {name}. Skipping.")
                continue

            # Identify all missing tasks upfront to avoid redundant loop cycles
            missing_tasks = []
            for expiry in expiries:
                for strike_rel in strikes:
                    save_dir = os.path.join(PROJECT_ROOT, "Options Data", name, strike_rel)
                    os.makedirs(save_dir, exist_ok=True)
                    file_path = os.path.join(save_dir, f"{expiry}.csv")

                    if _is_valid_file(file_path):
                        total_skipped += 1
                    else:
                        missing_tasks.append((expiry, strike_rel, save_dir, file_path))

            total_expected = len(expiries) * len(strikes)
            if not missing_tasks:
                msg = f"All {len(expiries)} expiries ({total_expected} files) already exist for {name}. Skipping download."
                logger.info(msg)
                _write_status(f"All options data already up to date ({len(expiries)} expiries present)", done=True)
                continue

            unique_missing_expiries = sorted(list(set(t[0] for t in missing_tasks)), reverse=True)
            logger.info(
                f"[{name}] {len(missing_tasks)} files missing across {len(unique_missing_expiries)}/{len(expiries)} expiries. "
                f"({total_skipped} files already present)."
            )

            # Process only the missing tasks
            for task_idx, (expiry, strike_rel, save_dir, file_path) in enumerate(missing_tasks, 1):
                if _check_stop():
                    logger.info("Stop trigger detected. Exiting gracefully.")
                    _write_status("Stopped by user", done=True)
                    return

                if _is_valid_file(file_path):
                    continue

                expiry_dt = datetime.strptime(expiry, "%Y-%m-%d")
                to_date = expiry
                from_date = (expiry_dt - timedelta(days=7)).strftime("%Y-%m-%d")

                status_msg = f"Downloading {name} {strike_rel} {expiry} ({task_idx}/{len(missing_tasks)})"
                logger.info(status_msg)
                _write_status(status_msg)

                all_data = []
                for o_type in ["CALL", "PUT"]:
                    if _check_stop():
                        _write_status("Stopped by user", done=True)
                        return

                    df = helper.get_expired_options_data(
                        security_id=info["id"],
                        exchange_segment=info["segment"],
                        instrument_type=info["instrument"],
                        expiry_flag="WEEK",
                        expiry_code=1,  # Near Week relative to date range
                        strike=strike_rel,
                        drv_option_type=o_type,
                        required_data=required_data,
                        from_date=from_date,
                        to_date=to_date,
                        interval=1
                    )
                    if df.empty and helper.is_fatal_error(helper.last_api_error):
                        err = helper.last_api_error
                        msg = (f"Dhan API error {err.get('code') or '?'} "
                               f"({err.get('type', '')}): {err.get('message', '')}")
                        logger.error(f"Fatal API error — aborting: {msg}")
                        _write_status(f"Error: {msg}", done=True, error=msg)
                        return
                    if not df.empty:
                        if 'option_type' not in df.columns:
                            df['option_type'] = "CE" if o_type == "CALL" else "PE"
                        else:
                            df['option_type'] = df['option_type'].apply(
                                lambda x: "CE" if x == "CALL" else "PE"
                            )
                        all_data.append(df)
                    time.sleep(0.2)  # Respect rate limits

                if all_data:
                    final_df = pd.concat(all_data, ignore_index=True)
                    final_df['strike_relative'] = strike_rel
                    cols = (
                        ['datetime', 'option_type', 'strike_relative'] +
                        [c for c in final_df.columns
                         if c not in ['datetime', 'option_type', 'strike_relative']]
                    )
                    final_df = final_df[cols]
                    final_df.to_csv(file_path, index=False)
                    total_downloaded += 1
                    logger.info(f"Saved: {file_path} ({len(final_df)} rows)")
                else:
                    logger.warning(f"No data for {name} {strike_rel} {expiry}")

        # If new files were downloaded, sync to SQLite DB
        if total_downloaded > 0:
            try:
                _write_status(f"Syncing {total_downloaded} new files to SQLite database…")
                logger.info("Updating SQLite database with newly downloaded files...")
                from scripts.analysis.convert_options_to_sqlite import main as sync_sqlite
                sync_sqlite()
            except Exception as e:
                logger.warning(f"Failed to sync SQLite database: {e}")

        final_msg = (
            f"Done: Downloaded {total_downloaded} files, skipped {total_skipped} existing files"
            if total_downloaded > 0
            else f"All options data already up to date ({total_skipped} files verified)"
        )
        logger.info(final_msg)
        _write_status(final_msg, done=True)
    except Exception as e:
        logger.error(f"Downloader failed: {e}")
        _write_status(f"Error: {e}", done=True, error=str(e))

if __name__ == "__main__":
    main()
