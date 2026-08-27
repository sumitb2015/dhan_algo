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

# Per-underlying instrument resolution, mirroring UNDERLYINGS in
# options_chart_fetch.py. Two things vary independently and are NOT
# interchangeable:
#   chain_id / chain_seg  - what the option-chain and expiry-list APIs key on
#   spot_id  / spot_seg   - the index's own security id, for LTP / prev close
#
# For the NSE indices the two happen to coincide. SENSEX is the exception, and
# getting it wrong fails silently: the chain keys on security id 1 / BSE_FNO,
# NOT the index's 51. Probe-verified against the live API on 2026-08-16 —
# (1, BSE_FNO) and (51, IDX_I) both return 170 strikes, while the previous
# mapping here (bare symbol "SENSEX", which resolves to 51 through the master
# list, + BSE_IDX) returns an EMPTY chain and an EMPTY expiry list. Beware when
# re-probing: DhanHelper.get_option_chain caches 5 s on (security_id, expiry),
# so a bad combination can appear to work off a prior call's cache entry.
UNDERLYINGS = {
    'NIFTY':     {'chain_id': 13, 'chain_seg': 'IDX_I',   'spot_id': 13, 'spot_seg': 'IDX_I'},
    'BANKNIFTY': {'chain_id': 25, 'chain_seg': 'IDX_I',   'spot_id': 25, 'spot_seg': 'IDX_I'},
    'FINNIFTY':  {'chain_id': 27, 'chain_seg': 'IDX_I',   'spot_id': 27, 'spot_seg': 'IDX_I'},
    # SENSEX index intraday is served under IDX_I — BSE_IDX returns DH-905.
    'SENSEX':    {'chain_id': 1,  'chain_seg': 'BSE_FNO', 'spot_id': 51, 'spot_seg': 'IDX_I'},
}


def _index_spot(helper, under: str) -> float:
    """LTP for one of the UNDERLYINGS indices.

    SENSEX needs the numeric security id: the bare symbol resolves through the
    BSE master list to exchange BSE_IDX, which the quote API answers with an
    empty payload (get_ltp then returns 0.0). Passing the id with exchange
    "NSE" routes it to IDX_I, where BSE index quotes actually live. The NSE
    indices are unaffected either way, so one path serves all of them.
    """
    meta = UNDERLYINGS[under]
    return helper.get_ltp(meta['spot_id'], exchange='NSE', instrument='INDEX') or 0


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

    # Resolve the nearest MCX futures contract to a security id, so a Node caller
    # can then quote it directly over Dhan's batch OHLC endpoint instead of paying
    # a Python spawn (~1.5s of master-list load) on every poll. The contract rolls
    # monthly, so callers should cache the answer per trading day, not forever.
    p_fut = sub.add_parser('futsid')
    p_fut.add_argument('--underlying', default='CRUDEOIL')

    args = parser.parse_args()

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'error': 'auth_failed — run login.py to refresh the access token'}))
        sys.exit(0)

    helper = DhanHelper(dhan)

    if args.cmd == 'expiries':
        under = args.underlying.upper()
        if under in ('CRUDEOIL', 'CRUDEOILM'):
            from scripts.tools.premarket_data import _find_nearest_future
            fut = _find_nearest_future(helper, under, exchange="MCX", instrument="FUTCOM")
            if not fut:
                print(json.dumps({'error': f'{under} future contract not found'}))
                sys.exit(0)
            uid = int(fut["SECURITY_ID"])
            seg = 'MCX_COMM'
        elif under in UNDERLYINGS:
            uid = UNDERLYINGS[under]['chain_id']
            seg = UNDERLYINGS[under]['chain_seg']
        else:
            # Not a known index — treat as an equity F&O underlying (e.g. a
            # Nifty 50 stock). get_expiry_list needs the raw security id +
            # segment (no auto-resolve like get_option_chain has).
            eq = helper.find_equity(under)
            if not eq:
                print(json.dumps({'error': f'unknown underlying: {args.underlying}'}))
                sys.exit(0)
            uid = int(eq['SECURITY_ID'])
            seg = 'NSE_EQ'
        expiries = helper.get_expiry_list(
            under_security_id=uid,
            under_exchange_segment=seg,
        )
        print(json.dumps({'expiries': expiries}))

    elif args.cmd == 'chain':
        under = args.underlying.upper()
        is_crude = under in ('CRUDEOIL', 'CRUDEOILM')
        is_index = under in UNDERLYINGS
        # Leave seg=None for equity underlyings — get_option_chain() auto-resolves
        # the symbol and its segment (NSE_EQ -> NSE_FNO) via the master list.
        seg = 'MCX_COMM' if is_crude else (UNDERLYINGS[under]['chain_seg'] if is_index else None)

        # Resolve the underlying the SAME way the expiries/ltp branches do so the
        # chain never diverges from the expiry list after a contract rolls over.
        # For crude, that means the nearest non-expired FUTCOM contract; passing
        # its numeric security id makes get_option_chain trust it directly
        # (bypassing the un-filtered iloc[0] symbol lookup).
        # For indices, pass the numeric chain id rather than the bare symbol so
        # get_option_chain trusts it directly instead of resolving through the
        # master list — "SENSEX" resolves to the index id 51, whose chain is empty.
        chain_symbol = str(UNDERLYINGS[under]['chain_id']) if is_index else under
        fut_sid = None
        if is_crude:
            from scripts.tools.premarket_data import _find_nearest_future
            fut = _find_nearest_future(helper, under, exchange="MCX", instrument="FUTCOM")
            if not fut:
                print(json.dumps({'error': f'{under} future contract not found'}))
                sys.exit(0)
            fut_sid = int(fut["SECURITY_ID"])
            chain_symbol = str(fut_sid)

        # Empty chain almost always means the Dhan option-chain API rate
        # limit (~1 call/3s per token) was hit — the helper's in-process
        # spacing can't protect across processes. Retry a few times with
        # growing backoff before giving up and reporting empty.
        chain = None
        for backoff in (0, 3.5, 5.0):
            if backoff:
                time.sleep(backoff)
            chain = helper.get_option_chain(
                symbol=chain_symbol,
                expiry=args.expiry,
                exchange_segment=seg,
            )
            if chain:
                break

        # For CRUDEOIL: always fetch a dedicated live OHLC quote for the
        # futures LTP — chain.last_price is a Dhan snapshot that can lag
        # the actual market price by several minutes. Also carries
        # prev_close/change/change_pct so the dashboard doesn't need a
        # second concurrent spawn (options/spot) just to show those.
        # For indices: chain.last_price is usually fresh enough; fall back
        # to a dedicated LTP call only when it is missing.
        spot = 0
        prev_close = 0.0
        if is_crude and fut_sid is not None:
            ohlc_raw = helper.get_ohlc_data({"MCX_COMM": [fut_sid]})
            entry = ohlc_raw.get("MCX_COMM", {}).get(str(fut_sid), {})
            spot = entry.get("last_price") or 0.0
            prev_close = entry.get("ohlc", {}).get("close") or 0.0
            if not spot:
                # Final fallback: dedicated LTP call
                spot = helper.get_ltp(fut_sid, exchange="MCX", instrument="FUTCOM") or 0.0
        else:
            # Index/equity: prefer chain snapshot, fall back to dedicated LTP
            spot = (chain or {}).get('last_price') or 0
            if not spot:
                if is_index:
                    spot = _index_spot(helper, under)
                else:
                    spot = helper.get_ltp(under, exchange='NSE', instrument='EQUITY') or 0
            levels = helper.get_prev_day_levels(under)
            prev_close = levels['close'] if levels else 0.0
        change = round(spot - prev_close, 2) if (spot > 0 and prev_close > 0) else 0.0
        change_pct = round(change / prev_close * 100, 4) if prev_close > 0 else 0.0
        print(json.dumps({
            'chain': chain,
            'spot': spot,
            'prev_close': prev_close,
            'change': change,
            'change_pct': change_pct,
        }))

    elif args.cmd == 'ltp':
        under = args.underlying.upper()
        is_crude = under in ('CRUDEOIL', 'CRUDEOILM')
        if is_crude:
            from scripts.tools.premarket_data import _find_nearest_future
            fut = _find_nearest_future(helper, under, exchange="MCX", instrument="FUTCOM")
            if fut:
                sid = int(fut["SECURITY_ID"])
                ohlc_raw = helper.get_ohlc_data({"MCX_COMM": [sid]})
                entry = ohlc_raw.get("MCX_COMM", {}).get(str(sid), {})
                spot = entry.get("last_price") or 0.0
                prev_close = entry.get("ohlc", {}).get("close") or 0.0
            else:
                spot, prev_close = 0, 0.0
        elif under in UNDERLYINGS:
            spot = _index_spot(helper, under)
            levels = helper.get_prev_day_levels(under)
            prev_close = levels['close'] if levels else 0.0
        else:
            spot = helper.get_ltp(under, exchange='NSE', instrument='EQUITY') or 0
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

    elif args.cmd == 'futsid':
        from scripts.tools.premarket_data import _find_nearest_future
        under = args.underlying.upper()
        fut = _find_nearest_future(helper, under, exchange="MCX", instrument="FUTCOM")
        if not fut:
            print(json.dumps({'error': f'{under} future contract not found'}))
            sys.exit(0)
        print(json.dumps({
            'security_id': int(fut["SECURITY_ID"]),
            'symbol': str(fut.get("SEM_TRADING_SYMBOL") or fut.get("SYMBOL_NAME") or under),
            'expiry': str(fut.get("SM_EXPIRY_DATE") or fut.get("EXPIRY_DATE") or ''),
            'segment': 'MCX_COMM',
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
