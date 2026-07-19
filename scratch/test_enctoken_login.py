"""
Test only the enctoken REST API path (bypasses Kite Connect OAuth CAPTCHA entirely).
The enctoken from kite.zerodha.com/api/login does NOT require CAPTCHA.
"""
import sys, os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import credDemo as cred
from lib.zerodha.authentication import get_enctoken
from lib.zerodha.kite_trade import KiteApp

print("Testing REST API enctoken login (no Selenium, no CAPTCHA)...")
print(f"User: {cred.USER_ID}")

try:
    enctoken = get_enctoken(cred.USER_ID, cred.PASSWORD, cred.TOTP)
    print(f"\n[SUCCESS] Got enctoken: {enctoken[:20]}...{enctoken[-10:]}")

    kitew = KiteApp(enctoken=enctoken)
    profile = kitew.profile()
    print(f"[SUCCESS] Logged in as: {profile['user_name']} ({profile['user_id']})")
    print(f"Email: {profile.get('email', 'N/A')}")

except Exception as e:
    print(f"\n[FAILURE] {e}")
