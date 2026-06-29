"""
Calls exit_all_positions() on DhanHelper to atomically liquidate all open positions
via the broker's DELETE /positions endpoint. Outputs JSON to stdout.
Called by the Next.js /api/exit-all route.
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper


def main():
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"success": False, "error": "Failed to authenticate with Dhan"}))
        sys.exit(1)

    helper = DhanHelper(dhan)
    ok = helper.exit_all_positions()

    if ok:
        print(json.dumps({"success": True, "message": "All positions liquidated and pending orders cancelled"}))
    else:
        print(json.dumps({"success": False, "error": "exit_all_positions returned False — check logs"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
