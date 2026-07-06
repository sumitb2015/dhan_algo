"""
Fetch today's 1-min intraday candle history for all open F&O option positions
and compute net combined premium (sell legs minus buy legs) per minute.

Usage (no args needed):
    python positions_history.py

Prints one JSON line to stdout:
    { "history": [{"time": "<ISO UTC>", "netPremium": 270.5, "vix": 14.2}, ...] }

On error:
    { "history": [], "error": "<reason>" }

Logs go to stderr.
"""
import sys
import os
import json
from datetime import date, timedelta, timezone, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

import pandas as pd

VIX_SECURITY_ID = "21"


def _ts_col(df):
    for c in ('start_Time', 'timestamp', 'time', 'date'):
        if c in df.columns:
            return c
    return df.columns[0]


def _to_epoch_series(df):
    """Return epoch-seconds int series for the timestamp column."""
    tc = _ts_col(df)
    col = df[tc]
    if col.dtype in ('int64', 'float64'):
        return col.astype(int)
    return (pd.to_datetime(col, errors='coerce').astype('int64') // 10 ** 9).astype(int)


def _filter_last_day(df):
    if df is None or df.empty:
        return df
    tc = _ts_col(df)
    col = df[tc]
    if col.dtype in ('int64', 'float64'):
        dates = pd.to_datetime(col, unit='s').dt.date
    else:
        dates = pd.to_datetime(col, errors='coerce').dt.date
    last = dates.max()
    return df[dates == last].copy()


def _is_option_leg(row):
    """Return True if this position row is an F&O option (CE or PE)."""
    sym = str(row.get('tradingSymbol', '') or '')
    seg = str(row.get('exchangeSegment', '') or '')
    opt_type = str(row.get('drvOptionType', '') or '')
    if seg == 'NSE_FNO' and opt_type in ('CALL', 'PUT'):
        return True
    return seg == 'NSE_FNO' and bool(__import__('re').search(r'-(CE|PE)', sym, __import__('re').I))


def main():
    today = date.today()
    lookback_str = str(today - timedelta(days=5))
    today_str    = str(today)

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'history': [], 'error': 'auth_failed'}))
        return

    helper = DhanHelper(dhan)

    # ── Fetch open positions ──────────────────────────────────────────
    positions_df = helper.get_positions()
    if positions_df is None or positions_df.empty:
        print(json.dumps({'history': [], 'error': 'no_positions'}))
        return

    # Filter to option legs with non-zero netQty
    opt_rows = [
        row for _, row in positions_df.iterrows()
        if _is_option_leg(row) and int(row.get('netQty', 0) or 0) != 0
    ]

    if not opt_rows:
        print(json.dumps({'history': [], 'error': 'no_option_legs'}))
        return

    # ── Fetch 1-min candles for each leg ─────────────────────────────
    leg_maps = {}  # secId → {'side', 'abs_qty', 'close_map'}
    for row in opt_rows:
        sid     = str(row.get('securityId', '') or '')
        qty     = int(row.get('netQty', 0) or 0)
        side    = 'SELL' if qty < 0 else 'BUY'
        abs_qty = abs(qty)
        if not sid:
            continue
        try:
            raw = helper.get_intraday_minute_data(
                security_id=sid,
                exchange_segment='NSE_FNO',
                instrument_type='OPTIDX',
                interval='1',
                from_date=lookback_str,
                to_date=today_str,
            )
            df = _filter_last_day(raw)
            if df is None or df.empty:
                continue
            ts_ser = _to_epoch_series(df)
            leg_maps[sid] = {
                'side':      side,
                'abs_qty':   abs_qty,
                'close_map': dict(zip(ts_ser.tolist(), df['close'].tolist())),
            }
        except Exception as e:
            print(f'WARN: could not fetch candles for leg {sid}: {e}', file=sys.stderr)

    # ── Fetch VIX candles ─────────────────────────────────────────────
    vix_map: dict = {}
    try:
        vix_raw = helper.get_intraday_minute_data(
            security_id=VIX_SECURITY_ID,
            exchange_segment='IDX_I',
            instrument_type='INDEX',
            interval='1',
            from_date=lookback_str,
            to_date=today_str,
        )
        vix_df = _filter_last_day(vix_raw)
        if vix_df is not None and not vix_df.empty:
            ts_ser  = _to_epoch_series(vix_df)
            vix_map = dict(zip(ts_ser.tolist(), vix_df['close'].tolist()))
    except Exception as e:
        print(f'WARN: could not fetch VIX: {e}', file=sys.stderr)

    if not leg_maps:
        print(json.dumps({'history': [], 'error': 'no_candle_data'}))
        return

    # ── Align timestamps across all legs ─────────────────────────────
    all_ts_sets = [set(m['close_map'].keys()) for m in leg_maps.values()]
    common_ts   = sorted(all_ts_sets[0].intersection(*all_ts_sets[1:]))

    # ── Build per-minute net premium history ──────────────────────────
    history = []
    for ts in common_ts:
        net_premium = 0.0
        for info in leg_maps.values():
            ltp     = float(info['close_map'].get(ts, 0) or 0)
            abs_qty = info['abs_qty']
            net_premium += ltp * abs_qty if info['side'] == 'SELL' else -ltp * abs_qty

        vix_val = float(vix_map.get(ts, 0) or 0)

        # Emit time as ISO UTC so the frontend fmtTime() converts it to local IST
        dt_utc = datetime.fromtimestamp(ts, tz=timezone.utc)
        history.append({
            'time':       dt_utc.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'netPremium': round(net_premium, 2),
            'vix':        round(vix_val, 2),
        })

    print(json.dumps({'history': history}))


if __name__ == '__main__':
    main()
