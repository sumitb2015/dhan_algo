"""
CLI tool for P&L-based exit configuration via Dhan API.
Called by the Next.js /api/pnl-exit route.

Usage:
  python pnl_exit.py --action get
  python pnl_exit.py --action set --profit 5000 --loss 3000 --product-types INTRADAY --kill-switch false
  python pnl_exit.py --action delete
"""
import sys
import os
import json
import argparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper


def main():
    parser = argparse.ArgumentParser(description='P&L exit configuration tool')
    parser.add_argument('--action', required=True, choices=['get', 'set', 'delete'])
    parser.add_argument('--profit', type=float, default=0.0)
    parser.add_argument('--loss', type=float, default=0.0)
    parser.add_argument('--product-types', nargs='+', default=['INTRADAY'],
                        choices=['INTRADAY', 'DELIVERY'])
    parser.add_argument('--kill-switch', default='false', choices=['true', 'false'])
    args = parser.parse_args()

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"success": False, "error": "Failed to authenticate with Dhan"}))
        sys.exit(1)

    helper = DhanHelper(dhan)

    if args.action == 'get':
        data = helper.get_pnl_exit()
        if data is not None:
            print(json.dumps({"success": True, "data": data}))
        else:
            print(json.dumps({"success": False, "error": "Failed to retrieve P&L exit config"}))

    elif args.action == 'set':
        enable_ks = args.kill_switch.lower() == 'true'
        ok = helper.set_pnl_exit(
            profit_value=args.profit,
            loss_value=args.loss,
            product_types=args.product_types,
            enable_kill_switch=enable_ks,
        )
        if ok:
            print(json.dumps({"success": True}))
        else:
            print(json.dumps({"success": False, "error": "Failed to configure P&L exit"}))

    elif args.action == 'delete':
        ok = helper.delete_pnl_exit()
        if ok:
            print(json.dumps({"success": True}))
        else:
            print(json.dumps({"success": False, "error": "Failed to disable P&L exit"}))


if __name__ == '__main__':
    main()
