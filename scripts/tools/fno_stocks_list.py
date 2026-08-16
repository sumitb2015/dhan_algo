"""
Derive the tradeable F&O universe (index + stock underlyings) from master_list.csv.

The repo has no F&O constituent list — Nifty 50 / Nifty 500 lists exist, but neither
matches the ~208 stocks that actually have stock options. The master list does know:
every OPTSTK row names its UNDERLYING_SYMBOL, and the distinct set of those IS the F&O
stock universe. Indices come from the OPTIDX underlyings plus SENSEX.

Result is cached to debug/fno_universe.json with a date stamp so the dashboard route
does not re-parse a 288K-row, 15 MB CSV on every request. Regenerates when the stamp is
not today, or with --force.

Usage:
    venv\\Scripts\\python.exe scripts/tools/fno_stocks_list.py [--force]

Outputs a single JSON line to stdout. Logs go to stderr.
"""
import os
import sys
import json
import argparse
from datetime import date

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

MASTER = os.path.join(ROOT, "master_list.csv")
CACHE = os.path.join(ROOT, "debug", "fno_universe.json")

# Broad indices worth charting, in display order. Each must exist in master_list.csv as
# an INDEX row under the given exchange or it is silently dropped — the sidebar should
# never offer a symbol the candle fetch cannot resolve.
INDEX_CANDIDATES = [
    ("NIFTY", "NSE", "Nifty 50"),
    ("BANKNIFTY", "NSE", "Nifty Bank"),
    ("FINNIFTY", "NSE", "Nifty Financial Services"),
    ("MIDCPNIFTY", "NSE", "Nifty Midcap Select"),
    ("NIFTYNXT50", "NSE", "Nifty Next 50"),
    ("NIFTY 100", "NSE", "Nifty 100"),
    ("NIFTY 500", "NSE", "Nifty 500"),
    ("NIFTY MID100 FREE", "NSE", "Nifty Midcap 100"),
    ("NIFTY SMALLCAP 100", "NSE", "Nifty Smallcap 100"),
    ("NIFTY AUTO", "NSE", "Nifty Auto"),
    ("NIFTYIT", "NSE", "Nifty IT"),
    ("NIFTY FMCG", "NSE", "Nifty FMCG"),
    ("NIFTY METAL", "NSE", "Nifty Metal"),
    ("NIFTY PHARMA", "NSE", "Nifty Pharma"),
    ("NIFTY ENERGY", "NSE", "Nifty Energy"),
    ("NIFTY PSU BANK", "NSE", "Nifty PSU Bank"),
    ("NIFTY PVT BANK", "NSE", "Nifty Private Bank"),
    ("NIFTY REALTY", "NSE", "Nifty Realty"),
    ("INDIA VIX", "NSE", "India VIX"),
    ("SENSEX", "BSE", "BSE Sensex"),
    ("BANKEX", "BSE", "BSE Bankex"),
]


def build() -> dict:
    df = pd.read_csv(MASTER, low_memory=False)

    stock_mask = (df["EXCH_ID"] == "NSE") & (df["INSTRUMENT"] == "OPTSTK")
    stocks = sorted(df.loc[stock_mask, "UNDERLYING_SYMBOL"].dropna().astype(str).unique())

    index_rows = df[df["INSTRUMENT"] == "INDEX"]
    known = set(zip(index_rows["SYMBOL_NAME"].astype(str), index_rows["EXCH_ID"].astype(str)))
    indices = [
        {"symbol": sym, "exchange": exch, "label": label}
        for sym, exch, label in INDEX_CANDIDATES
        if (sym, exch) in known
    ]

    return {
        "success": True,
        "built_on": date.today().isoformat(),
        "indices": indices,
        "stocks": stocks,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="rebuild even if today's cache exists")
    args = ap.parse_args()

    if not args.force and os.path.exists(CACHE):
        try:
            with open(CACHE, "r", encoding="utf-8") as f:
                cached = json.load(f)
            if cached.get("built_on") == date.today().isoformat():
                cached["cached"] = True
                print(json.dumps(cached))
                return
        except (OSError, ValueError):
            pass  # unreadable cache is a rebuild, not a failure

    payload = build()
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    tmp = CACHE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    os.replace(tmp, CACHE)

    payload["cached"] = False
    print(json.dumps(payload))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc), "indices": [], "stocks": []}))
        sys.exit(0)
