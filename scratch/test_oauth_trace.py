"""
Diagnostic: trace all cookies and redirect headers through the Zerodha OAuth flow.
"""
import sys, os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import requests, pyotp
from urllib.parse import urlparse, parse_qs
import credDemo as cred

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
})

# Step 1: OAuth init
print("=== Step 1: OAuth init ===")
r0 = session.get(f"https://kite.trade/connect/login?api_key={cred.API_KEY}&v=3", allow_redirects=True)
print(f"Status: {r0.status_code}, Final URL: {r0.url}")
print(f"Cookies after init: {dict(session.cookies)}")
parsed = urlparse(r0.url)
sess_id = parse_qs(parsed.query).get("sess_id", [None])[0]
print(f"sess_id: {sess_id}")

# Step 2: Login
print("\n=== Step 2: Login ===")
r1 = session.post(
    "https://kite.zerodha.com/api/login",
    data={"user_id": cred.USER_ID, "password": cred.PASSWORD},
)
print(f"Status: {r1.status_code}")
login_res = r1.json()
print(f"Response: {login_res}")
print(f"Cookies after login: {dict(session.cookies)}")

# Step 3: TOTP 2FA
print("\n=== Step 3: 2FA ===")
totp = pyotp.TOTP(cred.TOTP).now()
print(f"TOTP: {totp}")
r2 = session.post(
    "https://kite.zerodha.com/api/twofa",
    data={
        "request_id": login_res["data"]["request_id"],
        "twofa_value": totp,
        "user_id": login_res["data"]["user_id"],
        "twofa_type": "totp",
    },
)
print(f"Status: {r2.status_code}")
print(f"Response: {r2.json()}")
print(f"Cookies after 2FA: {dict(session.cookies)}")

# Step 4: Try various finish URLs
print("\n=== Step 4: Finish attempts ===")

urls_to_try = [
    f"https://kite.zerodha.com/connect/finish?sess_id={sess_id}",
    f"https://kite.zerodha.com/connect/finish",
    f"https://kite.zerodha.com/connect/finish?api_key={cred.API_KEY}&sess_id={sess_id}",
]

for url in urls_to_try:
    r = session.get(url, allow_redirects=False)
    loc = r.headers.get("Location", "N/A")
    print(f"\nURL: {url}")
    print(f"  Status: {r.status_code}")
    print(f"  Location: {loc}")
    if r.status_code >= 400:
        print(f"  Body: {r.text[:300]}")
