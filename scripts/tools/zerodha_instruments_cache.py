"""
Fetches and caches Zerodha NFO NIFTY option instruments for the scalper's
strike -> tradingsymbol lookup (Zerodha has no numeric securityId like Dhan).

Usage:
    venv\\Scripts\\python.exe scripts/tools/zerodha_instruments_cache.py

Writes debug/zerodha_nifty_instruments.json. Prints a single JSON status
line to stdout; logs go to stderr.
"""
import sys
import os
import json

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from kiteconnect import KiteConnect

OUTPUT_FILE = os.path.join(ROOT, 'debug', 'zerodha_nifty_instruments.json')


def restore_session_from_json():
    """Builds a KiteConnect session from zerodha_access_token.json — the file
    scripts/tools/zerodha_autologin.py writes (the dashboard's actual login
    path) — rather than the legacy access_token.txt used by
    lib.zerodha.authentication.restore_kite_session()."""
    token_file = os.path.join(ROOT, 'zerodha_access_token.json')
    if not os.path.exists(token_file):
        return None
    with open(token_file) as f:
        data = json.load(f)
    access_token = data.get('accessToken')
    if not access_token:
        return None

    api_key = None
    env_file = os.path.join(ROOT, '.env.zerodha')
    if os.path.exists(env_file):
        with open(env_file) as f:
            for line in f:
                if line.strip().startswith('ZERODHA_API_KEY'):
                    api_key = line.split('=', 1)[1].strip().strip('"')
                    break
    if not api_key:
        return None

    kite = KiteConnect(api_key=api_key)
    kite.set_access_token(access_token)
    return kite


def main():
    kite = restore_session_from_json()
    if kite is None:
        print(json.dumps({'success': False, 'error': 'No Zerodha session — run zerodha_autologin.py first'}))
        sys.exit(1)

    try:
        instruments = kite.instruments('NFO')
    except Exception as e:
        print(json.dumps({'success': False, 'error': f'instruments() failed: {e}'}))
        sys.exit(1)

    rows = []
    for inst in instruments:
        if inst.get('name') != 'NIFTY':
            continue
        if inst.get('instrument_type') not in ('CE', 'PE'):
            continue
        expiry = inst.get('expiry')
        rows.append({
            'tradingsymbol': inst['tradingsymbol'],
            'instrument_token': inst['instrument_token'],
            'strike': float(inst['strike']),
            'expiry': expiry.strftime('%Y-%m-%d') if hasattr(expiry, 'strftime') else str(expiry),
            'instrument_type': inst['instrument_type'],
            'lot_size': int(inst['lot_size']),
        })

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(rows, f)

    print(json.dumps({'success': True, 'count': len(rows)}))


if __name__ == '__main__':
    main()
