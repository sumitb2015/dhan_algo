"""
Fetches intraday candles for an already-resolved Dhan security id/segment —
the Markets Overview page's per-index detail chart (any of the headline NSE
indices, or the MCX crude oil / crude oil mini futures rows).

Unlike futures_candles_fetch.py (which resolves NIFTY/BANKNIFTY futures by
underlying symbol), this script takes the security id directly: the caller
(app/api/indices-overview/chart/route.ts) already resolved it via the same
INDICES table / getFutSid cache that scalper/top-indices/route.ts uses for
live quotes, so there is no lookup to duplicate here.

Usage:
    python index_candles_fetch.py --sid 13 --segment IDX_I --instrument INDEX --days 1
    python index_candles_fetch.py --sid 315235 --segment MCX_COMM --instrument FUTCOM --days 1

Outputs a single JSON line to stdout: {"candles": [...]} or {"error": "..."}.
Logs go to stderr.
"""

import sys
import os
import json
import argparse
import math
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper


def clean_val(v, default=0.0):
    try:
        f = float(v)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def main():
    parser = argparse.ArgumentParser(description="Fetch intraday candles for a resolved Dhan security id")
    parser.add_argument("--sid", type=int, required=True)
    parser.add_argument("--segment", required=True, choices=["IDX_I", "MCX_COMM", "NSE_FNO"])
    parser.add_argument("--instrument", required=True, choices=["INDEX", "FUTCOM", "FUTIDX"])
    parser.add_argument("--interval", default="5", choices=["1", "5", "15", "25", "60"])
    parser.add_argument("--days", type=int, default=1, help="Days of intraday candles to fetch")
    args = parser.parse_args()

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"error": "auth_failed — run login.py to refresh the access token"}))
        sys.exit(0)

    helper = DhanHelper(dhan)

    end_date = datetime.now().strftime("%Y-%m-%d")
    start_date = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")

    df_candles = helper.get_intraday_minute_data(
        security_id=args.sid,
        exchange_segment=args.segment,
        instrument_type=args.instrument,
        interval=args.interval,
        from_date=start_date,
        to_date=end_date,
        oi=args.instrument != "INDEX",
    )

    if df_candles is None or df_candles.empty:
        print(json.dumps({"error": f"No intraday candles available for sid={args.sid}"}))
        sys.exit(0)

    rename_map = {
        "start_time": "time", "start_Time": "time", "kline_time": "time", "timestamp": "time",
        "Open": "open", "High": "high", "Low": "low", "Close": "close", "Volume": "volume", "OI": "oi",
    }
    df_candles = df_candles.rename(columns=rename_map)
    if "time" in df_candles.columns:
        df_candles = df_candles.sort_values(by="time")

    candles = []
    for _, row in df_candles.iterrows():
        candles.append({
            "time": str(row.get("time", "")),
            "open": round(clean_val(row.get("open")), 2),
            "high": round(clean_val(row.get("high")), 2),
            "low": round(clean_val(row.get("low")), 2),
            "close": round(clean_val(row.get("close")), 2),
            "volume": clean_val(row.get("volume")),
            "oi": clean_val(row.get("oi")) if "oi" in row else 0.0,
        })

    print(json.dumps({"candles": candles}))


if __name__ == "__main__":
    main()
