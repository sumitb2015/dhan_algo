"""
Download 5-year daily OHLCV data for key NSE indices to Historical Data/Indices/.

Nifty 50 and Nifty 500 are maintained separately by refresh_dashboard_data.py
and are excluded here to avoid duplication.

Usage:
    venv\\Scripts\\python.exe scripts/downloader/download_indices.py
    venv\\Scripts\\python.exe scripts/downloader/download_indices.py --force
    venv\\Scripts\\python.exe scripts/downloader/download_indices.py --name BANKNIFTY
"""
import sys
import os
import time
import argparse
import pandas as pd
from datetime import datetime, timedelta

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)

INDICES_DIR = os.path.join(PROJECT_ROOT, "Historical Data", "Indices")
os.makedirs(INDICES_DIR, exist_ok=True)

# All indices to download (Nifty 50=13 and Nifty 500=19 are handled by refresh_dashboard_data.py)
INDICES = [
    {"id": 38, "name": "NIFTY_NEXT50",      "label": "Nifty Next 50"},
    {"id": 17, "name": "NIFTY_100",          "label": "Nifty 100"},
    {"id": 18, "name": "NIFTY_200",          "label": "Nifty 200"},
    {"id": 37, "name": "NIFTY_MIDCAP100",    "label": "Nifty Midcap 100"},
    {"id": 5,  "name": "NIFTY_SMALLCAP100",  "label": "Nifty Smallcap 100"},
    {"id": 25, "name": "BANKNIFTY",          "label": "Nifty Bank"},
    {"id": 29, "name": "NIFTYIT",            "label": "Nifty IT"},
    {"id": 28, "name": "NIFTY_FMCG",         "label": "Nifty FMCG"},
    {"id": 14, "name": "NIFTY_AUTO",         "label": "Nifty Auto"},
    {"id": 32, "name": "NIFTY_PHARMA",       "label": "Nifty Pharma"},
    {"id": 31, "name": "NIFTY_METAL",        "label": "Nifty Metal"},
    {"id": 34, "name": "NIFTY_REALTY",       "label": "Nifty Realty"},
    {"id": 33, "name": "NIFTY_PSU_BANK",     "label": "Nifty PSU Bank"},
    {"id": 15, "name": "NIFTY_PVT_BANK",     "label": "Nifty Private Bank"},
    {"id": 27, "name": "FINNIFTY",           "label": "Nifty Financial Services"},
    {"id": 42, "name": "NIFTY_ENERGY",       "label": "Nifty Energy"},
    {"id": 43, "name": "NIFTY_INFRA",        "label": "Nifty Infra"},
    {"id": 21, "name": "INDIA_VIX",          "label": "India VIX"},
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


def normalize_df(df: pd.DataFrame) -> pd.DataFrame:
    rename_map = {
        "start_time": "Datetime", "start_time": "Datetime",
        "open": "Open", "high": "High", "low": "Low",
        "close": "Close", "volume": "Volume",
    }
    df = df.rename(columns={c: rename_map[c.lower()] for c in df.columns if c.lower() in rename_map})

    if "Datetime" in df.columns:
        first = df["Datetime"].iloc[0] if len(df) > 0 else None
        if first is not None and isinstance(first, (int, float)):
            df["Datetime"] = (
                pd.to_datetime(df["Datetime"], unit="s")
                .dt.tz_localize("UTC")
                .dt.tz_convert("Asia/Kolkata")
                .dt.tz_localize(None)
            )
        else:
            df["Datetime"] = pd.to_datetime(df["Datetime"])
        df = df.set_index("Datetime").sort_index()

    wanted = [c for c in ["Open", "High", "Low", "Close", "Volume"] if c in df.columns]
    return df[wanted]


def get_last_date(csv_path: str):
    if not os.path.exists(csv_path):
        return None
    try:
        df = pd.read_csv(csv_path)
        col = "Datetime" if "Datetime" in df.columns else df.columns[0]
        dates = pd.to_datetime(df[col], errors="coerce").dropna()
        return dates.max().strftime("%Y-%m-%d") if len(dates) > 0 else None
    except Exception:
        return None


def get_last_trading_day() -> str:
    """Return the most recent COMPLETED trading day as YYYY-MM-DD (never today).

    Starts from yesterday because the Dhan historical API does not publish
    same-day EOD data — requesting today's date causes a DH-905 error.
    """
    d = datetime.now().date() - timedelta(days=1)
    for _ in range(7):
        if d.weekday() < 5:  # Mon–Fri
            return d.strftime("%Y-%m-%d")
        d -= timedelta(days=1)
    return d.strftime("%Y-%m-%d")


def save_csv(df: pd.DataFrame, path: str):
    out = df.reset_index()
    out.columns = [str(c).capitalize() for c in out.columns]
    if "Datetime" not in out.columns:
        out = out.rename(columns={out.columns[0]: "Datetime"})
    if "Volume" not in out.columns:
        out["Volume"] = 0
    cols = ["Datetime", "Open", "High", "Low", "Close", "Volume"]
    out = out[[c for c in cols if c in out.columns]]
    out.to_csv(path, index=False)


def download_index(helper, entry: dict, force: bool = False) -> bool:
    csv_path = os.path.join(INDICES_DIR, f"{entry['name']}.csv")
    last_trading_day = get_last_trading_day()
    last_date = None if force else get_last_date(csv_path)

    if last_date and last_date >= last_trading_day:
        print(f"  ✓ {entry['label']}: up to date ({last_date})")
        return True

    from_date = (
        (datetime.strptime(last_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        if last_date
        else (datetime.now() - timedelta(days=1825)).strftime("%Y-%m-%d")
    )

    print(f"  ↓ {entry['label']} [id={entry['id']}]: {from_date} → {last_trading_day} ...", end=" ", flush=True)

    try:
        chunks = []
        cur = datetime.strptime(from_date, "%Y-%m-%d")
        end = datetime.strptime(last_trading_day, "%Y-%m-%d")
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
                chunks.append(normalize_df(df_chunk))
            cur = chunk_end + timedelta(days=1)
            time.sleep(0.4)

        if not chunks:
            print("no data from API")
            return False

        new_df = pd.concat(chunks)
        new_df = new_df[~new_df.index.duplicated(keep="last")].sort_index()

        if last_date and os.path.exists(csv_path):
            old = pd.read_csv(csv_path)
            col = "Datetime" if "Datetime" in old.columns else old.columns[0]
            old[col] = pd.to_datetime(old[col])
            old = old.set_index(col).sort_index()
            old.index.name = "Datetime"
            old.columns = [str(c).capitalize() for c in old.columns]
            combined = pd.concat([old, new_df])
            combined = combined[~combined.index.duplicated(keep="last")].sort_index()
        else:
            combined = new_df

        save_csv(combined, csv_path)
        print(f"+{len(new_df)} rows ({len(combined)} total)")
        return True

    except Exception as e:
        print(f"ERROR: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Download NSE index daily data to Historical Data/Indices/")
    parser.add_argument("--force", action="store_true", help="Re-download from scratch ignoring existing data")
    parser.add_argument("--name", help="Download only this index by name (e.g. BANKNIFTY)")
    args = parser.parse_args()

    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper

    print("Connecting to Dhan...")
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)

    targets = INDICES
    if args.name:
        targets = [e for e in INDICES if e["name"].upper() == args.name.upper()]
        if not targets:
            print(f"Unknown index name '{args.name}'. Valid names: {[e['name'] for e in INDICES]}")
            sys.exit(1)

    print(f"Downloading {len(targets)} indices to 'Historical Data/Indices/'...\n")
    ok = err = 0
    for entry in targets:
        if download_index(helper, entry, force=args.force):
            ok += 1
        else:
            err += 1
        time.sleep(0.3)

    print(f"\n✅ Done: {ok} OK, {err} failed.")
    if err:
        print("   Re-run failed indices individually with --name <NAME>")


if __name__ == "__main__":
    main()
