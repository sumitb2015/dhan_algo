"""
Runs Dhan's TOTP-based autologin (PIN + TOTP, no browser) and caches the token.
Called by the Next.js /api/auth/autologin route.

Usage: python dhan_autologin.py [--force]
Output: JSON on stdout — {"success": true, "clientId": "...", "expiryTime": "..."}
        or {"success": false, "error": "<message>"}
"""
import sys
import os
import json
import argparse

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)


def _cached_token_if_valid(force: bool = False):
    """Mirrors login.get_dhan_client()'s cache check. Reuses the cached token only
    if it was issued during the current trading session (after 06:00 AM IST) and is
    not expired, avoiding Dhan's 2-minute TOTP generation throttle for intra-day calls.
    Morning calls with previous-session tokens always force a fresh login."""
    if force:
        return None

    import login

    if not os.path.exists(login.TOKEN_FILE):
        return None
    try:
        with open(login.TOKEN_FILE, 'r') as f:
            token_data = json.load(f)
        if login.is_token_from_current_session(token_data):
            return token_data
        return None
    except Exception:
        return None


def main():
    parser = argparse.ArgumentParser(description="Dhan TOTP autologin")
    parser.add_argument("--force", "-f", action="store_true", help="Force new login even if a cached token exists")
    args = parser.parse_args()

    import login

    token_data = _cached_token_if_valid(force=args.force)

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

    # The token file's own client-id key has drifted across writers: login.py's
    # OAuth/TOTP paths write "dhanClientId", but the dashboard's manual-connect
    # route (rs_dashboard/lib/session.ts writeDhanTokenFile) writes "clientId" —
    # so a token file last written by that path has no "dhanClientId" at all.
    # Reading only "dhanClientId" then returns None here while the rest of the
    # response still reports success, which lets the Next.js route decide
    # enterDashboard=true without ever getting a client id to sign the session
    # cookie with — no Set-Cookie is sent, and the browser bounces straight
    # back from "/" to "/login" after a "successful" autologin.
    #
    # .env's client_id is the authoritative id anyway (it's what get_dhan_client()
    # hands to DhanContext for every API call), so prefer it and fall back to
    # whichever key the cached file happens to carry.
    client_id = (
        os.getenv("client_id")
        or token_data.get("dhanClientId")
        or token_data.get("clientId")
    )

    print(json.dumps({
        "success": True,
        "clientId": client_id,
        "expiryTime": token_data.get("expiryTime"),
    }))


if __name__ == "__main__":
    main()
