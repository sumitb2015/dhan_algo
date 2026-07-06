"""
One-off helper for the Next.js API to compute combined multi-leg margin via Dhan's
margin-calculator/multi endpoint, plus available account funds.

Usage:
    python options_margin.py --underlying NIFTY --expiry 2026-07-30 --legs-json '<json>'

--legs-json is a JSON array: [{"strike":25000,"type":"CE","side":"SELL","qtyLots":1,"price":150.0}, ...]

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


def build_margin_scripts(legs: list, underlying: str, expiry: str, helper: 'DhanHelper') -> list:
    """Resolve each leg to a Dhan margincalculator/multi 'scripts' entry.

    Raises ValueError with a descriptive message if any leg's contract can't be resolved
    via the master instrument list (find_option) — callers should catch this and surface
    it as {"error": str(exc)}.
    """
    scripts = []
    for leg in legs:
        strike = float(leg['strike'])
        option_type = leg['type'].upper()
        side = leg['side'].upper()
        qty_lots = int(leg['qtyLots'])
        price = float(leg['price'])

        contract = helper.find_option(underlying, expiry, strike, option_type)
        if not contract:
            raise ValueError(f"strike not found: {strike} {option_type} @ {expiry}")

        lot_size = int(contract['LOT_SIZE'])
        scripts.append({
            'exchangeSegment': 'NSE_FNO',
            'transactionType': side,
            'quantity': qty_lots * lot_size,
            'productType': 'MARGIN',
            'securityId': str(contract['SECURITY_ID']),
            'price': price,
        })
    return scripts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--underlying', default='NIFTY')
    parser.add_argument('--expiry', required=True)
    parser.add_argument('--legs-json', required=True, dest='legs_json')
    args = parser.parse_args()

    legs = json.loads(args.legs_json)

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'error': 'auth_failed — run login.py to refresh the access token'}))
        sys.exit(0)

    helper = DhanHelper(dhan)

    scripts = build_margin_scripts(legs, args.underlying.upper(), args.expiry, helper)

    margin = helper.get_margin_calculator_multi(scripts, include_position=True, include_orders=True)
    if not margin:
        print(json.dumps({'error': 'margin_calculator_failed'}))
        sys.exit(0)

    available_funds = helper.get_available_funds()

    print(json.dumps({
        'total_margin': margin.get('total_margin', 0.0),
        'span_margin': margin.get('span_margin', 0.0),
        'exposure_margin': margin.get('exposure_margin', 0.0),
        'hedge_benefit': margin.get('hedge_benefit', 0.0),
        'available_funds': available_funds,
    }))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(0)
