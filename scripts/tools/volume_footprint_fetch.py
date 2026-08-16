"""
Fetch 1-minute OHLCV bars for the dashboard's Volume Footprint page.

Hybrid source, because neither store alone is sufficient:
  * Intraday_Historical_Data/1min/<SYMBOL>.parquet is fast and deep (~81 sessions) but
    covers only the Nifty 50 universe and is only as fresh as the last refresh run.
  * Dhan's intraday API covers every index and F&O stock and includes today, but is
    rate-limited and serves a limited trailing window.

So: read the store when it has the symbol, top it up from Dhan when it is stale, and fall
back to a pure Dhan fetch for everything else.

Buy/sell split is NOT computed here — Dhan serves no bid/ask tick history, so the split is
derived client-side from candle geometry (see rs_dashboard/lib/volumeProfile.ts). This
script's only job is clean, session-filtered, de-duplicated 1-minute bars.

Usage:
    venv\\Scripts\\python.exe scripts/tools/volume_footprint_fetch.py --symbol RELIANCE --days 5
    venv\\Scripts\\python.exe scripts/tools/volume_footprint_fetch.py --symbol NIFTY --source dhan

Outputs a single JSON line to stdout. Logs go to stderr.
"""
import os
import sys
import json
import math
import argparse
from datetime import datetime, timedelta, time as dtime

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

STORE_DIR = os.path.join(ROOT, "Intraday_Historical_Data", "1min")
MANIFEST = os.path.join(ROOT, "Intraday_Historical_Data", "manifest.json")

# NSE equity continuous session. Bars are stamped at their OPEN, so the last bar of the
# day opens at 15:29. Same filter as scripts/downloader/refresh_intraday_1min.py — the
# feed does emit out-of-session bars, so this is load-bearing.
SESSION_START = dtime(9, 15)
SESSION_END = dtime(15, 29)

# The store keys the Nifty 50 index under its benchmark name, not its Dhan symbol.
STORE_ALIASES = {"NIFTY": "NIFTY_50", "NIFTY 50": "NIFTY_50"}

MAX_TOPUP_DAYS = 12  # a longer Dhan window is slower and the store covers the rest


def log(msg: str):
    print(msg, file=sys.stderr, flush=True)


def store_path(symbol: str) -> str:
    key = STORE_ALIASES.get(symbol.upper(), symbol.upper())
    return os.path.join(STORE_DIR, f"{key}.parquet")


def session_filter(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    t = df.index.time
    keep = [(SESSION_START <= x <= SESSION_END) for x in t]
    return df[keep]


def trailing_sessions(df: pd.DataFrame, sessions: int) -> pd.DataFrame:
    """Keep the last `sessions` trading days present in the frame."""
    if df.empty:
        return df
    days = sorted({d for d in df.index.normalize().unique()})
    if len(days) <= sessions:
        return df
    cutoff = days[-sessions]
    return df[df.index >= cutoff]


def read_store(symbol: str) -> pd.DataFrame:
    path = store_path(symbol)
    if not os.path.exists(path):
        return pd.DataFrame()
    try:
        df = pd.read_parquet(path)
    except Exception as exc:
        log(f"store read failed for {symbol}: {exc}")
        return pd.DataFrame()
    if df.empty:
        return df
    df.index = pd.to_datetime(df.index)
    return df.sort_index()


def store_is_stale(store_df: pd.DataFrame, now: datetime) -> bool:
    """
    True when the archive is missing bars that should already exist.

    Two distinct cases, and checking only the first is what makes a live page freeze: the
    archive can be missing whole prior sessions (gap in days), OR it can hold today's
    early bars from a mid-session refresh and be hours behind the current one. Comparing
    the last bar against the lesser of `now` and today's session end covers both, and
    stays quiet after the close when the archive is genuinely complete.
    """
    if store_df.empty:
        return True
    last_ts = store_df.index.max()
    if last_ts.date() < now.date():
        return True
    session_end_today = datetime.combine(now.date(), SESSION_END)
    return last_ts < min(now, session_end_today)


def fetch_dhan(symbol: str, calendar_days: int) -> tuple[pd.DataFrame, str | None]:
    """Fetch 1-minute candles from Dhan. Returns (frame, api_error)."""
    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper

    # This script is respawned on a ~10s poll, so it pays the constructor cost every time:
    # the parquet sidecar cuts the master-list read from ~0.65s to ~0.1s, and the session
    # health-check round trip is redundant when a dead token surfaces on the data call
    # anyway. Both flags exist for exactly this short-lived-script case.
    helper = DhanHelper(get_dhan_client(), skip_session_validation=True, master_list_cache=True)
    df = helper.get_latest_candles(symbol, interval="1", days=calendar_days)
    # Data API failures are silent — an empty frame is not proof of "no data".
    err = getattr(helper, "last_api_error", None) if df is None or df.empty else None
    if df is None or df.empty:
        return pd.DataFrame(), (str(err) if err else None)
    df.index = pd.to_datetime(df.index)
    return df.sort_index(), None


def clean(v, default=0.0) -> float:
    """Sanitize floats against NaN/Inf so json.dumps produces valid JSON."""
    try:
        f = float(v)
        return default if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return default


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", required=True)
    ap.add_argument("--days", type=int, default=5, help="trading sessions to return")
    ap.add_argument("--source", choices=["auto", "store", "dhan"], default="auto")
    args = ap.parse_args()

    symbol = args.symbol.strip().upper()
    sessions = max(1, min(args.days, 30))

    store_df = pd.DataFrame()
    if args.source in ("auto", "store"):
        store_df = session_filter(read_store(symbol))

    store_last = None
    if not store_df.empty:
        store_last = store_df.index.max().strftime("%Y-%m-%d")

    dhan_df = pd.DataFrame()
    api_error = None
    used_dhan = False

    if args.source == "dhan":
        # Calendar days must exceed trading sessions to span weekends and holidays.
        used_dhan = True
        dhan_df, api_error = fetch_dhan(symbol, calendar_days=int(sessions * 1.6) + 4)
    elif args.source == "auto":
        now = datetime.now()
        if store_df.empty:
            used_dhan = True
            dhan_df, api_error = fetch_dhan(symbol, calendar_days=int(sessions * 1.6) + 4)
        elif store_is_stale(store_df, now):
            used_dhan = True
            gap_days = (now.date() - store_df.index.max().date()).days
            dhan_df, api_error = fetch_dhan(symbol, calendar_days=min(gap_days + 2, MAX_TOPUP_DAYS))

    dhan_df = session_filter(dhan_df)

    if store_df.empty and dhan_df.empty:
        print(json.dumps({
            "success": False,
            "symbol": symbol,
            "source": "none",
            "bars": [],
            "error": api_error or "no 1-minute data available for this symbol",
        }))
        return

    # Store rows win on conflict: they are the settled archive, whereas a Dhan top-up of
    # an in-progress session can carry a partial last bar.
    if store_df.empty:
        merged, source = dhan_df, "dhan"
    elif dhan_df.empty:
        merged, source = store_df, "store"
    else:
        merged = pd.concat([dhan_df, store_df])
        merged = merged[~merged.index.duplicated(keep="last")].sort_index()
        source = "store+dhan"

    merged = trailing_sessions(merged, sessions)

    bars = [
        {
            "t": ts.strftime("%Y-%m-%d %H:%M:%S"),
            "o": clean(row.Open),
            "h": clean(row.High),
            "l": clean(row.Low),
            "c": clean(row.Close),
            "v": clean(row.Volume),
        }
        for ts, row in merged.iterrows()
    ]

    print(json.dumps({
        "success": True,
        "symbol": symbol,
        "source": source,
        "store_last": store_last,
        "used_dhan": used_dhan,
        "sessions": len({b["t"][:10] for b in bars}),
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "last_bar": bars[-1]["t"] if bars else None,
        "api_error": api_error,
        "bars": bars,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc), "bars": []}))
        sys.exit(0)
