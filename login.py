import os
import requests
import json
from dhanhq import dhanhq
from dotenv import load_dotenv

# Load environment variables
# TOKEN_FILE path absolute relative to this script for notebook compatibility
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TOKEN_FILE = os.path.join(BASE_DIR, "access_token.json")
ENV_FILE = os.path.join(BASE_DIR, ".env")

# Load environment variables explicitly from the known path
load_dotenv(ENV_FILE)

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
            with open(TOKEN_FILE, 'w') as f:
                json.dump(token_res, f)
            print("Successfully obtained and saved Access Token!")
            return access_token
        else:
            print(f"Error: Access token not found in response: {token_res}")
            return None
            
    except Exception as e:
        print(f"Failed to get access token: {e}")
        return None

def get_dhan_client():
    """
    Initializes the Dhan client using a cached token or a new login.
    """
    from datetime import datetime
    client_id = os.getenv("client_id")
    access_token = None

    if os.path.exists(TOKEN_FILE):
        try:
            with open(TOKEN_FILE, 'r') as f:
                data = json.load(f)
                access_token = data.get('accessToken')
                expiry_str = data.get('expiryTime')
                
                if expiry_str:
                    expiry_dt = datetime.fromisoformat(expiry_str)
                    if datetime.now() > expiry_dt:
                        print(f"Cached token expired on {expiry_str}. Forcing re-login.")
                        access_token = None
                    else:
                        print(f"Using cached access token (Valid until: {expiry_str})")
        except Exception as e:
            print(f"Error reading token cache: {e}")
            access_token = None

    if not access_token:
        access_token = get_new_access_token()

    if access_token:
        try:
            # SDK 2.0.2 initialization using DhanContext
            from dhanhq import DhanContext
            dhan_context = DhanContext(client_id, access_token)
            dhan = dhanhq(dhan_context)
            
            # --- Active Verification ---
            res = dhan.get_holdings()
            
            is_invalid = False
            if isinstance(res, dict):
                error_msg = str(res.get('error_message', '') or res.get('remarks', '')).lower()
                if 'invalid' in error_msg and 'token' in error_msg:
                    is_invalid = True
                elif res.get('status') == 'error' and 'token' in str(res.get('remarks', '')).lower():
                    is_invalid = True
            
            if is_invalid:
                print("Cached token is rejected by the server (Invalid Token). Forcing re-login.")
                access_token = get_new_access_token()
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
    dhan = get_dhan_client()
    if dhan:
        print("\nLogin Successful!")
        print(dhan.get_holdings())