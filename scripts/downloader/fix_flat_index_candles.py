"""
Repair degenerate index candles caused by fetch_today_quotes.py's LTP-only
fallback (writes Open=High=Low=Close=LTP, Volume=0 when the batch OHLC/quote
API doesn't return real intraday OHLC). refresh_dashboard_data.py only ever
fills forward from the last CSV date, so once a flat placeholder row lands
on a date that's already "last date", it never gets corrected by the normal
incremental refresh — and non-trading days (weekends) can end up with a
bogus carried-forward row too.

For each target index CSV, this re-fetches real daily EOD data for the last
`--days` calendar days from the Dhan historical API, drops all existing rows
in that window, and replaces them with the freshly fetched authoritative
data (which naturally excludes non-trading days).

Usage:
    venv\\Scripts\\python.exe scripts/downloader/fix_flat_index_candles.py
    venv\\Scripts\\python.exe scripts/downloader/fix_flat_index_candles.py --days 60
    venv\\Scripts\\python.exe scripts/downloader/fix_flat_index_candles.py --name BANKNIFTY
"""
import sys
import os
import time
import argparse
import warnings
import pandas as pd
from datetime import datetime, timedelta

warnings.filterwarnings("ignore")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)

HIST_DIR = os.path.join(PROJECT_ROOT, "Historical Data")
INDICES_DIR = os.path.join(HIST_DIR, "Indices")
NIFTY50_5Y_CSV = os.path.join(HIST_DIR, "NIFTY_50_Daily_5Y.csv")
NIFTY50_1Y_CSV = os.path.join(HIST_DIR, "NIFTY_50_Daily_1Y.csv")
NIFTY500_CSV = os.path.join(HIST_DIR, "NIFTY_500_Daily.csv")

# security_id=13/IDX_I is Nifty 50; each CSV below gets patched from the same fetch.
NIFTY50_TARGETS = [NIFTY50_5Y_CSV, NIFTY50_1Y_CSV]

TARGETS = [
    {"id": 19, "name": "NIFTY_500_ROOT", "label": "Nifty 500", "csv": NIFTY500_CSV},
    {"id": 38, "name": "NIFTY_NEXT50", "label": "Nifty Next 50", "csv": os.path.join(INDICES_DIR, "NIFTY_NEXT50.csv")},
    {"id": 17, "name": "NIFTY_100", "label": "Nifty 100", "csv": os.path.join(INDICES_DIR, "NIFTY_100.csv")},
    {"id": 18, "name": "NIFTY_200", "label": "Nifty 200", "csv": os.path.join(INDICES_DIR, "NIFTY_200.csv")},
    {"id": 37, "name": "NIFTY_MIDCAP100", "label": "Nifty Midcap 100", "csv": os.path.join(INDICES_DIR, "NIFTY_MIDCAP100.csv")},
    {"id": 5, "name": "NIFTY_SMALLCAP100", "label": "Nifty Smallcap 100", "csv": os.path.join(INDICES_DIR, "NIFTY_SMALLCAP100.csv")},
    {"id": 25, "name": "BANKNIFTY", "label": "Nifty Bank", "csv": os.path.join(INDICES_DIR, "BANKNIFTY.csv")},
    {"id": 29, "name": "NIFTYIT", "label": "Nifty IT", "csv": os.path.join(INDICES_DIR, "NIFTYIT.csv")},
    {"id": 28, "name": "NIFTY_FMCG", "label": "Nifty FMCG", "csv": os.path.join(INDICES_DIR, "NIFTY_FMCG.csv")},
    {"id": 14, "name": "NIFTY_AUTO", "label": "Nifty Auto", "csv": os.path.join(INDICES_DIR, "NIFTY_AUTO.csv")},
    {"id": 32, "name": "NIFTY_PHARMA", "label": "Nifty Pharma", "csv": os.path.join(INDICES_DIR, "NIFTY_PHARMA.csv")},
    {"id": 31, "name": "NIFTY_METAL", "label": "Nifty Metal", "csv": os.path.join(INDICES_DIR, "NIFTY_METAL.csv")},
    {"id": 34, "name": "NIFTY_REALTY", "label": "Nifty Realty", "csv": os.path.join(INDICES_DIR, "NIFTY_REALTY.csv")},
    {"id": 33, "name": "NIFTY_PSU_BANK", "label": "Nifty PSU Bank", "csv": os.path.join(INDICES_DIR, "NIFTY_PSU_BANK.csv")},
    {"id": 15, "name": "NIFTY_PVT_BANK", "label": "Nifty Private Bank", "csv": os.path.join(INDICES_DIR, "NIFTY_PVT_BANK.csv")},
    {"id": 27, "name": "FINNIFTY", "label": "Nifty Financial Services", "csv": os.path.join(INDICES_DIR, "FINNIFTY.csv")},
    {"id": 42, "name": "NIFTY_ENERGY", "label": "Nifty Energy", "csv": os.path.join(INDICES_DIR, "NIFTY_ENERGY.csv")},
    {"id": 43, "name": "NIFTY_INFRA", "label": "Nifty Infra", "csv": os.path.join(INDICES_DIR, "NIFTY_INFRA.csv")},
    {"id": 21, "name": "INDIA_VIX", "label": "India VIX", "csv": os.path.join(INDICES_DIR, "INDIA_VIX.csv")},
    {"id": 30, "name": "NIFTY_MEDIA", "label": "Nifty Media", "csv": os.path.join(INDICES_DIR, "NIFTY_MEDIA.csv")},
    {"id": 447, "name": "NIFTY_HEALTHCARE", "label": "Nifty Healthcare", "csv": os.path.join(INDICES_DIR, "NIFTY_HEALTHCARE.csv")},
    {"id": 466, "name": "NIFTY_CONSR_DURBL", "label": "Nifty Consumer Durables", "csv": os.path.join(INDICES_DIR, "NIFTY_CONSR_DURBL.csv")},
    {"id": 469, "name": "NIFTY_FINSRV25_50", "label": "Nifty Financial Services 25/50", "csv": os.path.join(INDICES_DIR, "NIFTY_FINSRV25_50.csv")},
    {"id": 470, "name": "NIFTY_OIL_GAS", "label": "Nifty Oil and Gas", "csv": os.path.join(INDICES_DIR, "NIFTY_OIL_GAS.csv")},
    {"id": 471, "name": "NIFTY_MIDSML_HLTH", "label": "Nifty MidSmall Healthcare", "csv": os.path.join(INDICES_DIR, "NIFTY_MIDSML_HLTH.csv")},
    {"id": 495, "name": "NIFTY_FINSEREXBNK", "label": "Nifty Fin Services Ex-Bank", "csv": os.path.join(INDICES_DIR, "NIFTY_FINSEREXBNK.csv")},
    {"id": 819, "name": "NIFTY_MS_FIN", "label": "Nifty MidSmall Financial Services", "csv": os.path.join(INDICES_DIR, "NIFTY_MS_FIN.csv")},
    {"id": 821, "name": "NIFTY_MS_IT_TELCM", "label": "Nifty MidSmall IT & Telecom", "csv": os.path.join(INDICES_DIR, "NIFTY_MS_IT_TELCM.csv")},
]


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


def load_csv(csv_path: str) -> pd.DataFrame:
    if not os.path.exists(csv_path):
        return pd.DataFrame()
    df = pd.read_csv(csv_path, on_bad_lines="skip")
    date_col = "Datetime" if "Datetime" in df.columns else df.columns[0]
    df[date_col] = pd.to_datetime(df[date_col], errors="coerce")
    df = df.dropna(subset=[date_col]).set_index(date_col).sort_index()
    df.index.name = "Datetime"
    df.columns = [str(c).capitalize() for c in df.columns]
    return df


def save_csv(df: pd.DataFrame, csv_path: str):
    df_save = df.reset_index()
    df_save.columns = [str(c).capitalize() for c in df_save.columns]
    if "Volume" not in df_save.columns:
        df_save["Volume"] = 0
    cols = ["Datetime", "Open", "High", "Low", "Close", "Volume"]
    df_save = df_save[[c for c in cols if c in df_save.columns]]
    df_save.to_csv(csv_path, index=False)


def fetch_window(helper, security_id: int, from_date: str, to_date_api: str) -> pd.DataFrame:
    df_chunk = helper.get_historical_daily_data(
        security_id=security_id,
        exchange_segment="IDX_I",
        instrument_type="INDEX",
        from_date=from_date,
        to_date=to_date_api,
    )
    if df_chunk.empty:
        return pd.DataFrame()
    return normalize_historical_df(df_chunk)


def repair_csv(helper, security_id: int, csv_path: str, label: str, window_start: str, last_trading_day: str, to_date_api: str) -> str:
    if not os.path.exists(csv_path):
        return "no csv"

    fresh = fetch_window(helper, security_id, window_start, to_date_api)
    if fresh.empty:
        return "no data from API"

    existing = load_csv(csv_path)
    # Drop every existing row inside the repair window — including bogus
    # weekend rows, which simply won't reappear since `fresh` only has
    # real trading days.
    outside_window = existing[
        (existing.index < pd.Timestamp(window_start)) | (existing.index > pd.Timestamp(last_trading_day))
    ]
    combined = pd.concat([outside_window, fresh]).sort_index()
    combined = combined[~combined.index.duplicated(keep="last")]
    # NSE never trades on weekends — fetch_today_quotes.py can write a bogus
    # "today" row on a Saturday/Sunday if run then; strip any such rows.
    combined = combined[combined.index.dayofweek < 5]

    save_csv(combined, csv_path)
    return f"replaced {len(fresh)} rows in [{window_start}..{last_trading_day}] (total {len(combined)})"


def get_last_trading_day() -> str:
    d = datetime.now().date() - timedelta(days=1)
    for _ in range(14):
        if d.weekday() < 5:
            return d.strftime("%Y-%m-%d")
        d -= timedelta(days=1)
    return d.strftime("%Y-%m-%d")


def main():
    parser = argparse.ArgumentParser(description="Repair flat/degenerate index candles")
    parser.add_argument("--days", type=int, default=45, help="Lookback window in calendar days to repair")
    parser.add_argument("--name", help="Repair only this index by name (e.g. BANKNIFTY, NIFTY50)")
    args = parser.parse_args()

    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper

    print("Initializing Dhan client...")
    dhan = get_dhan_client()
    if not dhan:
        print("Failed to authenticate with Dhan - run login.py first")
        return
    helper = DhanHelper(dhan)

    last_trading_day = get_last_trading_day()
    window_start = (datetime.strptime(last_trading_day, "%Y-%m-%d") - timedelta(days=args.days)).strftime("%Y-%m-%d")
    to_date_api = (datetime.strptime(last_trading_day, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")

    print(f"Repair window: {window_start} .. {last_trading_day}\n")

    if not args.name or args.name.upper() == "NIFTY50":
        for csv_path in NIFTY50_TARGETS:
            result = repair_csv(helper, 13, csv_path, "Nifty 50", window_start, last_trading_day, to_date_api)
            print(f"  Nifty 50 ({os.path.basename(csv_path)}): {result}")
            time.sleep(0.4)

    targets = TARGETS
    if args.name:
        targets = [t for t in TARGETS if t["name"].upper() == args.name.upper()]

    for entry in targets:
        result = repair_csv(helper, entry["id"], entry["csv"], entry["label"], window_start, last_trading_day, to_date_api)
        print(f"  {entry['label']}: {result}")
        time.sleep(0.4)

    print("\nDone.")


if __name__ == "__main__":
    main()
