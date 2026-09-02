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


def list_strikes(expiry: str) -> dict:
    conn = sqlite3.connect(str(DB_PATH))
    try:
        cursor = conn.execute(
            "SELECT DISTINCT strike FROM option_prices WHERE expiry = ? ORDER BY strike ASC",
            (expiry,),
        )
        strikes = [row[0] for row in cursor.fetchall()]
    finally:
        conn.close()
    return {"expiry": expiry, "strikes": strikes}


def fetch_series(
    expiry: str,
    option_type: str,
    strike_relative: str | None = None,
    strike: float | None = None,
) -> dict:
    option_type = option_type.strip().upper()
    if strike_relative:
        strike_relative = strike_relative.strip().upper().replace(" ", "+")

    conn = sqlite3.connect(str(DB_PATH))
    try:
        if strike is not None and strike > 0:
            cursor = conn.execute(
                "SELECT datetime, open, high, low, close, strike, spot, oi, volume, iv "
                "FROM option_prices "
                "WHERE expiry = ? AND option_type = ? AND strike = ? "
                "ORDER BY datetime",
                (expiry, option_type, strike),
            )
        else:
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
            "strike": strike_val,
            "spot": spot,
            "oi": oi,
            "volume": volume,
            "iv": iv,
        }
        for dt, o, h, l, c, strike_val, spot, oi, volume, iv in rows
    ]

    meta = {}
    if points:
        spots = [p["spot"] for p in points if p["spot"]]
        strikes = [p["strike"] for p in points if p["strike"]]
        closes = [p["close"] for p in points if p["close"] is not None]
        trading_days = sorted(list(set(p["datetime"][:10] for p in points)))
        init_spot = points[0]["spot"] or 0.0
        last_spot = points[-1]["spot"] or 0.0
        spot_change = last_spot - init_spot
        spot_change_pct = (spot_change / init_spot * 100) if init_spot else 0.0

        init_close = points[0]["close"] or 0.0
        last_close = points[-1]["close"] or 0.0
        decay = last_close - init_close
        decay_pct = (decay / init_close * 100) if init_close else 0.0

        meta = {
            "initialSpot": init_spot,
            "latestSpot": last_spot,
            "spotChange": round(spot_change, 2),
            "spotChangePct": round(spot_change_pct, 2),
            "initialStrike": points[0]["strike"],
            "latestStrike": points[-1]["strike"],
            "minStrike": min(strikes) if strikes else 0.0,
            "maxStrike": max(strikes) if strikes else 0.0,
            "distinctStrikes": sorted(list(set(strikes))),
            "initialClose": init_close,
            "latestClose": last_close,
            "minClose": min(closes) if closes else 0.0,
            "maxClose": max(closes) if closes else 0.0,
            "decay": round(decay, 2),
            "decayPct": round(decay_pct, 2),
            "tradingDays": trading_days,
            "totalDays": len(trading_days),
        }

    return {
        "expiry": expiry,
        "strikeMode": "fixed" if (strike is not None and strike > 0) else "relative",
        "strike": strike if (strike is not None and strike > 0) else (points[-1]["strike"] if points else None),
        "strikeRelative": strike_relative,
        "optionType": option_type,
        "meta": meta,
        "points": points,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--list-expiries", action="store_true")
    parser.add_argument("--list-strikes", action="store_true")
    parser.add_argument("--expiry")
    parser.add_argument("--strike", type=float)
    parser.add_argument("--strike-relative")
    parser.add_argument("--option-type", choices=["CE", "PE"])
    args = parser.parse_args()

    if args.list_expiries:
        print(json.dumps(list_expiries()))
        return

    if args.list_strikes:
        if not args.expiry:
            print(json.dumps({"error": "--expiry is required for --list-strikes"}))
            sys.exit(1)
        print(json.dumps(list_strikes(args.expiry)))
        return

    if not args.expiry or not args.option_type or (not args.strike_relative and not args.strike):
        print(json.dumps({"error": "--expiry, --option-type, and either --strike or --strike-relative are required"}))
        sys.exit(1)

    print(
        json.dumps(
            fetch_series(
                expiry=args.expiry,
                option_type=args.option_type,
                strike_relative=args.strike_relative,
                strike=args.strike,
            )
        )
    )


if __name__ == "__main__":
    main()
