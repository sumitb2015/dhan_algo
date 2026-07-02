"""
Non-interactive incremental data refresh for the RS dashboard.

Usage:
    venv\\Scripts\\python.exe scripts/downloader/refresh_dashboard_data.py
    venv\\Scripts\\python.exe scripts/downloader/refresh_dashboard_data.py --target nifty50
    venv\\Scripts\\python.exe scripts/downloader/refresh_dashboard_data.py --target nifty500-index
    venv\\Scripts\\python.exe scripts/downloader/refresh_dashboard_data.py --target indices
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
INDICES_DIR  = os.path.join(HIST_DIR, "Indices")
STOCKS_DIR   = os.path.join(PROJECT_ROOT, "Daily_Historical_Data_Fresh")
DEBUG_DIR    = os.path.join(PROJECT_ROOT, "debug")
STATUS_FILE  = os.path.join(DEBUG_DIR, "refresh_status.json")
STOP_FILE    = os.path.join(DEBUG_DIR, "refresh_stop.trigger")
NIFTY50_CSV  = os.path.join(HIST_DIR, "NIFTY_50_Daily_5Y.csv")
N500IDX_CSV  = os.path.join(HIST_DIR, "NIFTY_500_Daily.csv")
N500_LIST    = os.path.join(PROJECT_ROOT, "MW-NIFTY-500-25-Jan-2026.csv")

os.makedirs(DEBUG_DIR, exist_ok=True)
os.makedirs(HIST_DIR, exist_ok=True)
os.makedirs(INDICES_DIR, exist_ok=True)
os.makedirs(STOCKS_DIR, exist_ok=True)

# Sector indices to refresh daily (Nifty 50=13 and Nifty 500=19 have dedicated phases above)
SECTOR_INDICES = [
    {"id": 38, "name": "NIFTY_NEXT50",     "label": "Nifty Next 50"},
    {"id": 17, "name": "NIFTY_100",         "label": "Nifty 100"},
    {"id": 18, "name": "NIFTY_200",         "label": "Nifty 200"},
    {"id": 37, "name": "NIFTY_MIDCAP100",   "label": "Nifty Midcap 100"},
    {"id": 5,  "name": "NIFTY_SMALLCAP100", "label": "Nifty Smallcap 100"},
    {"id": 25, "name": "BANKNIFTY",         "label": "Nifty Bank"},
    {"id": 29, "name": "NIFTYIT",           "label": "Nifty IT"},
    {"id": 28, "name": "NIFTY_FMCG",        "label": "Nifty FMCG"},
    {"id": 14, "name": "NIFTY_AUTO",        "label": "Nifty Auto"},
    {"id": 32, "name": "NIFTY_PHARMA",      "label": "Nifty Pharma"},
    {"id": 31, "name": "NIFTY_METAL",       "label": "Nifty Metal"},
    {"id": 34, "name": "NIFTY_REALTY",      "label": "Nifty Realty"},
    {"id": 33, "name": "NIFTY_PSU_BANK",    "label": "Nifty PSU Bank"},
    {"id": 15, "name": "NIFTY_PVT_BANK",    "label": "Nifty Private Bank"},
    {"id": 27, "name": "FINNIFTY",          "label": "Nifty Financial Services"},
    {"id": 42,  "name": "NIFTY_ENERGY",      "label": "Nifty Energy"},
    {"id": 43,  "name": "NIFTY_INFRA",       "label": "Nifty Infra"},
    {"id": 21,  "name": "INDIA_VIX",         "label": "India VIX"},
    {"id": 30,  "name": "NIFTY_MEDIA",          "label": "Nifty Media"},
    {"id": 447, "name": "NIFTY_HEALTHCARE",     "label": "Nifty Healthcare"},
    {"id": 466, "name": "NIFTY_CONSR_DURBL",    "label": "Nifty Consumer Durables"},
    {"id": 469, "name": "NIFTY_FINSRV25_50",    "label": "Nifty Financial Services 25/50"},
    {"id": 470, "name": "NIFTY_OIL_GAS",        "label": "Nifty Oil and Gas"},
    {"id": 471, "name": "NIFTY_MIDSML_HLTH",    "label": "Nifty MidSmall Healthcare"},
    {"id": 495, "name": "NIFTY_FINSEREXBNK",    "label": "Nifty Fin Services Ex-Bank"},
    {"id": 819, "name": "NIFTY_MS_FIN",         "label": "Nifty MidSmall Financial Services"},
    {"id": 821, "name": "NIFTY_MS_IT_TELCM",    "label": "Nifty MidSmall IT & Telecom"},
]

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


# ── Trading day helpers ───────────────────────────────────────────────────────
# NSE market holidays. Historical data is published the following day,
# so we never treat today as the reference — always work from yesterday back.
_NSE_HOLIDAYS = {
    "2026-01-15", "2026-01-26", "2026-03-03", "2026-03-26",
    "2026-03-31", "2026-04-03", "2026-04-14", "2026-05-01",
    "2026-05-28", "2026-06-26", "2026-09-14", "2026-10-02",
    "2026-10-20", "2026-11-10", "2026-11-24", "2026-12-25",
}

def get_last_trading_day() -> str:
    """Return the most recent COMPLETED trading day as YYYY-MM-DD (never includes today).

    Starts from yesterday because the Dhan historical API does not publish
    same-day EOD data. Skips weekends and NSE holidays.
    """
    d = datetime.now().date() - timedelta(days=1)
    for _ in range(14):
        if d.weekday() < 5 and d.strftime("%Y-%m-%d") not in _NSE_HOLIDAYS:
            return d.strftime("%Y-%m-%d")
        d -= timedelta(days=1)
    return d.strftime("%Y-%m-%d")


# ── CSV helpers ───────────────────────────────────────────────────────────────
def get_last_date(csv_path: str) -> Optional[str]:
    """Return the latest date string (YYYY-MM-DD) in a CSV, or None."""
    if not os.path.exists(csv_path):
        return None
    try:
        # on_bad_lines='skip' handles CSVs where fetch_today_quotes appended a
        # Timestamp column (7 values) to a 6-column file — pandas 3.x would
        # otherwise raise ParserError on the mismatched row count.
        df = pd.read_csv(csv_path, on_bad_lines='skip')
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


def _daily_from_intraday(helper, security_id, exchange_segment, instrument_type, from_date, to_date):
    """Fallback: compute daily OHLCV from 1-min intraday data when the daily historical API is down."""
    try:
        df_raw = helper.get_intraday_minute_data(
            security_id=security_id,
            exchange_segment=exchange_segment,
            instrument_type=instrument_type,
            interval=1,
            from_date=from_date,
            to_date=to_date,
        )
        if df_raw.empty:
            return pd.DataFrame()
        df = normalize_historical_df(df_raw)
        if df.empty:
            return pd.DataFrame()
        daily = df.resample("D").agg(
            Open=("Open", "first"),
            High=("High", "max"),
            Low=("Low", "min"),
            Close=("Close", "last"),
            Volume=("Volume", "sum"),
        ).dropna(subset=["Open", "Close"])
        daily.index = daily.index.normalize()
        daily.index.name = "Datetime"
        return daily
    except Exception:
        return pd.DataFrame()


MIN_INDEX_ROWS = 200  # below this we treat the CSV as corrupt and force a full re-download

def _csv_row_count(csv_path: str) -> int:
    """Return number of data rows in a CSV (excludes header line)."""
    try:
        with open(csv_path, "r", encoding="utf-8") as f:
            return max(0, sum(1 for _ in f) - 1)
    except Exception:
        return 0


# ── Phase 1: Nifty 50 index ───────────────────────────────────────────────────
def refresh_nifty50(helper):
    write_status("nifty50", "▶ Refreshing Nifty 50 daily index data...")

    last_trading_day = get_last_trading_day()
    # toDate is non-inclusive in the daily API, so pass tomorrow to include last_trading_day
    to_date_api = (datetime.strptime(last_trading_day, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    last_date = get_last_date(NIFTY50_CSV)

    # Detect corrupt/truncated CSV and force a full re-download
    if last_date and os.path.exists(NIFTY50_CSV):
        row_count = _csv_row_count(NIFTY50_CSV)
        if row_count < MIN_INDEX_ROWS:
            write_status("nifty50",
                         f"  ⚠ Nifty 50 CSV appears truncated ({row_count} rows) — forcing full 5Y re-download")
            last_date = None

    if last_date and last_date >= last_trading_day:
        if last_date > last_trading_day:
            # fetch_today_quotes.py may have inserted today's live row while
            # last_trading_day's historical data is still missing — fill the gap.
            from_date = last_trading_day
        else:
            write_status("nifty50", f"✓ Nifty 50 already up to date (last: {last_date})")
            return True
    else:
        from_date = (
            (datetime.strptime(last_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
            if last_date
            else (datetime.now() - timedelta(days=1825)).strftime("%Y-%m-%d")
        )

    write_status("nifty50", f"  Fetching Nifty 50 from {from_date} to {last_trading_day} (api to_date={to_date_api})...")

    try:
        sec = helper._resolve_symbol("NIFTY 50")
        if not sec:
            write_status("nifty50", "  ✗ Could not resolve NIFTY 50 symbol")
            return False

        security_id = int(sec["SECURITY_ID"])
        instr = sec.get("INSTRUMENT", "INDEX")
        segment = "IDX_I" if instr == "INDEX" else "NSE_EQ"

        # Chunk by year (API limit); use to_date_api so the non-inclusive bound covers last_trading_day
        chunks = []
        cur = datetime.strptime(from_date, "%Y-%m-%d")
        end = datetime.strptime(to_date_api, "%Y-%m-%d")
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
            write_status("nifty50", "  ↺ Daily API returned no data — trying intraday fallback...")
            fb = _daily_from_intraday(helper, security_id, segment, instr, from_date, last_trading_day)
            if fb.empty:
                write_status("nifty50", "  ✓ Nifty 50 up to date (no new data from daily or intraday API)")
                return True
            chunks.append(fb)

        new_df = pd.concat(chunks)
        new_df = new_df[~new_df.index.duplicated(keep="last")].sort_index()
        # Clip to last_trading_day in case the API returned any partial today data
        new_df = new_df[new_df.index <= pd.Timestamp(last_trading_day)]

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

    last_trading_day = get_last_trading_day()
    to_date_api = (datetime.strptime(last_trading_day, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    last_date = get_last_date(N500IDX_CSV)

    # Detect corrupt/truncated CSV and force a full re-download
    if last_date and os.path.exists(N500IDX_CSV):
        row_count = _csv_row_count(N500IDX_CSV)
        if row_count < MIN_INDEX_ROWS:
            write_status("nifty500_index",
                         f"  ⚠ Nifty 500 index CSV appears truncated ({row_count} rows) — forcing full 5Y re-download")
            last_date = None

    if last_date and last_date >= last_trading_day:
        if last_date > last_trading_day:
            from_date = last_trading_day
        else:
            write_status("nifty500_index", f"✓ Nifty 500 index already up to date (last: {last_date})")
            return True
    else:
        from_date = (
            (datetime.strptime(last_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
            if last_date
            else (datetime.now() - timedelta(days=1825)).strftime("%Y-%m-%d")
        )

    write_status("nifty500_index", f"  Fetching Nifty 500 index from {from_date} to {last_trading_day} (api to_date={to_date_api})...")

    try:
        # Chunk by year to stay within API date-range limits (security_id=19)
        chunks = []
        cur = datetime.strptime(from_date, "%Y-%m-%d")
        end = datetime.strptime(to_date_api, "%Y-%m-%d")
        while cur <= end:
            chunk_end = min(cur + timedelta(days=365), end)
            df_chunk = helper.get_historical_daily_data(
                security_id=19,
                exchange_segment="IDX_I",
                instrument_type="INDEX",
                from_date=cur.strftime("%Y-%m-%d"),
                to_date=chunk_end.strftime("%Y-%m-%d"),
            )
            if not df_chunk.empty:
                chunks.append(normalize_historical_df(df_chunk))
            cur = chunk_end + timedelta(days=1)
            time.sleep(0.4)

        if not chunks:
            write_status("nifty500_index", "  ↺ Daily API returned no data — trying intraday fallback...")
            fb = _daily_from_intraday(helper, 19, "IDX_I", "INDEX", from_date, last_trading_day)
            if fb.empty:
                write_status("nifty500_index", "  ✓ Nifty 500 index up to date (no new data from daily or intraday API)")
                return True
            chunks.append(fb)

        new_df = pd.concat(chunks)
        new_df = new_df[~new_df.index.duplicated(keep="last")].sort_index()
        new_df = new_df[new_df.index <= pd.Timestamp(last_trading_day)]

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

    last_trading_day = get_last_trading_day()
    # toDate is non-inclusive in the daily API; add 1 day so last_trading_day is included
    to_date_api = (datetime.strptime(last_trading_day, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    skipped = updated = failed = 0

    for i, symbol in enumerate(symbols, 1):
        if should_stop():
            write_status("stocks", f"⏹ Stopped by user at [{i}/{total}]",
                         current=i, total=total, done=True)
            return

        csv_path = os.path.join(STOCKS_DIR, f"{symbol}_Daily_2Y.csv")
        last_date = get_last_date(csv_path)

        # Already up to date?
        if last_date and last_date >= last_trading_day:
            if last_date > last_trading_day:
                # fetch_today_quotes.py may have inserted today's live row while
                # last_trading_day's historical data is still missing — fill the gap.
                from_date = last_trading_day
            else:
                skipped += 1
                write_status("stocks", f"  [{i}/{total}] {symbol}: up to date ({last_date})",
                             current=i, total=total)
                continue
        else:
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
                to_date=to_date_api,
            )

            if df_new.empty:
                write_status("stocks", f"  [{i}/{total}] {symbol}: ✓ up to date (no new data from API)",
                             current=i, total=total)
                skipped += 1
                time.sleep(0.2)
                continue

            new_df = normalize_historical_df(df_new)
            new_df = new_df[~new_df.index.duplicated(keep="last")].sort_index()
            # Clip to last_trading_day to guard against partial today data if API is inclusive
            new_df = new_df[new_df.index <= pd.Timestamp(last_trading_day)]
            if new_df.empty:
                skipped += 1
                time.sleep(0.2)
                continue

            if last_date and os.path.exists(csv_path):
                old = pd.read_csv(csv_path, on_bad_lines='skip')
                date_col = "Datetime" if "Datetime" in old.columns else old.columns[0]
                old[date_col] = pd.to_datetime(old[date_col])
                old = old.set_index(date_col).sort_index()
                old.index.name = "Datetime"
                old.columns = [str(c).capitalize() for c in old.columns]
                # Keep only canonical OHLCV columns — drops Timestamp added by fetch_today_quotes
                ohlcv_cols = [c for c in ["Open", "High", "Low", "Close", "Volume"] if c in old.columns]
                old = old[ohlcv_cols]
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


# ── Phase 4: Sector / broad-market indices ────────────────────────────────────
def refresh_indices(helper):
    total = len(SECTOR_INDICES)
    write_status("indices", f"▶ Refreshing {total} sector/market indices...", current=0, total=total)

    last_trading_day = get_last_trading_day()
    to_date_api = (datetime.strptime(last_trading_day, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    updated = skipped = failed = 0

    for i, entry in enumerate(SECTOR_INDICES, 1):
        if should_stop():
            write_status("indices", f"⏹ Stopped at [{i}/{total}]", current=i, total=total, done=True)
            return

        csv_path = os.path.join(INDICES_DIR, f"{entry['name']}.csv")
        last_date = get_last_date(csv_path)

        if last_date and last_date >= last_trading_day:
            if last_date > last_trading_day:
                from_date = last_trading_day
            else:
                skipped += 1
                write_status("indices", f"  [{i}/{total}] {entry['label']}: up to date ({last_date})",
                             current=i, total=total)
                continue
        else:
            from_date = (
                (datetime.strptime(last_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
                if last_date
                else (datetime.now() - timedelta(days=1825)).strftime("%Y-%m-%d")
            )

        write_status("indices", f"  [{i}/{total}] {entry['label']}: fetching from {from_date}...",
                     current=i, total=total)

        try:
            chunks = []
            cur = datetime.strptime(from_date, "%Y-%m-%d")
            end = datetime.strptime(to_date_api, "%Y-%m-%d")
            while cur <= end:
                chunk_end = min(cur + timedelta(days=365), end)
                df_chunk = helper.get_historical_daily_data(
                    security_id=entry["id"],
                    exchange_segment="IDX_I",
                    instrument_type="INDEX",
                    from_date=cur.strftime("%Y-%m-%d"),
                    to_date=chunk_end.strftime("%Y-%m-%d"),
                )
                if not df_chunk.empty:
                    chunks.append(normalize_historical_df(df_chunk))
                cur = chunk_end + timedelta(days=1)
                time.sleep(0.4)

            if not chunks:
                fb = _daily_from_intraday(helper, entry["id"], "IDX_I", "INDEX", from_date, last_trading_day)
                if fb.empty:
                    write_status("indices",
                                 f"  [{i}/{total}] {entry['label']}: ✓ up to date (no new data from daily or intraday API)",
                                 current=i, total=total)
                    skipped += 1
                    continue
                chunks.append(fb)

            new_df = pd.concat(chunks)
            new_df = new_df[~new_df.index.duplicated(keep="last")].sort_index()
            new_df = new_df[new_df.index <= pd.Timestamp(last_trading_day)]

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

            df_to_index_csv(combined, csv_path)
            write_status("indices",
                         f"  [{i}/{total}] {entry['label']}: +{len(new_df)} rows → {len(combined)} total",
                         current=i, total=total)
            updated += 1

        except Exception as e:
            write_status("indices", f"  [{i}/{total}] {entry['label']}: ERROR — {e}",
                         current=i, total=total)
            failed += 1

        time.sleep(0.35)

    write_status("indices", f"✓ Indices done: {updated} updated, {skipped} skipped, {failed} failed",
                 current=total, total=total)


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Refresh RS dashboard data (incremental)")
    parser.add_argument("--target", default="all",
                        choices=["all", "nifty50", "nifty500-index", "indices", "stocks", "quotes"])
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

    if args.target in ("all", "indices"):
        refresh_indices(helper)
        if should_stop():
            write_status("stopped", "Stopped after indices.", done=True)
            return

    if args.target in ("all", "stocks"):
        refresh_stocks(helper)

    if args.target in ("all", "quotes"):
        # Dhan historical API only publishes prior-day EOD data (next-morning lag).
        # Fetch today's live quotes via quote_data so the dashboard can show
        # the current day's row without waiting for tomorrow's historical publish.
        write_status("quotes", "▶ Fetching live quotes for today's data...")
        try:
            import subprocess
            quotes_script = os.path.join(PROJECT_ROOT, "scripts", "downloader", "fetch_today_quotes.py")
            python_exe = sys.executable
            result = subprocess.run(
                [python_exe, quotes_script],
                capture_output=True, text=True, cwd=PROJECT_ROOT,
                env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            )
            write_status("quotes", f"  Output: {result.stdout[-500:] if result.stdout else '(none)'}")
            if result.returncode != 0:
                err_msg = result.stderr[-300:] if result.stderr else f"exit code {result.returncode}"
                write_status("quotes", f"  ✗ Quotes error: {err_msg}")
            else:
                write_status("quotes", "  ✓ Live quotes written to debug/today_quotes.json")
        except Exception as e:
            write_status("quotes", f"  ✗ Quotes fetch failed: {e}")

        if args.target == "quotes":
            write_status("quotes", "✅ Live quotes refresh complete.", done=True)
            return

    write_status("done", "✅ Data refresh complete.", done=True)


if __name__ == "__main__":
    main()
