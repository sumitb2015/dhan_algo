"""
One-off helper for the Next.js /api/breadth-intraday route: fetch current LTP
and previous close for a batch of NSE equity symbols via Dhan quote_data, and
report each symbol's direction vs previous close.

Usage:
    venv\\Scripts\\python.exe scripts/tools/breadth_intraday_snapshot.py SYM1 SYM2 ...

Prints a single JSON line to stdout: {"SYMBOL": {"ltp": .., "prevClose": .., "direction": "up"|"down"|"flat"}, ...}
On failure: {"error": "..."}
Logs go to stderr.
"""
import sys
import os
import json

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

MASTER_LIST = os.path.join(ROOT, 'master_list.csv')


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
            sys.stderr.write(f"[breadth_intraday_snapshot] SKIP {sym}: not found in master list\n")
    return result


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

    sid_to_symbol = {v: k for k, v in sid_map.items()}
    res = helper.dhan.quote_data(securities={"NSE_EQ": list(sid_map.values())})
    if not isinstance(res, dict) or res.get('status') != 'success':
        print(json.dumps({'error': f'quote_data failed: {res}'}))
        return

    raw = res.get('data', {})
    if isinstance(raw, dict) and 'data' in raw:
        raw = raw['data']
    segment_data = raw.get('NSE_EQ', raw) if isinstance(raw, dict) else {}
    if not isinstance(segment_data, dict):
        print(json.dumps({'error': 'unexpected quote_data shape'}))
        return

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

        ltp = float(ticker.get('last_price', 0) or 0)
        ohlc = ticker.get('ohlc', {}) or {}
        prev_close = float(ticker.get('close', 0) or ohlc.get('close', 0) or 0)
        if ltp <= 0 or prev_close <= 0:
            continue

        if ltp > prev_close:
            direction = 'up'
        elif ltp < prev_close:
            direction = 'down'
        else:
            direction = 'flat'

        out[sym] = {'ltp': ltp, 'prevClose': prev_close, 'direction': direction}

    print(json.dumps(out))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
