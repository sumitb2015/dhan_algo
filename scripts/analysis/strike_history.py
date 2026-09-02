#!/usr/bin/env python3
"""
Strike History — reads one leg's 1-minute OHLC series for a single expiry
from Options Data/nifty_options.db and emits it as JSON on stdout.

Usage:
  python scripts/analysis/strike_history.py --list-expiries
  python scripts/analysis/strike_history.py \
    --expiry 2026-07-31 --strike-relative ATM+2 --option-type CE
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DB_PATH = PROJECT_ROOT / "Options Data" / "nifty_options.db"


def list_expiries() -> dict:
    conn = sqlite3.connect(str(DB_PATH))
    try:
        cursor = conn.execute("SELECT DISTINCT expiry FROM option_prices ORDER BY expiry DESC")
        expiries = [row[0] for row in cursor.fetchall()]
    finally:
        conn.close()
    return {"expiries": expiries}


def fetch_series(expiry: str, strike_relative: str, option_type: str) -> dict:
    conn = sqlite3.connect(str(DB_PATH))
    try:
        cursor = conn.execute(
            "SELECT datetime, open, high, low, close, strike, spot, oi, volume, iv "
            "FROM option_prices "
            "WHERE expiry = ? AND strike_relative = ? AND option_type = ? "
            "ORDER BY datetime",
            (expiry, strike_relative, option_type),
        )
        rows = cursor.fetchall()
    finally:
        conn.close()

    points = [
        {
            "datetime": dt,
            "open": o,
            "high": h,
            "low": l,
            "close": c,
            "strike": strike,
            "spot": spot,
            "oi": oi,
            "volume": volume,
            "iv": iv,
        }
        for dt, o, h, l, c, strike, spot, oi, volume, iv in rows
    ]

    return {
        "expiry": expiry,
        "strikeRelative": strike_relative,
        "optionType": option_type,
        "points": points,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--list-expiries", action="store_true")
    parser.add_argument("--expiry")
    parser.add_argument("--strike-relative")
    parser.add_argument("--option-type", choices=["CE", "PE"])
    args = parser.parse_args()

    if args.list_expiries:
        print(json.dumps(list_expiries()))
        return

    if not args.expiry or not args.strike_relative or not args.option_type:
        print(json.dumps({"error": "--expiry, --strike-relative and --option-type are required"}))
        sys.exit(1)

    print(json.dumps(fetch_series(args.expiry, args.strike_relative, args.option_type)))


if __name__ == "__main__":
    main()
