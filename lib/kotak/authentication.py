"""
Kotak Neo authentication: TOTP + MPIN login, session persistence, session restore.

Ported from the proven implementation in C:\\kotak_algo\\login.py, with token
caching added (that project kept the session in memory only, which cannot serve
the dashboard's Node API routes).

Three things here are non-obvious and each has bitten the original project:

  1. **Kotak reports auth failures as a 200-OK body**, never an exception.
     Everything goes through `_response_error()`; skipping it leaves a
     half-dead session that looks authenticated but cannot place orders.
  2. **The SDK issues every HTTP call with no timeout at all.** `install_timeouts()`
     must run before any API use or a stalled socket hangs the calling thread
     forever — in the copy-trade bridge that thread is the order-update WS
     callback, so the whole replication path dies silently.
  3. **The REST base URL is per-user** (e.g. https://e21.kotaksecurities.com) and
     arrives in the totp_validate response. It must be persisted with the tokens;
     there is no fixed host to fall back on.

Credentials live in .env.kotak at the project root (mirroring .env.zerodha).
"""
import os
import json
import time
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOKEN_FILE = os.path.join(ROOT, 'kotak_access_token.json')
ENV_FILE = os.path.join(ROOT, '.env.kotak')

ENV_KEYS = [
    'KOTAK_CONSUMER_KEY',
    'KOTAK_MOBILE_NUMBER',
    'KOTAK_UCC',
    'KOTAK_MPIN',
    'KOTAK_TOTP_SECRET',
]

# The session fields totp_login/totp_validate set on client.configuration. All
# plain strings, which is what makes save/restore possible at all.
SESSION_FIELDS = [
    'view_token', 'sid',
    'edit_token', 'edit_sid', 'edit_rid',
    'serverId', 'data_center', 'base_url',
]

HTTP_TIMEOUT = (3.05, 10)  # (connect, read) seconds

_timeouts_installed = False


def install_timeouts():
    """Force a socket timeout onto every Kotak SDK HTTP call.

    The SDK calls requests.post/get with NO timeout, so a stalled broker socket
    hangs the calling thread forever. Rebinding the module-level `requests` name
    inside the SDK to a shim that injects a default is the only hook available —
    the SDK exposes no timeout parameter anywhere.

    Note a READ timeout after place_order does NOT mean the order failed; callers
    must treat it as unconfirmed and verify against the order book before
    retrying (see is_connect_error / is_timeout_error).
    """
    global _timeouts_installed
    if _timeouts_installed:
        return
    import requests
    import neo_api_client.rest as _neo_rest
    import neo_api_client.api.scrip_search as _neo_scrip

    class _TimeoutRequests:
        @staticmethod
        def get(*args, **kwargs):
            kwargs.setdefault('timeout', HTTP_TIMEOUT)
            return requests.get(*args, **kwargs)

        @staticmethod
        def post(*args, **kwargs):
            kwargs.setdefault('timeout', HTTP_TIMEOUT)
            return requests.post(*args, **kwargs)

    _neo_rest.requests = _TimeoutRequests
    _neo_scrip.requests = _TimeoutRequests
    _timeouts_installed = True


def is_timeout_error(exc) -> bool:
    """The SDK folds the underlying exception type name into ApiException.reason
    ("ReadTimeout\\n..." / "ConnectTimeout\\n...") — string-match is the only way."""
    s = str(exc)
    return 'Timeout' in s or 'timed out' in s


def is_connect_error(exc) -> bool:
    """True when the request never reached the broker (order definitely NOT placed).

    The distinction matters on order placement: a connect error is safe to retry
    blindly, a read timeout is not (the order may be live).
    """
    s = str(exc)
    return 'ConnectTimeout' in s or 'ConnectionError' in s or 'NewConnectionError' in s


def _response_error(resp):
    """Kotak returns auth failures as a NORMAL response body ({'error': [...]})
    instead of raising — silently accepting one leaves a half-dead session that
    looks authenticated but can't subscribe to the feed or place orders.
    Returns a readable message, or None when the response is OK."""
    if isinstance(resp, dict) and resp.get('error'):
        errs = resp['error']
        if isinstance(errs, list):
            return '; '.join(str(e.get('message', e)) if isinstance(e, dict) else str(e) for e in errs)
        return str(errs)
    return None


def load_credentials() -> dict:
    """Read .env.kotak into a dict. Falls back to the process environment for any
    key the file omits, so an operator can export one secret without editing the
    file."""
    creds = {}
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, value = line.partition('=')
                creds[key.strip()] = value.strip().strip('"').strip("'")
    for key in ENV_KEYS:
        if not creds.get(key):
            env_value = os.getenv(key)
            if env_value:
                creds[key] = env_value
    missing = [k for k in ENV_KEYS if not creds.get(k)]
    if missing:
        raise ValueError(
            f'Missing Kotak credentials: {", ".join(missing)}. '
            f'Add them to {ENV_FILE} (see .env.kotak.example).'
        )
    return creds


def _token_expiry(edit_token: str):
    """Expiry from the edit_token's JWT `exp` claim.

    Kotak issues day-session tokens (observed expiring ~05:20 UTC, i.e. the next
    trading-day boundary). Signature verification is deliberately off: we are not
    validating the token, only reading when the broker says it dies.

    Falls back to +12h if the claim is unreadable — short enough that a stale
    session gets re-established rather than used past its life.
    """
    try:
        import jwt
        claims = jwt.decode(edit_token, options={'verify_signature': False})
        exp = claims.get('exp')
        if exp:
            return datetime.fromtimestamp(int(exp))
    except Exception:
        pass
    return datetime.now() + timedelta(hours=12)


def save_session(client, ucc: str = None, profile: dict = None) -> dict:
    """Persist the session to kotak_access_token.json so the dashboard's Node
    routes and other scripts can reuse it without a second TOTP login.

    A second login is not merely wasteful: Kotak binds a session per
    consumer-key/UCC, so re-authenticating would likely invalidate the session
    the copy-trade bridge is holding.
    """
    cfg = client.configuration
    data = {field: getattr(cfg, field, None) for field in SESSION_FIELDS}
    expiry = _token_expiry(data.get('edit_token') or '')
    data.update({
        'consumerKey': getattr(cfg, 'consumer_key', None),
        'ucc': ucc,
        'profile': profile or getattr(client, 'session_profile', None) or {},
        'savedAt': datetime.now().isoformat(),
        'expiryTime': expiry.isoformat(),
    })
    tmp = TOKEN_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, TOKEN_FILE)
    return data


def read_token_file():
    """Raw contents of kotak_access_token.json, or None if absent/unreadable."""
    try:
        with open(TOKEN_FILE, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def token_is_valid(data=None) -> bool:
    """Does a usable, unexpired session exist on disk?"""
    data = data if data is not None else read_token_file()
    if not data or not data.get('edit_token') or not data.get('base_url'):
        return False
    expiry = data.get('expiryTime')
    if not expiry:
        return False
    try:
        return datetime.fromisoformat(expiry) > datetime.now()
    except ValueError:
        return False


def restore_session_from_json():
    """Rebuild a NeoAPI client from the persisted session, or None.

    Mirrors scripts/tools/zerodha_instruments_cache.restore_session_from_json().
    Every NeoAPI method guards on `configuration.edit_token and
    configuration.edit_sid`, so assigning the saved fields back is genuinely all
    that is required — there is no server-side handshake to redo.
    """
    install_timeouts()
    data = read_token_file()
    if not token_is_valid(data):
        return None
    consumer_key = data.get('consumerKey')
    if not consumer_key:
        try:
            consumer_key = load_credentials()['KOTAK_CONSUMER_KEY']
        except ValueError:
            return None

    from neo_api_client import NeoAPI
    client = NeoAPI(environment='prod', consumer_key=consumer_key)
    for field in SESSION_FIELDS:
        value = data.get(field)
        if value is not None:
            setattr(client.configuration, field, value)
    client.session_profile = data.get('profile') or {}
    return client


def kotak_login(verbose: bool = True):
    """Full TOTP + MPIN login. Returns an authenticated NeoAPI client.

    Ported from C:\\kotak_algo\\login.py — that flow is verified against the live
    API, so the sequence and error handling here should not be "improved" without
    testing against a real account.
    """
    install_timeouts()
    creds = load_credentials()

    import pyotp
    from neo_api_client import NeoAPI

    def log(msg):
        if verbose:
            print(f'[kotak_auth] {msg}', flush=True)

    client = NeoAPI(environment='prod', consumer_key=creds['KOTAK_CONSUMER_KEY'])

    try:
        totp_helper = pyotp.TOTP(creds['KOTAK_TOTP_SECRET'].replace(' ', ''))
        current_totp = totp_helper.now()
    except Exception as e:
        raise ValueError(f'Error generating TOTP: {e}. Check KOTAK_TOTP_SECRET.')

    def try_login(totp_code):
        return client.totp_login(
            mobile_number=creds['KOTAK_MOBILE_NUMBER'],
            ucc=creds['KOTAK_UCC'],
            totp=totp_code,
        )

    log(f"Logging in with UCC {creds['KOTAK_UCC']}...")
    try:
        login_response = try_login(current_totp)
        err = _response_error(login_response)
    except Exception as e:
        login_response, err = None, str(e)

    if err:
        # An "Invalid TOTP" is usually a code that rolled over mid-flight.
        # Sleeping a fixed 1s regenerates the SAME 30-second code — instead
        # wait for the next TOTP window so the retry uses a genuinely new one.
        wait = 30 - (time.time() % 30) + 1
        log(f'TOTP login rejected ({err}). Retrying with a fresh code in {wait:.0f}s...')
        time.sleep(wait)
        login_response = try_login(totp_helper.now())
        err = _response_error(login_response)
        if err:
            raise RuntimeError(
                f'TOTP login failed: {err}. If this persists, re-register TOTP on '
                'the Kotak Neo portal and update .env.kotak.'
            )

    log('Validating MPIN...')
    try:
        validation_response = client.totp_validate(mpin=creds['KOTAK_MPIN'])
    except Exception as e:
        raise RuntimeError(f'MPIN validation failed: {e}')
    err = _response_error(validation_response)
    if err:
        raise RuntimeError(f'MPIN validation failed: {err}')

    # The v2 SDK has no "get profile" endpoint — identity fields (name, UCC,
    # client type, PAN/KYC id, ...) only ever appear in the login/validate
    # responses, so capture them here rather than re-authenticating later.
    login_data = (login_response or {}).get('data', {}) if isinstance(login_response, dict) else {}
    validate_data = (validation_response or {}).get('data', {}) if isinstance(validation_response, dict) else {}
    client.session_profile = {**login_data, **validate_data}

    save_session(client, ucc=creds['KOTAK_UCC'], profile=client.session_profile)
    log('Authenticated with Kotak Neo.')
    return client


def get_kotak_client(force_login: bool = False):
    """The single entry point: restore the persisted session, else log in fresh.

    Restore-first is deliberate. Kotak binds one session per consumer-key/UCC, so
    a script that always logs in would silently invalidate the copy-trade
    bridge's live session mid-session.
    """
    if not force_login:
        client = restore_session_from_json()
        if client is not None:
            return client
    return kotak_login()
