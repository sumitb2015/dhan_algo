import sys
import os
import json
import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client

def main():
    from dotenv import load_dotenv
    load_dotenv()
    env_client_id = os.getenv("client_id")
    print("Env client_id:", env_client_id)
    with open('access_token.json', 'r') as f:
        data = json.load(f)
        print("Keys in access_token.json:", list(data.keys()))
        token = data['accessToken']
        client_id = env_client_id or data.get('clientId') or data.get('dhanClientId') or data.get('client_id')
        print("Final client_id to use:", client_id)
    
    headers = {
        'access-token': token,
        'client-id': client_id,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }

    url = 'https://api.dhan.co/v2/marketfeed/ohlc'
    
    # We want to test sending options IDs under NSE_FNO and VIX under NSE_IDX
    body = {
        "NSE_IDX": [21],
        "NSE_FNO": [44654, 44651, 44655, 44678, 44575]
    }
    
    print("Sending Request Body:", json.dumps(body, indent=2))
    
    try:
        res = requests.post(url, headers=headers, json=body)
        print("Status Code:", res.status_code)
        print("Response JSON:")
        print(json.dumps(res.json(), indent=2))
    except Exception as e:
        print("Error:", e)

if __name__ == '__main__':
    main()
