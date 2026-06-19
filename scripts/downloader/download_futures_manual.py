import requests
import json
import os
import sys
import pandas as pd
from datetime import datetime, timedelta

# Add project root to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def main():
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)
    
    # User's requested parameters for BANKNIFTY (securityId 25)
    # However, user's request text says "NIFTY futures data"
    # To be safe and helpful, I'll fetch for NIFTY (13) which is usually what they want for "Nifty"
    
    targets = [
        {"name": "NIFTY", "id": "13", "instr": "FUTIDX", "seg": "NSE_FNO"},
        {"name": "BANKNIFTY", "id": "25", "instr": "FUTIDX", "seg": "NSE_FNO"}
    ]
    
    save_dir = "Historical Data"
    os.makedirs(save_dir, exist_ok=True)
    
    access_token = getattr(dhan.dhan_http, 'access_token', None)
    client_id = getattr(dhan.dhan_http, 'client_id', None)
    url = "https://api.dhan.co/v2/charts/intraday"
    
    headers = {
        "access-token": access_token,
        "client-id": client_id,
        "Content-Type": "application/json",
        "Accept": "application/json"
    }

    # Time range: 2025-01-01 to 2026-01-23
    start_date = datetime(2025, 1, 1)
    end_date = datetime(2026, 1, 23)
    
    for target in targets:
        print(f"\n>>> PROCESSING {target['name']} (ID: {target['id']}) <<<")
        
        all_data = []
        current_start = start_date
        
        # 90-day chunks
        while current_start < end_date:
            current_end = min(current_start + timedelta(days=85), end_date)
            
            payload = {
                "securityId": target["id"],
                "exchangeSegment": target["seg"],
                "instrument": target["instr"],
                "interval": "1",
                "fromDate": current_start.strftime("%Y-%m-%d %H:%M:%S"),
                "toDate": current_end.strftime("%Y-%m-%d %H:%M:%S")
            }
            
            print(f"  Fetching: {payload['fromDate']} to {payload['toDate']}...")
            
            try:
                response = requests.post(url, headers=headers, json=payload)
                if response.status_code == 200:
                    data = response.json()
                    if data.get('status') == 'success':
                        chunk = data.get('data', [])
                        if chunk:
                            df_chunk = pd.DataFrame(chunk)
                            all_data.append(df_chunk)
                            print(f"    [OK] Received {len(df_chunk)} rows.")
                        else:
                            print(f"    [SKIP] No data in chunk.")
                    else:
                        print(f"    [API ERROR] {data.get('remarks')}")
                else:
                    print(f"    [HTTP ERROR] {response.status_code}: {response.text}")
            except Exception as e:
                print(f"    [EXCEPTION] {e}")
            
            current_start = current_end + timedelta(seconds=1)
            
        if all_data:
            df_final = pd.concat(all_data)
            
            # Post-processing
            rename_map = {
                "start_Time": "Datetime", "open": "Open", "high": "High", 
                "low": "Low", "close": "Close", "volume": "Volume"
            }
            df_final = df_final.rename(columns=rename_map)
            
            if "OI" in df_final.columns: pass # Keep OI if present
            
            if "Datetime" in df_final.columns:
                df_final["Datetime"] = pd.to_datetime(df_final["Datetime"], unit='s').dt.tz_localize('UTC').dt.tz_convert('Asia/Kolkata').dt.tz_localize(None)
                df_final = df_final.set_index("Datetime").sort_index()
            
            # Save
            filename = f"{target['name']}_Futures_1min_1Year_Manual.csv"
            output_path = os.path.join(save_dir, filename)
            df_final.to_csv(output_path)
            
            print(f"  [SUCCESS] Saved to {output_path}")
            print(f"  Total Rows: {len(df_final)}")
        else:
            print(f"  [FAIL] No data collected for {target['name']}")

if __name__ == "__main__":
    main()
