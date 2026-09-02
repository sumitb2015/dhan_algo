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
    'CRUDEOIL':  'MCX',
    'CRUDEOILM': 'MCX',
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

    # lotsize subcommand — helper-resolved lot sizes for one or more underlyings
    p_lot = sub.add_parser('lotsize')
    p_lot.add_argument('--symbols', required=True, help='Comma-separated underlyings, e.g. NIFTY,BANKNIFTY')

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
        under = args.underlying.upper()
        exchange = UNDERLYING_EXCHANGE.get(under, 'NSE')
        is_crude = under in ('CRUDEOIL', 'CRUDEOILM')
        df = helper._load_master_list()
        inst_filter = ['OPTFUT', 'OPTCOM'] if is_crude else ['OPTIDX', 'OPTSTK']
        mask = (
            (df['EXCH_ID'] == exchange) &
            (df['INSTRUMENT'].isin(inst_filter)) &
            (df['UNDERLYING_SYMBOL'] == under) &
            (df['SM_EXPIRY_DATE'] == args.expiry)
        )
        rows = df[mask][['STRIKE_PRICE', 'OPTION_TYPE', 'SECURITY_ID']].copy()
        if rows.empty:
            print(json.dumps({'success': False, 'error': f'No options found for {args.underlying} {args.expiry}'}))
            sys.exit(0)

        # Lot size comes from the helper, never from a literal. Exchange lot sizes
        # get revised (NIFTY has been 75 and is 65 today), so a hardcoded fallback
        # does not degrade gracefully — it silently mis-sizes every order placed
        # from the terminal. If it cannot be resolved, say so and let the UI
        # refuse to size rather than guess.
        # MCX contracts report LOT_SIZE=1 because Dhan order quantity is expressed in lots.
        if is_crude:
            lot_size = 1
        else:
            lot_size = helper.get_lot_size(under)
            if not lot_size or lot_size <= 1:
                print(json.dumps({
                    'success': False,
                    'error': f'Could not resolve lot size for {args.underlying} (got {lot_size!r})',
                }))
                sys.exit(0)

        strikes: dict = {}
        for _, row in rows.iterrows():
            strike = int(float(row['STRIKE_PRICE']))
            opt = str(row['OPTION_TYPE']).upper()
            sec_id = str(int(float(row['SECURITY_ID'])))
            if strike not in strikes:
                strikes[strike] = {}
            if opt == 'CE':
                strikes[strike]['ceId'] = sec_id
            elif opt == 'PE':
                strikes[strike]['peId'] = sec_id

        print(json.dumps({'success': True, 'data': {'lotSize': int(lot_size), 'strikes': strikes}}))

    elif args.cmd == 'lotsize':
        # Single authority for lot sizes across the dashboard. Exchange lot sizes
        # are revised periodically (NIFTY has been 75, is 65 today), so callers
        # get null for anything unresolved rather than a literal that would be
        # wrong the moment a revision lands.
        # get_lot_size() returns 1 both for "no derivative contract found" and,
        # legitimately, for Dhan's MCX contracts (its master reports LOT_SIZE=1
        # because MCX order quantity is expressed in lots). The return value
        # alone cannot tell those apart, so confirm the underlying actually has
        # derivative contracts before trusting any size it reports.
        DERIVATIVES = ['OPTIDX', 'FUTIDX', 'OPTSTK', 'FUTSTK', 'OPTFUT', 'OPTCOM', 'FUTCOM']
        master = helper._load_master_list()

        out: dict = {}
        for raw in args.symbols.split(','):
            sym = raw.strip().upper()
            if not sym:
                continue
            contracts = master[
                (master['UNDERLYING_SYMBOL'] == sym) & (master['INSTRUMENT'].isin(DERIVATIVES))
            ]
            if contracts.empty:
                out[sym] = None
                continue

            try:
                size = helper.get_lot_size(sym)
            except Exception as exc:  # noqa: BLE001 - report, never guess
                print(f'get_lot_size({sym}) failed: {exc}', file=sys.stderr)
                size = None

            # get_lot_size resolves an INDEX to its derivative lot, but a STOCK
            # underlying resolves to the EQUITY row, whose LOT_SIZE is the
            # documented placeholder of 1 (RELIANCE: 1, while its F&O lot is
            # 500). Callers of this subcommand always want the derivative lot,
            # so consult the same contract table get_lot_size uses for indices.
            # MCX is unaffected: its contracts genuinely report 1.
            if not size or size <= 1:
                try:
                    contract_lot = int(contracts.iloc[0]['LOT_SIZE'])
                    if contract_lot > 0:
                        size = contract_lot
                except (TypeError, ValueError, KeyError):
                    pass

            out[sym] = int(size) if size and size > 0 else None
        print(json.dumps({'success': True, 'data': out}))

    elif args.cmd == 'order':
        under = args.underlying.upper()
        exchange = UNDERLYING_EXCHANGE.get(under, 'NSE')
        is_crude = under in ('CRUDEOIL', 'CRUDEOILM')

        # Find the option — find_option() defaults to instrument='OPTIDX';
        # a stock underlying's contract is OPTSTK, commodity is OPTFUT.
        inst = 'OPTFUT' if is_crude else 'OPTIDX'
        sec = helper.find_option(args.underlying, args.expiry, args.strike, args.option, exchange=exchange, instrument=inst)
        if not sec and not is_crude:
            sec = helper.find_option(args.underlying, args.expiry, args.strike, args.option, exchange=exchange, instrument='OPTSTK')
        if not sec:
            print(json.dumps({
                'success': False,
                'error': f'Option not found: {args.underlying} {args.expiry} {args.strike} {args.option}'
            }))
            sys.exit(0)

        # Calculate quantity. The contract's own LOT_SIZE is the most specific
        # source; fall back to the helper for the underlying rather than to a
        # literal, and refuse the order outright if neither resolves — sizing an
        # order off a guessed lot size spends real money at the wrong size.
        lot_size = 0
        try:
            lot_size = int(float(sec.get('LOT_SIZE') or 0))
        except (TypeError, ValueError):
            lot_size = 0
        if lot_size <= 0:
            lot_size = 1 if is_crude else (helper.get_lot_size(under) or 0)
        if lot_size <= 0:
            print(json.dumps({
                'success': False,
                'error': f'Could not resolve lot size for {args.underlying} {args.strike} {args.option}',
            }))
            sys.exit(0)
        qty = args.lots * lot_size

        if is_crude:
            seg = 'MCX_COMM'
        elif exchange == 'BSE':
            seg = 'BSE_FNO'
        else:
            seg = 'NSE_FNO'

        # Place the order
        order_id = helper.place_order(
            security_id=str(int(sec['SECURITY_ID'])),
            exchange_segment=seg,
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
