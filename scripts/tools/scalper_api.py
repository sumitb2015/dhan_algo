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

# Cash-market exchange each underlying's options trade on
UNDERLYING_EXCHANGE = {
    'NIFTY':     'NSE',
    'BANKNIFTY': 'NSE',
    'FINNIFTY':  'NSE',
    'SENSEX':    'BSE',
}


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

    # lookup subcommand — returns security IDs for all strikes of an expiry in one master-list load
    p_lkp = sub.add_parser('lookup')
    p_lkp.add_argument('--underlying', default='NIFTY')
    p_lkp.add_argument('--expiry', required=True)

    # positions subcommand
    p_pos = sub.add_parser('positions')

    # orders subcommand
    p_ord = sub.add_parser('orders')

    # trades subcommand
    p_trd = sub.add_parser('trades')

    # funds subcommand
    p_fund = sub.add_parser('funds')

    # all subcommand
    p_all = sub.add_parser('all')

    # poll subcommand
    p_poll = sub.add_parser('poll')

    args = parser.parse_args()

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'error': 'auth_failed — run login.py to refresh the access token'}))
        sys.exit(0)

    helper = DhanHelper(dhan)

    if args.cmd == 'lookup':
        exchange = UNDERLYING_EXCHANGE.get(args.underlying.upper(), 'NSE')
        df = helper._load_master_list()
        mask = (
            (df['EXCH_ID'] == exchange) &
            (df['INSTRUMENT'] == 'OPTIDX') &
            (df['UNDERLYING_SYMBOL'] == args.underlying.upper()) &
            (df['SM_EXPIRY_DATE'] == args.expiry)
        )
        rows = df[mask][['STRIKE_PRICE', 'OPTION_TYPE', 'SECURITY_ID', 'LOT_SIZE']].copy()
        if rows.empty:
            print(json.dumps({'success': False, 'error': f'No options found for {args.underlying} {args.expiry}'}))
            sys.exit(0)

        strikes: dict = {}
        lot_size = 75
        for _, row in rows.iterrows():
            strike = int(float(row['STRIKE_PRICE']))
            opt = str(row['OPTION_TYPE']).upper()
            sec_id = str(int(float(row['SECURITY_ID'])))
            lot_size = int(float(row['LOT_SIZE']) or 75)
            if strike not in strikes:
                strikes[strike] = {}
            if opt == 'CE':
                strikes[strike]['ceId'] = sec_id
            elif opt == 'PE':
                strikes[strike]['peId'] = sec_id

        print(json.dumps({'success': True, 'data': {'lotSize': lot_size, 'strikes': strikes}}))

    elif args.cmd == 'order':
        exchange = UNDERLYING_EXCHANGE.get(args.underlying.upper(), 'NSE')

        # Find the option
        sec = helper.find_option(args.underlying, args.expiry, args.strike, args.option, exchange=exchange)
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
            exchange_segment='BSE_FNO' if exchange == 'BSE' else 'NSE_FNO',
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

    elif args.cmd == 'funds':
        data = helper.get_fund_details()
        print(json.dumps({'success': True, 'data': data or {}}))

    elif args.cmd == 'all':
        # Positions
        positions = []
        df = helper.get_positions()
        if df is not None and not df.empty:
            df = df.where(pd.notnull(df), None)
            positions = df.to_dict('records')
            
        # Orders, Trades, Funds, P&L Guard
        orders = helper.get_order_list() or []
        trades = helper.get_trade_book() or []
        funds = helper.get_fund_details() or {}
        pnl_guard = helper.get_pnl_exit()
        
        print(json.dumps({
            'success': True,
            'positions': positions,
            'orders': orders,
            'trades': trades,
            'funds': funds,
            'pnl_guard': pnl_guard
        }))

    elif args.cmd == 'poll':
        # Positions
        positions = []
        df = helper.get_positions()
        if df is not None and not df.empty:
            df = df.where(pd.notnull(df), None)
            positions = df.to_dict('records')
            
        # Orders, Trades
        orders = helper.get_order_list() or []
        trades = helper.get_trade_book() or []
        
        print(json.dumps({
            'success': True,
            'positions': positions,
            'orders': orders,
            'trades': trades
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
