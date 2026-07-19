"""
Test using the ORIGINAL library get_enctoken from kite_trade.py
(the one that came from the zerodha_pyconnect repo).
"""
import sys, os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import credDemo as cred
import pyotp
from lib.zerodha.kite_trade import get_enctoken, KiteApp

print("Testing original library get_enctoken from kite_trade.py...")
print(f"User: {cred.USER_ID}")

# Generate current TOTP
totp = pyotp.TOTP(cred.TOTP).now()
print(f"Generated TOTP: {totp}")

try:
    enctoken = get_enctoken(cred.USER_ID, cred.PASSWORD, totp)
    print(f"\n[SUCCESS] Got enctoken: {enctoken[:20]}...{enctoken[-10:]}")

    kitew = KiteApp(enctoken=enctoken)
    profile = kitew.profile()
    print(f"[SUCCESS] Logged in as: {profile['user_name']} ({profile['user_id']})")

except Exception as e:
    print(f"\n[FAILURE] {e}")
