"""
Unusual Options Activity & Institutional Flow Scanner
Detects:
- Unusual Volume-to-Open-Interest (Vol/OI) spikes
- Sudden aggressive OI accumulation (Long Buildup / Short Covering / Writing)
- Big premium blocks (Turnover in ₹ Cr)
- Net Institutional sentiment flow (Bullish vs Bearish)
"""

import sys
import os
import json
import math
import argparse
import pandas as pd
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

UNDERLYINGS_MAP = {
    'NIFTY':     {'chain_id': 13, 'chain_seg': 'IDX_I',   'spot_id': 13, 'spot_seg': 'IDX_I', 'name': 'NIFTY'},
    'BANKNIFTY': {'chain_id': 25, 'chain_seg': 'IDX_I',   'spot_id': 25, 'spot_seg': 'IDX_I', 'name': 'BANKNIFTY'},
    'FINNIFTY':  {'chain_id': 27, 'chain_seg': 'IDX_I',   'spot_id': 27, 'spot_seg': 'IDX_I', 'name': 'FINNIFTY'},
    'SENSEX':    {'chain_id': 1,  'chain_seg': 'BSE_FNO', 'spot_id': 51, 'spot_seg': 'IDX_I', 'name': 'SENSEX'},
}


def _clean_num(val, default: float = 0.0) -> float:
    if val is None:
        return default
    try:
        f = float(val)
        if math.isnan(f) or math.isinf(f):
            return default
        return f
    except (ValueError, TypeError):
        return default


def _clean_int(val, default: int = 0) -> int:
    if val is None:
        return default
    try:
        f = float(val)
        if math.isnan(f) or math.isinf(f):
            return default
        return int(f)
    except (ValueError, TypeError):
        return default


def scan_unusual_options(underlying: str = 'NIFTY', expiry: str = None, min_ratio: float = 1.0):
    try:
        dhan = get_dhan_client()
        helper = DhanHelper(dhan)
    except Exception as e:
        return {"success": False, "error": f"Failed to initialize DhanHelper: {e}"}

    under_upper = underlying.upper()
    meta = UNDERLYINGS_MAP.get(under_upper)

    if meta:
        chain_id = meta['chain_id']
        lot_size = helper.get_lot_size(under_upper) or 65
        spot = _clean_num(helper.get_ltp(meta['spot_id'], exchange='NSE', instrument='INDEX'))
    else:
        # Equity stock
        sec = helper.find_equity(under_upper)
        if not sec:
            return {"success": False, "error": f"Underlying {under_upper} not found in master list"}
        chain_id = int(sec.get('SECURITY_ID'))
        lot_size = helper.get_lot_size(under_upper) or 500
        spot = _clean_num(helper.get_ltp(under_upper, exchange='NSE', instrument='EQUITY'))

    try:
        expiries = helper.get_expiries(chain_id)
    except Exception as e:
        return {"success": False, "error": f"Failed to fetch expiries for {under_upper}: {e}"}

    if not expiries:
        return {"success": False, "error": f"No expiries available for {under_upper}"}

    target_expiry = expiry if expiry and expiry in expiries else expiries[0]

    try:
        df = helper.get_option_chain_df(chain_id, target_expiry)
    except Exception as e:
        return {"success": False, "error": f"Failed to fetch option chain: {e}"}

    if df.empty:
        return {"success": False, "error": "Option chain returned empty"}

    # Sort by Strike
    df = df.sort_index()

    # Build alerts and flow breakdown
    alerts = []
    all_flows = []

    total_ce_turnover = 0.0
    total_pe_turnover = 0.0
    total_ce_oi = 0
    total_pe_oi = 0
    total_ce_oi_change = 0
    total_pe_oi_change = 0
    total_ce_vol = 0
    total_pe_vol = 0

    for strike_idx, row in df.iterrows():
        strike = _clean_num(strike_idx)

        # CE analysis
        ce_ltp = _clean_num(row.get('ce_last_price'))
        ce_prev_close = _clean_num(row.get('ce_previous_close_price'), default=ce_ltp)
        if ce_prev_close <= 0.0:
            ce_prev_close = ce_ltp
        ce_oi = _clean_int(row.get('ce_oi'))
        ce_prev_oi = _clean_int(row.get('ce_previous_oi'), default=ce_oi)
        ce_vol = _clean_int(row.get('ce_volume'))
        ce_iv = _clean_num(row.get('ce_implied_volatility'))
        ce_delta = _clean_num(row.get('ce_delta'))
        ce_theta = _clean_num(row.get('ce_theta'))
        ce_gamma = _clean_num(row.get('ce_gamma'))
        ce_vega = _clean_num(row.get('ce_vega'))

        ce_chg_pct = round(((ce_ltp - ce_prev_close) / max(0.05, ce_prev_close)) * 100, 2)
        ce_oi_chg = ce_oi - ce_prev_oi
        ce_oi_chg_pct = round((ce_oi_chg / max(1, ce_prev_oi)) * 100, 2)
        ce_vol_oi = round(ce_vol / max(1, ce_oi), 2)
        ce_turnover_cr = round((ce_vol * ce_ltp * lot_size) / 10_000_000.0, 2)

        total_ce_turnover += ce_turnover_cr
        total_ce_oi += ce_oi
        total_ce_oi_change += ce_oi_chg
        total_ce_vol += ce_vol

        # PE analysis
        pe_ltp = _clean_num(row.get('pe_last_price'))
        pe_prev_close = _clean_num(row.get('pe_previous_close_price'), default=pe_ltp)
        if pe_prev_close <= 0.0:
            pe_prev_close = pe_ltp
        pe_oi = _clean_int(row.get('pe_oi'))
        pe_prev_oi = _clean_int(row.get('pe_previous_oi'), default=pe_oi)
        pe_vol = _clean_int(row.get('pe_volume'))
        pe_iv = _clean_num(row.get('pe_implied_volatility'))
        pe_delta = _clean_num(row.get('pe_delta'))
        pe_theta = _clean_num(row.get('pe_theta'))
        pe_gamma = _clean_num(row.get('pe_gamma'))
        pe_vega = _clean_num(row.get('pe_vega'))

        pe_chg_pct = round(((pe_ltp - pe_prev_close) / max(0.05, pe_prev_close)) * 100, 2)
        pe_oi_chg = pe_oi - pe_prev_oi
        pe_oi_chg_pct = round((pe_oi_chg / max(1, pe_prev_oi)) * 100, 2)
        pe_vol_oi = round(pe_vol / max(1, pe_oi), 2)
        pe_turnover_cr = round((pe_vol * pe_ltp * lot_size) / 10_000_000.0, 2)

        total_pe_turnover += pe_turnover_cr
        total_pe_oi += pe_oi
        total_pe_oi_change += pe_oi_chg
        total_pe_vol += pe_vol

        # CE Sentiment
        ce_sentiment = "NEUTRAL"
        ce_bias = "NEUTRAL"
        if ce_chg_pct > 0 and ce_oi_chg > 0:
            ce_sentiment = "LONG_BUILDUP"
            ce_bias = "BULLISH"
        elif ce_chg_pct < 0 and ce_oi_chg > 0:
            ce_sentiment = "SHORT_BUILDUP"
            ce_bias = "BEARISH"
        elif ce_chg_pct > 0 and ce_oi_chg < 0:
            ce_sentiment = "SHORT_COVERING"
            ce_bias = "BULLISH"
        elif ce_chg_pct < 0 and ce_oi_chg < 0:
            ce_sentiment = "LONG_UNWINDING"
            ce_bias = "BEARISH"

        # PE Sentiment
        pe_sentiment = "NEUTRAL"
        pe_bias = "NEUTRAL"
        if pe_chg_pct > 0 and pe_oi_chg > 0:
            pe_sentiment = "LONG_BUILDUP"
            pe_bias = "BEARISH"
        elif pe_chg_pct < 0 and pe_oi_chg > 0:
            pe_sentiment = "SHORT_BUILDUP"
            pe_bias = "BULLISH"
        elif pe_chg_pct > 0 and pe_oi_chg < 0:
            pe_sentiment = "SHORT_COVERING"
            pe_bias = "BEARISH"
        elif pe_chg_pct < 0 and pe_oi_chg < 0:
            pe_sentiment = "LONG_UNWINDING"
            pe_bias = "BULLISH"

        ce_item = {
            "strike": strike,
            "type": "CE",
            "ltp": ce_ltp,
            "change_pct": ce_chg_pct,
            "volume": ce_vol,
            "oi": ce_oi,
            "oi_change": ce_oi_chg,
            "oi_change_pct": ce_oi_chg_pct,
            "vol_oi_ratio": ce_vol_oi,
            "turnover_cr": ce_turnover_cr,
            "iv": ce_iv,
            "delta": ce_delta,
            "theta": ce_theta,
            "gamma": ce_gamma,
            "vega": ce_vega,
            "sentiment": ce_sentiment,
            "bias": ce_bias,
        }

        pe_item = {
            "strike": strike,
            "type": "PE",
            "ltp": pe_ltp,
            "change_pct": pe_chg_pct,
            "volume": pe_vol,
            "oi": pe_oi,
            "oi_change": pe_oi_chg,
            "oi_change_pct": pe_oi_chg_pct,
            "vol_oi_ratio": pe_vol_oi,
            "turnover_cr": pe_turnover_cr,
            "iv": pe_iv,
            "delta": pe_delta,
            "theta": pe_theta,
            "gamma": pe_gamma,
            "vega": pe_vega,
            "sentiment": pe_sentiment,
            "bias": pe_bias,
        }

        all_flows.append(ce_item)
        all_flows.append(pe_item)

        # Alerts detection
        for item in (ce_item, pe_item):
            reasons = []
            score = 0

            # 1. Unusual Volume vs OI
            if item["vol_oi_ratio"] >= 1.2 and item["volume"] >= 10_000:
                reasons.append(f"Vol/OI {item['vol_oi_ratio']}x")
                score += 30

            # 2. Large OI Spike (> 150k contracts)
            if abs(item["oi_change"]) >= 150_000:
                reasons.append(f"OI Δ {item['oi_change']:+d}")
                score += 25

            # 3. High Turnover Block (> ₹15 Cr)
            if item["turnover_cr"] >= 15.0:
                reasons.append(f"₹{item['turnover_cr']} Cr Turnover")
                score += 25

            # 4. Aggressive OTM move
            dist_pts = abs(strike - spot)
            if dist_pts >= 150 and item["volume"] >= 30_000 and item["turnover_cr"] >= 5.0:
                reasons.append("Aggressive OTM Flow")
                score += 20

            if reasons:
                alerts.append({
                    **item,
                    "score": score,
                    "reasons": reasons,
                    "spot_distance": round(strike - spot, 1),
                })

    # Sort alerts by score and turnover
    alerts.sort(key=lambda x: (x["score"], x["turnover_cr"]), reverse=True)

    # Calculate overall bias
    bullish_turnover = sum(a["turnover_cr"] for a in alerts if a["bias"] == "BULLISH")
    bearish_turnover = sum(a["turnover_cr"] for a in alerts if a["bias"] == "BEARISH")
    net_bias = "NEUTRAL"
    if bullish_turnover > bearish_turnover * 1.3:
        net_bias = "BULLISH"
    elif bearish_turnover > bullish_turnover * 1.3:
        net_bias = "BEARISH"

    pcr_oi = round(total_pe_oi / max(1, total_ce_oi), 2)
    pcr_vol = round(total_pe_vol / max(1, total_ce_vol), 2)

    return {
        "success": True,
        "underlying": under_upper,
        "spot": round(spot, 2),
        "lot_size": lot_size,
        "expiry": target_expiry,
        "expiries": expiries,
        "summary": {
            "net_bias": net_bias,
            "pcr_oi": pcr_oi,
            "pcr_vol": pcr_vol,
            "total_ce_turnover_cr": round(total_ce_turnover, 2),
            "total_pe_turnover_cr": round(total_pe_turnover, 2),
            "total_ce_oi": total_ce_oi,
            "total_pe_oi": total_pe_oi,
            "total_ce_oi_change": total_ce_oi_change,
            "total_pe_oi_change": total_pe_oi_change,
            "bullish_alert_turnover_cr": round(bullish_turnover, 2),
            "bearish_alert_turnover_cr": round(bearish_turnover, 2),
            "total_alerts": len(alerts),
        },
        "alerts": alerts[:50],  # top 50 alerts
        "flows": all_flows,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--underlying", default="NIFTY")
    parser.add_argument("--expiry", default=None)
    parser.add_argument("--min-ratio", type=float, default=1.0)
    args = parser.parse_args()

    result = scan_unusual_options(underlying=args.underlying, expiry=args.expiry, min_ratio=args.min_ratio)
    sys.stdout.write("\n" + json.dumps(result) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
