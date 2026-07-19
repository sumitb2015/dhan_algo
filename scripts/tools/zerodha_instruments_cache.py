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

from lib.zerodha import authentication, config

OUTPUT_FILE = os.path.join(ROOT, 'debug', 'zerodha_nifty_instruments.json')


def main():
    kite, access_token = authentication.restore_kite_session()
    if kite is None:
        print(json.dumps({'success': False, 'error': 'No Zerodha session — run zerodha_autologin.py first'}))
        sys.exit(0)
    config.kite = kite

    try:
        instruments = kite.instruments('NFO')
    except Exception as e:
        print(json.dumps({'success': False, 'error': f'instruments() failed: {e}'}))
        sys.exit(0)

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
