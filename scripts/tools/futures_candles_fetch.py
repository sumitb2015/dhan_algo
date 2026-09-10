"""
Fetches 5-minute intraday candles for a NIFTY/BANKNIFTY futures near-month
contract, falling back to index candles (no volume) if futures candles are
unavailable. Generalizes the candle-fetch block already used by
nifty_oi_profile_fetch.py so the Futures Monitor page can chart either
instrument without a full OI-profile fetch.

Usage:
    python futures_candles_fetch.py --symbol NIFTY --days 5
    python futures_candles_fetch.py --symbol BANKNIFTY --days 5

Outputs a single JSON line to stdout: {"candles": [...], "source": "future"|"index"}
or {"error": "..."}. Logs go to stderr.
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
    parser = argparse.ArgumentParser(description="Fetch futures/index 5m intraday candles")
    parser.add_argument("--symbol", default="NIFTY", choices=["NIFTY", "BANKNIFTY"])
    parser.add_argument("--days", type=int, default=5, help="Days of intraday candles to fetch")
    args = parser.parse_args()

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"error": "auth_failed — run login.py to refresh the access token"}))
        sys.exit(0)

    helper = DhanHelper(dhan)

    fut = helper.find_future(args.symbol, exchange="NSE", instrument="FUTIDX")
    end_date = datetime.now().strftime("%Y-%m-%d")
    start_date = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")

    df_candles = None
    source = None

    if fut:
        fut_security_id = int(fut["SECURITY_ID"])
        df_candles = helper.get_intraday_minute_data(
            security_id=fut_security_id,
            exchange_segment="NSE_FNO",
            instrument_type="FUTIDX",
            interval="5",
            from_date=start_date,
            to_date=end_date,
            oi=True,
        )
        if df_candles is not None and not df_candles.empty:
            source = "future"

    if df_candles is None or df_candles.empty:
        idx = helper.find_index(args.symbol)
        if idx:
            df_candles = helper.get_intraday_minute_data(
                security_id=int(idx["SECURITY_ID"]),
                exchange_segment="IDX_I",
                instrument_type="INDEX",
                interval="5",
                from_date=start_date,
                to_date=end_date,
                oi=False,
            )
            if df_candles is not None and not df_candles.empty:
                source = "index"

    if df_candles is None or df_candles.empty:
        print(json.dumps({"error": f"No intraday candles available for {args.symbol}"}))
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

    print(json.dumps({"candles": candles, "source": source}))


if __name__ == "__main__":
    main()
