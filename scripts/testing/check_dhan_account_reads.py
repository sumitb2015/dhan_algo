"""Check Dhan's account-read endpoints (positions, order book, trade book, funds) with a token.

Read-only: every call is a GET. Prints one line per endpoint with the HTTP status and Dhan's error code, then a verdict
(lib/dhan_health.diagnose_account_reads) that tells a "DH-905 on reads while orders work" day apart from a dead token, a
rate limit or a static-IP problem in seconds.

    venv/bin/python scripts/testing/check_dhan_account_reads.py              # the saved token
    venv/bin/python scripts/testing/check_dhan_account_reads.py --watch 30   # re-check every 30 s until all OK
    venv/bin/python scripts/testing/check_dhan_account_reads.py --new-token  # mint a fresh one first (TOTP)

--watch never mints. It prints a timestamped line whenever the verdict changes, so an outage's start and end are on
record (on 2026-10-23 the recovery could only be bracketed to 10:09-10:11 IST from other logs).

--new-token: Dhan invalidates the previous token the moment a new one is issued (seen 2026-10-23: the old token
answered DH-906 on /profile within seconds). So the fresh token is saved to access_token.json straight away (via
login.py) — the dashboard re-reads that file; anything holding the old token in memory has to reconnect. A new token
did NOT fix the 2026-10-23 DH-905 reads (three fresh tokens failed the same way), so don't reach for it on that verdict.
"""
import argparse
import base64
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from lib.dhan_health import VERDICT_ADVICE, dhan_error_code, diagnose_account_reads  # noqa: E402

BASE = 'https://api.dhan.co/v2'
TOKEN_FILE = os.path.join(ROOT, 'access_token.json')
IST = timezone(timedelta(hours=5, minutes=30))
# Control first (should always work), then the account reads under test.
ENDPOINTS = ['/profile', '/positions', '/orders', '/trades', '/fundlimit', '/holdings', '/ip/getIP']
# /ip/getIP fields that are safe to print (no client id, no account contents).
IP_FIELDS = ('ipMatchStatus', 'ordersAllowed', 'modifyDatePrimary', 'modifyDateSecondary')
MIN_WATCH_S = 15


def load_token() -> tuple[str, str]:
    with open(TOKEN_FILE) as f:
        d = json.load(f)
    return d['accessToken'], str(d.get('dhanClientId', ''))


def token_claims(token: str) -> dict:
    """The JWT's non-sensitive claims (consumer type, issued/expiry). {} if it isn't a readable JWT."""
    try:
        part = token.split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
    except (IndexError, ValueError):
        return {}
    if not isinstance(claims, dict):
        return {}
    out = {'tokenConsumerType': claims.get('tokenConsumerType')}
    for k in ('iat', 'exp'):
        if isinstance(claims.get(k), (int, float)):
            out[k] = datetime.fromtimestamp(claims[k], IST).strftime('%Y-%m-%d %H:%M:%S')
    return out


def collect(token: str, client_id: str, get=requests.get) -> dict:
    """One GET per endpoint -> {endpoint: (status or None, parsed body or None)}."""
    # Exactly the headers Dhan's docs and its own SDK (dhanhq 2.3.0) send.
    headers = {'access-token': token, 'client-id': client_id, 'Content-Type': 'application/json', 'Accept': 'application/json'}
    results = {}
    for ep in ENDPOINTS:
        try:
            r = get(BASE + ep, headers=headers, timeout=15)
        except requests.RequestException:
            results[ep] = (None, None)
            continue
        try:
            body = r.json()
        except ValueError:
            body = None
        results[ep] = (r.status_code, body)
    return results


def print_results(results: dict) -> int:
    failed = 0
    for ep, (status, body) in results.items():
        if status is None:
            print(f'{ep:12} ERROR   no response')
            failed += 1
        elif status == 200:
            # Counts only — never print account contents.
            size = len(body) if isinstance(body, list) else len(body.get('data', body)) if isinstance(body, dict) else 0
            print(f'{ep:12} {status} OK  ({size} item(s))')
        else:
            failed += 1
            msg = body.get('errorMessage', '') if isinstance(body, dict) else ''
            print(f'{ep:12} {status} {dhan_error_code(body) or "?"}  {msg}')
    ip_status, ip_body = results.get('/ip/getIP', (None, None))
    if ip_status == 200 and isinstance(ip_body, dict):
        print('static IP    ' + ', '.join(f'{k}={ip_body[k]}' for k in IP_FIELDS if k in ip_body))
    return failed


def report(results: dict) -> str:
    failed = print_results(results)
    verdict, notes = diagnose_account_reads(results)
    print(f'\n{len(results) - failed}/{len(results)} endpoints OK')
    print(f'Verdict: {verdict} - {VERDICT_ADVICE[verdict]}')
    for n in notes:
        print(f'  - {n}')
    return verdict


def watch(interval: int, get=requests.get, sleep=time.sleep) -> int:
    """Re-check until every endpoint is OK; one line per verdict change. Re-reads the token file each round."""
    interval = max(MIN_WATCH_S, interval)
    last = None
    while True:
        token, client_id = load_token()
        results = collect(token, client_id, get)
        verdict, _ = diagnose_account_reads(results)
        if verdict != last:
            ok = sum(1 for st, _ in results.values() if st == 200)
            print(f"{datetime.now(IST):%H:%M:%S} IST  {verdict}  ({ok}/{len(results)} OK)", flush=True)
            last = verdict
        if verdict == 'ok':
            return 0
        sleep(interval)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--new-token', action='store_true', help='mint a fresh TOTP token first (invalidates the old one)')
    ap.add_argument('--watch', type=int, metavar='SECONDS', help=f're-check every SECONDS (min {MIN_WATCH_S}) until all OK; never mints')
    args = ap.parse_args()

    if args.new_token and args.watch:
        ap.error('--watch never mints; run --new-token on its own first')
    if args.new_token:
        import login  # noqa: E402  (repo root on sys.path; loads .env)
        print('Minting a new token via TOTP (saved to access_token.json)...')
        if not login.get_new_access_token_via_totp():
            print(f'Token generation failed: {login.LAST_TOTP_ERROR}')
            return 2

    with open(TOKEN_FILE) as f:
        meta = json.load(f)
    claims = token_claims(meta['accessToken'])
    print(f"Token issued {meta.get('createdAt', '?')}, valid until {meta.get('expiryTime', '?')}, "
          f"type {claims.get('tokenConsumerType') or '?'}\n")
    if args.watch:
        try:
            return watch(args.watch)
        except KeyboardInterrupt:
            return 1
    token, client_id = load_token()
    return 0 if report(collect(token, client_id)) == 'ok' else 1


if __name__ == '__main__':
    sys.exit(main())
