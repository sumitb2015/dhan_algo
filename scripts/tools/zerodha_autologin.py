"""
Runs Zerodha's REST-based TOTP autologin (no Selenium/CAPTCHA) and caches the
resulting Kite Connect access token. Called by the Next.js /api/auth/autologin route.

Usage: python zerodha_autologin.py
Output: JSON on stdout — {"success": true, "userId": "...", "expiryTime": "..."}
        or {"success": false, "error": "<message>"}
"""
import sys
import os
import json
from datetime import datetime, timedelta, timezone

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, PROJECT_ROOT)
# lib/zerodha/credentials.py loads ".env.zerodha" via a relative path, so the CWD must be
# PROJECT_ROOT when it's imported (this script may be spawned with a
# different CWD, e.g. from the Next.js dashboard's api routes).
os.chdir(PROJECT_ROOT)

TOKEN_FILE = os.path.join(PROJECT_ROOT, "zerodha_access_token.json")


IST = timezone(timedelta(hours=5, minutes=30))


def next_kite_expiry(now=None):
    """Kite access tokens die at ~06:00 IST the next day, not 24h after login."""
    now = (now or datetime.now(IST)).astimezone(IST)
    expiry = now.replace(hour=6, minute=0, second=0, microsecond=0)
    if expiry <= now:
        expiry += timedelta(days=1)
    return expiry


def main():
    from lib.zerodha import authentication

    try:
        request_token = authentication.get_request_token()
        kite, access_token = authentication.initialize_kite_session(request_token)
        profile = kite.profile()
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(0)

    expiry_time = next_kite_expiry().isoformat()
    user_id = profile.get("user_id")

    with open(TOKEN_FILE, 'w') as f:
        json.dump({
            "accessToken": access_token,
            "userId": user_id,
            "expiryTime": expiry_time,
        }, f)

    print(json.dumps({
        "success": True,
        "userId": user_id,
        "expiryTime": expiry_time,
    }))


if __name__ == "__main__":
    main()
