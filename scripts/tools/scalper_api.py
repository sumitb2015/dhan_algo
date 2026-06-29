"""
Scalper API backend for the NIFTY Scalper trading terminal.

Usage:
    python scalper_api.py order --underlying NIFTY --expiry 2026-06-27 --strike 26000 --option CE --side BUY --lots 1 --type MARKET
    python scalper_api.py positions
    python scalper_api.py orders
    python scalper_api.py trades

Prints a single JSON line to stdout. Logs go to stderr.
"""
import sys
import os
import json
import argparse
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd')

    # order subcommand
    p_order = sub.add_parser('order')
    p_order.add_argument('--underlying', default='NIFTY')
    p_order.add_argument('--expiry', required=True)
    p_order.add_argument('--strike', type=float, required=True)
    p_order.add_argument('--option', required=True)
    p_order.add_argument('--side', required=True)
    p_order.add_argument('--lots', type=int, default=1)
    p_order.add_argument('--type', default='MARKET')
    p_order.add_argument('--price', type=float, default=0.0)

    # positions subcommand
    p_pos = sub.add_parser('positions')

    # orders subcommand
    p_ord = sub.add_parser('orders')

    # trades subcommand
    p_trd = sub.add_parser('trades')

    args = parser.parse_args()

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'error': 'auth_failed — run login.py to refresh the access token'}))
        sys.exit(0)

    helper = DhanHelper(dhan)

    if args.cmd == 'order':
        # Find the option
        sec = helper.find_option(args.underlying, args.expiry, args.strike, args.option)
        if not sec:
            print(json.dumps({
                'success': False,
                'error': f'Option not found: {args.underlying} {args.expiry} {args.strike} {args.option}'
            }))
            sys.exit(0)

        # Calculate quantity
        qty = args.lots * int(sec.get('LOT_SIZE', 75))

        # Place the order
        order_id = helper.place_order(
            security_id=str(int(sec['SECURITY_ID'])),
            exchange_segment='NSE_FNO',
            transaction_type=args.side.upper(),
            quantity=qty,
            order_type=args.type.upper(),
            product_type='INTRADAY',
            price=args.price if args.type.upper() == 'LIMIT' else 0.0
        )

        if order_id:
            print(json.dumps({
                'success': True,
                'order_id': order_id,
                'symbol': str(sec.get('DISPLAY_NAME', sec.get('TRADING_SYMBOL', '')))
            }))
        else:
            print(json.dumps({
                'success': False,
                'error': 'Order placement failed — check logs'
            }))

    elif args.cmd == 'positions':
        df = helper.get_positions()
        if df is not None and not df.empty:
            df = df.where(pd.notnull(df), None)
            print(json.dumps({'success': True, 'data': df.to_dict('records')}))
        else:
            print(json.dumps({'success': True, 'data': []}))

    elif args.cmd == 'orders':
        data = helper.get_order_list()
        print(json.dumps({'success': True, 'data': data or []}))

    elif args.cmd == 'trades':
        data = helper.get_trade_book()
        print(json.dumps({'success': True, 'data': data or []}))

    else:
        print(json.dumps({'error': 'unknown command'}))
        sys.exit(0)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(0)
