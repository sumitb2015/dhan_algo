"""
Index Scalper candles: NIFTY index / CRUDEOILM future intraday candles (1/3/5/15 min) for the /index-scalper chart,
or one option contract's premium candles (--security-id with --segment NSE_FNO --instrument OPTIDX, or MCX_COMM OPTFUT).

Index candles only (no futures, no volume) so the chart matches the index the options are traded on.
Dhan only. Prints ONE JSON line: {"candles": [{"t": <epoch seconds>, "o","h","l","c"}], "interval": "5"}
or {"error": "..."}; logs go to stderr.

`t` is a real UTC epoch; the dashboard shifts it by +19800 s to show IST wall-clock on the axis.

Usage:
    python index_scalper_candles.py --symbol NIFTY --interval 5 --days 10
"""
import argparse
import json
import math
import os
import sys
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

SUPPORTED = {"1", "3", "5", "15", "30", "60"}
# Fetched from Dhan at this interval, then resampled: 3 from 1; 30 and 60 from 15 so their bars are anchored to the
# session open (09:15 NSE / 09:00 MCX), exactly like the page's live bars (lib/indexScalperSession.ts barAnchorSec).
FETCH = {"3": "1", "30": "15", "60": "15"}
NSE_OPEN_S = 9 * 3600 + 15 * 60
MCX_OPEN_S = 9 * 3600


def fnum(v):
    try:
        f = float(v)
        return round(f, 2) if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def to_epoch(v):
    """Dhan returns epoch seconds, a pandas Timestamp or a datetime string depending on SDK path."""
    import pandas as pd
    if isinstance(v, (int, float)):
        return int(v)
    ts = pd.Timestamp(v)
    if ts.tzinfo is None:
        ts = ts.tz_localize("Asia/Kolkata")
    return int(ts.timestamp())


def resample(rows, minutes, anchor_s):
    """OHLC buckets of `minutes`, anchored to `anchor_s` seconds after IST midnight (the session open)."""
    step = minutes * 60
    out = []
    bucket = None
    for r in rows:
        ist = r["t"] + 19800
        key = ((ist - anchor_s) // step) * step + anchor_s - 19800
        if bucket is None or bucket["t"] != key:
            if bucket:
                out.append(bucket)
            bucket = {"t": key, "o": r["o"], "h": r["h"], "l": r["l"], "c": r["c"]}
        else:
            bucket["h"] = max(bucket["h"], r["h"])
            bucket["l"] = min(bucket["l"], r["l"])
            bucket["c"] = r["c"]
    if bucket:
        out.append(bucket)
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--symbol", default="NIFTY")
    p.add_argument("--segment", default="IDX_I")
    p.add_argument("--instrument", default="INDEX")
    p.add_argument("--security-id", default=None)
    p.add_argument("--interval", default="5")
    p.add_argument("--days", type=int, default=10)
    a = p.parse_args()

    if a.interval not in SUPPORTED:
        print(json.dumps({"error": f"interval must be one of {sorted(SUPPORTED)}"}))
        return
    days = max(1, min(a.days, 60))

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"error": "auth_failed — run login.py to refresh the access token"}))
        return
    helper = DhanHelper(dhan)

    if a.security_id:
        try:
            sec_id = int(a.security_id)
        except ValueError:
            print(json.dumps({"error": f"invalid security_id: {a.security_id}"}))
            return
        segment = a.segment
        inst = a.instrument
    elif a.segment == "MCX_COMM" or a.symbol == "CRUDEOILM":
        fut = helper.find_future("CRUDEOILM", exchange="MCX", instrument="FUTCOM")
        if not fut:
            print(json.dumps({"error": "CRUDEOILM future contract not found"}))
            return
        sec_id = int(fut["SECURITY_ID"])
        segment = "MCX_COMM"
        inst = "FUTCOM"
    else:
        idx = helper.find_index(a.symbol)
        if not idx:
            print(json.dumps({"error": f"index {a.symbol} not found"}))
            return
        sec_id = int(idx["SECURITY_ID"])
        segment = "IDX_I"
        inst = "INDEX"

    api_interval = FETCH.get(a.interval, a.interval)
    end = datetime.now() + timedelta(days=1)
    start = datetime.now() - timedelta(days=days)
    df = helper.get_intraday_minute_data(
        security_id=sec_id,
        exchange_segment=segment,
        instrument_type=inst,
        interval=api_interval,
        from_date=start.strftime("%Y-%m-%d"),
        to_date=end.strftime("%Y-%m-%d"),
        oi=False,
    )
    if df is None or df.empty:
        err = getattr(helper, "last_api_error", None)
        print(json.dumps({"error": f"no candles for {a.symbol}" + (f" ({err})" if err else "")}))
        return

    df = df.rename(columns={
        "start_time": "time", "start_Time": "time", "kline_time": "time", "timestamp": "time",
        "Open": "open", "High": "high", "Low": "low", "Close": "close",
    })
    if "time" not in df.columns:
        df = df.reset_index().rename(columns={df.index.name or "index": "time"})

    rows = []
    for _, r in df.iterrows():
        o, h, l, c = fnum(r.get("open")), fnum(r.get("high")), fnum(r.get("low")), fnum(r.get("close"))
        if None in (o, h, l, c):
            continue
        rows.append({"t": to_epoch(r["time"]), "o": o, "h": h, "l": l, "c": c})
    rows.sort(key=lambda x: x["t"])
    # de-duplicate identical timestamps (keep the last)
    uniq = {}
    for r in rows:
        uniq[r["t"]] = r
    rows = list(uniq.values())
    if a.interval in FETCH:
        anchor = MCX_OPEN_S if str(segment).startswith("MCX") else NSE_OPEN_S
        rows = resample(rows, int(a.interval), anchor)

    print(json.dumps({"candles": rows, "interval": a.interval}))


if __name__ == "__main__":
    main()
