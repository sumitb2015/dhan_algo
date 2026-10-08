"""
High / low of a time range, for the Focus Tool's AlgoTest-style Range Breakout.

The range is [--start, --end): every 1-minute bar whose start minute is >= start
and < end, so "09:16 to 09:30" covers 09:16:00 through 09:29:59 exactly as
AlgoTest defines it. The instrument is either one option contract
(--strike/--leg) or the underlying index (--index).

--start-date / --end-date (YYYY-MM-DD, default today) let the range span
days, for AlgoTest's Range Breakout BTST (previous day -> today) and Positional
ORB (DTE n -> DTE m): the range is then [start-date start, end-date end).

Also reports `open`, the first bar's open in the range: for an index range it is
the spot at the range start, from which a tab that was not open then can still
work out the ATM strike AlgoTest would have picked.

Reports `complete` only once the last minute of the range (end - 1) has a
closed bar: an unfinished range must never be used, because a high that is
still being made would let a premature "breakout" through.

One-off call, spawned per request by app/api/focus-tool/range/route.ts, which
paces it with the other Dhan historical calls.

Usage:
    venv/bin/python scripts/tools/focus_tool_range.py --underlying NIFTY \
        --expiry 2026-10-06 --strike 24800 --leg CE --start 09:16 --end 09:30
    venv/bin/python scripts/tools/focus_tool_range.py --underlying NIFTY --index \
        --start 09:16 --end 09:30
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

UNDERLYING_EXCHANGE = {'NIFTY': 'NSE', 'BANKNIFTY': 'NSE', 'SENSEX': 'BSE', 'CRUDEOILM': 'MCX'}
SEGMENT_FOR_EXCHANGE = {'NSE': 'NSE_FNO', 'BSE': 'BSE_FNO', 'MCX': 'MCX_COMM'}
# Dhan's instrument type for option candles; MCX commodity options are OPTFUT.
OPTION_INSTRUMENT = {'NSE': 'OPTIDX', 'BSE': 'OPTIDX', 'MCX': 'OPTFUT'}
SPOT_IDS = {'NIFTY': 13, 'BANKNIFTY': 25, 'SENSEX': 51}
_IST = timezone(timedelta(hours=5, minutes=30))


def _col(df, *names):
    for nm in names:
        if nm in df.columns:
            return nm
    return None


def _ts_col(df):
    for c in ('start_Time', 'timestamp', 'time', 'date'):
        if c in df.columns:
            return c
    return df.columns[0]


def _to_dt(raw):
    """Bar-start timestamp -> aware IST datetime (unix s / ms or an ISO-ish string)."""
    try:
        val = float(str(raw).strip())
        if val > 1_500_000_000_000:
            val /= 1000
        return datetime.fromtimestamp(val, tz=_IST)
    except (ValueError, TypeError, OSError):
        pass
    try:
        s = str(raw).replace('T', ' ').strip()
        return datetime.strptime(s[:19], '%Y-%m-%d %H:%M:%S').replace(tzinfo=_IST)
    except ValueError:
        return None


def main():
    p = argparse.ArgumentParser(description='High/low of a time range for Range Breakout')
    p.add_argument('--underlying', required=True, choices=list(UNDERLYING_EXCHANGE))
    p.add_argument('--index', action='store_true', help='Use the underlying index, not an option')
    p.add_argument('--expiry', help='Expiry YYYY-MM-DD (option only)')
    p.add_argument('--strike', type=float)
    p.add_argument('--leg', choices=['CE', 'PE'])
    p.add_argument('--start', required=True, help='HH:MM (inclusive)')
    p.add_argument('--end', required=True, help='HH:MM (exclusive)')
    p.add_argument('--start-date', help='YYYY-MM-DD of the start (default today)')
    p.add_argument('--end-date', help='YYYY-MM-DD of the end (default today)')
    args = p.parse_args()

    today_d = datetime.now(tz=_IST).date()
    try:
        start_d = date.fromisoformat(args.start_date) if args.start_date else today_d
        end_d = date.fromisoformat(args.end_date) if args.end_date else today_d
    except ValueError:
        print(json.dumps({'error': 'bad date'}))
        return
    sh, sm = (int(x) for x in args.start.split(':'))
    eh, em = (int(x) for x in args.end.split(':'))
    start_dt = datetime(start_d.year, start_d.month, start_d.day, sh, sm, tzinfo=_IST)
    end_dt = datetime(end_d.year, end_d.month, end_d.day, eh, em, tzinfo=_IST)
    if end_dt <= start_dt:
        print(json.dumps({'error': 'end must be after start'}))
        return

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'error': 'auth failed'}))
        return
    helper = DhanHelper(dhan)

    if args.index and args.underlying == 'CRUDEOILM':
        # MCX has no index: the underlying IS the nearest futures contract, the same one
        # the page's spot / futures strip quotes.
        from scripts.tools.premarket_data import _find_nearest_future
        fut = _find_nearest_future(helper, 'CRUDEOILM', exchange='MCX', instrument='FUTCOM')
        if fut is None:
            print(json.dumps({'error': 'no non-lapsed CRUDEOILM futures contract'}))
            return
        security_id, segment, itype = int(fut['SECURITY_ID']), 'MCX_COMM', 'FUTCOM'
    elif args.index:
        security_id, segment, itype = SPOT_IDS[args.underlying], 'IDX_I', 'INDEX'
    else:
        if not (args.expiry and args.strike and args.leg):
            print(json.dumps({'error': 'expiry, strike and leg are required for an option'}))
            return
        exchange = UNDERLYING_EXCHANGE[args.underlying]
        opt = helper.find_option(args.underlying, args.expiry, args.strike, args.leg, exchange=exchange,
                                 instrument=OPTION_INSTRUMENT[exchange])
        if opt is None:
            print(json.dumps({'error': f'{args.leg} contract not resolved'}))
            return
        security_id, segment, itype = int(opt['SECURITY_ID']), SEGMENT_FOR_EXCHANGE[exchange], OPTION_INSTRUMENT[exchange]

    df = helper.get_intraday_minute_data(
        security_id=str(security_id), exchange_segment=segment, instrument_type=itype,
        interval='1', from_date=start_d.strftime('%Y-%m-%d'),
        to_date=(end_d + timedelta(days=1)).strftime('%Y-%m-%d'))
    if df is None or df.empty:
        print(json.dumps({'error': 'no intraday data yet'}))
        return

    ts_col, hi_col, lo_col = _ts_col(df), _col(df, 'high', 'High'), _col(df, 'low', 'Low')
    op_col = _col(df, 'open', 'Open')
    if hi_col is None or lo_col is None:
        print(json.dumps({'error': 'missing OHLC columns'}))
        return

    now = datetime.now(tz=_IST)
    high = low = None
    first = None
    last_bar = None
    bars = 0
    for _, r in df.iterrows():
        dt = _to_dt(r[ts_col])
        if dt is None or dt < start_dt or dt >= end_dt:
            continue
        if dt + timedelta(minutes=1) > now:   # still forming — never fold a partial bar in
            continue
        h, l = float(r[hi_col]), float(r[lo_col])
        high = h if high is None else max(high, h)
        low = l if low is None else min(low, l)
        if first is None or dt < first[0]:
            first = (dt, float(r[op_col]) if op_col else None)
        last_bar = dt if last_bar is None else max(last_bar, dt)
        bars += 1

    # Complete only once the range's LAST minute has a closed bar. Dhan's feed
    # can lag a few seconds behind the clock, so if that bar is still missing
    # (an illiquid minute with no trades, or lag) allow two minutes past the end
    # before accepting the range as it stands.
    complete = high is not None and now >= end_dt and (
        (last_bar is not None and last_bar >= end_dt - timedelta(minutes=1))
        or now >= end_dt + timedelta(minutes=2))
    print(json.dumps({
        'high': high, 'low': low, 'bars': bars, 'complete': bool(complete),
        'open': first[1] if first else None,
    }))


if __name__ == '__main__':
    main()
