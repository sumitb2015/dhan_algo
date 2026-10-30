"""
Multi-session 1-min price bars of an NSE index or cash equity for the Straddle P&F page's price mode.

Usage:
    python price_pnf_candles.py --kind index  --symbol NIFTY      [--sessions 3]
    python price_pnf_candles.py --kind equity --symbol RELIANCE   [--sessions 3]

Prints ONE JSON line to stdout:
    {"bars": {"0": [{t, ce, pe, straddle, vol}, ...]}, "name": "...", "errors": {...}}
or {"error": "..."}. Bars are straddle-shaped (`straddle` and `ce` carry the close, `pe` is 0) so the page's P&F model runs unchanged;
indices carry no volume, which the VWAP already handles (it falls back to the plain average). Logs go to stderr. Read-only.
"""
import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from futures_pnf_candles import to_bars  # noqa: E402

_IST = timezone(timedelta(hours=5, minutes=30))

# NSE index security ids (IDX_I segment): the same ones options_data_fetch.py uses for spot.
INDEX_IDS = {"NIFTY": 13, "BANKNIFTY": 25, "FINNIFTY": 27}
# Display names, matching the search box (rs_dashboard/lib/straddlePnfSearch.ts PNF_INDICES).
INDEX_NAMES = {"NIFTY": "Nifty 50", "BANKNIFTY": "Nifty Bank", "FINNIFTY": "Nifty Financial Services"}
_SERIES_RANK = {"EQ": 0, "BE": 1}


def resolve_equity(master: pd.DataFrame, symbol: str):
    """The NSE cash row for `symbol` (EQ series preferred over BE), as (security id, name), or None."""
    m = master[(master["EXCH_ID"] == "NSE") & (master["INSTRUMENT"] == "EQUITY") & (master["UNDERLYING_SYMBOL"] == symbol)].copy()
    m = m[m["SERIES"].isin(_SERIES_RANK)]
    if m.empty:
        return None
    m["rank"] = m["SERIES"].map(_SERIES_RANK)
    row = m.sort_values("rank").iloc[0]
    return str(int(row["SECURITY_ID"])), str(row["SYMBOL_NAME"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", required=True, choices=["index", "equity"])
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--sessions", type=int, default=3, help="completed sessions of history; today's bars come on top")
    args = parser.parse_args()
    symbol = args.symbol.upper()

    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper
    from options_straddle_candles import _fetch_leg

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"error": "auth_failed — run login.py to refresh the access token"}))
        return
    helper = DhanHelper(dhan)

    if args.kind == "index":
        if symbol not in INDEX_IDS:
            print(json.dumps({"error": f"unsupported index {symbol}"}))
            return
        sid, name, segment, instrument = str(INDEX_IDS[symbol]), INDEX_NAMES[symbol], "IDX_I", "INDEX"
    else:
        found = resolve_equity(helper._load_master_list(), symbol)
        if not found:
            print(json.dumps({"error": f"{symbol} not found in the NSE equity master list"}))
            return
        (sid, name), segment, instrument = found, "NSE_EQ", "EQUITY"

    today = date.today()
    from_date = (today - timedelta(days=args.sessions * 3 + 4)).strftime("%Y-%m-%d")
    df = _fetch_leg(helper, sid, from_date, today.strftime("%Y-%m-%d"), "1", exchange_segment=segment, instrument_type=instrument)
    rows = to_bars(df, args.sessions, today=datetime.now(_IST).date())
    errors = {} if rows else {"0": "no intraday bars"}
    print(json.dumps({"bars": {"0": rows} if rows else {}, "name": name, "instrument": {"segment": segment, "security_id": sid}, "errors": errors}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
