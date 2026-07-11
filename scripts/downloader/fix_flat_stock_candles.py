"""
Repair degenerate/duplicated stock candles caused by fetch_today_quotes.py
writing a live-quote row unconditionally (including on non-trading days) and
refresh_dashboard_data.py never retroactively overwriting an already-present
date. Symptoms seen in Daily_Historical_Data_Fresh/*_Daily_2Y.csv:
  - A trailing row dated on a Saturday/Sunday (bogus — NSE never trades then).
  - That row's OHLC identical to the prior (real) trading day's row, i.e. the
    live quote was simply carried forward unchanged.
  - Flat Open=High=Low=Close rows with Volume=0 on real trading days when the
    OHLC batch API returned no real intraday range.

By default this scans every stock CSV, flags ones with a trailing
weekend row and/or a flat/degenerate row within the lookback window, and
re-fetches real EOD data for just those symbols from the Dhan historical
API — dropping stray weekend rows in the process. Pass --all to force a
repair pass over every symbol regardless of whether it looks broken.

Usage:
    venv\\Scripts\\python.exe scripts/downloader/fix_flat_stock_candles.py
    venv\\Scripts\\python.exe scripts/downloader/fix_flat_stock_candles.py --days 60
    venv\\Scripts\\python.exe scripts/downloader/fix_flat_stock_candles.py --symbols VAML VOGL
    venv\\Scripts\\python.exe scripts/downloader/fix_flat_stock_candles.py --all
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

STOCKS_DIR = os.path.join(PROJECT_ROOT, "Daily_Historical_Data_Fresh")


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
    # on_bad_lines='skip' handles the stray 7-column rows fetch_today_quotes.py
    # appends (extra Timestamp column) on a 6-column file.
    df = pd.read_csv(csv_path, on_bad_lines="skip")
    date_col = "Datetime" if "Datetime" in df.columns else df.columns[0]
    df[date_col] = pd.to_datetime(df[date_col], errors="coerce")
    df = df.dropna(subset=[date_col]).set_index(date_col).sort_index()
    df.index.name = "Datetime"
    df.columns = [str(c).capitalize() for c in df.columns][:len(df.columns)]
    keep = [c for c in ["Open", "High", "Low", "Close", "Volume"] if c in df.columns]
    return df[keep]


def save_csv(df: pd.DataFrame, csv_path: str):
    df_save = df.reset_index()
    df_save.columns = [str(c).capitalize() for c in df_save.columns]
    if "Volume" not in df_save.columns:
        df_save["Volume"] = 0
    cols = ["Datetime", "Open", "High", "Low", "Close", "Volume"]
    df_save = df_save[[c for c in cols if c in df_save.columns]]
    df_save.to_csv(csv_path, index=False)


def list_all_symbols() -> list[str]:
    files = [f for f in os.listdir(STOCKS_DIR) if f.endswith("_Daily_2Y.csv")]
    return sorted(f.replace("_Daily_2Y.csv", "") for f in files)


def looks_broken(df: pd.DataFrame, window_start: str) -> bool:
    if df.empty:
        return False
    last = df.iloc[-1]
    if df.index[-1].dayofweek >= 5:
        return True
    recent = df[df.index >= pd.Timestamp(window_start)]
    if recent.empty:
        return False
    flat = (recent["Open"] == recent["High"]) & (recent["High"] == recent["Low"]) & (recent["Low"] == recent["Close"])
    if flat.any():
        return True
    # Two consecutive rows with identical OHLC (live quote carried forward unchanged)
    dup = (recent[["Open", "High", "Low", "Close"]].diff().abs().sum(axis=1) == 0)
    return bool(dup.any())


def repair_symbol(helper, symbol: str, csv_path: str, window_start: str, last_trading_day: str, to_date_api: str) -> str:
    try:
        sec = helper.get_security_id(symbol=symbol, instrument="EQUITY")
    except Exception as e:
        return f"lookup error: {e}"
    if not sec:
        return "not found in master list"

    security_id = int(sec["SECURITY_ID"])
    instr = sec.get("INSTRUMENT", "EQUITY")
    exch_id = sec.get("EXCH_ID", "NSE")
    segment = "IDX_I" if instr == "INDEX" else ("BSE_EQ" if exch_id == "BSE" else "NSE_EQ")

    df_new = helper.get_historical_daily_data(
        security_id=security_id,
        exchange_segment=segment,
        instrument_type=instr,
        from_date=window_start,
        to_date=to_date_api,
    )
    if df_new.empty:
        return "no data from API"

    fresh = normalize_historical_df(df_new)
    fresh = fresh[fresh.index <= pd.Timestamp(last_trading_day)]
    if fresh.empty:
        return "no data from API in window"

    existing = load_csv(csv_path)
    outside_window = existing[
        (existing.index < pd.Timestamp(window_start)) | (existing.index > pd.Timestamp(last_trading_day))
    ]
    combined = pd.concat([outside_window, fresh]).sort_index()
    combined = combined[~combined.index.duplicated(keep="last")]
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
    parser = argparse.ArgumentParser(description="Repair flat/duplicated stock candles")
    parser.add_argument("--days", type=int, default=45, help="Lookback window in calendar days to repair")
    parser.add_argument("--symbols", nargs="*", help="Repair only these symbols (default: auto-detect broken ones)")
    parser.add_argument("--all", action="store_true", help="Repair every symbol, not just ones that look broken")
    args = parser.parse_args()

    last_trading_day = get_last_trading_day()
    window_start = (datetime.strptime(last_trading_day, "%Y-%m-%d") - timedelta(days=args.days)).strftime("%Y-%m-%d")
    to_date_api = (datetime.strptime(last_trading_day, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")

    if args.symbols:
        targets = [s.upper() for s in args.symbols]
    else:
        print("Scanning for broken stock CSVs...")
        all_symbols = list_all_symbols()
        if args.all:
            targets = all_symbols
        else:
            targets = []
            for sym in all_symbols:
                df = load_csv(os.path.join(STOCKS_DIR, f"{sym}_Daily_2Y.csv"))
                if looks_broken(df, window_start):
                    targets.append(sym)
        print(f"  {len(targets)} / {len(all_symbols)} symbols flagged")

    if not targets:
        print("Nothing to repair.")
        return

    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper

    print("Initializing Dhan client...")
    dhan = get_dhan_client()
    if not dhan:
        print("Failed to authenticate with Dhan - run login.py first")
        return
    helper = DhanHelper(dhan)

    print(f"Repair window: {window_start} .. {last_trading_day}\n")

    fixed = failed = 0
    for i, symbol in enumerate(targets, 1):
        csv_path = os.path.join(STOCKS_DIR, f"{symbol}_Daily_2Y.csv")
        result = repair_symbol(helper, symbol, csv_path, window_start, last_trading_day, to_date_api)
        print(f"  [{i}/{len(targets)}] {symbol}: {result}")
        if result.startswith("replaced"):
            fixed += 1
        else:
            failed += 1
        time.sleep(0.35)

    print(f"\nDone: {fixed} fixed, {failed} skipped/failed.")


if __name__ == "__main__":
    main()
