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
from straddle_pnf_candles import merge_legs, _to_epoch_seconds  # noqa: E402

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


STORED_DIR = os.path.join(ROOT, "Intraday_Historical_Data", "1min")
# The Dhan intraday API serves at most ~90 days per request; stay inside it when stitching onto the stored history.
API_WINDOW_DAYS = 85


def load_stored_1min(symbol: str, directory: str = STORED_DIR) -> pd.DataFrame:
    """The downloaded 1-min history of `symbol` (IST-naive Datetime index) as a Dhan-shaped frame
    (start_Time epoch seconds, close, volume), or an empty frame when none is stored for it."""
    path = os.path.join(directory, f"{symbol}.parquet")
    if not os.path.isfile(path):
        return pd.DataFrame(columns=["start_Time", "close", "volume"])
    raw = pd.read_parquet(path)
    ist = pd.DatetimeIndex(raw.index).tz_localize(_IST)
    return pd.DataFrame({"start_Time": ((ist - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(seconds=1)).astype("int64"),
                         "close": raw["Close"].to_numpy(), "volume": raw["Volume"].to_numpy()})


DAILY_DIR = os.path.join(ROOT, "Daily_Historical_Data_Fresh")
_DAILY_CLOSE_MIN = 15 * 60 + 29  # a daily close sits on the session's last minute, so day bars close at the bell


def load_daily_before(symbol: str, first_t: int, directory: str = DAILY_DIR) -> pd.DataFrame:
    """Daily closes of `symbol` for every date before the day of epoch `first_t` (IST), one bar each at 15:29 IST, in the
    same shape as load_stored_1min. They let the 1-day / 1-week / 1-month charts reach back years before the 1-min history
    starts; an intraday chart sees them as one price per day. Raw CSV: not adjusted for splits."""
    empty = pd.DataFrame(columns=["start_Time", "close", "volume"])
    path = os.path.join(directory, f"{symbol}_Daily_2Y.csv")
    if not os.path.isfile(path):
        return empty
    raw = pd.read_csv(path)
    day = pd.to_datetime(raw["Datetime"], errors="coerce")
    first_day = pd.Timestamp(datetime.fromtimestamp(first_t, _IST).date())
    keep = day.notna() & (day < first_day) & (pd.to_numeric(raw["Close"], errors="coerce") > 0)
    raw, day = raw[keep], day[keep]
    if raw.empty:
        return empty
    ist = (day + pd.Timedelta(minutes=_DAILY_CLOSE_MIN)).dt.tz_localize(_IST)
    return pd.DataFrame({"start_Time": ((ist - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(seconds=1)).astype("int64").to_numpy(),
                         "close": pd.to_numeric(raw["Close"]).to_numpy(), "volume": pd.to_numeric(raw["Volume"], errors="coerce").fillna(0).to_numpy()})


def stitch_history(stored: pd.DataFrame, fresh: pd.DataFrame) -> pd.DataFrame:
    """Stored bars followed by API bars; where both hold a minute the API's wins (`_leg` keeps the last duplicate)."""
    if stored.empty:
        return fresh
    if fresh is None or fresh.empty:
        return stored
    ts = next((c for c in ("start_Time", "timestamp", "time", "date") if c in fresh.columns), fresh.columns[0])
    cl = next((c for c in ("close", "Close", "c") if c in fresh.columns), fresh.columns[-1])
    vl = next((c for c in ("volume", "Volume", "vol", "Vol") if c in fresh.columns), None)
    norm = pd.DataFrame({"start_Time": _to_epoch_seconds(fresh[ts]), "close": fresh[cl],
                         "volume": fresh[vl] if vl else 0})
    return pd.concat([stored, norm], ignore_index=True)


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

    stored = pd.DataFrame()
    if args.kind == "equity":
        # Equity: show the whole stored history, with the API filling from the day after it ends (or the last ~85 days).
        stored = load_stored_1min(symbol)
        api_from = today - timedelta(days=API_WINDOW_DAYS)
        if not stored.empty:
            last = datetime.fromtimestamp(int(stored["start_Time"].max()), _IST).date()
            api_from = max(api_from, last + timedelta(days=1))
        from_date = min(api_from, today).strftime("%Y-%m-%d")
    df = _fetch_leg(helper, sid, from_date, to_date, "1", exchange_segment=segment, instrument_type=instrument)
    df = stitch_history(stored, df)
    anchor_t = None
    if args.kind == "equity" and not df.empty:
        first_t = int(_to_epoch_seconds(df[next(c for c in ("start_Time", "timestamp", "time", "date") if c in df.columns)]).min())
        anchor_t = first_t  # the box size is a % of the price here, not of a daily close years earlier
        df = stitch_history(load_daily_before(symbol, first_t), df)
    rows = to_bars(df, args.sessions, today=today_ist)
    errors = {} if rows else {"0": "no intraday bars"}
    print(json.dumps({"bars": {"0": rows} if rows else {}, "name": name, "instrument": {"segment": segment, "security_id": sid}, "errors": errors,
                      **({"anchor_t": anchor_t} if anchor_t else {})}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
