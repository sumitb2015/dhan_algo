import pyotp
import requests
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from urllib.parse import urlparse, parse_qs
import time
try:
    import credDemo as cred  # Assume this exists and contains your credentials
except ImportError:
    class DummyCred:
        USER_ID = "PLACEHOLDER"
        PASSWORD = "PLACEHOLDER"
        TOTP = "PLACEHOLDER"
        API_KEY = "PLACEHOLDER"
        API_SECRET = "PLACEHOLDER"
    cred = DummyCred()
import logging
from kiteconnect import KiteConnect
import os
from datetime import datetime
from . import config  # Import the config file relative to package
import tempfile  # Import tempfile for temporary directory

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)


def get_chrome_driver():
    options = webdriver.ChromeOptions()
    driver = webdriver.Chrome(
        service=Service(ChromeDriverManager().install()), options=options
    )
    return driver


def get_request_token():
    """
    Logs into Kite Connect via REST API (no browser/CAPTCHA) and returns the request token.

    Flow:
      1. GET kite.trade/connect/login  → redirects to kite.zerodha.com with a sess_id
      2. POST kite.zerodha.com/api/login  → user+password auth
      3. POST kite.zerodha.com/api/twofa  → TOTP 2FA
      4. GET kite.zerodha.com/connect/finish?sess_id=...  → redirects to app URL with request_token
    """
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    })

    # Step 1: Initiate the Kite Connect OAuth flow — follow redirects to capture sess_id
    login_url = f"https://kite.trade/connect/login?api_key={cred.API_KEY}&v=3"
    r0 = session.get(login_url, allow_redirects=True)
    logging.info(f"OAuth init status: {r0.status_code}, Final URL: {r0.url}")

    # Extract sess_id from the final redirected URL
    parsed_init = urlparse(r0.url)
    sess_id = parse_qs(parsed_init.query).get("sess_id", [None])[0]
    if not sess_id:
        raise Exception(f"Could not get sess_id from OAuth init redirect. URL: {r0.url}")
    logging.info(f"Got sess_id: {sess_id}")

    # Step 2: POST credentials to Kite Web login endpoint
    r1 = session.post(
        "https://kite.zerodha.com/api/login",
        data={"user_id": cred.USER_ID, "password": cred.PASSWORD},
    )
    login_res = r1.json()
    logging.info(f"Login response status: {r1.status_code}")
    if r1.status_code != 200 or "data" not in login_res:
        raise Exception(f"Login step 1 failed: {login_res}")

    # Step 3: Submit TOTP for 2FA
    totp = pyotp.TOTP(cred.TOTP).now()
    print("Generated TOTP:", totp)
    r2 = session.post(
        "https://kite.zerodha.com/api/twofa",
        data={
            "request_id": login_res["data"]["request_id"],
            "twofa_value": totp,
            "user_id": login_res["data"]["user_id"],
            "twofa_type": "totp",
        },
    )
    twofa_res = r2.json()
    logging.info(f"2FA response status: {r2.status_code}")
    if r2.status_code != 200 or "data" not in twofa_res:
        raise Exception(f"2FA step failed: {twofa_res}")

    # Step 4: Complete the OAuth flow — requires both api_key and sess_id for the redirect
    finish_url = f"https://kite.zerodha.com/connect/finish?api_key={cred.API_KEY}&sess_id={sess_id}"
    r3 = session.get(finish_url, allow_redirects=False)
    logging.info(f"Finish redirect status: {r3.status_code}, Location: {r3.headers.get('Location', 'N/A')}")

    redirect_url = r3.headers.get("Location", "")
    parsed_url = urlparse(redirect_url)
    request_token = parse_qs(parsed_url.query).get("request_token", [None])[0]

    if not request_token:
        raise Exception(
            f"Request Token not found in redirect URL: {redirect_url!r}. "
            f"Finish status={r3.status_code}, body={r3.text[:200]}"
        )

    return request_token



def initialize_kite_session(request_token):
    """Initializes the KiteConnect session with the request token."""
    config.kite = KiteConnect(api_key=cred.API_KEY)
    session_data = config.kite.generate_session(
        request_token=request_token, api_secret=cred.API_SECRET
    )
    access_token = session_data["access_token"]
    config.kite.set_access_token(access_token)
    return config.kite, access_token


def save_access_token(access_token):
    """Saves the access token to a file."""
    access_token_file = "access_token.txt"
    last_modified_file = "last_modified.txt"
    today_date = datetime.now().date()

    with open(access_token_file, "w") as file:
        file.write(access_token)

    with open(last_modified_file, "w") as file:
        file.write(today_date.strftime("%Y-%m-%d"))


def restore_kite_session():
    """Restores the KiteConnect session from a saved access token."""
    access_token_file = "access_token.txt"
    last_modified_file = "last_modified.txt"
    today_date = datetime.now().date()
    last_modified_date = None

    if os.path.exists(last_modified_file):
        try:
            with open(last_modified_file, "r") as file:
                last_modified_str = file.read().strip()
                last_modified_date = datetime.strptime(
                    last_modified_str, "%Y-%m-%d"
                ).date()
        except ValueError:
            last_modified_date = None

    # if os.path.exists(access_token_file) and last_modified_date == today_date:
    if os.path.exists(access_token_file):
        with open(access_token_file, "r") as file:
            access_token = file.read().strip()
            config.kite = KiteConnect(api_key=cred.API_KEY)
            config.kite.set_access_token(access_token)
            print("Session restored from access token file.")
            return config.kite, access_token
    return None, None
