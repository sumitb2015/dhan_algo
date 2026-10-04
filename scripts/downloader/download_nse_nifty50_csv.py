"""
Download Nifty 50 and Live Market Indices CSV files from NSE India.

Fetches:
1. Live Market Indices CSV: Direct export from the "Download (.csv)" button
   on https://www.nseindia.com/market-data/live-market-indices
2. NIFTY 50 Live Quotes CSV: Live market watch of all 50 constituent stocks
   (LTP, Open, High, Low, % Change, Volume, Traded Value in Cr, 52W H/L)
3. NIFTY 50 Constituents List: Official constituent list from NSE Archives
   (Company Name, Industry, Symbol, Series, ISIN Code)
"""

import os
import sys
import csv
from datetime import datetime
from curl_cffi import requests

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def download_nifty_csvs(dest_dir=PROJECT_ROOT):
    os.makedirs(dest_dir, exist_ok=True)
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
    }
    s = requests.Session(impersonate='chrome120')
    s.headers.update(headers)

    print("Connecting to NSE India...")
    s.get("https://www.nseindia.com")
    s.get("https://www.nseindia.com/market-data/live-market-indices")

    # 1. Live Market Indices CSV
    print("Downloading Live Market Indices CSV...")
    r_indices = s.get("https://www.nseindia.com/api/allIndices?csv=true")
    indices_filename = "MW-All-Indices.csv"
    if "filename=" in r_indices.headers.get("content-disposition", ""):
        indices_filename = r_indices.headers["content-disposition"].split("filename=")[-1].strip("\"' ")
    
    indices_path = os.path.join(dest_dir, indices_filename)
    with open(indices_path, "wb") as f:
        f.write(r_indices.content)
    print(f"[OK] Saved {indices_path}")

    # 2. NIFTY 50 Constituent Live Market Watch
    print("Downloading NIFTY 50 constituent stocks live data...")
    r_stocks = s.get("https://www.nseindia.com/api/NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=NIFTY%2050")
    data = r_stocks.json().get("data", {}).get("data", [])
    
    today_str = datetime.now().strftime("%d-%b-%Y")
    nifty50_live_filename = f"MW-NIFTY-50-{today_str}.csv"
    nifty50_live_path = os.path.join(dest_dir, nifty50_live_filename)

    fieldnames = [
        "SYMBOL", "COMPANY NAME", "SERIES", "OPEN", "DAY HIGH", "DAY LOW",
        "PREV CLOSE", "LTP", "CHNG", "%CHNG", "VOLUME (shares)", "VALUE (₹ Cr)",
        "52W H", "52W L", "30 D % CHNG", "365 D % CHNG"
    ]
    with open(nifty50_live_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in data:
            val_cr = round(row.get("totalTradedValue", 0) / 1e7, 2) if row.get("totalTradedValue") else ""
            writer.writerow({
                "SYMBOL": row.get("symbol", ""),
                "COMPANY NAME": row.get("companyName") or row.get("symbol", ""),
                "SERIES": row.get("series", ""),
                "OPEN": row.get("open", ""),
                "DAY HIGH": row.get("dayHigh", ""),
                "DAY LOW": row.get("dayLow", ""),
                "PREV CLOSE": row.get("previousClose", ""),
                "LTP": row.get("lastPrice", ""),
                "CHNG": row.get("change", ""),
                "%CHNG": row.get("pChange", ""),
                "VOLUME (shares)": row.get("totalTradedVolume", ""),
                "VALUE (₹ Cr)": val_cr,
                "52W H": row.get("yearHigh", ""),
                "52W L": row.get("yearLow", ""),
                "30 D % CHNG": row.get("perChange30d", ""),
                "365 D % CHNG": row.get("perChange365d", ""),
            })
    print(f"[OK] Saved {nifty50_live_path} ({len(data)} rows)")

    # 3. Official Constituent Master List
    print("Downloading official NIFTY 50 constituent master list...")
    r_constituents = s.get("https://archives.nseindia.com/content/indices/ind_nifty50list.csv")
    const_path = os.path.join(dest_dir, "ind_nifty50list.csv")
    with open(const_path, "wb") as f:
        f.write(r_constituents.content)
    print(f"[OK] Saved {const_path}")

    return {
        "indices_csv": indices_path,
        "nifty50_live_csv": nifty50_live_path,
        "constituents_csv": const_path,
    }

if __name__ == "__main__":
    download_nifty_csvs()
