"""Check Dhan's account-read endpoints (positions, order book, trade book, funds) with a token.

Read-only: every call is a GET. Prints one line per endpoint with the HTTP status and Dhan's error code, so a
"DH-905 on reads while orders work" day can be told apart from a token, header or IP problem in seconds.

    venv/bin/python scripts/testing/check_dhan_account_reads.py              # the saved token
    venv/bin/python scripts/testing/check_dhan_account_reads.py --new-token  # mint a fresh one first (TOTP)

--new-token: Dhan invalidates the previous token the moment a new one is issued (seen 2026-10-23: the old token
answered DH-906 on /profile within seconds). So the fresh token is saved to access_token.json straight away (via
login.py) — the dashboard re-reads that file; anything holding the old token in memory has to reconnect.
"""
import argparse
import json
import os
import sys

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

BASE = 'https://api.dhan.co/v2'
TOKEN_FILE = os.path.join(ROOT, 'access_token.json')
# Control first (should always work), then the account reads under test.
ENDPOINTS = ['/profile', '/positions', '/orders', '/trades', '/fundlimit', '/holdings', '/ip/getIP']


def load_token() -> tuple[str, str]:
    with open(TOKEN_FILE) as f:
        d = json.load(f)
    return d['accessToken'], str(d.get('dhanClientId', ''))


def check(token: str, client_id: str) -> int:
    # Exactly the headers Dhan's docs and its own SDK (dhanhq 2.3.0) send.
    headers = {'access-token': token, 'client-id': client_id, 'Content-Type': 'application/json', 'Accept': 'application/json'}
    failed = 0
    for ep in ENDPOINTS:
        try:
            r = requests.get(BASE + ep, headers=headers, timeout=15)
        except requests.RequestException as e:
            print(f'{ep:12} ERROR   {e}')
            failed += 1
            continue
        if r.ok:
            try:
                body = r.json()
            except ValueError:
                body = None
            # Counts only — never print account contents.
            size = len(body) if isinstance(body, list) else len(body.get('data', body)) if isinstance(body, dict) else 0
            print(f'{ep:12} {r.status_code} OK  ({size} item(s))')
        else:
            failed += 1
            try:
                j = r.json()
                code, msg = j.get('errorCode', '?'), j.get('errorMessage', '')
            except ValueError:
                code, msg = '?', r.text[:80]
            print(f'{ep:12} {r.status_code} {code}  {msg}')
    return failed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--new-token', action='store_true', help='mint a fresh TOTP token first (invalidates the old one)')
    args = ap.parse_args()

    if args.new_token:
        import login  # noqa: E402  (repo root on sys.path; loads .env)
        print('Minting a new token via TOTP (saved to access_token.json)...')
        if not login.get_new_access_token_via_totp():
            print(f'Token generation failed: {login.LAST_TOTP_ERROR}')
            return 2

    token, client_id = load_token()
    with open(TOKEN_FILE) as f:
        meta = json.load(f)
    print(f"Token issued {meta.get('createdAt', '?')}, valid until {meta.get('expiryTime', '?')}\n")
    failed = check(token, client_id)
    print(f'\n{len(ENDPOINTS) - failed}/{len(ENDPOINTS)} endpoints OK')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
