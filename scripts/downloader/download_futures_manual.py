"""
Download 1-minute futures data for NIFTY and BANKNIFTY from the Dhan v2 intraday API.

LIMITATION: The Dhan intraday API requires the specific contract securityId, which is
only available in the live master list for currently active contracts (~3 near months).
Expired contracts are purged from the master list and cannot be retrieved this way.

For each available contract, data is downloaded from its listing date to expiry.
"""
import requests
import os
import sys
import time
import pandas as pd
from datetime import datetime, timedelta

sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper


def fetch_chunk(url: str, headers: dict, security_id: str, segment: str,
                from_dt: datetime, to_dt: datetime) -> pd.DataFrame:
    payload = {
        "securityId": security_id,
        "exchangeSegment": segment,
        "instrument": "FUTIDX",
        "interval": 1,
        "fromDate": from_dt.strftime("%Y-%m-%d %H:%M:%S"),
        "toDate":   to_dt.strftime("%Y-%m-%d %H:%M:%S"),
    }
    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=30)
    except Exception as e:
        print(f"      [EXCEPTION] {e}")
        return pd.DataFrame()

    if resp.status_code != 200:
        print(f"      [HTTP {resp.status_code}] {resp.text[:150]}")
        return pd.DataFrame()

    data = resp.json()
    if not isinstance(data, dict) or not data.get("open"):
        return pd.DataFrame()

    df = pd.DataFrame({
        "Datetime": pd.to_datetime(data["timestamp"], unit="s")
                      .tz_localize("UTC").tz_convert("Asia/Kolkata").tz_localize(None),
        "Open":   data["open"],
        "High":   data["high"],
        "Low":    data["low"],
        "Close":  data["close"],
        "Volume": data["volume"],
    })
    if "open_interest" in data:
        df["OI"] = data["open_interest"]
    df.set_index("Datetime", inplace=True)
    return df


def download_futures(helper: DhanHelper, url: str, headers: dict,
                     underlying: str, segment: str, save_dir: str):
    print(f"\n>>> {underlying} FUTURES <<<")

    # Find all available contracts from the master list
    df_master = helper._load_master_list()
    contracts = df_master[
        (df_master["INSTRUMENT"] == "FUTIDX") &
        (df_master["UNDERLYING_SYMBOL"].str.upper() == underlying.upper())
    ][["SECURITY_ID", "SYMBOL_NAME", "SM_EXPIRY_DATE"]].sort_values("SM_EXPIRY_DATE")

    if contracts.empty:
        print(f"  [FAIL] No {underlying} FUTIDX contracts found in master list.")
        print("  Note: only currently active contracts (~3 near months) are available.")
        return

    print(f"  Found {len(contracts)} contracts in master list:")
    for _, row in contracts.iterrows():
        print(f"    ID:{row['SECURITY_ID']}  {row['SYMBOL_NAME']}  expiry:{row['SM_EXPIRY_DATE']}")

    all_chunks = []

    for _, row in contracts.iterrows():
        sec_id  = str(row["SECURITY_ID"])
        name    = row["SYMBOL_NAME"]
        expiry  = row["SM_EXPIRY_DATE"]  # "YYYY-MM-DD"
        expiry_dt = datetime.strptime(expiry, "%Y-%m-%d")

        # Fetch from ~3 months before expiry (contract's active window) up to expiry
        contract_start = expiry_dt - timedelta(days=90)
        contract_end   = min(expiry_dt, datetime.now())

        print(f"\n  Contract: {name} (ID:{sec_id})")
        print(f"  Fetching: {contract_start.date()} → {contract_end.date()}")

        cur = contract_start
        while cur < contract_end:
            chunk_end = min(cur + timedelta(days=85), contract_end)
            df = fetch_chunk(url, headers, sec_id, segment, cur, chunk_end)
            if not df.empty:
                df["Contract"] = expiry
                all_chunks.append(df)
                print(f"    [OK] {cur.date()} → {chunk_end.date()} — {len(df)} rows")
            else:
                print(f"    [SKIP] No data {cur.date()} → {chunk_end.date()}")
            cur = chunk_end + timedelta(seconds=1)
            time.sleep(0.3)

    if not all_chunks:
        print(f"\n  [FAIL] No data collected for {underlying}")
        return

    df_final = pd.concat(all_chunks)
    df_final = df_final[~df_final.index.duplicated(keep="first")].sort_index()

    out = os.path.join(save_dir, f"{underlying}_Futures_1min_Manual.csv")
    df_final.to_csv(out)
    print(f"\n  [SUCCESS] Saved → {out}")
    print(f"  Rows: {len(df_final)} | {df_final.index[0]} → {df_final.index[-1]}")
    print("\n  NOTE: Only contracts currently in the Dhan master list are included.")
    print("  To build a longer history, run this script monthly before each contract expires.")


def main():
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)

    dhan_http = getattr(dhan, "dhan_http", None)
    access_token = getattr(dhan_http, "access_token", None) if dhan_http else getattr(dhan, "access_token", None)
    client_id    = getattr(dhan_http, "client_id",    None) if dhan_http else getattr(dhan, "client_id",    None)
    if not access_token or not client_id:
        print("[FAIL] Could not retrieve credentials from Dhan client.")
        return

    url = "https://api.dhan.co/v2/charts/intraday"
    headers = {
        "access-token": access_token,
        "client-id":    client_id,
        "Content-Type": "application/json",
        "Accept":       "application/json",
    }

    save_dir = "Historical Data"
    os.makedirs(save_dir, exist_ok=True)

    for underlying, segment in [("NIFTY", "NSE_FNO"), ("BANKNIFTY", "NSE_FNO")]:
        download_futures(helper, url, headers, underlying, segment, save_dir)


if __name__ == "__main__":
    main()
