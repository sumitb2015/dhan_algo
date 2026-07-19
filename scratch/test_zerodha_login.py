import sys
import os
import pyotp

# Add project root to python path to import lib.zerodha
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.zerodha import authentication
from lib.zerodha.kite_trade import KiteApp

def test_unofficial_login():
    print("\n--- Testing Unofficial Login (enctoken bypass) ---")
    userid = input("Enter Zerodha User ID: ").strip()
    password = input("Enter Zerodha Password: ").strip()
    totp_key = input("Enter TOTP Key (2FA seed): ").strip()

    if not userid or not password or not totp_key:
        print("Error: All fields are required.")
        return

    try:
        # Generate TOTP to show it works
        totp = pyotp.TOTP(totp_key).now()
        print(f"Generated current TOTP: {totp}")

        print("Sending login request to Zerodha Kite Web...")
        enctoken = authentication.get_enctoken(userid, password, totp_key)
        print("\n[SUCCESS] Successfully logged in and retrieved enctoken!")
        print(f"enctoken: {enctoken}")

        # Test profile API with KiteApp
        print("\nVerifying session by fetching profile information...")
        kitew = KiteApp(enctoken=enctoken)
        profile = kitew.profile()
        print(f"Logged in User Profile: {profile.get('user_name')} (ID: {profile.get('user_id')})")
        print(f"Email: {profile.get('email')}, Member ID: {profile.get('member_id')}")

    except Exception as e:
        print(f"\n[FAILURE] Unofficial Login Failed: {e}")
        print("Note: Direct HTTP logins can sometimes be blocked by Zerodha's anti-bot protections.")


def test_official_login():
    print("\n--- Testing Official Login (Kite Connect API via Selenium) ---")
    
    # We will write a temp credDemo.py containing credentials so authentication.py can load it
    api_key = input("Enter Kite API Key: ").strip()
    api_secret = input("Enter Kite API Secret: ").strip()
    userid = input("Enter Zerodha User ID: ").strip()
    password = input("Enter Zerodha Password: ").strip()
    totp_key = input("Enter TOTP Key (2FA seed): ").strip()

    if not all([api_key, api_secret, userid, password, totp_key]):
        print("Error: All fields are required.")
        return

    # Temporarily write to credDemo.py for authentication module to read
    cred_content = f"""# Automatically generated for testing
API_KEY = "{api_key}"
API_SECRET = "{api_secret}"
USER_ID = "{userid}"
PASSWORD = "{password}"
TOTP = "{totp_key}"
"""
    with open("credDemo.py", "w") as f:
        f.write(cred_content)
        
    try:
        print("\nStarting Selenium browser automation to login...")
        request_token = authentication.get_request_token()
        print(f"[SUCCESS] Retrieved Request Token: {request_token}")

        print("Initializing KiteConnect session...")
        kite, access_token = authentication.initialize_kite_session(request_token)
        print(f"[SUCCESS] Generated Access Token: {access_token}")
        
        print("Saving access token...")
        authentication.save_access_token(access_token)

        # Test margins fetch
        margins = kite.margins()
        print("\nSuccessfully fetched account margins!")
        print(f"Available Cash: {margins.get('equity', {}).get('net')}")

    except Exception as e:
        print(f"\n[FAILURE] Official Login Failed: {e}")
    finally:
        # Clean up temporary credentials file
        if os.path.exists("credDemo.py"):
            os.remove("credDemo.py")


def main():
    print("==============================================")
    print("     Zerodha API Login Tester & Sample Code")
    print("==============================================")
    print("Select Login Method to Test:")
    print("1. Unofficial Web Login (No API key, uses enctoken bypass)")
    print("2. Official Kite Connect API Login (Uses API credentials & Selenium)")
    print("3. Exit")
    
    choice = input("\nEnter choice (1/2/3): ").strip()
    if choice == '1':
        test_unofficial_login()
    elif choice == '2':
        test_official_login()
    else:
        print("Exiting.")

if __name__ == "__main__":
    main()
