"""
Batch 1-minute OHLCV backfill for a set of option contracts (Bearish Strikes page).

Read-only, one-off call spawned by rs_dashboard/app/api/bearish-strikes/bars/route.ts,
which caches per contract and paces the spawns. Returns every CLOSED-or-forming 1-minute
bar from today's session open, plus (with --history-days N) the last N prior trading days
that have data for the contract, so Supertrend / EMA20 are already warm at 09:15. VWAP is
a per-session indicator and resets each date downstream; the page drops the forming bar
itself, so the indicator code owns that rule in one place.

Output (last stdout line, JSON):
    {"bars": {"24500CE": [{"t": "2026-10-14 09:15:00", "o":..,"h":..,"l":..,"c":..,"v":..}, ...]},
     "errors": {"24500PE": "contract not resolved"}}

Timestamps are IST-naive "YYYY-MM-DD HH:MM:SS" (the repo's intraday-store convention).
Dhan has no 3-minute interval, so the page resamples these 1-minute bars.

Usage:
    python scripts/tools/option_bars_batch.py --underlying NIFTY --expiry 2026-10-20 \
        --contracts 24500CE,24500PE --history-days 2
"""
import sys
import os
import json
import time
import argparse
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

UNDERLYING_EXCHANGE = {'NIFTY': 'NSE', 'BANKNIFTY': 'NSE', 'FINNIFTY': 'NSE', 'SENSEX': 'BSE', 'CRUDEOIL': 'MCX', 'CRUDEOILM': 'MCX'}
SEGMENT_FOR_EXCHANGE = {'NSE': 'NSE_FNO', 'BSE': 'BSE_FNO', 'MCX': 'MCX_COMM'}
OPTION_INSTRUMENT = {'NSE': 'OPTIDX', 'BSE': 'OPTIDX', 'MCX': 'OPTFUT'}
_IST = timezone(timedelta(hours=5, minutes=30))
MAX_CONTRACTS = 12
CALL_GAP_S = 0.3   # stay well inside the Data API limit across a batch


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
    """Bar-start stamp -> aware IST datetime (unix s / unix ms / ISO-ish string)."""
    try:
        val = float(str(raw).strip())
        if val > 1_500_000_000_000:
            val /= 1000
        # Dhan's intraday epoch is IST-naive for some instruments: treat as UTC clock then label IST
        return datetime.fromtimestamp(val, tz=_IST)
    except (ValueError, TypeError, OSError):
        pass
    try:
        s = str(raw).replace('T', ' ').strip()
        return datetime.strptime(s[:19], '%Y-%m-%d %H:%M:%S').replace(tzinfo=_IST)
    except ValueError:
        return None


def _is_rate_limited(err, exc=None) -> bool:
    """True for Dhan's rate-limit family (DH-904, 805, HTTP 429): retrying the next contract only makes it worse."""
    err = err or {}
    if str(err.get('code', '')).strip().upper() in ('DH-904', '904', '805'):
        return True
    text = ' '.join(str(x) for x in (err.get('type'), err.get('message'), exc) if x).lower()
    return any(t in text for t in ('dh-904', '429', 'too many', 'rate limit', 'rate_limit'))


def _parse_contract(tok: str):
    tok = tok.strip().upper()
    if tok.endswith('CE') or tok.endswith('PE'):
        try:
            return float(tok[:-2]), tok[-2:]
        except ValueError:
            return None
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--underlying', required=True, choices=list(UNDERLYING_EXCHANGE))
    ap.add_argument('--expiry', required=True)
    ap.add_argument('--contracts', required=True, help='comma list like 24500CE,24500PE')
    ap.add_argument('--history-days', type=int, default=0,
                    help='also return the last N prior trading days (0 = today only)')
    args = ap.parse_args()

    contracts = [c for c in (_parse_contract(t) for t in args.contracts.split(',')) if c][:MAX_CONTRACTS]
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'bars': {}, 'errors': {'*': 'auth failed'}}))
        return
    helper = DhanHelper(dhan)
    exchange = UNDERLYING_EXCHANGE[args.underlying]
    segment = SEGMENT_FOR_EXCHANGE[exchange]
    today = date.today().strftime('%Y-%m-%d')
    # Calendar look-back wide enough to cover N trading days across weekends/holidays; trimmed to N dates below.
    from_date = (date.today() - timedelta(days=max(args.history_days * 2 + 3, 0))).strftime('%Y-%m-%d') if args.history_days > 0 else today
    tomorrow = (date.today() + timedelta(days=1)).strftime('%Y-%m-%d')

    bars, errors = {}, {}
    rate_limited = False
    for i, (strike, opt_type) in enumerate(contracts):
        key = f'{int(strike) if strike == int(strike) else strike}{opt_type}'
        if rate_limited:
            errors[key] = 'rate limited (skipped)'
            continue
        if i:
            time.sleep(CALL_GAP_S)
        try:
            opt = helper.find_option(args.underlying, args.expiry, strike, opt_type, exchange=exchange,
                                     instrument=OPTION_INSTRUMENT[exchange])
            if opt is None:
                errors[key] = 'contract not resolved'
                continue
            df = helper.get_intraday_minute_data(
                security_id=str(int(opt['SECURITY_ID'])), exchange_segment=segment,
                instrument_type=OPTION_INSTRUMENT[exchange], interval='1',
                from_date=from_date, to_date=tomorrow)
            if df is None or df.empty:
                if _is_rate_limited(helper.last_api_error):
                    rate_limited = True
                    errors[key] = 'rate limited'
                    continue
                errors[key] = (helper.last_api_error or {}).get('message') or 'no intraday data yet'
                continue
            ts, hi, lo = _ts_col(df), _col(df, 'high', 'High'), _col(df, 'low', 'Low')
            op, cl, vo = _col(df, 'open', 'Open'), _col(df, 'close', 'Close'), _col(df, 'volume', 'Volume')
            if None in (hi, lo, op, cl, vo):
                errors[key] = 'missing OHLCV columns'
                continue
            rows = []
            for _, r in df.iterrows():
                dt = _to_dt(r[ts])
                if dt is None:
                    continue
                rows.append({'t': dt.strftime('%Y-%m-%d %H:%M:00'), 'o': float(r[op]), 'h': float(r[hi]),
                             'l': float(r[lo]), 'c': float(r[cl]), 'v': float(r[vo])})
            rows.sort(key=lambda x: x['t'])
            # Keep today + the last N prior dates that actually have bars (holidays/weekends drop out).
            dates = sorted({r['t'][:10] for r in rows})
            keep = set([d for d in dates if d != today][-args.history_days:] if args.history_days > 0 else []) | {today}
            bars[key] = [r for r in rows if r['t'][:10] in keep]
        except Exception as e:  # one bad contract must not sink the batch
            if _is_rate_limited(None, e):
                rate_limited = True
                errors[key] = 'rate limited'
            else:
                errors[key] = str(e)

    print(json.dumps({'bars': bars, 'errors': errors, 'rateLimited': rate_limited}))


if __name__ == '__main__':
    main()
