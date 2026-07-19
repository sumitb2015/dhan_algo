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


def main():
    import login

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
