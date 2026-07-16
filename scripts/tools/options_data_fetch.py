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
import time
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
        under = args.underlying.upper()
        if under == 'CRUDEOIL':
            from scripts.tools.premarket_data import _find_nearest_future
            fut = _find_nearest_future(helper, "CRUDEOIL", exchange="MCX", instrument="FUTCOM")
            if not fut:
                print(json.dumps({'error': 'CRUDEOIL future contract not found'}))
                sys.exit(0)
            uid = int(fut["SECURITY_ID"])
            seg = 'MCX_COMM'
        else:
            uid = UNDERLYING_IDS.get(under)
            if not uid:
                print(json.dumps({'error': f'unknown underlying: {args.underlying}'}))
                sys.exit(0)
            seg = 'IDX_I'
        expiries = helper.get_expiry_list(
            under_security_id=uid,
            under_exchange_segment=seg,
        )
        print(json.dumps({'expiries': expiries}))

    elif args.cmd == 'chain':
        under = args.underlying.upper()
        is_crude = (under == 'CRUDEOIL')
        seg = 'MCX_COMM' if is_crude else 'IDX_I'

        # Resolve the underlying the SAME way the expiries/ltp branches do so the
        # chain never diverges from the expiry list after a contract rolls over.
        # For crude, that means the nearest non-expired FUTCOM contract; passing
        # its numeric security id makes get_option_chain trust it directly
        # (bypassing the un-filtered iloc[0] symbol lookup).
        chain_symbol = under
        fut_sid = None
        if is_crude:
            from scripts.tools.premarket_data import _find_nearest_future
            fut = _find_nearest_future(helper, "CRUDEOIL", exchange="MCX", instrument="FUTCOM")
            if not fut:
                print(json.dumps({'error': 'CRUDEOIL future contract not found'}))
                sys.exit(0)
            fut_sid = int(fut["SECURITY_ID"])
            chain_symbol = str(fut_sid)

        chain = helper.get_option_chain(
            symbol=chain_symbol,
            expiry=args.expiry,
            exchange_segment=seg,
        )
        if not chain:
            # Empty chain almost always means the Dhan option-chain API
            # rate limit (~1 call/3s per token) was hit — the helper's
            # in-process spacing can't protect across processes. One
            # spaced retry resolves the common transient case.
            time.sleep(3.5)
            chain = helper.get_option_chain(
                symbol=chain_symbol,
                expiry=args.expiry,
                exchange_segment=seg,
            )

        # For CRUDEOIL: always fetch a dedicated live OHLC quote for the
        # futures LTP — chain.last_price is a Dhan snapshot that can lag
        # the actual market price by several minutes.
        # For indices: chain.last_price is usually fresh enough; fall back
        # to a dedicated LTP call only when it is missing.
        spot = 0
        if is_crude and fut_sid is not None:
            ohlc_raw = helper.get_ohlc_data({"MCX_COMM": [fut_sid]})
            spot = ohlc_raw.get("MCX_COMM", {}).get(str(fut_sid), {}).get("last_price") or 0.0
            if not spot:
                # Final fallback: dedicated LTP call
                spot = helper.get_ltp(fut_sid, exchange="MCX", instrument="FUTCOM") or 0.0
        else:
            # Index: prefer chain snapshot, fall back to dedicated LTP
            spot = (chain or {}).get('last_price') or 0
            if not spot:
                spot = helper.get_ltp(under, exchange='IDX_I', instrument='INDEX') or 0
        print(json.dumps({'chain': chain, 'spot': spot}))

    elif args.cmd == 'ltp':
        under = args.underlying.upper()
        is_crude = (under == 'CRUDEOIL')
        if is_crude:
            from scripts.tools.premarket_data import _find_nearest_future
            fut = _find_nearest_future(helper, "CRUDEOIL", exchange="MCX", instrument="FUTCOM")
            if fut:
                sid = int(fut["SECURITY_ID"])
                ohlc_raw = helper.get_ohlc_data({"MCX_COMM": [sid]})
                entry = ohlc_raw.get("MCX_COMM", {}).get(str(sid), {})
                spot = entry.get("last_price") or 0.0
                prev_close = entry.get("ohlc", {}).get("close") or 0.0
            else:
                spot, prev_close = 0, 0.0
        else:
            spot = helper.get_ltp(under, exchange='IDX_I', instrument='INDEX') or 0
            levels = helper.get_prev_day_levels(under)
            prev_close = levels['close'] if levels else 0.0
        change = round(spot - prev_close, 2) if (spot > 0 and prev_close > 0) else 0.0
        change_pct = round(change / prev_close * 100, 4) if prev_close > 0 else 0.0
        print(json.dumps({
            'spot': spot,
            'prev_close': prev_close,
            'change': change,
            'change_pct': change_pct
        }))

    else:
        print(json.dumps({'error': 'unknown command'}))
        sys.exit(0)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(0)
