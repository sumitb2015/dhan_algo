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
import pandas as pd
from datetime import date, timedelta, datetime, timezone

_IST = timezone(timedelta(hours=5, minutes=30))

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper


def _fetch_leg(helper, sid: str, from_date: str, to_date: str, interval: str):
    """Fetch intraday candles for one leg over a date range, returning the DataFrame."""
    return helper.get_intraday_minute_data(
        security_id=sid,
        exchange_segment='NSE_FNO',
        instrument_type='OPTIDX',
        interval=interval,
        from_date=from_date,
        to_date=to_date,
        oi=True,
    )


def _ts_col(df):
    for c in ('start_Time', 'timestamp', 'time', 'date'):
        if c in df.columns:
            return c
    return df.columns[0]


def _filter_last_day(df) -> tuple:
    """
    Given a multi-day DataFrame, return (filtered_df, date_str) keeping only
    the most recent trading day's rows.  Returns (df, None) if df is empty.
    """
    if df.empty:
        return df, None

    tc = _ts_col(df)
    col = df[tc]

    # Timestamps may be unix epoch seconds (int/float) or ISO strings
    if col.dtype in ('int64', 'float64'):
        dates = pd.to_datetime(col, unit='s').dt.date
    else:
        dates = pd.to_datetime(col, errors='coerce').dt.date

    last_day = dates.max()
    mask = dates == last_day
    return df[mask].copy(), str(last_day)


def _find_last_trading_day(helper, ce_sid: str, pe_sid: str, interval: str, lookback: int = 7):
    """
    Fetch a date range in TWO API calls (not one per day) and slice out the
    last trading day.  Returns (ce_df, pe_df, date_used, ce_all, pe_all).
    """
    today      = date.today()
    from_date  = (today - timedelta(days=lookback)).strftime('%Y-%m-%d')
    to_date    = today.strftime('%Y-%m-%d')

    ce_all = _fetch_leg(helper, ce_sid, from_date, to_date, interval)
    pe_all = _fetch_leg(helper, pe_sid, from_date, to_date, interval)

    ce_df, ce_date = _filter_last_day(ce_all)
    pe_df, pe_date = _filter_last_day(pe_all)

    data_date = ce_date or pe_date
    if data_date is None:
        return None, None, None, None, None

    return ce_df, pe_df, data_date, ce_all, pe_all


def _prev_day_close_from_intraday(raw_df, today_date_str: str) -> float:
    try:
        if raw_df is None or raw_df.empty:
            return 0.0
        # Determine timestamp column
        tc = None
        for c in ('start_Time', 'timestamp', 'time', 'date'):
            if c in raw_df.columns:
                tc = c
                break
        if tc is None:
            tc = raw_df.columns[0]
        
        col = raw_df[tc]
        dates = (pd.to_datetime(col, unit='s').dt.date
                 if col.dtype in ('int64', 'float64')
                 else pd.to_datetime(col, errors='coerce').dt.date)
        prev_days = sorted(d for d in dates.unique() if str(d) < today_date_str)
        if not prev_days:
            return 0.0
        prev_day = prev_days[-1]
        prev_df = raw_df[dates == prev_day]
        
        # Determine close column
        cc = None
        for c in ('close', 'Close', 'c'):
            if c in prev_df.columns:
                cc = c
                break
        if cc is None:
            cc = prev_df.columns[-1]
            
        return round(float(prev_df[cc].iloc[-1]), 2)
    except Exception:
        return 0.0


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

    # Fetch candles: try today first, fall back up to 5 calendar days to find the last trading day
    ce_df, pe_df, data_date, ce_all, pe_all = _find_last_trading_day(
        helper, ce_sid, pe_sid, args.interval, lookback=5
    )

    if ce_df is None or (ce_df.empty and pe_df.empty):
        print(json.dumps({'error': 'No intraday data found in the last 5 days — check auth token or expiry'}))
        return

    is_today = data_date == today

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

    def vol_col(df):
        for c in ('volume', 'Volume', 'vol', 'Vol'):
            if c in df.columns:
                return c
        return None

    def oi_col(df):
        for c in ('oi', 'OI', 'open_interest', 'openInterest'):
            if c in df.columns:
                return c
        return None

    ce_ts  = ts_col(ce_df)   if not ce_df.empty else None
    pe_ts  = ts_col(pe_df)   if not pe_df.empty else None
    ce_cls = close_col(ce_df) if not ce_df.empty else None
    pe_cls = close_col(pe_df) if not pe_df.empty else None
    ce_volc = vol_col(ce_df) if not ce_df.empty else None
    pe_volc = vol_col(pe_df) if not pe_df.empty else None
    ce_oic = oi_col(ce_df)   if not ce_df.empty else None
    pe_oic = oi_col(pe_df)   if not pe_df.empty else None

    def to_hhmm(raw) -> str:
        """Convert a Dhan timestamp (unix seconds, unix ms, or ISO string) to HH:MM IST."""
        try:
            val = float(str(raw).strip())
            if val > 1_500_000_000_000:   # milliseconds (> year 2017 in ms)
                val /= 1000
            dt = datetime.fromtimestamp(val, tz=_IST)
            return dt.strftime('%H:%M')
        except (ValueError, TypeError, OSError):
            pass
        # ISO / string fallback: "2026-06-25 09:15:00" or "2026-06-25T09:15:00"
        s = str(raw).replace('T', ' ')
        return s[11:16] if len(s) > 10 else s

    # Build lookup dicts keyed by canonical HH:MM label
    def build_map(df, ts, val_col):
        return {to_hhmm(row[ts]): row[val_col] for _, row in df.iterrows()} if not df.empty else {}

    ce_map     = build_map(ce_df, ce_ts, ce_cls)   if ce_ts and ce_cls   else {}
    pe_map     = build_map(pe_df, pe_ts, pe_cls)   if pe_ts and pe_cls   else {}
    ce_vol_map = build_map(ce_df, ce_ts, ce_volc)  if (ce_ts and ce_volc) else {}
    pe_vol_map = build_map(pe_df, pe_ts, pe_volc)  if (pe_ts and pe_volc) else {}
    ce_oi_map  = build_map(ce_df, ce_ts, ce_oic)   if (ce_ts and ce_oic)  else {}
    pe_oi_map  = build_map(pe_df, pe_ts, pe_oic)   if (pe_ts and pe_oic)  else {}

    # Union of timestamps, sorted (HH:MM strings sort lexicographically)
    all_times = sorted(set(ce_map) | set(pe_map))

    rows = []
    for t in all_times:
        ce_close = float(ce_map.get(t, 0))
        pe_close = float(pe_map.get(t, 0))
        ce_vol   = int(ce_vol_map.get(t, 0))
        pe_vol   = int(pe_vol_map.get(t, 0))
        ce_oi    = int(ce_oi_map.get(t, 0))
        pe_oi    = int(pe_oi_map.get(t, 0))
        rows.append({
            'time':     t,
            'CE LTP':   round(ce_close, 2),
            'PE LTP':   round(pe_close, 2),
            'Straddle': round(ce_close + pe_close, 2),
            'CE Vol':   ce_vol,
            'PE Vol':   pe_vol,
            'CE OI':    ce_oi,
            'PE OI':    pe_oi,
        })

    ce_prev = _prev_day_close_from_intraday(ce_all, data_date)
    pe_prev = _prev_day_close_from_intraday(pe_all, data_date)

    print(json.dumps({
        'candles':   rows,
        'strike':    int(args.strike),
        'expiry':    args.expiry,
        'data_date': data_date,
        'is_today':  is_today,
        'ce_prev_close': ce_prev,
        'pe_prev_close': pe_prev,
    }))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
