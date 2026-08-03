"""
Runs Dhan's TOTP-based autologin (PIN + TOTP, no browser) and caches the token.
Called by the Next.js /api/auth/autologin route.

Usage: python dhan_autologin.py
Output: JSON on stdout — {"success": true, "clientId": "...", "expiryTime": "..."}
        or {"success": false, "error": "<message>"}
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def _cached_token_if_valid():
    """Mirrors login.get_dhan_client()'s cache check, so autologin doesn't
    force a fresh TOTP token generation (Dhan throttles this to once every
    2 minutes) when the cached one is still valid."""
    import login
    from datetime import datetime

    if not os.path.exists(login.TOKEN_FILE):
        return None
    try:
        with open(login.TOKEN_FILE, 'r') as f:
            token_data = json.load(f)
        expiry_str = token_data.get('expiryTime')
        if not token_data.get('accessToken') or not expiry_str:
            return None
        expiry_dt = datetime.fromisoformat(expiry_str)
        now = datetime.now(expiry_dt.tzinfo) if expiry_dt.tzinfo else datetime.now()
        return token_data if now < expiry_dt else None
    except Exception:
        return None


def main():
    import login

    token_data = _cached_token_if_valid()

    if not token_data:
        access_token = login.get_new_access_token_via_totp()

        if not access_token:
            error = login.LAST_TOTP_ERROR or "TOTP autologin failed"
            print(json.dumps({"success": False, "error": error}))
            sys.exit(0)

        try:
            with open(login.TOKEN_FILE, 'r') as f:
                token_data = json.load(f)
        except Exception:
            token_data = {}

    print(json.dumps({
        "success": True,
        "clientId": token_data.get("dhanClientId"),
        "expiryTime": token_data.get("expiryTime"),
    }))


if __name__ == "__main__":
    main()
