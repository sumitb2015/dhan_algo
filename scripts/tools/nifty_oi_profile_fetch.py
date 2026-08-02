"""
Helper script to fetch NIFTY Futures 5-minute candles (last 7 days) and 
strike-aligned Open Interest (OI) & Daily OI Change profiles for Next.js API.

Usage:
    python nifty_oi_profile_fetch.py --expiry monthly --step 100 --range 15 --days 7

Outputs a single JSON line to stdout. Logs go to stderr.
"""

import sys
import os
import json
import argparse
import time
import math
from datetime import datetime, timedelta
import pandas as pd

# Add project root to sys.path
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper


def clean_val(v, default=0.0):
    """Sanitize floats against NaN/Inf so json.dumps produces 100% valid JSON."""
    try:
        val = float(v)
        if math.isnan(val) or math.isinf(val):
            return default
        return val
    except Exception:
        return default


def get_monthly_expiries(expiries):
    """
    Given a list of sorted YYYY-MM-DD expiries, returns a set or list of monthly expiries.
    A monthly expiry is defined as the last expiry date in a given YYYY-MM month.
    """
    by_month = {}
    for exp in expiries:
        try:
            ym = exp[:7] # YYYY-MM
            by_month[ym] = exp # Keeps updating to latest date in month
        except Exception:
            continue
    return list(by_month.values())


def find_default_monthly_expiry(expiries):
    """
    Finds the current active monthly expiry (the monthly expiry for current month if >= today,
    else the next month's monthly expiry).
    """
    today_str = datetime.now().strftime("%Y-%m-%d")
    monthly_expiries = get_monthly_expiries(expiries)
    
    future_monthlies = [exp for exp in monthly_expiries if exp >= today_str]
    if future_monthlies:
        return future_monthlies[0]
    return expiries[-1] if expiries else ""


def main():
    parser = argparse.ArgumentParser(description="Fetch Nifty OI Profile & Futures 5m candles")
    parser.add_argument("--expiry", default="nearest", help="Expiry date (YYYY-MM-DD), 'nearest', or 'monthly'")
    parser.add_argument("--step", type=int, default=50, help="Strike step interval (e.g. 100 or 50)")
    parser.add_argument("--range", type=int, default=10, help="Number of strikes above/below ATM")
    parser.add_argument("--days", type=int, default=3, help="Days of intraday candles to fetch")

    args = parser.parse_args()

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"error": "auth_failed — run login.py to refresh the access token"}))
        sys.exit(0)

    helper = DhanHelper(dhan)

    # 1. Fetch available expiries for NIFTY (Security ID 13 on IDX_I)
    expiries = helper.get_expiry_list(under_security_id=13, under_exchange_segment="IDX_I")
    if not expiries:
        print(json.dumps({"error": "Failed to fetch NIFTY expiry list from Dhan"}))
        sys.exit(0)

    today_str = datetime.now().strftime("%Y-%m-%d")
    future_expiries = [e for e in expiries if e >= today_str]
    nearest_expiry = future_expiries[0] if future_expiries else (expiries[0] if expiries else "")

    monthly_expiries = get_monthly_expiries(expiries)
    current_monthly_expiry = find_default_monthly_expiry(expiries)

    # Determine targeted expiry
    if args.expiry in ("nearest", "weekly", "default") or not args.expiry:
        chosen_expiry = nearest_expiry
    elif args.expiry == "monthly":
        chosen_expiry = current_monthly_expiry
    else:
        chosen_expiry = args.expiry

    # 2. Get Spot / Future LTP. NIFTY spot is on IDX_I (mapped to NSE internally for
    # the master-list lookup) — passing "NSE" here skips that mapping and can return 0.
    spot_price = helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX") or 0.0

    fut = helper.find_future("NIFTY", exchange="NSE", instrument="FUTIDX")
    fut_price = 0.0
    fut_symbol = "NIFTY FUT"
    fut_security_id = None
    fut_expiry = None

    if fut:
        fut_security_id = int(fut["SECURITY_ID"])
        fut_expiry = str(fut.get("SM_EXPIRY_DATE", ""))
        fut_price = helper.get_ltp(fut_security_id, exchange="NSE_FNO", instrument="FUTIDX") or 0.0

    # If fut_price wasn't retrieved, fall back to spot_price. With neither, every
    # strike in the ladder would be centred on a guess — fail loudly instead of
    # returning a plausible-looking profile built around an invented ATM.
    ref_price = fut_price if fut_price > 0 else spot_price
    if ref_price <= 0:
        print(json.dumps({
            "error": "Could not resolve NIFTY spot or futures price — cannot determine ATM. "
                     "Check the Dhan Data API subscription / access token."
        }))
        sys.exit(0)

    # 3. Fetch 5-Minute Futures Intraday Candles (Last N Days)
    end_date = datetime.now().strftime("%Y-%m-%d")
    start_date = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")
    
    candles = []
    df_candles = pd.DataFrame()

    if fut_security_id:
        df_candles = helper.get_intraday_minute_data(
            security_id=fut_security_id,
            exchange_segment="NSE_FNO",
            instrument_type="FUTIDX",
            interval="5",
            from_date=start_date,
            to_date=end_date,
            oi=True
        )

    # Fallback to NIFTY Index candles if Futures candles unavailable
    if df_candles.empty:
        df_candles = helper.get_intraday_minute_data(
            security_id=13,
            exchange_segment="IDX_I",
            instrument_type="INDEX",
            interval="5",
            from_date=start_date,
            to_date=end_date,
            oi=False
        )

    if not df_candles.empty:
        # Normalize column names
        rename_map = {
            "start_time": "time", "start_Time": "time", "kline_time": "time", "timestamp": "time",
            "open": "open", "high": "high", "low": "low", "close": "close", "volume": "volume", "oi": "oi",
            "Open": "open", "High": "high", "Low": "low", "Close": "close", "Volume": "volume", "OI": "oi"
        }
        df_candles = df_candles.rename(columns=rename_map)
        
        # Sort by time
        if "time" in df_candles.columns:
            df_candles = df_candles.sort_values(by="time")
            
        for _, row in df_candles.iterrows():
            candles.append({
                "time": str(row.get("time", "")),
                "open": round(clean_val(row.get("open")), 2),
                "high": round(clean_val(row.get("high")), 2),
                "low": round(clean_val(row.get("low")), 2),
                "close": round(clean_val(row.get("close")), 2),
                "volume": clean_val(row.get("volume")),
                "oi": clean_val(row.get("oi")) if "oi" in row else 0.0
            })

    # 4. Fetch Option Chain Data for chosen_expiry
    chain_df = pd.DataFrame()
    for backoff in (0, 3.5):
        if backoff:
            time.sleep(backoff)
        try:
            chain_df = helper.get_option_chain_df("NIFTY", chosen_expiry)
            if not chain_df.empty:
                break
        except Exception:
            pass

    # Calculate ATM strike based on reference price and step
    step = args.step if args.step in (50, 100, 200) else 50
    atm_strike = float(round(ref_price / step) * step)

    # Build list of strikes centered around ATM
    range_count = args.range if args.range > 0 else 10
    target_strikes = [atm_strike + (i * step) for i in range(-range_count, range_count + 1)]

    strike_profiles = []
    total_call_oi = 0.0
    total_put_oi = 0.0
    total_call_oi_change = 0.0
    total_put_oi_change = 0.0

    max_call_oi = -1.0
    max_call_oi_strike = 0.0
    max_put_oi = -1.0
    max_put_oi_strike = 0.0

    # Index chain_df by strike if available
    chain_lookup = {}
    if not chain_df.empty:
        for strike_val, row in chain_df.iterrows():
            chain_lookup[clean_val(strike_val)] = row.to_dict()

    for s in target_strikes:
        row_data = chain_lookup.get(s, {})
        
        ce_oi = clean_val(row_data.get("ce_oi"))
        pe_oi = clean_val(row_data.get("pe_oi"))

        # Presence of the column is not enough — a NaN previous_oi cleans to 0 and would
        # report the whole of today's OI as the day's change. Require a positive baseline.
        ce_prev_oi = clean_val(row_data.get("ce_previous_oi"))
        pe_prev_oi = clean_val(row_data.get("pe_previous_oi"))
        ce_oi_change = (ce_oi - ce_prev_oi) if ce_prev_oi > 0 else clean_val(row_data.get("ce_oi_change"))
        pe_oi_change = (pe_oi - pe_prev_oi) if pe_prev_oi > 0 else clean_val(row_data.get("pe_oi_change"))

        ce_ltp = clean_val(row_data.get("ce_last_price"))
        pe_ltp = clean_val(row_data.get("pe_last_price"))
        ce_vol = clean_val(row_data.get("ce_volume"))
        pe_vol = clean_val(row_data.get("pe_volume"))
        ce_iv = clean_val(row_data.get("ce_implied_volatility"))
        pe_iv = clean_val(row_data.get("pe_implied_volatility"))

        total_call_oi += ce_oi
        total_put_oi += pe_oi
        total_call_oi_change += ce_oi_change
        total_put_oi_change += pe_oi_change

        # Seeded at -1 with a strict >, an all-zero chain would silently nominate the
        # lowest strike as "resistance". Only a strike with real OI can win.
        if ce_oi > 0 and ce_oi > max_call_oi:
            max_call_oi = ce_oi
            max_call_oi_strike = s

        if pe_oi > 0 and pe_oi > max_put_oi:
            max_put_oi = pe_oi
            max_put_oi_strike = s

        strike_profiles.append({
            "strike": s,
            "is_atm": (s == atm_strike),
            "ce_oi": ce_oi,
            "pe_oi": pe_oi,
            "ce_oi_change": ce_oi_change,
            "pe_oi_change": pe_oi_change,
            "ce_ltp": round(ce_ltp, 2),
            "pe_ltp": round(pe_ltp, 2),
            "ce_volume": ce_vol,
            "pe_volume": pe_vol,
            "ce_iv": round(ce_iv, 2),
            "pe_iv": round(pe_iv, 2),
        })

    pcr = round(total_put_oi / total_call_oi, 2) if total_call_oi > 0 else 0.0
    # Guard the denominator only. Requiring BOTH changes to be positive reported 0.0 on
    # any unwinding day, which reads as "no change" rather than "puts and calls moved
    # opposite ways" — a negative ratio here means exactly that.
    pcr_change = round(total_put_oi_change / total_call_oi_change, 2) if total_call_oi_change != 0 else 0.0

    result = {
        "symbol": "NIFTY",
        "spot_price": round(spot_price, 2),
        "futures_price": round(fut_price, 2),
        "ref_price": round(ref_price, 2),
        "atm_strike": atm_strike,
        "chosen_expiry": chosen_expiry,
        "nearest_expiry": nearest_expiry,
        "current_monthly_expiry": current_monthly_expiry,
        "expiries": expiries,
        "monthly_expiries": monthly_expiries,
        "candles": candles,
        "strike_profiles": strike_profiles,
        "summary": {
            "total_call_oi": total_call_oi,
            "total_put_oi": total_put_oi,
            "total_call_oi_change": total_call_oi_change,
            "total_put_oi_change": total_put_oi_change,
            "pcr": pcr,
            "pcr_change": pcr_change,
            "max_call_oi_strike": max_call_oi_strike,
            "max_put_oi_strike": max_put_oi_strike,
            "resistance_level": max_call_oi_strike,
            "support_level": max_put_oi_strike,
        },
        "last_updated": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }

    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(0)
