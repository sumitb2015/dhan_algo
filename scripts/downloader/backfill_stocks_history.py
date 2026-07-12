"""
One-time backfill: extend existing Daily_Historical_Data_Fresh/*_Daily_2Y.csv
stock files backward to an earlier start date (default 2019-01-01).

refresh_dashboard_data.py only ever appends forward from each file's last
date, and seeds brand-new files with a 730-day lookback — that's why every
stock CSV currently starts at 2024-07-02. This script fetches everything
between --start-date and each file's current earliest date and prepends it,
using the same chunk-by-365-days + merge/dedupe pattern as the existing
refresh script.

Usage:
    venv\\Scripts\\python.exe scripts/downloader/backfill_stocks_history.py
    venv\\Scripts\\python.exe scripts/downloader/backfill_stocks_history.py --start-date 2019-01-01
    venv\\Scripts\\python.exe scripts/downloader/backfill_stocks_history.py --symbol RELIANCE
    venv\\Scripts\\python.exe scripts/downloader/backfill_stocks_history.py --limit 10

Writes progress to debug/backfill_status.json; write debug/backfill_stop.trigger to abort.
"""
import sys
import os
import time
import json
import argparse
import warnings
import pandas as pd
from datetime import datetime, timedelta

warnings.filterwarnings("ignore")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)

STOCKS_DIR = os.path.join(PROJECT_ROOT, "Daily_Historical_Data_Fresh")
N500_LIST = os.path.join(PROJECT_ROOT, "MW-NIFTY-500-25-Jan-2026.csv")
DEBUG_DIR = os.path.join(PROJECT_ROOT, "debug")
STATUS_FILE = os.path.join(DEBUG_DIR, "backfill_status.json")
STOP_FILE = os.path.join(DEBUG_DIR, "backfill_stop.trigger")

os.makedirs(DEBUG_DIR, exist_ok=True)

_log_lines = []


def write_status(message: str, current: int = 0, total: int = 0, done: bool = False, error: str = None):
    _log_lines.append(message)
    if len(_log_lines) > 200:
        _log_lines.pop(0)
    payload = {
        "pid": os.getpid(),
        "message": message,
        "current": current,
        "total": total,
        "done": done,
        "error": error,
        "log": _log_lines[-60:],
        "updated_at": datetime.now().isoformat(),
    }
    with open(STATUS_FILE, "w") as f:
        json.dump(payload, f)
    try:
        print(message, flush=True)
    except (UnicodeEncodeError, OSError):
        pass


def should_stop() -> bool:
    return os.path.exists(STOP_FILE)


def parse_nifty500_symbols() -> list:
    if not os.path.exists(N500_LIST):
        files = [f for f in os.listdir(STOCKS_DIR) if f.endswith("_Daily_2Y.csv")]
        return [f.replace("_Daily_2Y.csv", "") for f in sorted(files)]
    df = pd.read_csv(N500_LIST)
    first_col = str(df.columns[0]).upper().strip()
    if "SYMBOL" not in first_col:
        df = pd.read_csv(N500_LIST, skiprows=16)
    symbols = df.iloc[:, 0].astype(str).str.strip().tolist()
    return [s for s in symbols if s and s != "NIFTY 500" and not s.startswith("Note")
            and len(s) > 0 and s != "nan"]


def get_earliest_date(csv_path: str):
    if not os.path.exists(csv_path):
        return None
    try:
        df = pd.read_csv(csv_path, on_bad_lines="skip")
        col = "Datetime" if "Datetime" in df.columns else df.columns[0]
        dates = pd.to_datetime(df[col], errors="coerce").dropna()
        return dates.min().strftime("%Y-%m-%d") if len(dates) > 0 else None
    except Exception:
        return None


def normalize_historical_df(df: pd.DataFrame) -> pd.DataFrame:
    rename = {
        "start_time": "Datetime", "kline_time": "Datetime", "timestamp": "Datetime",
        "open": "Open", "high": "High", "low": "Low", "close": "Close", "volume": "Volume",
    }
    df = df.rename(columns={c: rename[c.lower()] for c in df.columns if c.lower() in rename})
    if "Datetime" in df.columns:
        first_val = df["Datetime"].iloc[0] if len(df) > 0 else None
        if first_val is not None and isinstance(first_val, (int, float)):
            df["Datetime"] = (pd.to_datetime(df["Datetime"], unit="s")
                               .dt.tz_localize("UTC").dt.tz_convert("Asia/Kolkata").dt.tz_localize(None))
        else:
            df["Datetime"] = pd.to_datetime(df["Datetime"])
        df = df.set_index("Datetime").sort_index()
    wanted = [c for c in ["Open", "High", "Low", "Close", "Volume"] if c in df.columns]
    return df[wanted]


def df_to_stock_csv(df: pd.DataFrame, csv_path: str):
    df_save = df.reset_index()
    df_save.columns = [str(c).capitalize() for c in df_save.columns]
    if "Datetime" not in df_save.columns and len(df_save.columns) > 0:
        df_save = df_save.rename(columns={df_save.columns[0]: "Datetime"})
    df_save.to_csv(csv_path, index=False)


def fetch_range_chunked(helper, security_id, segment, instr, from_date, to_date):
    """Fetch [from_date, to_date] inclusive, chunked by 365 days (API date-range limit)."""
    chunks = []
    cur = datetime.strptime(from_date, "%Y-%m-%d")
    end = datetime.strptime(to_date, "%Y-%m-%d")
    while cur <= end:
        chunk_end = min(cur + timedelta(days=365), end)
        df_chunk = helper.get_historical_daily_data(
            security_id=security_id,
            exchange_segment=segment,
            instrument_type=instr,
            from_date=cur.strftime("%Y-%m-%d"),
            to_date=chunk_end.strftime("%Y-%m-%d"),
        )
        if not df_chunk.empty:
            chunks.append(normalize_historical_df(df_chunk))
        cur = chunk_end + timedelta(days=1)
        time.sleep(0.4)
    if not chunks:
        return pd.DataFrame()
    out = pd.concat(chunks)
    return out[~out.index.duplicated(keep="last")].sort_index()


def backfill_symbol(helper, symbol: str, start_date: str) -> str:
    csv_path = os.path.join(STOCKS_DIR, f"{symbol}_Daily_2Y.csv")
    earliest = get_earliest_date(csv_path)

    if earliest and earliest <= start_date:
        return "up-to-date"

    to_date = (
        (datetime.strptime(earliest, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
        if earliest
        else datetime.now().strftime("%Y-%m-%d")
    )

    sec = helper.get_security_id(symbol=symbol, instrument="EQUITY")
    if not sec:
        return "not-found"

    security_id = int(sec["SECURITY_ID"])
    instr = sec.get("INSTRUMENT", "EQUITY")
    exch_id = sec.get("EXCH_ID", "NSE")
    segment = "IDX_I" if instr == "INDEX" else ("BSE_EQ" if exch_id == "BSE" else "NSE_EQ")

    old_df = fetch_range_chunked(helper, security_id, segment, instr, start_date, to_date)
    if old_df.empty:
        return "no-data"

    if os.path.exists(csv_path):
        existing = pd.read_csv(csv_path, on_bad_lines="skip")
        date_col = "Datetime" if "Datetime" in existing.columns else existing.columns[0]
        existing[date_col] = pd.to_datetime(existing[date_col])
        existing = existing.set_index(date_col).sort_index()
        existing.index.name = "Datetime"
        existing.columns = [str(c).capitalize() for c in existing.columns]
        ohlcv_cols = [c for c in ["Open", "High", "Low", "Close", "Volume"] if c in existing.columns]
        existing = existing[ohlcv_cols]
        combined = pd.concat([old_df, existing])
        combined = combined[~combined.index.duplicated(keep="last")].sort_index()
    else:
        combined = old_df

    df_to_stock_csv(combined, csv_path)
    return f"+{len(old_df)} rows -> {len(combined)} total"


def main():
    parser = argparse.ArgumentParser(description="Backfill Nifty 500 daily stock history to an earlier start date")
    parser.add_argument("--start-date", default="2019-01-01", help="Earliest date to backfill to (YYYY-MM-DD)")
    parser.add_argument("--symbol", help="Backfill only this single symbol")
    parser.add_argument("--limit", type=int, help="Only process the first N symbols (for testing)")
    args = parser.parse_args()

    if os.path.exists(STOP_FILE):
        os.remove(STOP_FILE)

    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper

    write_status("Initializing Dhan client...")
    dhan = get_dhan_client()
    if not dhan:
        write_status("Failed to authenticate with Dhan - run login.py first", done=True, error="auth failed")
        return
    helper = DhanHelper(dhan)

    if args.symbol:
        symbols = [args.symbol.strip().upper()]
    else:
        symbols = parse_nifty500_symbols()
        if args.limit:
            symbols = symbols[: args.limit]

    total = len(symbols)
    write_status(f"Backfilling {total} symbols to {args.start_date}...", current=0, total=total)

    updated = skipped = failed = 0
    for i, symbol in enumerate(symbols, 1):
        if should_stop():
            write_status(f"Stopped by user at [{i}/{total}]", current=i, total=total, done=True)
            return
        try:
            result = backfill_symbol(helper, symbol, args.start_date)
            write_status(f"  [{i}/{total}] {symbol}: {result}", current=i, total=total)
            if result == "up-to-date" or result == "no-data":
                skipped += 1
            elif result == "not-found":
                failed += 1
            else:
                updated += 1
        except Exception as e:
            write_status(f"  [{i}/{total}] {symbol}: ERROR - {e}", current=i, total=total)
            failed += 1
        time.sleep(0.2)

    write_status(f"Done: {updated} updated, {skipped} skipped, {failed} failed", current=total, total=total, done=True)


if __name__ == "__main__":
    main()
