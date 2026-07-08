"""
Fetch today's 1-min intraday candles for NIFTY, BANKNIFTY, and CRUDEOILM and
print normalized (% change from each instrument's own session-open) series
as a single JSON line to stdout.

Usage:
    venv\\Scripts\\python.exe scripts/tools/normalized_1min_candles.py

Logs go to stderr; only the JSON result goes to stdout.
"""
import sys
import os
import json
from datetime import date, timedelta, datetime, timezone

_IST = timezone(timedelta(hours=5, minutes=30))

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

INSTRUMENTS = {
    'NIFTY':     'index',
    'BANKNIFTY': 'index',
    'CRUDEOILM': 'future',
}

LOOKBACK_DAYS = 5
INTERVAL = '1'


def _resolve(helper, symbol: str, kind: str):
    """Resolve a symbol to {security_id, exchange_segment, instrument_type}, or None."""
    if kind == 'index':
        sec = helper.find_index(symbol, exchange='IDX_I')
        if not sec:
            return None
        return {
            'security_id': str(int(sec['SECURITY_ID'])),
            'exchange_segment': 'IDX_I',
            'instrument_type': 'INDEX',
        }
    sec = helper.find_future(symbol, exchange='MCX', instrument='FUTCOM')
    if not sec:
        return None
    return {
        'security_id': str(int(sec['SECURITY_ID'])),
        'exchange_segment': 'MCX_COMM',
        'instrument_type': 'FUTCOM',
    }


def _to_hhmm(raw) -> str:
    """Convert a Dhan timestamp (unix seconds, unix ms, or ISO string) to HH:MM IST."""
    try:
        val = float(str(raw).strip())
        if val > 1_500_000_000_000:  # milliseconds
            val /= 1000
        dt = datetime.fromtimestamp(val, tz=_IST)
        return dt.strftime('%H:%M')
    except (ValueError, TypeError, OSError):
        pass
    s = str(raw).replace('T', ' ')
    return s[11:16] if len(s) > 10 else s


def _pick_col(df, candidates):
    for c in candidates:
        if c in df.columns:
            return c
    return None


def _filter_last_day(df):
    """Given a multi-day DataFrame, return (filtered_df, date_str) for the most recent day."""
    import pandas as pd

    if df.empty:
        return df, None

    tc = _pick_col(df, ('start_Time', 'timestamp', 'time', 'date')) or df.columns[0]
    col = df[tc]

    if col.dtype in ('int64', 'float64'):
        dates = pd.to_datetime(col, unit='s').dt.date
    else:
        dates = pd.to_datetime(col, errors='coerce').dt.date

    last_day = dates.max()
    mask = dates == last_day
    return df[mask].copy(), str(last_day)


def _fetch_symbol_candles(helper, symbol: str, kind: str):
    """Returns (filtered_df, data_date, error_message). Exactly one of (df, error) is set."""
    resolved = _resolve(helper, symbol, kind)
    if not resolved:
        return None, None, f'Could not resolve {symbol}'

    today = date.today()
    from_date = (today - timedelta(days=LOOKBACK_DAYS)).strftime('%Y-%m-%d')
    to_date = today.strftime('%Y-%m-%d')

    df = helper.get_intraday_minute_data(
        security_id=resolved['security_id'],
        exchange_segment=resolved['exchange_segment'],
        instrument_type=resolved['instrument_type'],
        interval=INTERVAL,
        from_date=from_date,
        to_date=to_date,
    )
    if df.empty:
        return None, None, f'No intraday data for {symbol} in last {LOOKBACK_DAYS} days'

    filtered, data_date = _filter_last_day(df)
    if filtered.empty:
        return None, None, f'No candles found for {symbol} on last trading day'
    return filtered, data_date, None


def _extract_rows(df):
    """DataFrame -> list of {"time","open","close"} sorted ascending by time."""
    ts = _pick_col(df, ('start_Time', 'timestamp', 'time', 'date'))
    oc = _pick_col(df, ('open', 'Open', 'o'))
    cc = _pick_col(df, ('close', 'Close', 'c'))
    if ts is None or oc is None or cc is None:
        return []
    rows = [
        {'time': _to_hhmm(row[ts]), 'open': float(row[oc]), 'close': float(row[cc])}
        for _, row in df.iterrows()
    ]
    rows.sort(key=lambda r: r['time'])
    return rows


def _normalize_series(rows, baseline=None):
    """
    rows: list of {"time","open","close"} sorted ascending by time.
    baseline: if provided, this value is used to compute percentage change.
              Otherwise, the FIRST row's open is used as the baseline.
    Returns list of {"time","close","pct"} where pct is % change of close
    vs the baseline.
    A zero/missing baseline/open degrades to flat 0.0% rather than raising.
    """
    if not rows:
        return []
    base = baseline if baseline is not None else rows[0]['open']
    if not base:
        return [{'time': r['time'], 'close': round(r['close'], 4), 'pct': 0.0} for r in rows]
    out = []
    for r in rows:
        pct = (r['close'] - base) / base * 100
        out.append({'time': r['time'], 'close': round(r['close'], 4), 'pct': round(pct, 4)})
    return out


def _get_prev_close(helper, symbol, kind, data_date):
    """
    Robustly fetch the previous trading day's close price strictly prior to data_date.
    Converts daily history timestamps to Asia/Kolkata timezone to determine correct trading dates.
    """
    resolved = _resolve(helper, symbol, kind)
    if not resolved:
        return None

    from datetime import datetime, timedelta
    try:
        dt = datetime.strptime(data_date, "%Y-%m-%d").date()
    except ValueError:
        return None

    from_date = (dt - timedelta(days=10)).strftime("%Y-%m-%d")
    to_date = data_date

    df = helper.get_historical_data(
        security_id=resolved['security_id'],
        exchange_segment=resolved['exchange_segment'],
        instrument_type=resolved['instrument_type'],
        from_date=from_date,
        to_date=to_date,
        interval="DAILY"
    )
    if df.empty:
        return None

    col_map = {}
    for col in df.columns:
        col_lower = col.lower()
        if col_lower in ("close", "c"): col_map[col] = "close"
        elif col_lower in ("timestamp", "time", "date"): col_map[col] = "timestamp"
    df = df.rename(columns=col_map)

    if "close" not in df.columns or "timestamp" not in df.columns:
        return None

    import pandas as pd
    # Convert timestamps to Asia/Kolkata timezone date strings
    df['date_str'] = pd.to_datetime(df['timestamp'], unit='s', utc=True).dt.tz_convert('Asia/Kolkata').dt.strftime('%Y-%m-%d')

    prior = df[df['date_str'] < data_date]
    if prior.empty:
        return None

    prior = prior.sort_values('date_str')
    prev_candle = prior.iloc[-1]
    return float(prev_candle['close'])


def main():
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'success': False, 'error': 'auth_failed — run login.py to refresh the access token'}))
        return

    helper = DhanHelper(dhan)

    series = {}
    errors = {}
    data_date = None
    is_today_flag = False
    today = date.today().strftime('%Y-%m-%d')

    for symbol, kind in INSTRUMENTS.items():
        try:
            df, sym_date, err = _fetch_symbol_candles(helper, symbol, kind)
            if err:
                errors[symbol] = err
                continue
            rows = _extract_rows(df)

            # Fetch previous day close (PDC) for NIFTY and BANKNIFTY
            baseline = None
            if symbol in ('NIFTY', 'BANKNIFTY') and sym_date:
                try:
                    prev_close = _get_prev_close(helper, symbol, kind, sym_date)
                    if prev_close:
                        baseline = prev_close
                        sys.stderr.write(f"[normalized_1min_candles] {symbol} baseline: {baseline} (robust prev close prior to {sym_date})\n")
                    else:
                        sys.stderr.write(f"[normalized_1min_candles] Warning: Could not get robust prev close for {symbol}, using session open.\n")
                except Exception as ex:
                    sys.stderr.write(f"[normalized_1min_candles] Error calculating robust prev close for {symbol}: {ex}, using session open.\n")

            series[symbol] = _normalize_series(rows, baseline)
            if data_date is None:
                data_date = sym_date
                is_today_flag = sym_date == today
        except Exception as exc:
            errors[symbol] = f'Unexpected error: {exc}'

    if not series:
        print(json.dumps({'success': False, 'error': 'Could not fetch candles for any instrument', 'errors': errors}))
        return

    result = {
        'success': True,
        'data_date': data_date,
        'is_today': is_today_flag,
        'series': series,
    }
    if errors:
        result['errors'] = errors
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'success': False, 'error': str(exc)}))
