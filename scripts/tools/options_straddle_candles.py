"""
Fetch today's 1-min intraday candles for a NIFTY straddle leg pair and print
a JSON array of {time, ce, pe, straddle} rows to stdout.

Usage:
    python options_straddle_candles.py --expiry 2026-06-27 --strike 24000 [--interval 1]

Prints a single JSON line to stdout. Logs go to stderr.
"""
import sys
import os
import json
import argparse
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--expiry',   required=True, help='Expiry date YYYY-MM-DD')
    parser.add_argument('--strike',   required=True, type=float, help='Strike price')
    parser.add_argument('--interval', default='1', choices=['1', '5', '15'],
                        help='Candle interval in minutes (default 1)')
    args = parser.parse_args()

    today = date.today().strftime('%Y-%m-%d')

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'error': 'auth_failed — run login.py to refresh the access token'}))
        return

    helper = DhanHelper(dhan)

    # Resolve CE and PE security IDs from master list
    ce_opt = helper.find_option('NIFTY', args.expiry, args.strike, 'CE')
    pe_opt = helper.find_option('NIFTY', args.expiry, args.strike, 'PE')

    if ce_opt is None or pe_opt is None:
        print(json.dumps({'error': f'Could not resolve NIFTY {int(args.strike)} CE/PE for expiry {args.expiry}'}))
        return

    ce_sid = str(int(ce_opt['SECURITY_ID']))
    pe_sid = str(int(pe_opt['SECURITY_ID']))

    # Fetch today's intraday candles for both legs
    ce_df = helper.get_intraday_minute_data(
        security_id=ce_sid,
        exchange_segment='NSE_FNO',
        instrument_type='OPTIDX',
        interval=args.interval,
        from_date=today,
        to_date=today,
    )
    pe_df = helper.get_intraday_minute_data(
        security_id=pe_sid,
        exchange_segment='NSE_FNO',
        instrument_type='OPTIDX',
        interval=args.interval,
        from_date=today,
        to_date=today,
    )

    if ce_df.empty and pe_df.empty:
        print(json.dumps({'error': 'No intraday data returned — market may be closed or token expired'}))
        return

    # Identify the timestamp column (Dhan returns 'start_Time' or 'timestamp')
    def ts_col(df):
        for c in ('start_Time', 'timestamp', 'time', 'date'):
            if c in df.columns:
                return c
        return df.columns[0]

    def close_col(df):
        for c in ('close', 'Close', 'c'):
            if c in df.columns:
                return c
        return df.columns[-1]

    ce_ts  = ts_col(ce_df)  if not ce_df.empty else None
    pe_ts  = ts_col(pe_df)  if not pe_df.empty else None
    ce_cls = close_col(ce_df) if not ce_df.empty else None
    pe_cls = close_col(pe_df) if not pe_df.empty else None

    # Build lookup dicts keyed by timestamp string
    ce_map = {str(row[ce_ts]): float(row[ce_cls]) for _, row in ce_df.iterrows()} if not ce_df.empty else {}
    pe_map = {str(row[pe_ts]): float(row[pe_cls]) for _, row in pe_df.iterrows()} if not pe_df.empty else {}

    # Union of timestamps, sorted
    all_times = sorted(set(ce_map) | set(pe_map))

    rows = []
    for t in all_times:
        ce_close = ce_map.get(t, 0)
        pe_close = pe_map.get(t, 0)
        # Format time as HH:MM for chart axis
        try:
            time_label = str(t)[11:16] if len(str(t)) > 10 else str(t)
        except Exception:
            time_label = str(t)
        rows.append({
            'time':     time_label,
            'CE LTP':   round(ce_close, 2),
            'PE LTP':   round(pe_close, 2),
            'Straddle': round(ce_close + pe_close, 2),
        })

    print(json.dumps({'candles': rows, 'strike': int(args.strike), 'expiry': args.expiry}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
