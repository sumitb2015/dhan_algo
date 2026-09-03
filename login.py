import os
import sys
import base64
import requests
import json
import pyotp
import argparse
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any
from dhanhq import dhanhq, DhanLogin
from dotenv import load_dotenv

# Indian Standard Time (UTC+5:30)
IST = timezone(timedelta(hours=5, minutes=30))

# Load environment variables
# TOKEN_FILE path absolute relative to this script for notebook compatibility
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TOKEN_FILE = os.path.join(BASE_DIR, "access_token.json")
ENV_FILE = os.path.join(BASE_DIR, ".env")

# Load environment variables explicitly from the known path
load_dotenv(ENV_FILE)

LAST_TOTP_ERROR = None


def get_token_issue_time(token_data: Dict[str, Any]) -> Optional[datetime]:
    """
    Extracts the token issuance datetime (in IST) from createdAt, JWT iat, or expiryTime.
    """
    # 1. Explicit createdAt field
    created_at = token_data.get("createdAt")
    if created_at:
        try:
            dt = datetime.fromisoformat(created_at)
            return dt.astimezone(IST) if dt.tzinfo else dt.replace(tzinfo=IST)
        except Exception:
            pass

    # 2. Extract iat from JWT payload
    access_token = token_data.get("accessToken")
    if access_token and isinstance(access_token, str) and "." in access_token:
        try:
            parts = access_token.split(".")
            if len(parts) >= 2:
                payload_b64 = parts[1]
                payload_b64 += "=" * ((4 - len(payload_b64) % 4) % 4)
                payload = json.loads(base64.urlsafe_b64decode(payload_b64.encode("utf-8")).decode("utf-8"))
                iat = payload.get("iat")
                if iat and isinstance(iat, (int, float)):
                    return datetime.fromtimestamp(iat, tz=IST)
        except Exception:
            pass

    # 3. Fallback: Dhan tokens are issued for ~24h, so estimate from expiryTime
    expiry_str = token_data.get("expiryTime")
    if expiry_str:
        try:
            dt = datetime.fromisoformat(expiry_str)
            dt_ist = dt.astimezone(IST) if dt.tzinfo else dt.replace(tzinfo=IST)
            return dt_ist - timedelta(hours=24)
        except Exception:
            pass

    return None


def get_current_session_start(now: Optional[datetime] = None) -> datetime:
    """
    Returns the start time of the current trading session in IST.
    Dhan resets auth sessions daily around 05:00 - 06:00 AM IST.
    If the current time is >= 06:00 AM IST, today's session started at 06:00 AM today.
    If before 06:00 AM IST, the session belongs to yesterday's 06:00 AM cutoff.
    """
    if now is None:
        now = datetime.now(IST)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=IST)
    else:
        now = now.astimezone(IST)

    if now.hour >= 6:
        return now.replace(hour=6, minute=0, second=0, microsecond=0)
    else:
        yesterday = now - timedelta(days=1)
        return yesterday.replace(hour=6, minute=0, second=0, microsecond=0)


def is_token_from_current_session(token_data: Dict[str, Any], now: Optional[datetime] = None) -> bool:
    """
    Returns True only if the token exists, is not expired, AND was issued
    during the current trading session (after today's 06:00 AM IST cutoff).
    Tokens from previous calendar days/sessions are considered stale.
    """
    if not token_data or not token_data.get("accessToken"):
        return False

    if now is None:
        now = datetime.now(IST)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=IST)
    else:
        now = now.astimezone(IST)

    # 1. Check expiration timestamp
    expiry_str = token_data.get("expiryTime")
    if expiry_str:
        try:
            expiry_dt = datetime.fromisoformat(expiry_str)
            expiry_ist = expiry_dt.astimezone(IST) if expiry_dt.tzinfo else expiry_dt.replace(tzinfo=IST)
            if now >= expiry_ist:
                return False
        except Exception:
            return False

    # 2. Check issuance session window
    issued_dt = get_token_issue_time(token_data)
    if issued_dt:
        session_start = get_current_session_start(now)
        if issued_dt < session_start:
            return False

    return True


def get_new_access_token():
    """
    Follows the 3-step OAuth flow from the documentation images.
    """
    client_id = os.getenv("client_id")
    api_key = os.getenv("api_key")
    api_secret = os.getenv("api_secret")

    if not all([client_id, api_key, api_secret]):
        print("Error: client_id, api_key, or api_secret missing in .env")
        return None

    # --- STEP 1: Get URL / Generate Consent ---
    print("Step 1: Generating Consent...")
    url = f"https://auth.dhan.co/app/generate-consent?client_id={client_id}"
    headers = {
        "app_id": api_key,
        "app_secret": api_secret
    }
    
    try:
        response = requests.post(url, headers=headers)
        response.raise_for_status()
        consent_res = response.json()
        consent_app_id = consent_res['consentAppId']
        
        # Construct the Login URL
        login_url = f"https://auth.dhan.co/login/consentApp-login?consentAppId={consent_app_id}"
        print(f"\n>>> PLEASE OPEN THIS URL IN YOUR BROWSER AND LOGIN:")
        print(f"{login_url}\n")
        
    except Exception as e:
        print(f"Failed to generate consent: {e}")
        return None

    # --- STEP 2: Browser Based Login ---
    token_id = input("Step 2: Enter the 'tokenId' from the browser's redirect URL: ").strip()
    if not token_id:
        print("Error: tokenId cannot be empty.")
        return None

    # --- STEP 3: Get Access Token ---
    print("\nStep 3: Exchanging tokenId for Access Token...")
    consume_url = f"https://auth.dhan.co/app/consumeApp-consent?tokenId={token_id}"
    
    try:
        response = requests.get(consume_url, headers=headers)
        response.raise_for_status()
        token_res = response.json()
        
        access_token = token_res.get('accessToken')
        if access_token:
            # Ensure dhanClientId is stored correctly from .env (the raw API response
            # may put a phone number in 'clientId' — always persist the correct Dhan ID)
            dhan_client_id = os.getenv("client_id", "")
            created_at_iso = datetime.now(IST).isoformat()
            token_res_to_save = {**token_res, "dhanClientId": dhan_client_id, "createdAt": created_at_iso}
            with open(TOKEN_FILE, 'w') as f:
                json.dump(token_res_to_save, f)
            print("Successfully obtained and saved Access Token!")
            return access_token
        else:
            print(f"Error: Access token not found in response: {token_res}")
            return None
            
    except Exception as e:
        print(f"Failed to get access token: {e}")
        return None


def get_new_access_token_via_totp():
    """
    Fully automated login: PIN + TOTP, no browser/manual token needed.
    Requires dhan_pin and totp_key in .env (totp_key is the base32 secret
    from the QR code shown when enabling TOTP under Dhan Web > DhanHQ Trading APIs).
    """
    global LAST_TOTP_ERROR
    LAST_TOTP_ERROR = None

    client_id = os.getenv("client_id")
    pin = os.getenv("dhan_pin")
    totp_key = os.getenv("totp_key")

    if not all([client_id, pin, totp_key]):
        LAST_TOTP_ERROR = "client_id, dhan_pin, or totp_key missing in .env"
        print(f"TOTP autologin skipped: {LAST_TOTP_ERROR}")
        return None

    totp_code = pyotp.TOTP(totp_key).now()

    try:
        dhan_login = DhanLogin(client_id)
        token_res = dhan_login.generate_token(pin, totp_code)

        access_token = token_res.get('accessToken')
        if access_token:
            created_at_iso = datetime.now(IST).isoformat()
            token_res_to_save = {**token_res, "dhanClientId": client_id, "createdAt": created_at_iso}
            with open(TOKEN_FILE, 'w') as f:
                json.dump(token_res_to_save, f)
            print("Successfully obtained and saved Access Token via TOTP autologin!")
            return access_token
        else:
            LAST_TOTP_ERROR = f"Access token not found in response: {token_res}"
            print(f"TOTP autologin failed: {LAST_TOTP_ERROR}")
            return None
    except Exception as e:
        LAST_TOTP_ERROR = str(e)
        print(f"TOTP autologin failed: {e}")
        return None


def get_dhan_client(force_login: bool = False):
    """
    Initializes the Dhan client using a cached token or a new login.
    If the cached token is from a previous day/session or expired, automatically forces a fresh login.
    """
    client_id = os.getenv("client_id")
    access_token = None

    if not force_login and os.path.exists(TOKEN_FILE):
        try:
            with open(TOKEN_FILE, 'r') as f:
                data = json.load(f)
            
            if is_token_from_current_session(data):
                access_token = data.get('accessToken')
                expiry_str = data.get('expiryTime', 'N/A')
                print(f"Using cached access token (Valid until: {expiry_str})")
            else:
                expiry_str = data.get('expiryTime', 'N/A')
                issued_dt = get_token_issue_time(data)
                issued_str = issued_dt.strftime('%Y-%m-%d %H:%M:%S IST') if issued_dt else 'unknown'
                print(f"Cached token is from a previous session (Issued: {issued_str}, Expiry: {expiry_str}). Forcing fresh morning login.")
                access_token = None
        except Exception as e:
            print(f"Error reading token cache: {e}")
            access_token = None

    if not access_token:
        access_token = get_new_access_token_via_totp()

    if not access_token:
        if not sys.stdin.isatty():
            print("ERROR: Access token expired, TOTP autologin unavailable, and no TTY for interactive login. Run login.py manually first.")
            return None
        access_token = get_new_access_token()

    if access_token:
        try:
            # SDK 2.0.2 initialization using DhanContext
            from dhanhq import DhanContext
            dhan_context = DhanContext(client_id, access_token)
            dhan = dhanhq(dhan_context)
            # Cached expiryTime is not authoritative — Dhan can revoke a token
            # server-side before its claimed expiry (e.g. a newer login replaces
            # it), so a lightweight call is needed to catch that case.
            res = dhan.get_holdings()
            is_invalid = False
            if isinstance(res, dict):
                error_msg = str(res.get('error_message', '') or res.get('remarks', '')).lower()
                if 'invalid' in error_msg and 'token' in error_msg:
                    is_invalid = True
                elif res.get('status') == 'failure' and 'token' in str(res.get('remarks', '')).lower():
                    is_invalid = True

            if is_invalid:
                print("Cached token is rejected by the server (Invalid Token). Forcing re-login.")
                access_token = get_new_access_token_via_totp() or get_new_access_token()
                if access_token:
                    dhan_context = DhanContext(client_id, access_token)
                    dhan = dhanhq(dhan_context)
                else:
                    return None

            return dhan
        except Exception as e:
            print(f"Failed to initialize Dhan client: {e}")
    
    return None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Dhan login and token generator")
    parser.add_argument("--force", "-f", action="store_true", help="Force new login even if a cached token exists")
    args = parser.parse_args()

    dhan = get_dhan_client(force_login=args.force)
    if dhan:
        print("\nLogin Successful!")
        try:
            holdings = dhan.get_holdings()
            print("Holdings check:", "OK" if isinstance(holdings, list) or (isinstance(holdings, dict) and holdings.get("status") != "error") else holdings)
        except Exception as e:
            print(f"Holdings check error: {e}")