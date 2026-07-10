"""
Fetch open F&O option positions and map them with live option chain Greeks (specifically delta).
Returns JSON string with individual and net deltas.
"""
import sys
import os
import json
import re
import math
from datetime import datetime, date, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

RISK_FREE_RATE = 0.07  # 7% standard risk-free rate for Indian market

# Standard normal distribution functions for Black-Scholes fallback
def _norm_pdf(x: float) -> float:
    return math.exp(-x**2 / 2.0) / math.sqrt(2.0 * math.pi)

def _norm_cdf(x: float) -> float:
    # Math.erf is available in Python 3.2+
    return (1.0 + math.erf(x / math.sqrt(2.0))) / 2.0

def bs_delta(S: float, K: float, T: float, r: float, sigma_pct: float, opt_type: str = "CE") -> float:
    """
    Calculate option delta using the Black-Scholes formula.
    sigma_pct: Implied Volatility as a percentage (e.g. 15.4)
    """
    sigma = sigma_pct / 100.0
    if T <= 0 or sigma <= 0 or S <= 0 or K <= 0:
        return 0.5 if opt_type.upper() == "CE" else -0.5
    try:
        d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
        if opt_type.upper() == "CE":
            return _norm_cdf(d1)
        else:
            return _norm_cdf(d1) - 1.0
    except Exception:
        return 0.5 if opt_type.upper() == "CE" else -0.5

def main():
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'error': 'auth_failed'}))
        return

    helper = DhanHelper(dhan)

    # 1. Fetch live positions
    pos_df = helper.get_positions()
    if pos_df is None or pos_df.empty:
        print(json.dumps({
            'has_positions': False,
            'net_delta': 0.0,
            'net_lot_delta': 0.0,
            'legs': [],
            'timestamp': datetime.now(timezone.utc).isoformat()
        }))
        return

    # 2. Filter to open option positions (NSE_FNO segment and non-zero quantity)
    opt_rows = []
    for _, row in pos_df.iterrows():
        seg = str(row.get('exchangeSegment', '') or '')
        opt_type = str(row.get('drvOptionType', '') or '')
        sym = str(row.get('tradingSymbol', '') or '')
        qty = int(row.get('netQty', 0) or 0)
        is_opt = seg == 'NSE_FNO' and (
            opt_type in ('CALL', 'PUT') or bool(re.search(r'-(CE|PE)', sym, re.I))
        )
        if is_opt and qty != 0:
            opt_rows.append(row)

    if not opt_rows:
        print(json.dumps({
            'has_positions': False,
            'net_delta': 0.0,
            'net_lot_delta': 0.0,
            'legs': [],
            'timestamp': datetime.now(timezone.utc).isoformat()
        }))
        return

    # Fetch live VIX as a fallback for option IV
    vix = 15.0
    try:
        vix_ltp = helper.get_ltp('INDIAVIX', exchange='IDX_I', instrument='INDEX')
        if vix_ltp and vix_ltp > 0:
            vix = float(vix_ltp)
    except Exception:
        pass

    # 3. Resolve security details from master list for each leg
    legs_data = []
    # Store unique combinations of (underlying, expiry) to fetch chains
    chains_to_fetch = set()

    for row in opt_rows:
        sid = str(row.get('securityId', '') or '')
        qty = int(row.get('netQty', 0) or 0)
        sym = str(row.get('tradingSymbol', '') or '')
        ltp = float(row.get('lastPrice', 0) or row.get('buyAvgPx', 0) or 0)
        entry_price = float(row.get('costPrice', 0) or 0)
        pnl = float(row.get('unrealizedProfit', 0) or 0)
        side = 'SELL' if qty < 0 else 'BUY'

        # Look up security details
        sec_info = helper.get_security_id(symbol=sid, quiet=True)
        if not sec_info:
            # Simple parsing fallback if security ID not resolved (highly unlikely)
            underlying = "NIFTY"
            expiry = datetime.now().strftime("%Y-%m-%d")
            strike = 24000.0
            opt_type = "CE"
            lot_size = 50
            display_name = sym
        else:
            underlying = sec_info.get('UNDERLYING_SYMBOL', 'NIFTY')
            expiry = sec_info.get('SM_EXPIRY_DATE')
            strike = float(sec_info.get('STRIKE_PRICE') or 0.0)
            opt_type = sec_info.get('OPTION_TYPE', 'CE')
            lot_size = int(sec_info.get('LOT_SIZE') or 50)
            display_name = sec_info.get('DISPLAY_NAME', sym)

        legs_data.append({
            'securityId': sid,
            'symbol': sym,
            'displayName': display_name,
            'underlying': underlying,
            'expiry': expiry,
            'strike': strike,
            'type': opt_type,
            'side': side,
            'netQty': qty,
            'ltp': round(ltp, 2),
            'entryPrice': round(entry_price, 2),
            'pnl': round(pnl, 2),
            'lotSize': lot_size,
        })

        if underlying and expiry:
            chains_to_fetch.add((underlying, expiry))

    # 4. Fetch option chains for all unique (underlying, expiry) groups
    chains_cache = {}
    spots_cache = {}

    for under, exp in chains_to_fetch:
        try:
            chain = helper.get_option_chain(under, exp)
            if chain:
                chains_cache[(under, exp)] = chain.get('oc', {})
                spots_cache[(under, exp)] = chain.get('spot', 0.0)
        except Exception as e:
            print(f"WARN: Failed to fetch option chain for {under} {exp}: {e}", file=sys.stderr)

    # 5. Compute delta for each leg and sum them
    total_net_delta = 0.0
    total_net_lot_delta = 0.0

    today_date = date.today()

    for leg in legs_data:
        under = leg['underlying']
        exp = leg['expiry']
        strike_val = leg['strike']
        opt_type = leg['type']
        qty = leg['netQty']
        lot_size = leg['lotSize']

        delta = 0.0
        iv = vix
        spot = spots_cache.get((under, exp), 0.0)

        # Fallback spot check if 0
        if spot <= 0:
            try:
                spot = helper.get_ltp(under, exchange='IDX_I', instrument='INDEX') or 0.0
            except Exception:
                pass
        
        leg['spot'] = spot

        oc = chains_cache.get((under, exp), {})
        
        # Look up strike in option chain
        matched_strike_data = None
        # Try exact numeric matching
        for oc_strike, strike_entry in oc.items():
            try:
                if abs(float(oc_strike) - strike_val) < 0.1:
                    matched_strike_data = strike_entry
                    break
            except ValueError:
                continue

        if matched_strike_data:
            side_entry = matched_strike_data.get(opt_type.lower(), {})
            delta = float(side_entry.get('greeks', {}).get('delta') or 0.0)
            iv = float(side_entry.get('implied_volatility') or side_entry.get('greeks', {}).get('iv') or 0.0)

        # 6. Apply Black-Scholes fallback if delta is 0 but we have a valid spot price
        if delta == 0.0 and spot > 0:
            try:
                exp_dt = datetime.strptime(exp, "%Y-%m-%d").date()
                days_diff = (exp_dt - today_date).days
                T = max(0.5, float(days_diff)) / 365.0
                delta = bs_delta(
                    S=spot,
                    K=strike_val,
                    T=T,
                    r=RISK_FREE_RATE,
                    sigma_pct=iv if iv > 0 else vix,
                    opt_type=opt_type
                )
            except Exception as bs_err:
                print(f"WARN: BS calculation failed for {leg['symbol']}: {bs_err}", file=sys.stderr)

        # For CE, delta is positive (0 to 1). For PE, delta is negative (-1 to 0).
        # Double check signs: CE buying increases delta (+), PE buying decreases delta (-)
        # Selling options has the opposite effect: short CE delta is negative, short PE delta is positive
        # positionDelta = netQty * delta
        position_delta = qty * delta
        lot_delta = (qty / lot_size) * delta

        leg['delta'] = round(delta, 4)
        leg['positionDelta'] = round(position_delta, 2)
        leg['lotDelta'] = round(lot_delta, 4)

        total_net_delta += position_delta
        total_net_lot_delta += lot_delta

    print(json.dumps({
        'has_positions': True,
        'net_delta': round(total_net_delta, 2),
        'net_lot_delta': round(total_net_lot_delta, 2),
        'legs': legs_data,
        'timestamp': datetime.now(timezone.utc).isoformat()
    }))

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(0)
