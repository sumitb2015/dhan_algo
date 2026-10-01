"""
High / low of a time range, for the Focus Tool's AlgoTest-style Range Breakout.

The range is [--start, --end): every 1-minute bar whose start minute is >= start
and < end, so "09:16 to 09:30" covers 09:16:00 through 09:29:59 exactly as
AlgoTest defines it. The instrument is either one option contract
(--strike/--leg) or the underlying index (--index).

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

UNDERLYING_EXCHANGE = {'NIFTY': 'NSE', 'BANKNIFTY': 'NSE', 'SENSEX': 'BSE'}
SEGMENT_FOR_EXCHANGE = {'NSE': 'NSE_FNO', 'BSE': 'BSE_FNO'}
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


def _hm(text):
    h, m = text.split(':')
    return int(h) * 60 + int(m)


def main():
    p = argparse.ArgumentParser(description='High/low of a time range for Range Breakout')
    p.add_argument('--underlying', required=True, choices=['NIFTY', 'BANKNIFTY', 'SENSEX'])
    p.add_argument('--index', action='store_true', help='Use the underlying index, not an option')
    p.add_argument('--expiry', help='Expiry YYYY-MM-DD (option only)')
    p.add_argument('--strike', type=float)
    p.add_argument('--leg', choices=['CE', 'PE'])
    p.add_argument('--start', required=True, help='HH:MM (inclusive)')
    p.add_argument('--end', required=True, help='HH:MM (exclusive)')
    args = p.parse_args()

    start_m, end_m = _hm(args.start), _hm(args.end)
    if end_m <= start_m:
        print(json.dumps({'error': 'end must be after start'}))
        return

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'error': 'auth failed'}))
        return
    helper = DhanHelper(dhan)

    if args.index:
        security_id, segment, itype = SPOT_IDS[args.underlying], 'IDX_I', 'INDEX'
    else:
        if not (args.expiry and args.strike and args.leg):
            print(json.dumps({'error': 'expiry, strike and leg are required for an option'}))
            return
        exchange = UNDERLYING_EXCHANGE[args.underlying]
        opt = helper.find_option(args.underlying, args.expiry, args.strike, args.leg, exchange=exchange)
        if opt is None:
            print(json.dumps({'error': f'{args.leg} contract not resolved'}))
            return
        security_id, segment, itype = int(opt['SECURITY_ID']), SEGMENT_FOR_EXCHANGE[exchange], 'OPTIDX'

    today = date.today().strftime('%Y-%m-%d')
    tomorrow = (date.today() + timedelta(days=1)).strftime('%Y-%m-%d')
    df = helper.get_intraday_minute_data(
        security_id=str(security_id), exchange_segment=segment, instrument_type=itype,
        interval='1', from_date=today, to_date=tomorrow)
    if df is None or df.empty:
        print(json.dumps({'error': 'no intraday data yet'}))
        return

    ts_col, hi_col, lo_col = _ts_col(df), _col(df, 'high', 'High'), _col(df, 'low', 'Low')
    if hi_col is None or lo_col is None:
        print(json.dumps({'error': 'missing OHLC columns'}))
        return

    now = datetime.now(tz=_IST)
    high = low = None
    minutes = set()
    for _, r in df.iterrows():
        dt = _to_dt(r[ts_col])
        if dt is None or dt.date() != now.date():
            continue
        m = dt.hour * 60 + dt.minute
        if m < start_m or m >= end_m:
            continue
        if dt + timedelta(minutes=1) > now:   # still forming — never fold a partial bar in
            continue
        h, l = float(r[hi_col]), float(r[lo_col])
        high = h if high is None else max(high, h)
        low = l if low is None else min(low, l)
        minutes.add(m)

    # Complete only once the range's LAST minute has a closed bar. Dhan's feed
    # can lag a few seconds behind the clock, so if that bar is still missing
    # (an illiquid minute with no trades, or lag) allow two minutes past the end
    # before accepting the range as it stands.
    now_m = now.hour * 60 + now.minute
    complete = high is not None and now_m >= end_m and (
        max(minutes, default=-1) >= end_m - 1 or now_m >= end_m + 2)
    print(json.dumps({
        'high': high, 'low': low, 'bars': len(minutes), 'complete': bool(complete),
    }))


if __name__ == '__main__':
    main()
