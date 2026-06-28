"""
One-off helper for the Next.js API to fetch options data via Python.

Usage:
    python options_data_fetch.py expiries --underlying NIFTY
    python options_data_fetch.py chain    --underlying NIFTY --expiry 2026-06-27
    python options_data_fetch.py ltp      --underlying NIFTY

Prints a single JSON line to stdout. Logs go to stderr.
"""
import sys
import os
import json
import argparse

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

UNDERLYING_IDS = {
    'NIFTY':     13,
    'BANKNIFTY': 25,
    'FINNIFTY':  27,
}


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd')

    p_exp = sub.add_parser('expiries')
    p_exp.add_argument('--underlying', default='NIFTY')

    p_chain = sub.add_parser('chain')
    p_chain.add_argument('--underlying', default='NIFTY')
    p_chain.add_argument('--expiry', required=True)

    p_ltp = sub.add_parser('ltp')
    p_ltp.add_argument('--underlying', default='NIFTY')

    args = parser.parse_args()

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'error': 'auth_failed — run login.py to refresh the access token'}))
        sys.exit(0)

    helper = DhanHelper(dhan)

    if args.cmd == 'expiries':
        uid = UNDERLYING_IDS.get(args.underlying.upper())
        if not uid:
            print(json.dumps({'error': f'unknown underlying: {args.underlying}'}))
            sys.exit(0)
        expiries = helper.get_expiry_list(
            under_security_id=uid,
            under_exchange_segment='IDX_I',
        )
        print(json.dumps({'expiries': expiries}))

    elif args.cmd == 'chain':
        chain = helper.get_option_chain(
            symbol=args.underlying.upper(),
            expiry=args.expiry,
            exchange_segment='IDX_I',
        )
        # Also get spot for ATM calculation
        spot = helper.get_ltp(args.underlying.upper(), exchange='IDX_I', instrument='INDEX') or 0
        print(json.dumps({'chain': chain, 'spot': spot}))

    elif args.cmd == 'ltp':
        spot = helper.get_ltp(args.underlying.upper(), exchange='IDX_I', instrument='INDEX') or 0
        print(json.dumps({'spot': spot}))

    else:
        print(json.dumps({'error': 'unknown command'}))
        sys.exit(0)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(0)
