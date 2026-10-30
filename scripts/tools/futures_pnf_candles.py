"""
Multi-session 1-min futures bars for the Straddle P&F page's CRUDEOILM mode (the upcoming monthly contracts, one chart each).

Usage:
    python futures_pnf_candles.py [--underlying CRUDEOILM] [--contracts 3] [--sessions 3]

Prints ONE JSON line to stdout:
    {"bars": {"<YYYYMMDD expiry>": [{t, ce, pe, straddle, vol}, ...]}, "expiries": {"<YYYYMMDD>": "YYYY-MM-DD"}, "errors": {...}}
or {"error": "..."}. The bar shape is the straddle bar's: `straddle` and `ce` carry the futures close, `pe` is 0, so the page's P&F model
runs unchanged. `t` is epoch seconds. Logs go to stderr. Read-only: market-data calls only, no orders.
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
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from straddle_pnf_candles import _leg  # noqa: E402  (same timestamp/close/volume normalisation as the straddle bars)

_IST = timezone(timedelta(hours=5, minutes=30))


def to_bars(df: pd.DataFrame, sessions: int, today=None) -> list:
    """Futures candles -> straddle-shaped bars for the last `sessions` IST dates; rows with a zero close are dropped.

    With `today` (an IST date), `sessions` counts completed sessions only and today's bars are kept on top, so the chart always
    has `sessions` full days of history however early in the day it is opened."""
    leg = _leg(df)
    leg = leg[leg["close"] > 0].sort_values("t")
    if leg.empty:
        return []
    day = leg["t"].map(lambda t: datetime.fromtimestamp(int(t), _IST).date())
    days = sorted(day.unique())
    past = [d for d in days if today is None or d < today]
    keep = past[-sessions:] + [d for d in days if today is not None and d == today]
    leg = leg[day.isin(keep)]
    return [
        {"t": int(r.t), "ce": round(float(r.close), 2), "pe": 0, "straddle": round(float(r.close), 2), "vol": int(r.vol)}
        for r in leg.itertuples(index=False)
    ]


def upcoming_contracts(master: pd.DataFrame, underlying: str, today: str, n: int) -> list:
    """The next `n` unexpired MCX futures of `underlying`, soonest first: [(expiry YYYY-MM-DD, security id)]."""
    m = master[(master["EXCH_ID"] == "MCX") & (master["INSTRUMENT"] == "FUTCOM") & (master["UNDERLYING_SYMBOL"] == underlying)].copy()
    if m.empty:
        return []
    m["exp_date"] = m["SM_EXPIRY_DATE"].astype(str).str[:10]
    m = m[m["exp_date"] >= today].sort_values("exp_date").drop_duplicates("exp_date")
    return [(r.exp_date, str(int(r.SECURITY_ID))) for r in m.head(n).itertuples(index=False)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--underlying", default="CRUDEOILM")
    parser.add_argument("--contracts", type=int, default=3)
    parser.add_argument("--sessions", type=int, default=3, help="completed sessions of history; today's bars come on top")
    args = parser.parse_args()

    # Broker SDK imports live here so the pure helpers above stay importable (and testable) without them.
    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper
    from options_straddle_candles import _fetch_leg

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"error": "auth_failed — run login.py to refresh the access token"}))
        return
    helper = DhanHelper(dhan)

    today = date.today()
    contracts = upcoming_contracts(helper._load_master_list(), args.underlying.upper(), today.strftime("%Y-%m-%d"), args.contracts)
    if not contracts:
        print(json.dumps({"error": f"no {args.underlying} futures contracts found in the master list"}))
        return

    from_date = (today - timedelta(days=args.sessions * 3 + 4)).strftime("%Y-%m-%d")
    to_date = today.strftime("%Y-%m-%d")
    bars, expiries, errors = {}, {}, {}
    for expiry, sid in contracts:
        key = expiry.replace("-", "")
        expiries[key] = expiry
        try:
            df = _fetch_leg(helper, sid, from_date, to_date, "1", exchange_segment="MCX_COMM", instrument_type="FUTCOM")
            rows = to_bars(df, args.sessions, today=datetime.now(_IST).date())
            if rows:
                bars[key] = rows
            else:
                errors[key] = "no intraday bars"
        except Exception as exc:  # one bad contract must not abort the others
            errors[key] = str(exc)
        time.sleep(0.4)  # Dhan data API is rate limited

    print(json.dumps({"bars": bars, "expiries": expiries, "instrument": {"segment": "MCX_COMM", "security_id": contracts[0][1]}, "errors": errors}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
