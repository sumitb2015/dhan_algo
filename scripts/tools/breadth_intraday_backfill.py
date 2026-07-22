"""
One-off backfill for /api/breadth-intraday: reconstructs each symbol's
1-minute up/down direction from market open to now using historical 1-min
candles, for the stretch before the live snapshot poller started (e.g. the
dashboard tab wasn't open at 09:15).

Previous close is fetched once for all symbols via a single bulk quote_data
call (same approach as breadth_intraday_snapshot.py); each symbol's today's
1-min candles are then fetched individually via get_latest_candles.

Usage:
    venv\\Scripts\\python.exe scripts/tools/breadth_intraday_backfill.py SYM1 SYM2 ...

Prints one JSON line: {"SYM1": {"09:15": "up", "09:16": "down", ...}, ...}
Symbols that fail to resolve, or whose quote/candles can't be fetched, are
simply omitted — the caller merges whatever comes back.
On total failure: {"error": "..."}
Logs go to stderr.
"""
import sys
import os
import json
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

MASTER_LIST = os.path.join(ROOT, 'master_list.csv')
MARKET_OPEN = "09:15"

# Small gap between per-symbol historical calls — quote_data is 1 bulk call,
# but intraday_minute_data is one call per symbol; a burst of 60+ back-to-back
# risks a 429 the caller has no time budget to recover gracefully from.
CALL_GAP_SEC = 0.25


def build_security_id_map(symbols):
    import pandas as pd
    df = pd.read_csv(MASTER_LIST, low_memory=False)
    df.columns = [c.strip() for c in df.columns]

    eq = df[
        (df["EXCH_ID"] == "NSE") &
        (df["INSTRUMENT"] == "EQUITY") &
        (df["SERIES"] == "EQ")
    ][["UNDERLYING_SYMBOL", "SECURITY_ID"]].copy()

    eq["UNDERLYING_SYMBOL"] = eq["UNDERLYING_SYMBOL"].astype(str).str.strip()
    eq["SECURITY_ID"] = pd.to_numeric(eq["SECURITY_ID"], errors="coerce")
    eq = eq.dropna(subset=["SECURITY_ID"])
    mapping = dict(zip(eq["UNDERLYING_SYMBOL"], eq["SECURITY_ID"].astype(int)))

    result = {}
    for sym in symbols:
        sid = mapping.get(sym)
        if sid:
            result[sym] = int(sid)
        else:
            sys.stderr.write(f"[breadth_intraday_backfill] SKIP {sym}: not found in master list\n")
    return result


def fetch_prev_closes(helper, sid_map):
    """One bulk quote_data call → {symbol: prevClose}."""
    sid_to_symbol = {v: k for k, v in sid_map.items()}
    res = helper.dhan.quote_data(securities={"NSE_EQ": list(sid_map.values())})
    if not isinstance(res, dict) or res.get('status') != 'success':
        sys.stderr.write(f"[breadth_intraday_backfill] quote_data failed: {res}\n")
        return {}

    raw = res.get('data', {})
    if isinstance(raw, dict) and 'data' in raw:
        raw = raw['data']
    segment_data = raw.get('NSE_EQ', raw) if isinstance(raw, dict) else {}
    if not isinstance(segment_data, dict):
        return {}

    out = {}
    for sid_str, ticker in segment_data.items():
        if not isinstance(ticker, dict):
            continue
        try:
            sid = int(sid_str)
        except ValueError:
            continue
        sym = sid_to_symbol.get(sid)
        if not sym:
            continue
        ohlc = ticker.get('ohlc', {}) or {}
        prev_close = float(ticker.get('close', 0) or ohlc.get('close', 0) or 0)
        if prev_close > 0:
            out[sym] = prev_close
    return out


def main():
    symbols = [s.upper().strip() for s in sys.argv[1:] if s.strip()]
    if not symbols:
        print(json.dumps({'error': 'no symbols provided'}))
        return

    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'error': 'auth_failed — run login.py to refresh the access token'}))
        return
    helper = DhanHelper(dhan)

    sid_map = build_security_id_map(symbols)
    if not sid_map:
        print(json.dumps({'error': 'no security ids resolved'}))
        return

    prev_closes = fetch_prev_closes(helper, sid_map)

    out = {}
    for i, sym in enumerate(sid_map.keys()):
        prev_close = prev_closes.get(sym)
        if not prev_close:
            continue
        try:
            df = helper.get_latest_candles(sym, interval="1", days=1)
        except Exception as e:
            sys.stderr.write(f"[breadth_intraday_backfill] {sym}: {e}\n")
            df = None

        if df is not None and not df.empty and 'Close' in df.columns:
            today = df.index[-1].date()
            today_df = df[df.index.date == today]
            per_minute = {}
            for ts, row in today_df.iterrows():
                hm = ts.strftime('%H:%M')
                if hm < MARKET_OPEN:
                    continue
                close = float(row['Close'])
                if close > prev_close:
                    per_minute[hm] = 'up'
                elif close < prev_close:
                    per_minute[hm] = 'down'
                else:
                    per_minute[hm] = 'flat'
            if per_minute:
                out[sym] = per_minute

        if (i + 1) % 10 == 0:
            sys.stderr.write(f"[breadth_intraday_backfill] {i+1}/{len(sid_map)}\n")
        time.sleep(CALL_GAP_SEC)

    print(json.dumps(out))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
