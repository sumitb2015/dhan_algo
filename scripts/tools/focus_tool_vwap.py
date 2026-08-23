"""
Session-open VWAP for one Focus Tool row's CE+PE strike pair.

Genuine session-open VWAP, not a live-tick approximation: fetches today's
intraday candles from Dhan's historical intraday endpoint, which starts at
the exchange's actual 9:15 session open regardless of when the Focus Tool
page/bridge was started — unlike reconstructing VWAP from live WebSocket
ticks (which would only cover the session from whenever this process
happened to start watching).

Same construction as focus_tool_rows_worker.py's side_vwap() (an
unwired rewrite of this page kept elsewhere in the repo) and
nifty_vwap_1min_straddle: typical price of the combined bar
((high+low+close)/3 per leg, summed), weighted by the average of the traded
legs' per-bar volumes, accumulated over every CLOSED bar so far today.

--side selects which legs are included, and must match the Side of the row
the result is compared against: a CE-only row measured against a combined
CE+PE VWAP would cross its exit threshold at the wrong premium.

Only fully closed bars are used (the currently-forming bar is dropped) —
this is what makes the number match TradingView/broker-platform VWAP
readouts, which likewise never fold a still-forming candle's partial volume
into the running average.

Bar granularity is configurable (--interval), but finer bars approximate a
true tick-by-tick VWAP more closely than coarse ones: this formula collapses
each bar down to one typical price, so a 1-minute bar's (H+L+C)/3 discards
far less of what actually traded than a 15-minute bar's does. Default is 1,
Dhan's finest supported interval.

One-off call, not a bridge — spawned per request by
app/api/focus-tool/vwap/route.ts, which caches/paces it (Dhan's historical
endpoint shares the same account-wide ~1 req/3s limit as the option chain).

Usage:
    venv\\Scripts\\python.exe scripts/tools/focus_tool_vwap.py \\
        --underlying NIFTY --expiry 2026-06-25 --ce-strike 24800 --pe-strike 24600 --interval 1
"""
import sys
import os
import json
import argparse
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

UNDERLYING_EXCHANGE = {'NIFTY': 'NSE', 'BANKNIFTY': 'NSE', 'SENSEX': 'BSE'}
SEGMENT_FOR_EXCHANGE = {'NSE': 'NSE_FNO', 'BSE': 'BSE_FNO'}
_IST = timezone(timedelta(hours=5, minutes=30))


def _col(df, *names):
    for nm in names:
        if nm in df.columns:
            return nm
    return None


def _ts_col(df):
    # Dhan's intraday endpoint has returned different column names across
    # versions/instruments — same fallback list as options_straddle_candles.py.
    for c in ('start_Time', 'timestamp', 'time', 'date'):
        if c in df.columns:
            return c
    return df.columns[0]


def _to_dt(raw) -> datetime | None:
    """Bar-start timestamp -> aware IST datetime. Handles unix seconds, unix
    ms, or an ISO-ish string — same parsing as options_straddle_candles.py."""
    try:
        val = float(str(raw).strip())
        if val > 1_500_000_000_000:   # milliseconds (> year 2017 in ms)
            val /= 1000
        return datetime.fromtimestamp(val, tz=_IST)
    except (ValueError, TypeError, OSError):
        pass
    try:
        s = str(raw).replace('T', ' ').strip()
        dt = datetime.strptime(s[:19], '%Y-%m-%d %H:%M:%S')
        return dt.replace(tzinfo=_IST)
    except ValueError:
        return None


def _closed_bars_only(df, interval_minutes: int):
    """Drop any bar whose (start + interval) hasn't elapsed yet — the
    currently-forming bar, whose volume/typical-price are still partial and
    would otherwise skew the running VWAP away from what a closed-bar-only
    platform (TradingView, the broker terminal) shows."""
    ts_col = _ts_col(df)
    now = datetime.now(tz=_IST)
    keep = []
    for raw in df[ts_col]:
        start = _to_dt(raw)
        if start is None:
            keep.append(True)   # unparseable timestamp — don't silently drop the bar
            continue
        keep.append(start + timedelta(minutes=interval_minutes) <= now)
    return df[keep].reset_index(drop=True), ts_col


def main():
    parser = argparse.ArgumentParser(description='Session-open VWAP for a Focus Tool row')
    parser.add_argument('--underlying', required=True, choices=['NIFTY', 'BANKNIFTY', 'SENSEX'])
    parser.add_argument('--expiry', required=True, help='Expiry date YYYY-MM-DD')
    parser.add_argument('--ce-strike', required=True, type=float)
    parser.add_argument('--pe-strike', required=True, type=float)
    parser.add_argument('--interval', default='1', choices=['1', '5', '15', '25', '60'],
                        help='Candle interval in minutes (default 1, the finest Dhan supports)')
    parser.add_argument('--side', default='BOTH', choices=['CE', 'PE', 'BOTH'],
                        help='Which legs the VWAP covers. Must match the row Side it is '
                             'compared against: a CE-only row measured against a combined '
                             'CE+PE VWAP would exit at the wrong threshold (default BOTH)')
    args = parser.parse_args()
    interval_minutes = int(args.interval)
    legs = ['CE', 'PE'] if args.side == 'BOTH' else [args.side]

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'vwap': None, 'error': 'auth failed'}))
        return

    helper = DhanHelper(dhan)
    exchange = UNDERLYING_EXCHANGE[args.underlying]
    segment = SEGMENT_FOR_EXCHANGE[exchange]

    strike_for = {'CE': args.ce_strike, 'PE': args.pe_strike}
    today = date.today().strftime('%Y-%m-%d')
    tomorrow = (date.today() + timedelta(days=1)).strftime('%Y-%m-%d')

    # leg -> {minute: row}, plus that leg's resolved column names.
    per_leg: dict[str, tuple[dict, dict]] = {}
    for leg in legs:
        opt = helper.find_option(args.underlying, args.expiry, strike_for[leg], leg, exchange=exchange)
        if opt is None:
            print(json.dumps({'vwap': None, 'error': f'{leg} contract not resolved'}))
            return

        df = helper.get_intraday_minute_data(
            security_id=str(int(opt['SECURITY_ID'])), exchange_segment=segment,
            instrument_type='OPTIDX', interval=args.interval, from_date=today, to_date=tomorrow)
        if df is None or df.empty:
            print(json.dumps({'vwap': None, 'error': 'no intraday data yet'}))
            return
        closed, ts_col = _closed_bars_only(df, interval_minutes)
        if closed.empty:
            print(json.dumps({'vwap': None, 'error': 'no closed bars yet this session'}))
            return

        cols = {
            'hi': _col(closed, 'high', 'High'), 'lo': _col(closed, 'low', 'Low'),
            'cl': _col(closed, 'close', 'Close'), 'vol': _col(closed, 'volume', 'Volume'),
        }
        if any(v is None for v in cols.values()):
            print(json.dumps({'vwap': None, 'error': 'missing OHLCV columns'}))
            return

        # Key bars by their actual minute label rather than trusting row
        # count/order — a bar with zero trades on one leg but not the other
        # would otherwise silently misalign the two legs.
        by_minute = {}
        for _, r in closed.iterrows():
            dt = _to_dt(r[ts_col])
            if dt is not None:
                by_minute[dt.replace(second=0, microsecond=0)] = r
        per_leg[leg] = (by_minute, cols)

    common = sorted(set.intersection(*(set(m) for m, _ in per_leg.values())))
    if not common:
        print(json.dumps({'vwap': None, 'error': 'no aligned bars'}))
        return

    num = 0.0
    den = 0.0
    for minute in common:
        # Typical price of the combined position for this bar: each traded
        # leg's (H+L+C)/3, summed across legs. Volume weight is the mean of the
        # legs' volumes, so a one-leg row weights by its own volume unchanged.
        typical = 0.0
        vol = 0.0
        for leg in legs:
            by_minute, cols = per_leg[leg]
            r = by_minute[minute]
            typical += (float(r[cols['hi']]) + float(r[cols['lo']]) + float(r[cols['cl']])) / 3.0
            vol += float(r[cols['vol']])
        vol /= len(legs)
        num += typical * vol
        den += vol

    vwap = (num / den) if den > 0 else None
    print(json.dumps({'vwap': round(vwap, 4) if vwap is not None else None}))


if __name__ == '__main__':
    main()
