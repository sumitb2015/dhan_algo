"""
Futures API backend for the Futures Monitor trading terminal.

Usage:
    python futures_api.py lookup --underlying NIFTY [--expiry 2026-09-29]
    python futures_api.py lookup --underlying HDFCBANK [--expiry 2026-09-29]
    python futures_api.py order --underlying NIFTY --side BUY --lots 1 --type MARKET --product INTRADAY
    python futures_api.py order --underlying HDFCBANK --side SELL --lots 2 --type LIMIT --price 710.5 --product MARGIN

Prints a single JSON line to stdout. Logs go to stderr.
"""
import sys
import os
import json
import argparse
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

INDEX_SYMBOLS = {'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'}


def resolve_instrument_and_exchange(underlying: str):
    under = underlying.upper()
    if under in ('CRUDEOIL', 'CRUDEOILM'):
        return 'MCX', 'FUTCOM', 'MCX_COMM'
    if under in ('SENSEX', 'BANKEX'):
        return 'BSE', 'FUTIDX', 'BSE_FNO'
    if under in INDEX_SYMBOLS:
        return 'NSE', 'FUTIDX', 'NSE_FNO'
    return 'NSE', 'FUTSTK', 'NSE_FNO'


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd')

    # lookup subcommand
    p_lkp = sub.add_parser('lookup')
    p_lkp.add_argument('--underlying', required=True)
    p_lkp.add_argument('--expiry', default=None)

    # order subcommand
    p_ord = sub.add_parser('order')
    p_ord.add_argument('--underlying', required=True)
    p_ord.add_argument('--expiry', default=None)
    p_ord.add_argument('--side', required=True)
    p_ord.add_argument('--lots', type=int, default=1)
    p_ord.add_argument('--type', default='MARKET')
    p_ord.add_argument('--price', type=float, default=0.0)
    p_ord.add_argument('--product', default='INTRADAY')

    args = parser.parse_args()

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'success': False, 'error': 'auth_failed — run login.py to refresh the access token'}))
        sys.exit(0)

    helper = DhanHelper(dhan)
    under = args.underlying.strip().upper()
    exchange, instrument, default_seg = resolve_instrument_and_exchange(under)

    if args.cmd == 'lookup':
        sec = helper.find_future(under, expiry=args.expiry, exchange=exchange, instrument=instrument)
        if not sec:
            print(json.dumps({'success': False, 'error': f'Futures contract not found for {under}'}))
            sys.exit(0)

        sec_id = int(float(sec['SECURITY_ID']))
        lot_size = int(float(sec.get('LOT_SIZE') or 0))
        if lot_size <= 0:
            lot_size = helper.get_lot_size(under) or 1

        seg = helper._auto_detect_segment(sec) or default_seg
        ltp = helper.get_ltp(sec_id, exchange=seg, instrument=instrument) or 0.0

        print(json.dumps({
            'success': True,
            'data': {
                'symbol': under,
                'securityId': str(sec_id),
                'displayName': str(sec.get('DISPLAY_NAME', sec.get('TRADING_SYMBOL', f'{under} FUT'))),
                'tradingSymbol': str(sec.get('TRADING_SYMBOL', '')),
                'expiry': str(sec.get('SM_EXPIRY_DATE', '')),
                'lotSize': lot_size,
                'exchange': exchange,
                'instrument': instrument,
                'exchangeSegment': seg,
                'ltp': float(ltp),
                'tickSize': float(sec.get('TICK_SIZE', 0.05) or 0.05),
            }
        }))

    elif args.cmd == 'order':
        sec = helper.find_future(under, expiry=args.expiry, exchange=exchange, instrument=instrument)
        if not sec:
            print(json.dumps({'success': False, 'error': f'Futures contract not found for {under}'}))
            sys.exit(0)

        sec_id = int(float(sec['SECURITY_ID']))
        lot_size = int(float(sec.get('LOT_SIZE') or 0))
        if lot_size <= 0:
            lot_size = helper.get_lot_size(under) or 1

        lots = max(1, args.lots)
        qty = lots * lot_size
        seg = helper._auto_detect_segment(sec) or default_seg

        order_type = args.type.upper()
        if order_type not in ('MARKET', 'LIMIT'):
            order_type = 'MARKET'

        product = args.product.upper()
        if product not in ('INTRADAY', 'MARGIN', 'CNC'):
            product = 'INTRADAY'

        side = args.side.upper()
        if side not in ('BUY', 'SELL'):
            print(json.dumps({'success': False, 'error': f'Invalid order side: {side}'}))
            sys.exit(0)

        try:
            res = helper.dhan.place_order(
                security_id=str(sec_id),
                exchange_segment=seg,
                transaction_type=side,
                quantity=qty,
                order_type=order_type,
                product_type=product,
                price=args.price if order_type == 'LIMIT' else 0.0,
                trigger_price=0.0
            )
            if isinstance(res, dict) and res.get('status') == 'success':
                order_id = res.get('data', {}).get('orderId')
                print(json.dumps({
                    'success': True,
                    'orderId': str(order_id),
                    'securityId': str(sec_id),
                    'displayName': str(sec.get('DISPLAY_NAME', sec.get('TRADING_SYMBOL', f'{under} FUT'))),
                    'symbol': under,
                    'side': side,
                    'lots': lots,
                    'lotSize': lot_size,
                    'quantity': qty,
                    'orderType': order_type,
                    'productType': product,
                    'price': args.price if order_type == 'LIMIT' else 0.0
                }))
            else:
                remarks = res.get('remarks') if isinstance(res, dict) else str(res)
                error_detail = ''
                if isinstance(remarks, dict):
                    error_detail = remarks.get('error_message') or remarks.get('message') or str(remarks)
                elif remarks:
                    error_detail = str(remarks)
                else:
                    error_detail = 'Order rejected by broker'
                print(json.dumps({
                    'success': False,
                    'error': f'Broker: {error_detail}'
                }))
        except Exception as exc:
            print(json.dumps({'success': False, 'error': f'Exception placing order: {exc}'}))


if __name__ == '__main__':
    main()
