"""
One-off helper for the Next.js API to compute a multi-leg options margin summary
(overall margin, final/portfolio margin, hedge benefit) plus available funds.

Thin CLI wrapper over DhanHelper.resolve_option_legs_to_margin_scripts() +
get_multi_leg_margin_summary() — the reusable margin library lives there, so
Python strategies can call it directly without going through this script.

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

    scripts = helper.resolve_option_legs_to_margin_scripts(legs, args.underlying.upper(), args.expiry)

    # Standalone what-if calculation (matches Dhan's own Strategy Builder) — must NOT
    # fold in the account's actual open positions/pending orders, or totalMargin from
    # /margincalculator/multi reflects whole-portfolio impact instead of just this
    # combo, which can exceed the sum of independent leg margins (impossible after
    # netting) and zero out the derived hedge_benefit.
    summary = helper.get_multi_leg_margin_summary(
        scripts, include_position=False, include_orders=False, include_available_funds=True)
    if not summary:
        print(json.dumps({'error': 'margin_calculator_failed'}))
        sys.exit(0)

    # Route/UI still consume the legacy `total_margin` key for the final
    # (portfolio-netted) figure; keep it alongside the library's `final_margin`.
    print(json.dumps({
        'total_margin': summary['final_margin'],
        'span_margin': summary['span_margin'],
        'exposure_margin': summary['exposure_margin'],
        'hedge_benefit': summary['hedge_benefit'],
        'overall_margin': summary['overall_margin'],
        'available_funds': summary['available_funds'],
    }))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(0)
