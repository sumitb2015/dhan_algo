"""
Re-download master_list.csv from Dhan when it is stale (an earlier IST day, no live NIFTY future, or no MCX rows).
Read-only against the broker (instrument lists only, no orders). Prints one JSON line:
{"status": "fresh"|"refreshed"|"busy"|"failed", "reason"?: str, "rows"?: int}

    venv\\Scripts\\python.exe scripts/tools/refresh_master_list.py           # only if stale
    venv\\Scripts\\python.exe scripts/tools/refresh_master_list.py --force   # always

Spawned by the dashboard's scheduler (rs_dashboard/lib/masterListRefresh.ts). Rules in lib/master_list_refresh.py.
"""
import argparse
import json
import logging
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, ROOT)
os.chdir(ROOT)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument('--force', action='store_true', help='download even when the file looks current')
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format='%(asctime)s %(levelname)s %(message)s')

    from dhanhq import dhanhq, DhanContext
    from login import TOKEN_FILE, is_token_from_current_session
    from lib.dhan_helper import DhanHelper
    from lib.master_list_refresh import refresh_if_stale

    # Only an existing current-session token: a background job must never log in (get_dhan_client() would run the TOTP
    # autologin, which replaces the token every other process is using).
    try:
        with open(TOKEN_FILE, 'r') as f:
            tok = json.load(f)
    except (OSError, ValueError):
        tok = None
    if not tok or not is_token_from_current_session(tok) or not tok.get('accessToken'):
        print(json.dumps({'status': 'no-session', 'reason': 'no current Dhan session; run login.py'}))
        return 1
    client = dhanhq(DhanContext(os.getenv('client_id'), tok['accessToken']))

    # skip_session_validation: no holdings health-check, and DhanHelper's own auto-refresh stays off - this call is the one
    helper = DhanHelper(client, skip_session_validation=True)
    result = refresh_if_stale(helper, force=args.force)
    print(json.dumps(result))
    return 0 if result.get('status') in ('fresh', 'refreshed', 'busy') else 1


if __name__ == '__main__':
    sys.exit(main())
