"""
Multi-session 1-min price bars of an NSE index or cash equity for the Straddle P&F page's price mode.

Usage:
    python price_pnf_candles.py --kind index  --symbol NIFTY      [--sessions 3]
    python price_pnf_candles.py --kind equity --symbol RELIANCE   [--sessions 3]
    python price_pnf_candles.py --kind contract --legs NSE_FNO:53872:OPTIDX[,NSE_FNO:53873:OPTIDX] --name "..."

`--kind contract` charts F&O contracts the dashboard already resolved from master_list.csv (it never takes ids from the browser):
one leg is a future or a single option (its close), two legs are a CE + PE straddle (their summed close, inner-joined on time).

Prints ONE JSON line to stdout:
    {"bars": {"0": [{t, ce, pe, straddle, vol}, ...]}, "name": "...", "errors": {...}}
or {"error": "..."}. Bars are straddle-shaped (`straddle` and `ce` carry the close, `pe` is 0) so the page's P&F model runs unchanged;
indices carry no volume, which the VWAP already handles (it falls back to the plain average). Logs go to stderr. Read-only.
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

from futures_pnf_candles import to_bars  # noqa: E402
from straddle_pnf_candles import merge_legs  # noqa: E402

_IST = timezone(timedelta(hours=5, minutes=30))

# NSE index security ids (IDX_I segment): the same ones options_data_fetch.py uses for spot.
INDEX_IDS = {"NIFTY": 13, "BANKNIFTY": 25, "FINNIFTY": 27}
# Display names, matching the search box (rs_dashboard/lib/straddlePnfSearch.ts PNF_INDICES).
INDEX_NAMES = {"NIFTY": "Nifty 50", "BANKNIFTY": "Nifty Bank", "FINNIFTY": "Nifty Financial Services"}
_SERIES_RANK = {"EQ": 0, "BE": 1}


_LEG_SEGMENTS = {"NSE_FNO", "MCX_COMM"}
_LEG_INSTRUMENTS = {"FUTIDX", "FUTSTK", "FUTCOM", "OPTIDX", "OPTSTK", "OPTFUT"}


def parse_legs(text: str) -> list:
    """'SEG:ID:INSTR[,SEG:ID:INSTR]' -> [(segment, security id, instrument)]; one or two F&O legs, else ValueError."""
    legs = []
    for part in (p.strip() for p in text.split(",") if p.strip()):
        seg, sid, inst = part.split(":")
        if seg not in _LEG_SEGMENTS or inst not in _LEG_INSTRUMENTS or not sid.isdigit():
            raise ValueError(f"bad leg {part!r}")
        legs.append((seg, sid, inst))
    if not 1 <= len(legs) <= 2:
        raise ValueError("expected one or two legs")
    return legs


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
    parser.add_argument("--kind", required=True, choices=["index", "equity", "contract"])
    parser.add_argument("--symbol", default="")
    parser.add_argument("--legs", default="", help="contract mode: SEG:ID:INSTR[,SEG:ID:INSTR]")
    parser.add_argument("--name", default="", help="contract mode: display name to echo back")
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

    today = date.today()
    from_date = (today - timedelta(days=args.sessions * 3 + 4)).strftime("%Y-%m-%d")
    to_date = today.strftime("%Y-%m-%d")
    today_ist = datetime.now(_IST).date()

    if args.kind == "contract":
        try:
            legs = parse_legs(args.legs)
        except ValueError as exc:
            print(json.dumps({"error": str(exc)}))
            return
        frames = []
        for n, (seg, sid, inst) in enumerate(legs):
            if n:
                time.sleep(0.4)  # Dhan data API is rate limited
            frames.append(_fetch_leg(helper, sid, from_date, to_date, "1", exchange_segment=seg, instrument_type=inst))
        rows = to_bars(frames[0], args.sessions, today=today_ist) if len(frames) == 1 else merge_legs(frames[0], frames[1], args.sessions, today=today_ist)
        errors = {} if rows else {"0": "no intraday bars" if len(legs) == 1 else "no intraday bars for both legs"}
        print(json.dumps({"bars": {"0": rows} if rows else {}, "name": args.name or args.legs,
                          "instruments": [{"segment": seg, "security_id": sid} for seg, sid, _ in legs], "errors": errors}))
        return

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

    df = _fetch_leg(helper, sid, from_date, to_date, "1", exchange_segment=segment, instrument_type=instrument)
    rows = to_bars(df, args.sessions, today=today_ist)
    errors = {} if rows else {"0": "no intraday bars"}
    print(json.dumps({"bars": {"0": rows} if rows else {}, "name": name, "instrument": {"segment": segment, "security_id": sid}, "errors": errors}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
