#!/usr/bin/env python
"""
Resolve the nearest index-futures contract for the Focus Tool header strip.

    python scripts/tools/focus_tool_futs.py
    -> {"success": true, "data": {"NIFTY": {"security_id": 58072, "segment": "NSE_FNO",
                                            "expiry": "2026-08-25", "symbol": "NIFTY AUG FUT"}, ...}}

Prints a single JSON line to stdout; logs go to stderr. Always exits 0 — errors
come back in the payload, which is the convention every other Node-spawned
script here follows.

Why a separate resolve step: a futures security id is only valid until the
contract expires, so unlike an index id it cannot be hardcoded. Resolving costs
a ~2s master-list load, which is far too slow for a header that polls every few
seconds — so the API route resolves once per IST day and then quotes the ids
directly over Dhan's batched OHLC endpoint. Same split top-indices uses for
CRUDEOIL.

Uses premarket_data._find_nearest_future rather than DhanHelper.find_future:
find_future sorts by expiry but does NOT filter lapsed contracts, so it will
cheerfully return one that expired months ago.
"""

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from scripts.tools.premarket_data import _find_nearest_future

# SENSEX futures trade on BSE and settle into BSE_FNO; the NSE indices into
# NSE_FNO. Getting this pair wrong returns an empty quote rather than an error.
CONTRACTS = {
    'NIFTY':     {'exchange': 'NSE', 'segment': 'NSE_FNO'},
    'BANKNIFTY': {'exchange': 'NSE', 'segment': 'NSE_FNO'},
    'SENSEX':    {'exchange': 'BSE', 'segment': 'BSE_FNO'},
}


def main():
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'success': False, 'error': 'auth_failed — run login.py to refresh the access token'}))
        return 0

    helper = DhanHelper(dhan)
    data = {}
    errors = {}

    for underlying, meta in CONTRACTS.items():
        try:
            fut = _find_nearest_future(helper, underlying,
                                       exchange=meta['exchange'], instrument='FUTIDX')
        except Exception as e:
            errors[underlying] = str(e)
            continue
        if fut is None:
            errors[underlying] = 'no non-lapsed FUTIDX contract found'
            continue
        data[underlying] = {
            'security_id': int(fut['SECURITY_ID']),
            'segment': meta['segment'],
            'expiry': str(fut.get('SM_EXPIRY_DATE') or ''),
            'symbol': str(fut.get('TRADING_SYMBOL') or fut.get('DISPLAY_NAME') or f'{underlying} FUT').strip(),
        }

    # Partial success is still useful — the header shows whichever contracts
    # resolved and reports the rest rather than blanking the whole strip.
    print(json.dumps({'success': bool(data), 'data': data, 'errors': errors}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
