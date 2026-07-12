"""
One-time backfill: extend existing index daily CSVs (Historical Data/Indices/*.csv,
plus NIFTY_50_Daily_5Y.csv and NIFTY_500_Daily.csv) backward to an earlier start
date (default 2019-01-01).

Mirrors backfill_stocks_history.py: refresh_dashboard_data.py / download_indices.py
only ever append forward and seed new files with a 1825-day (5Y) lookback, which is
why every index CSV currently starts around 2021-06/2021-08. This script fetches
everything between --start-date and each file's current earliest date and prepends
it, chunked by 365 days (API date-range limit).

Usage:
    venv\\Scripts\\python.exe scripts/downloader/backfill_indices_history.py
    venv\\Scripts\\python.exe scripts/downloader/backfill_indices_history.py --start-date 2019-01-01
    venv\\Scripts\\python.exe scripts/downloader/backfill_indices_history.py --name BANKNIFTY

Writes progress to debug/backfill_indices_status.json; write
debug/backfill_indices_stop.trigger to abort.
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

HIST_DIR = os.path.join(PROJECT_ROOT, "Historical Data")
INDICES_DIR = os.path.join(HIST_DIR, "Indices")
DEBUG_DIR = os.path.join(PROJECT_ROOT, "debug")
STATUS_FILE = os.path.join(DEBUG_DIR, "backfill_indices_status.json")
STOP_FILE = os.path.join(DEBUG_DIR, "backfill_indices_stop.trigger")

os.makedirs(DEBUG_DIR, exist_ok=True)
os.makedirs(INDICES_DIR, exist_ok=True)

# Nifty 50 / Nifty 500 use dedicated CSVs at Historical Data root (not Indices/)
NIFTY50_CSV = os.path.join(HIST_DIR, "NIFTY_50_Daily_5Y.csv")
N500IDX_CSV = os.path.join(HIST_DIR, "NIFTY_500_Daily.csv")

# All sector/broad-market indices (kept in sync with download_indices.py / refresh_dashboard_data.py)
INDICES = [
    {"id": 13, "name": "NIFTY_50_ROOT", "label": "Nifty 50", "csv": NIFTY50_CSV, "segment": "IDX_I"},
    {"id": 19, "name": "NIFTY_500_ROOT", "label": "Nifty 500", "csv": N500IDX_CSV, "segment": "IDX_I"},
    {"id": 38, "name": "NIFTY_NEXT50", "label": "Nifty Next 50"},
    {"id": 17, "name": "NIFTY_100", "label": "Nifty 100"},
    {"id": 18, "name": "NIFTY_200", "label": "Nifty 200"},
    {"id": 37, "name": "NIFTY_MIDCAP100", "label": "Nifty Midcap 100"},
    {"id": 5, "name": "NIFTY_SMALLCAP100", "label": "Nifty Smallcap 100"},
    {"id": 25, "name": "BANKNIFTY", "label": "Nifty Bank"},
    {"id": 29, "name": "NIFTYIT", "label": "Nifty IT"},
    {"id": 28, "name": "NIFTY_FMCG", "label": "Nifty FMCG"},
    {"id": 14, "name": "NIFTY_AUTO", "label": "Nifty Auto"},
    {"id": 32, "name": "NIFTY_PHARMA", "label": "Nifty Pharma"},
    {"id": 31, "name": "NIFTY_METAL", "label": "Nifty Metal"},
    {"id": 34, "name": "NIFTY_REALTY", "label": "Nifty Realty"},
    {"id": 33, "name": "NIFTY_PSU_BANK", "label": "Nifty PSU Bank"},
    {"id": 15, "name": "NIFTY_PVT_BANK", "label": "Nifty Private Bank"},
    {"id": 27, "name": "FINNIFTY", "label": "Nifty Financial Services"},
    {"id": 42, "name": "NIFTY_ENERGY", "label": "Nifty Energy"},
    {"id": 43, "name": "NIFTY_INFRA", "label": "Nifty Infra"},
    {"id": 21, "name": "INDIA_VIX", "label": "India VIX"},
    {"id": 30, "name": "NIFTY_MEDIA", "label": "Nifty Media"},
    {"id": 447, "name": "NIFTY_HEALTHCARE", "label": "Nifty Healthcare"},
    {"id": 466, "name": "NIFTY_CONSR_DURBL", "label": "Nifty Consumer Durables"},
    {"id": 469, "name": "NIFTY_FINSRV25_50", "label": "Nifty Financial Services 25/50"},
    {"id": 470, "name": "NIFTY_OIL_GAS", "label": "Nifty Oil and Gas"},
    {"id": 471, "name": "NIFTY_MIDSML_HLTH", "label": "Nifty MidSmall Healthcare"},
    {"id": 495, "name": "NIFTY_FINSEREXBNK", "label": "Nifty Fin Services Ex-Bank"},
    {"id": 819, "name": "NIFTY_MS_FIN", "label": "Nifty MidSmall Financial Services"},
    {"id": 821, "name": "NIFTY_MS_IT_TELCM", "label": "Nifty MidSmall IT & Telecom"},
]

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


def df_to_index_csv(df: pd.DataFrame, csv_path: str):
    df_save = df.reset_index()
    df_save.columns = [str(c).capitalize() for c in df_save.columns]
    if "Datetime" not in df_save.columns and len(df_save.columns) > 0:
        df_save = df_save.rename(columns={df_save.columns[0]: "Datetime"})
    if "Volume" not in df_save.columns:
        df_save["Volume"] = 0
    cols = ["Datetime", "Open", "High", "Low", "Close", "Volume"]
    df_save = df_save[[c for c in cols if c in df_save.columns]]
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


def backfill_entry(helper, entry: dict, start_date: str) -> str:
    csv_path = entry.get("csv") or os.path.join(INDICES_DIR, f"{entry['name']}.csv")
    earliest = get_earliest_date(csv_path)

    if earliest and earliest <= start_date:
        return "up-to-date"

    to_date = (
        (datetime.strptime(earliest, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")
        if earliest
        else datetime.now().strftime("%Y-%m-%d")
    )

    segment = entry.get("segment", "IDX_I")
    old_df = fetch_range_chunked(helper, entry["id"], segment, "INDEX", start_date, to_date)
    if old_df.empty:
        return "no-data"

    if os.path.exists(csv_path):
        existing = pd.read_csv(csv_path, on_bad_lines="skip")
        date_col = "Datetime" if "Datetime" in existing.columns else existing.columns[0]
        existing[date_col] = pd.to_datetime(existing[date_col])
        existing = existing.set_index(date_col).sort_index()
        existing.index.name = "Datetime"
        existing.columns = [str(c).capitalize() for c in existing.columns]
        combined = pd.concat([old_df, existing])
        combined = combined[~combined.index.duplicated(keep="last")].sort_index()
    else:
        combined = old_df

    df_to_index_csv(combined, csv_path)
    return f"+{len(old_df)} rows -> {len(combined)} total"


def main():
    parser = argparse.ArgumentParser(description="Backfill index daily history to an earlier start date")
    parser.add_argument("--start-date", default="2019-01-01", help="Earliest date to backfill to (YYYY-MM-DD)")
    parser.add_argument("--name", help="Backfill only this single index by name (e.g. BANKNIFTY, NIFTY_50_ROOT)")
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

    targets = INDICES
    if args.name:
        targets = [e for e in INDICES if e["name"].upper() == args.name.upper()]
        if not targets:
            write_status(f"Unknown index name '{args.name}'", done=True, error="unknown index")
            return

    total = len(targets)
    write_status(f"Backfilling {total} indices to {args.start_date}...", current=0, total=total)

    updated = skipped = failed = 0
    for i, entry in enumerate(targets, 1):
        if should_stop():
            write_status(f"Stopped by user at [{i}/{total}]", current=i, total=total, done=True)
            return
        try:
            result = backfill_entry(helper, entry, args.start_date)
            write_status(f"  [{i}/{total}] {entry['label']}: {result}", current=i, total=total)
            if result in ("up-to-date", "no-data"):
                skipped += 1
            else:
                updated += 1
        except Exception as e:
            write_status(f"  [{i}/{total}] {entry['label']}: ERROR - {e}", current=i, total=total)
            failed += 1
        time.sleep(0.3)

    write_status(f"Done: {updated} updated, {skipped} skipped, {failed} failed", current=total, total=total, done=True)


if __name__ == "__main__":
    main()
