"""
Download 1-minute futures data (price) and daily futures data (price + OI) for
NIFTY and BANKNIFTY from the Dhan v2 API.

NOTE: The intraday API does NOT return open_interest for FUTIDX — OI is only
available from the daily historical endpoint (v2/charts/historical).

Output files:
  Historical Data/NIFTY_Futures_1min_Manual.csv   — 1-min OHLCV (no OI)
  Historical Data/NIFTY_Futures_Daily.csv         — daily OHLCV + OI
  Historical Data/BANKNIFTY_Futures_1min_Manual.csv
  Historical Data/BANKNIFTY_Futures_Daily.csv

LIMITATION: Only contracts currently active in the Dhan master list (~3 near
months) are available. Run this script monthly before each contract expires.
"""
import json
import requests
import os
import sys
import time
import pandas as pd
from datetime import datetime, timedelta

sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEBUG_DIR    = os.path.join(PROJECT_ROOT, "debug")
STATUS_FILE  = os.path.join(DEBUG_DIR, "futures_refresh_status.json")


def _write_status(message: str, done: bool = False, error: str | None = None) -> None:
    os.makedirs(DEBUG_DIR, exist_ok=True)
    with open(STATUS_FILE, "w") as f:
        json.dump({
            "pid": os.getpid(),
            "message": message,
            "done": done,
            "error": error,
            "updated_at": datetime.now().isoformat(),
        }, f)


def fetch_chunk(url: str, headers: dict, security_id: str, segment: str,
                from_dt: datetime, to_dt: datetime) -> pd.DataFrame:
    payload = {
        "securityId": security_id,
        "exchangeSegment": segment,
        "instrument": "FUTIDX",
        "interval": 1,
        "oi": True,
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
        "OI":     data.get("open_interest", [0] * len(data["open"])),
    })
    df.set_index("Datetime", inplace=True)
    return df


def fetch_daily_chunk(url: str, headers: dict, security_id: str, segment: str,
                      from_date: str, to_date: str) -> pd.DataFrame:
    """Fetch daily OHLCV + OI from the Dhan v2/charts/historical endpoint."""
    payload = {
        "securityId": security_id,
        "exchangeSegment": segment,
        "instrument": "FUTIDX",
        "oi": True,
        "fromDate": from_date,
        "toDate":   to_date,
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

    dates = (pd.to_datetime(data["timestamp"], unit="s")
               .tz_localize("UTC").tz_convert("Asia/Kolkata").tz_localize(None)
               .strftime("%Y-%m-%d"))
    df = pd.DataFrame({
        "Datetime": dates,
        "Open":   data["open"],
        "High":   data["high"],
        "Low":    data["low"],
        "Close":  data["close"],
        "Volume": data["volume"],
        "OI":     data.get("open_interest", [0] * len(data["open"])),
    })
    df.set_index("Datetime", inplace=True)
    return df


def download_futures_daily(helper: DhanHelper, url: str, headers: dict,
                           underlying: str, segment: str, save_dir: str):
    """Fetch daily OHLCV + OI for all available contracts and save to CSV."""
    print(f"\n>>> {underlying} DAILY FUTURES (OI) <<<")

    df_master = helper._load_master_list()
    contracts = df_master[
        (df_master["INSTRUMENT"] == "FUTIDX") &
        (df_master["UNDERLYING_SYMBOL"].str.upper() == underlying.upper())
    ][["SECURITY_ID", "SYMBOL_NAME", "SM_EXPIRY_DATE"]].sort_values("SM_EXPIRY_DATE")

    if contracts.empty:
        print(f"  [SKIP] No {underlying} FUTIDX contracts found.")
        return

    all_chunks = []

    for _, row in contracts.iterrows():
        sec_id  = str(row["SECURITY_ID"])
        name    = row["SYMBOL_NAME"]
        expiry  = row["SM_EXPIRY_DATE"]
        expiry_dt = datetime.strptime(expiry, "%Y-%m-%d")

        from_date = (expiry_dt - timedelta(days=90)).strftime("%Y-%m-%d")
        to_date   = min(expiry_dt, datetime.now()).strftime("%Y-%m-%d")

        print(f"  Contract: {name} — {from_date} → {to_date}")
        df = fetch_daily_chunk(url, headers, sec_id, segment, from_date, to_date)
        if not df.empty:
            df["Contract"] = expiry
            all_chunks.append(df)
            oi_ok = df["OI"].sum() > 0
            print(f"    [OK] {len(df)} rows  OI={'yes' if oi_ok else 'MISSING'}")
        else:
            print(f"    [SKIP] No data returned")
        time.sleep(0.3)

    if not all_chunks:
        print(f"  [FAIL] No daily data collected for {underlying}")
        return

    df_final = pd.concat(all_chunks)
    df_final = (df_final.reset_index()
                .drop_duplicates(subset=["Datetime", "Contract"])
                .sort_values(["Datetime", "Contract"])
                .set_index("Datetime"))

    out = os.path.join(save_dir, f"{underlying}_Futures_Daily.csv")
    df_final.to_csv(out)
    oi_ok = df_final["OI"].sum() > 0
    print(f"  [SUCCESS] {out}  ({len(df_final)} rows, OI={'yes' if oi_ok else 'MISSING — API may not return OI for this instrument'})")


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
        print(f"  Fetching: {contract_start.date()} to {contract_end.date()}")

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
    # Reset index so Datetime becomes a column, deduplicate per (Datetime, Contract) pair
    # to handle chunked-fetch overlaps without dropping rows from different contracts.
    df_final = df_final.reset_index()
    df_final = (df_final
                .drop_duplicates(subset=["Datetime", "Contract"])
                .sort_values(["Datetime", "Contract"])
                .set_index("Datetime"))

    out = os.path.join(save_dir, f"{underlying}_Futures_1min_Manual.csv")
    df_final.to_csv(out)
    print(f"\n  [SUCCESS] Saved → {out}")
    print(f"  Rows: {len(df_final)} | {df_final.index[0]} → {df_final.index[-1]}")
    print(f"  Contracts: {sorted(df_final['Contract'].unique().tolist())}")
    print("\n  NOTE: Only contracts currently in the Dhan master list are included.")
    print("  To build a longer history, run this script monthly before each contract expires.")


def download_futstk_oi_snapshot(helper: DhanHelper, url: str, headers: dict, save_dir: str):
    """Fetch near-month FUTSTK daily OI for all F&O stocks and write a classification snapshot."""
    print("\n>>> STOCK FUTURES OI SNAPSHOT <<<")

    df_master = helper._load_master_list()
    futstk = df_master[df_master["INSTRUMENT"] == "FUTSTK"].copy()
    # Exclude test contracts (symbols starting with a digit)
    futstk = futstk[~futstk["UNDERLYING_SYMBOL"].str[0].str.isdigit()]
    futstk["SM_EXPIRY_DATE"] = pd.to_datetime(futstk["SM_EXPIRY_DATE"])
    # Keep near-month only: lowest future expiry per underlying
    futstk = futstk[futstk["SM_EXPIRY_DATE"] > pd.Timestamp(datetime.now())]
    near_month = (futstk.sort_values("SM_EXPIRY_DATE")
                  .drop_duplicates("UNDERLYING_SYMBOL", keep="first"))

    total = len(near_month)
    print(f"  Found {total} near-month FUTSTK contracts")

    from_date = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
    to_date   = datetime.now().strftime("%Y-%m-%d")

    rows = []
    skipped = 0

    for i, (_, row) in enumerate(near_month.iterrows()):
        sec_id = str(row["SECURITY_ID"])
        symbol = row["UNDERLYING_SYMBOL"]
        expiry = row["SM_EXPIRY_DATE"].strftime("%Y-%m-%d")

        if (i + 1) % 20 == 0:
            _write_status(f"Stock futures OI: {i + 1}/{total}…")
            print(f"  [{i + 1}/{total}] processed (last: {symbol})")

        payload = {
            "securityId": sec_id,
            "exchangeSegment": "NSE_FNO",
            "instrument": "FUTSTK",
            "oi": True,
            "fromDate": from_date,
            "toDate":   to_date,
        }
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=30)
        except Exception:
            skipped += 1
            continue

        if resp.status_code != 200:
            skipped += 1
            continue

        data = resp.json()
        if not isinstance(data, dict) or not data.get("close") or len(data["close"]) < 2:
            skipped += 1
            continue

        closes = data["close"]
        ois    = data.get("open_interest", [0] * len(closes))

        close_today = closes[-1]
        close_prev  = closes[-2]
        oi_today    = ois[-1]
        oi_prev     = ois[-2]

        if oi_prev == 0:
            skipped += 1
            continue

        price_chg_pct = (close_today - close_prev) / close_prev * 100
        oi_chg_pct    = (oi_today - oi_prev) / oi_prev * 100

        if price_chg_pct >= 0 and oi_chg_pct >= 0:
            category = "LONG_BUILDUP"
        elif price_chg_pct < 0 and oi_chg_pct >= 0:
            category = "SHORT_BUILDUP"
        elif price_chg_pct >= 0 and oi_chg_pct < 0:
            category = "SHORT_COVERING"
        else:
            category = "LONG_UNWINDING"

        rows.append({
            "Symbol":      symbol,
            "Expiry":      expiry,
            "Price":       round(close_today, 2),
            "PriceChgPct": round(price_chg_pct, 2),
            "OI":          int(oi_today),
            "OIChgPct":    round(oi_chg_pct, 2),
            "Category":    category,
        })
        time.sleep(0.2)

    if not rows:
        print(f"  [FAIL] No FUTSTK OI data collected ({skipped} skipped)")
        return

    df_out = pd.DataFrame(rows)
    out = os.path.join(save_dir, "FUTSTK_OI_Snapshot.csv")
    df_out.to_csv(out, index=False)

    counts = df_out["Category"].value_counts()
    print(f"  [SUCCESS] {out} ({len(df_out)} stocks, {skipped} skipped)")
    for cat, n in counts.items():
        print(f"    {cat}: {n}")


def main():
    _write_status("Initialising…")
    try:
        dhan = get_dhan_client()
        helper = DhanHelper(dhan)

        dhan_http = getattr(dhan, "dhan_http", None)
        access_token = getattr(dhan_http, "access_token", None) if dhan_http else getattr(dhan, "access_token", None)
        client_id    = getattr(dhan_http, "client_id",    None) if dhan_http else getattr(dhan, "client_id",    None)
        if not access_token or not client_id:
            _write_status("Failed: could not read credentials", done=True, error="No credentials")
            print("[FAIL] Could not retrieve credentials from Dhan client.")
            return

        intraday_url = "https://api.dhan.co/v2/charts/intraday"
        daily_url    = "https://api.dhan.co/v2/charts/historical"
        headers = {
            "access-token": access_token,
            "client-id":    client_id,
            "Content-Type": "application/json",
            "Accept":       "application/json",
        }

        save_dir = "Historical Data"
        os.makedirs(save_dir, exist_ok=True)

        for underlying, segment in [("NIFTY", "NSE_FNO"), ("BANKNIFTY", "NSE_FNO")]:
            _write_status(f"Downloading {underlying} 1-min data…")
            download_futures(helper, intraday_url, headers, underlying, segment, save_dir)
            _write_status(f"Downloading {underlying} daily OI data…")
            download_futures_daily(helper, daily_url, headers, underlying, segment, save_dir)

        _write_status("Downloading stock futures OI snapshot…")
        download_futstk_oi_snapshot(helper, daily_url, headers, save_dir)

        _write_status("Done", done=True)
        print("\n[COMPLETE] All futures data downloaded.")
    except Exception as e:
        _write_status(f"Error: {e}", done=True, error=str(e))
        raise


if __name__ == "__main__":
    main()
