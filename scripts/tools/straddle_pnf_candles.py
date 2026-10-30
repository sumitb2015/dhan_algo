"""
Multi-session 1-min straddle bars for the Straddle Point & Figure page.

Usage:
    python straddle_pnf_candles.py --expiry 2026-10-27 --strikes 24800,25000,25200 [--sessions 3] [--underlying NIFTY]

Prints ONE JSON line to stdout:
    {"expiry": ..., "bars": {"<strike>": [{t, ce, pe, straddle, vol}, ...]}, "errors": {"<strike>": "msg"}}
or {"error": "..."}. `t` is epoch seconds. Logs go to stderr. Read-only: market-data calls only, no orders.

options_straddle_candles.py only returns the LAST trading day with HH:MM labels, which cannot carry a P&F chart across
sessions, so this is a separate script; it reuses that script's retrying leg fetch.
"""
import argparse
import json
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

_IST = timezone(timedelta(hours=5, minutes=30))


def _to_epoch_seconds(col: pd.Series) -> pd.Series:
    """Dhan timestamps arrive as epoch seconds (sometimes ms) or ISO strings."""
    if pd.api.types.is_numeric_dtype(col):
        s = col.astype("float64")
        return (s.where(s <= 1_500_000_000_000, s / 1000)).astype("int64")
    return pd.to_datetime(col, errors="coerce").map(lambda v: int(v.timestamp()) if pd.notna(v) else 0)


def _leg(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame(columns=["t", "close", "vol"])
    ts = next((c for c in ("start_Time", "timestamp", "time", "date") if c in df.columns), df.columns[0])
    cl = next((c for c in ("close", "Close", "c") if c in df.columns), df.columns[-1])
    vl = next((c for c in ("volume", "Volume", "vol", "Vol") if c in df.columns), None)
    out = pd.DataFrame({
        "t": _to_epoch_seconds(df[ts]),
        "close": pd.to_numeric(df[cl], errors="coerce").fillna(0.0),
        "vol": pd.to_numeric(df[vl], errors="coerce").fillna(0).astype("int64") if vl else 0,
    })
    return out.drop_duplicates("t", keep="last")


def merge_legs(ce_df: pd.DataFrame, pe_df: pd.DataFrame, sessions: int, today=None) -> list:
    """Inner-join CE and PE bars on timestamp, keep the last `sessions` IST dates, drop rows with a zero leg.

    With `today` (an IST date), `sessions` counts completed sessions and today's bars are kept on top (as in
    futures_pnf_candles.to_bars)."""
    ce, pe = _leg(ce_df), _leg(pe_df)
    if ce.empty or pe.empty:
        return []
    m = ce.merge(pe, on="t", suffixes=("_ce", "_pe"))
    m = m[(m["close_ce"] > 0) & (m["close_pe"] > 0)].sort_values("t")
    if m.empty:
        return []
    day = m["t"].map(lambda t: datetime.fromtimestamp(int(t), _IST).date())
    days = sorted(day.unique())
    past = [d for d in days if today is None or d < today]
    keep = past[-sessions:] + [d for d in days if today is not None and d == today]
    m = m[day.isin(keep)]
    return [
        {
            "t": int(r.t),
            "ce": round(float(r.close_ce), 2),
            "pe": round(float(r.close_pe), 2),
            "straddle": round(float(r.close_ce) + float(r.close_pe), 2),
            "vol": int(r.vol_ce) + int(r.vol_pe),
        }
        for r in m.itertuples(index=False)
    ]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--underlying", default="NIFTY")
    parser.add_argument("--expiry", required=True, help="YYYY-MM-DD")
    parser.add_argument("--strikes", required=True, help="comma-separated strikes")
    parser.add_argument("--sessions", type=int, default=3)
    args = parser.parse_args()

    # Broker SDK imports live here so merge_legs stays importable (and testable) without them.
    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper
    from options_straddle_candles import UNDERLYINGS_MAP, _fetch_leg

    underlying = args.underlying.upper()
    cfg = UNDERLYINGS_MAP.get(underlying, {"exchange": "NSE", "instrument": "OPTIDX", "segment": "NSE_FNO"})
    try:
        strikes = [float(s) for s in args.strikes.split(",") if s.strip()]
    except ValueError:
        print(json.dumps({"error": f"bad --strikes: {args.strikes}"}))
        return
    if not strikes:
        print(json.dumps({"error": "no strikes"}))
        return

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"error": "auth_failed — run login.py to refresh the access token"}))
        return
    helper = DhanHelper(dhan)

    today = date.today()
    from_date = (today - timedelta(days=args.sessions * 3 + 4)).strftime("%Y-%m-%d")
    to_date = today.strftime("%Y-%m-%d")

    bars, errors = {}, {}
    for strike in strikes:
        key = str(int(strike))
        try:
            ce = helper.find_option(underlying, args.expiry, strike, "CE", exchange=cfg["exchange"], instrument=cfg["instrument"])
            pe = helper.find_option(underlying, args.expiry, strike, "PE", exchange=cfg["exchange"], instrument=cfg["instrument"])
            if ce is None or pe is None:
                errors[key] = f"could not resolve {underlying} {key} CE/PE for {args.expiry}"
                continue
            legs = []
            for opt in (ce, pe):
                legs.append(_fetch_leg(helper, str(int(opt["SECURITY_ID"])), from_date, to_date, "1",
                                       exchange_segment=cfg["segment"], instrument_type=cfg["instrument"]))
            rows = merge_legs(legs[0], legs[1], args.sessions)
            if rows:
                bars[key] = rows
            else:
                errors[key] = "no intraday bars for both legs"
        except Exception as exc:  # one bad strike must not abort the other two
            errors[key] = str(exc)
        time.sleep(0.4)  # Dhan data API is rate limited

    print(json.dumps({"expiry": args.expiry, "bars": bars, "errors": errors}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
