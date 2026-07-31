"""
Runs Kotak Neo's TOTP + MPIN login and caches the resulting session.
Called by the Next.js /api/auth/autologin route.

Usage: python scripts/tools/kotak_autologin.py [--force]
Output: JSON on stdout — {"success": true, "ucc": "...", "expiryTime": "..."}
        or {"success": false, "error": "<message>"}

Without --force this reuses a still-valid persisted session rather than logging
in again. That is not just an optimisation: Kotak binds one session per
consumer-key/UCC, so a needless re-login can invalidate the session the
copy-trade bridge is currently holding.
"""
import sys
import os
import json
import argparse

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)
os.chdir(PROJECT_ROOT)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--force', action='store_true',
                        help='log in fresh even if a valid session exists')
    args = parser.parse_args()

    from lib.kotak import authentication

    if not args.force:
        existing = authentication.read_token_file()
        if authentication.token_is_valid(existing):
            print(json.dumps({
                'success': True,
                'reused': True,
                'ucc': existing.get('ucc'),
                'expiryTime': existing.get('expiryTime'),
            }))
            return

    try:
        # verbose=False keeps stdout to the single JSON line the route parses.
        authentication.kotak_login(verbose=False)
    except Exception as e:
        print(json.dumps({'success': False, 'error': str(e)}))
        sys.exit(0)

    data = authentication.read_token_file() or {}
    print(json.dumps({
        'success': True,
        'reused': False,
        'ucc': data.get('ucc'),
        'expiryTime': data.get('expiryTime'),
    }))


if __name__ == '__main__':
    main()
