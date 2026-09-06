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
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

MASTER_LIST = os.path.join(ROOT, 'master_list.csv')

# Instruments per quote_data call, and the pause between calls (Dhan's quote
# bucket is ~1 req/s account-wide — see the dhan-polling-guards skill).
#
# CHUNK is empirical, not documented. Measured 2026-09-06 against a live
# account: 100 and 150 instruments in one NSE_EQ quote_data call both succeed;
# 200 comes back {'status': 'failure', 'data': ''} with error_code, error_type
# and error_message ALL None — a silent rejection that names no limit and looks
# identical to an auth or rate-limit failure. 100 keeps a wide margin under the
# observed boundary.
CHUNK = 100
REQUEST_GAP_S = 1.2


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
    all_sids = list(sid_map.values())

    out = {}
    errors = []
    # Dhan's quote endpoint caps a single request well below a Nifty 500 sweep,
    # so batch rather than sending the whole list — and pace the batches, since
    # the quote bucket is ~1 req/s account-wide. A <=CHUNK request is a single
    # unpaced call, so the Nifty 50 / Bank Nifty callers behave exactly as before.
    for start in range(0, len(all_sids), CHUNK):
        chunk = all_sids[start:start + CHUNK]
        if start:
            time.sleep(REQUEST_GAP_S)

        res = helper.dhan.quote_data(securities={"NSE_EQ": chunk})
        if not isinstance(res, dict) or res.get('status') != 'success':
            errors.append(f'quote_data failed: {str(res)[:200]}')
            continue

        raw = res.get('data', {})
        if isinstance(raw, dict) and 'data' in raw:
            raw = raw['data']
        segment_data = raw.get('NSE_EQ', raw) if isinstance(raw, dict) else {}
        if not isinstance(segment_data, dict):
            errors.append('unexpected quote_data shape')
            continue

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

    # Only a total failure is an error: a partial sweep still yields usable
    # breadth, and reporting {"error": ...} would throw all of it away.
    if not out:
        print(json.dumps({'error': errors[0] if errors else 'no quotes returned'}))
        return
    for err in errors:
        sys.stderr.write(f'[breadth_intraday_snapshot] partial failure: {err}\n')

    print(json.dumps(out))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
