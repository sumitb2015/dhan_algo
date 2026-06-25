"""
Non-interactive incremental data refresh for the RS dashboard.

Usage:
    venv\\Scripts\\python.exe scripts/downloader/refresh_dashboard_data.py
    venv\\Scripts\\python.exe scripts/downloader/refresh_dashboard_data.py --target nifty50
    venv\\Scripts\\python.exe scripts/downloader/refresh_dashboard_data.py --target nifty500-index
    venv\\Scripts\\python.exe scripts/downloader/refresh_dashboard_data.py --target stocks

Writes JSON status to debug/refresh_status.json for the dashboard to poll.
"""
import sys
import os
import time
import json
import argparse
import traceback
import warnings
import pandas as pd
from datetime import datetime, timedelta
from typing import Optional

warnings.filterwarnings("ignore")

# ── Paths ────────────────────────────────────────────────────────────────────
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)

HIST_DIR     = os.path.join(PROJECT_ROOT, "Historical Data")
STOCKS_DIR   = os.path.join(PROJECT_ROOT, "Daily_Historical_Data_Fresh")
DEBUG_DIR    = os.path.join(PROJECT_ROOT, "debug")
STATUS_FILE  = os.path.join(DEBUG_DIR, "refresh_status.json")
STOP_FILE    = os.path.join(DEBUG_DIR, "refresh_stop.trigger")
NIFTY50_CSV  = os.path.join(HIST_DIR, "NIFTY_50_Daily_5Y.csv")
N500IDX_CSV  = os.path.join(HIST_DIR, "NIFTY_500_Daily.csv")
N500_LIST    = os.path.join(PROJECT_ROOT, "MW-NIFTY-500-25-Jan-2026.csv")

os.makedirs(DEBUG_DIR, exist_ok=True)
os.makedirs(HIST_DIR, exist_ok=True)
os.makedirs(STOCKS_DIR, exist_ok=True)

# ── Status writer ─────────────────────────────────────────────────────────────
_log_lines: list[str] = []

def write_status(phase: str, message: str, current: int = 0, total: int = 0,
                 done: bool = False, error: str = None):
    _log_lines.append(message)
    if len(_log_lines) > 200:
        _log_lines.pop(0)

    payload = {
        "pid":       os.getpid(),
        "phase":     phase,
        "message":   message,
        "current":   current,
        "total":     total,
        "done":      done,
        "error":     error,
        "log":       _log_lines[-60:],
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


def mark_error(msg: str):
    write_status("error", msg, done=True, error=msg)


# ── CSV helpers ───────────────────────────────────────────────────────────────
def get_last_date(csv_path: str) -> Optional[str]:
    """Return the latest date string (YYYY-MM-DD) in a CSV, or None."""
    if not os.path.exists(csv_path):
        return None
    try:
        df = pd.read_csv(csv_path)
        # Try named 'Datetime' column first, fall back to index col
        if 'Datetime' in df.columns:
            dates = pd.to_datetime(df['Datetime'], errors='coerce').dropna()
        elif len(df.columns) >= 1:
            dates = pd.to_datetime(df.iloc[:, 0], errors='coerce').dropna()
        else:
            return None
        if len(dates) == 0:
            return None
        return dates.max().strftime("%Y-%m-%d")
    except Exception:
        return None


def df_to_stock_csv(df: pd.DataFrame, csv_path: str):
    """Save DataFrame (DatetimeIndex) to CSV in the format readStockCSV expects."""
    df_save = df.reset_index()
    df_save.columns = [str(c).capitalize() for c in df_save.columns]
    # Ensure 'Datetime' column is first and rename if needed
    if 'Datetime' not in df_save.columns and len(df_save.columns) > 0:
        df_save = df_save.rename(columns={df_save.columns[0]: 'Datetime'})
    df_save.to_csv(csv_path, index=False)


def df_to_index_csv(df: pd.DataFrame, csv_path: str):
    """Save index DataFrame to CSV matching NIFTY_50/NIFTY_500 format."""
    df_save = df.reset_index()
    df_save.columns = [str(c).capitalize() for c in df_save.columns]
    if 'Datetime' not in df_save.columns and len(df_save.columns) > 0:
        df_save = df_save.rename(columns={df_save.columns[0]: 'Datetime'})
    if 'Volume' not in df_save.columns:
        df_save['Volume'] = 0
    cols = ['Datetime', 'Open', 'High', 'Low', 'Close', 'Volume']
    df_save = df_save[[c for c in cols if c in df_save.columns]]
    df_save.to_csv(csv_path, index=False)


def normalize_historical_df(df: pd.DataFrame) -> pd.DataFrame:
    """Normalize a raw API response DataFrame to a clean DatetimeIndex DF."""
    rename = {
        "start_time": "Datetime", "start_Time": "Datetime",
        "kline_time": "Datetime", "timestamp": "Datetime",
        "open": "Open", "high": "High", "low": "Low",
        "close": "Close", "volume": "Volume",
    }
    df = df.rename(columns={c: rename[c.lower()] for c in df.columns if c.lower() in rename})

    if "Datetime" in df.columns:
        first_val = df["Datetime"].iloc[0] if len(df) > 0 else None
        if first_val is not None and isinstance(first_val, (int, float)):
            df["Datetime"] = (pd.to_datetime(df["Datetime"], unit="s")
                              .dt.tz_localize("UTC")
                              .dt.tz_convert("Asia/Kolkata")
                              .dt.tz_localize(None))
        else:
            df["Datetime"] = pd.to_datetime(df["Datetime"])
        df = df.set_index("Datetime").sort_index()

    wanted = [c for c in ["Open", "High", "Low", "Close", "Volume"] if c in df.columns]
    return df[wanted]


# ── Phase 1: Nifty 50 index ───────────────────────────────────────────────────
def refresh_nifty50(helper):
    write_status("nifty50", "▶ Refreshing Nifty 50 daily index data...")

    today = datetime.now().strftime("%Y-%m-%d")
    last_date = get_last_date(NIFTY50_CSV)

    if last_date and last_date >= today:
        write_status("nifty50", f"✓ Nifty 50 already up to date (last: {last_date})")
        return True

    from_date = (
        (datetime.strptime(last_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        if last_date
        else (datetime.now() - timedelta(days=1825)).strftime("%Y-%m-%d")
    )

    write_status("nifty50", f"  Fetching Nifty 50 from {from_date} to {today}...")

    try:
        sec = helper._resolve_symbol("NIFTY 50")
        if not sec:
            write_status("nifty50", "  ✗ Could not resolve NIFTY 50 symbol")
            return False

        security_id = int(sec["SECURITY_ID"])
        instr = sec.get("INSTRUMENT", "INDEX")
        segment = "IDX_I" if instr == "INDEX" else "NSE_EQ"

        # Chunk by year (API limit)
        chunks = []
        cur = datetime.strptime(from_date, "%Y-%m-%d")
        end = datetime.strptime(today, "%Y-%m-%d")
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
            write_status("nifty50", f"  ✓ Nifty 50 already at latest (no new rows from API)")
            return True

        new_df = pd.concat(chunks)
        new_df = new_df[~new_df.index.duplicated(keep="last")].sort_index()

        # Merge with existing data
        if last_date and os.path.exists(NIFTY50_CSV):
            old = pd.read_csv(NIFTY50_CSV)
            date_col = "Datetime" if "Datetime" in old.columns else old.columns[0]
            old[date_col] = pd.to_datetime(old[date_col])
            old = old.set_index(date_col).sort_index()
            old.index.name = "Datetime"
            old.columns = [str(c).capitalize() for c in old.columns]
            combined = pd.concat([old, new_df])
            combined = combined[~combined.index.duplicated(keep="last")].sort_index()
        else:
            combined = new_df

        df_to_index_csv(combined, NIFTY50_CSV)
        write_status("nifty50", f"  ✓ Nifty 50 updated: {len(new_df)} new rows (total {len(combined)})")
        return True

    except Exception as e:
        write_status("nifty50", f"  ✗ Nifty 50 error: {e}")
        return False


# ── Phase 2: Nifty 500 index ──────────────────────────────────────────────────
def refresh_nifty500_index(helper):
    write_status("nifty500_index", "▶ Refreshing Nifty 500 daily index data...")

    today = datetime.now().strftime("%Y-%m-%d")
    last_date = get_last_date(N500IDX_CSV)

    if last_date and last_date >= today:
        write_status("nifty500_index", f"✓ Nifty 500 index already up to date (last: {last_date})")
        return True

    from_date = (
        (datetime.strptime(last_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        if last_date
        else (datetime.now() - timedelta(days=1825)).strftime("%Y-%m-%d")
    )

    write_status("nifty500_index", f"  Fetching Nifty 500 index from {from_date} to {today}...")

    try:
        # Nifty 500 Index: security_id=19, segment=IDX_I, instrument=INDEX
        df = helper.get_historical_daily_data(
            security_id=19,
            exchange_segment="IDX_I",
            instrument_type="INDEX",
            from_date=from_date,
            to_date=today,
        )

        if df.empty:
            write_status("nifty500_index", "  ✓ Nifty 500 index: no new rows from API")
            return True

        new_df = normalize_historical_df(df)
        new_df = new_df[~new_df.index.duplicated(keep="last")].sort_index()

        # Merge with existing
        if last_date and os.path.exists(N500IDX_CSV):
            old = pd.read_csv(N500IDX_CSV)
            date_col = "Datetime" if "Datetime" in old.columns else old.columns[0]
            old[date_col] = pd.to_datetime(old[date_col])
            old = old.set_index(date_col).sort_index()
            old.index.name = "Datetime"
            old.columns = [str(c).capitalize() for c in old.columns]
            combined = pd.concat([old, new_df])
            combined = combined[~combined.index.duplicated(keep="last")].sort_index()
        else:
            combined = new_df

        df_to_index_csv(combined, N500IDX_CSV)
        write_status("nifty500_index", f"  ✓ Nifty 500 index updated: {len(new_df)} new rows (total {len(combined)})")
        return True

    except Exception as e:
        write_status("nifty500_index", f"  ✗ Nifty 500 index error: {e}")
        return False


# ── Phase 3: Individual stocks ────────────────────────────────────────────────
def parse_nifty500_symbols() -> list[str]:
    """Parse symbol list from MW-NIFTY-500 CSV."""
    if not os.path.exists(N500_LIST):
        # Fall back to all files in STOCKS_DIR
        files = [f for f in os.listdir(STOCKS_DIR) if f.endswith("_Daily_2Y.csv")]
        return [f.replace("_Daily_2Y.csv", "") for f in sorted(files)]
    try:
        df = pd.read_csv(N500_LIST)
        first_col = str(df.columns[0]).upper().strip()
        if "SYMBOL" not in first_col:
            df = pd.read_csv(N500_LIST, skiprows=16)
        symbols = df.iloc[:, 0].astype(str).str.strip().tolist()
        return [s for s in symbols if s and s != "NIFTY 500" and not s.startswith("Note")
                and len(s) > 0 and s != "nan"]
    except Exception:
        files = [f for f in os.listdir(STOCKS_DIR) if f.endswith("_Daily_2Y.csv")]
        return [f.replace("_Daily_2Y.csv", "") for f in sorted(files)]


def refresh_stocks(helper):
    symbols = parse_nifty500_symbols()
    total = len(symbols)
    write_status("stocks", f"▶ Refreshing {total} stocks (incremental)...", current=0, total=total)

    today = datetime.now().strftime("%Y-%m-%d")
    skipped = updated = failed = 0

    for i, symbol in enumerate(symbols, 1):
        if should_stop():
            write_status("stocks", f"⏹ Stopped by user at [{i}/{total}]",
                         current=i, total=total, done=True)
            return

        csv_path = os.path.join(STOCKS_DIR, f"{symbol}_Daily_2Y.csv")
        last_date = get_last_date(csv_path)

        # Already up to date?
        if last_date and last_date >= today:
            skipped += 1
            write_status("stocks", f"  [{i}/{total}] {symbol}: up to date ({last_date})",
                         current=i, total=total)
            continue

        from_date = (
            (datetime.strptime(last_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
            if last_date
            else (datetime.now() - timedelta(days=730)).strftime("%Y-%m-%d")
        )

        write_status("stocks", f"  [{i}/{total}] {symbol}: fetching from {from_date}...",
                     current=i, total=total)

        try:
            sec = helper.get_security_id(symbol=symbol, instrument="EQUITY")
            if not sec:
                write_status("stocks", f"  [{i}/{total}] {symbol}: not found in master list",
                             current=i, total=total)
                failed += 1
                time.sleep(0.1)
                continue

            security_id = int(sec["SECURITY_ID"])
            instr = sec.get("INSTRUMENT", "EQUITY")
            exch_id = sec.get("EXCH_ID", "NSE")
            if instr == "INDEX":
                segment = "IDX_I"
            elif exch_id == "BSE":
                segment = "BSE_EQ"
            else:
                segment = "NSE_EQ"

            df_new = helper.get_historical_daily_data(
                security_id=security_id,
                exchange_segment=segment,
                instrument_type=instr,
                from_date=from_date,
                to_date=today,
            )

            if df_new.empty:
                write_status("stocks", f"  [{i}/{total}] {symbol}: no new data",
                             current=i, total=total)
                skipped += 1
                time.sleep(0.2)
                continue

            new_df = normalize_historical_df(df_new)
            new_df = new_df[~new_df.index.duplicated(keep="last")].sort_index()

            if last_date and os.path.exists(csv_path):
                old = pd.read_csv(csv_path)
                date_col = "Datetime" if "Datetime" in old.columns else old.columns[0]
                old[date_col] = pd.to_datetime(old[date_col])
                old = old.set_index(date_col).sort_index()
                old.index.name = "Datetime"
                old.columns = [str(c).capitalize() for c in old.columns]
                combined = pd.concat([old, new_df])
                combined = combined[~combined.index.duplicated(keep="last")].sort_index()
            else:
                combined = new_df

            df_to_stock_csv(combined, csv_path)
            write_status("stocks",
                         f"  [{i}/{total}] {symbol}: +{len(new_df)} rows → {len(combined)} total",
                         current=i, total=total)
            updated += 1

        except Exception as e:
            write_status("stocks", f"  [{i}/{total}] {symbol}: ERROR — {e}",
                         current=i, total=total)
            failed += 1

        time.sleep(0.35)

    summary = f"✓ Stocks done: {updated} updated, {skipped} skipped, {failed} failed"
    write_status("stocks", summary, current=total, total=total)


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Refresh RS dashboard data (incremental)")
    parser.add_argument("--target", default="all",
                        choices=["all", "nifty50", "nifty500-index", "stocks", "quotes"])
    args = parser.parse_args()

    # Remove any stale stop trigger
    if os.path.exists(STOP_FILE):
        os.remove(STOP_FILE)

    write_status("init", f"▶ Starting data refresh (target={args.target})...")

    try:
        from login import get_dhan_client
        from lib.dhan_helper import DhanHelper

        write_status("init", "  Initializing Dhan client...")
        dhan = get_dhan_client()
        if not dhan:
            mark_error("Failed to authenticate with Dhan — run login.py first")
            return

        helper = DhanHelper(dhan)
        write_status("init", "  Dhan client ready.")

    except Exception as e:
        mark_error(f"Initialization error: {e}\n{traceback.format_exc()}")
        return

    if should_stop():
        write_status("stopped", "Stopped before starting.", done=True)
        return

    if args.target in ("all", "nifty50"):
        refresh_nifty50(helper)
        if should_stop():
            write_status("stopped", "Stopped after Nifty 50.", done=True)
            return

    if args.target in ("all", "nifty500-index"):
        refresh_nifty500_index(helper)
        if should_stop():
            write_status("stopped", "Stopped after Nifty 500 index.", done=True)
            return

    if args.target in ("all", "stocks"):
        refresh_stocks(helper)

    if args.target == "quotes":
        write_status("quotes", "▶ Fetching live quotes for today's data...")
        try:
            import subprocess
            quotes_script = os.path.join(PROJECT_ROOT, "scripts", "downloader", "fetch_today_quotes.py")
            python_exe = sys.executable
            result = subprocess.run(
                [python_exe, quotes_script],
                capture_output=True, text=True, cwd=PROJECT_ROOT
            )
            write_status("quotes", f"  Output: {result.stdout[-500:] if result.stdout else '(none)'}")
            if result.returncode != 0:
                write_status("quotes", f"  ✗ Quotes error: {result.stderr[-300:]}")
            else:
                write_status("quotes", "  ✓ Live quotes written to debug/today_quotes.json", done=True)
        except Exception as e:
            write_status("quotes", f"  ✗ Quotes fetch failed: {e}", done=True, error=str(e))
        return

    write_status("done", "✅ Data refresh complete.", done=True)


if __name__ == "__main__":
    main()
