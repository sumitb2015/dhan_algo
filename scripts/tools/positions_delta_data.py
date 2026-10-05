"""
Fetch open F&O option positions and map them with live option chain Greeks (specifically delta).
Returns JSON string with individual and net deltas.
"""
import sys
import os
import json
import re
import math
import time
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

def _b76_price(F, K, T, r, sigma, opt_type):
    d1 = (math.log(F / K) + 0.5 * sigma ** 2 * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    df = math.exp(-r * T)
    if opt_type.upper() == "CE":
        return df * (F * _norm_cdf(d1) - K * _norm_cdf(d2))
    return df * (K * _norm_cdf(-d2) - F * _norm_cdf(-d1))

def b76_greeks_from_price(F, K, T, r, price, opt_type):
    """Black-76 Greeks with IV backed out of the live option price (bisection).

    The broker's analyzer prices off the futures and the traded premium; Dhan's
    chain-supplied delta drifted ~0.2 lots away from it on a 13-lot book.
    Per-unit result: delta, gamma, vega (per 1 vol point), theta (price change
    per calendar day), iv (%). None when the price is below intrinsic/unsolvable.
    """
    if F <= 0 or K <= 0 or T <= 0 or price <= 0:
        return None
    lo, hi = 0.01, 3.0
    try:
        if not (_b76_price(F, K, T, r, lo, opt_type) <= price <= _b76_price(F, K, T, r, hi, opt_type)):
            return None
        for _ in range(60):
            mid = (lo + hi) / 2
            if _b76_price(F, K, T, r, mid, opt_type) < price:
                lo = mid
            else:
                hi = mid
        sigma = (lo + hi) / 2
        sq = math.sqrt(T)
        d1 = (math.log(F / K) + 0.5 * sigma ** 2 * T) / (sigma * sq)
        df = math.exp(-r * T)
        delta = df * _norm_cdf(d1) if opt_type.upper() == "CE" else df * (_norm_cdf(d1) - 1.0)
        T1 = max(T - 1.0 / 365.0, 1e-6)
        d1b = (math.log(F / K) + 0.5 * sigma ** 2 * T1) / (sigma * math.sqrt(T1))
        delta_next = df * _norm_cdf(d1b) if opt_type.upper() == "CE" else df * (_norm_cdf(d1b) - 1.0)
        d2 = d1 - sigma * sq
        vega_raw = df * F * _norm_pdf(d1) * sq
        return {
            'delta': delta,
            'gamma': df * _norm_pdf(d1) / (F * sigma * sq),
            'vega': vega_raw / 100.0,
            'theta': _b76_price(F, K, T1, r, sigma, opt_type) - price,
            'rho': -T * price / 100.0,                       # per +1% rate
            'vanna': -df * _norm_pdf(d1) * d2 / sigma / 100.0,  # delta change per +1 vol pt
            'vomma': vega_raw * d1 * d2 / sigma / 10000.0,      # vega change per +1 vol pt
            'charm': delta_next - delta,                      # delta change per calendar day
            'iv': sigma * 100.0,
        }
    except Exception:
        return None

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
            # Ask the library rather than carry a literal: delta exposure scales
            # linearly with the lot size, and this file's old default of 50 has
            # been wrong since the contract was revised (75, now 65).
            lot_size = helper.get_lot_size(underlying) or 0
            display_name = sym
        else:
            underlying = sec_info.get('UNDERLYING_SYMBOL', 'NIFTY')
            expiry = sec_info.get('SM_EXPIRY_DATE')
            strike = float(sec_info.get('STRIKE_PRICE') or 0.0)
            opt_type = sec_info.get('OPTION_TYPE', 'CE')
            lot_size = int(sec_info.get('LOT_SIZE') or 0) or (helper.get_lot_size(underlying) or 0)
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
    net_greeks = {'gamma': 0.0, 'vega': 0.0, 'theta': 0.0}  # lot-weighted
    net_greeks_units = {'gamma': 0.0, 'vega': 0.0, 'theta': 0.0}
    # Broker Position Analyzer 'Decimals' basis: each leg counts as ONE lot (sign only).
    one_lot = {'delta': 0.0, 'gamma': 0.0, 'vega': 0.0, 'theta': 0.0}

    today_date = date.today()

    # Nearest futures per underlying = the forward the broker prices options off
    futs_cache = {}
    for under in {l['underlying'] for l in legs_data}:
        try:
            f = helper.find_future(under)
            fexp = datetime.strptime(f['SM_EXPIRY_DATE'], "%Y-%m-%d").date()
            fpx = float(helper.get_future_ltp(under, f['SM_EXPIRY_DATE']) or 0.0)
            if fpx > 0:
                futs_cache[under] = {'price': fpx, 'T': max(0.5, float((fexp - today_date).days)) / 365.0}
        except Exception as e:
            print(f"WARN: no futures forward for {under}: {e}", file=sys.stderr)

    under_spot, spot_src = {}, {}
    for leg in legs_data:
        under = leg['underlying']
        exp = leg['expiry']
        strike_val = leg['strike']
        opt_type = leg['type']
        qty = leg['netQty']
        lot_size = leg['lotSize']

        delta = 0.0
        iv = vix
        spot = under_spot.get(under)
        if spot is None:
            # One spot per underlying keeps every leg of the book on the same level:
            # chain spot, else the index quote (one retry past the 1 req/s limit), else futures.
            spot = next((v for (u, _e), v in spots_cache.items() if u == under and v and v > 0), 0.0)
            for attempt in range(2):
                if spot > 0:
                    break
                try:
                    spot = float(helper.get_ltp(under, exchange='IDX_I', instrument='INDEX') or 0.0)
                except Exception:
                    spot = 0.0
                if spot <= 0 and attempt == 0:
                    time.sleep(1.2)
            if spot <= 0 and futs_cache.get(under):
                spot = futs_cache[under]['price'] * math.exp(-RISK_FREE_RATE * futs_cache[under]['T'])
                spot_src[under] = 'futures'
            under_spot[under] = spot
        if spot_src.get(under):
            leg['spotSource'] = spot_src[under]

        leg['spot'] = round(spot, 2)

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
            # Dhan's positions payload carries no lastPrice, so leg LTP starts at 0.
            if not leg['ltp']:
                leg['ltp'] = round(float(side_entry.get('last_price') or 0.0), 2)

        if not leg['ltp']:
            try:
                leg['ltp'] = round(float(helper.get_ltp(
                    leg['securityId'], exchange='NSE_FNO', instrument='OPTIDX') or 0.0), 2)
            except Exception:
                pass

        # Prefer a delta solved from the live premium on the futures (matches the
        # broker's Position Analyzer); keep the chain delta if that can't be solved.
        try:
            exp_dt = datetime.strptime(exp, "%Y-%m-%d").date()
            T_leg = max(0.5, float((exp_dt - today_date).days)) / 365.0
            fut = futs_cache.get(under)
            if fut and leg['ltp'] > 0:
                F = fut['price'] * math.exp(-RISK_FREE_RATE * (fut['T'] - T_leg))
            else:
                F = spot * math.exp(RISK_FREE_RATE * T_leg) if spot > 0 else 0.0
            g76 = b76_greeks_from_price(F, strike_val, T_leg, RISK_FREE_RATE, leg['ltp'], opt_type)
            if g76 is not None:
                delta = g76['delta']
                leg['gamma'] = g76['gamma']
                leg['vega'] = g76['vega']
                leg['theta'] = g76['theta']
                for gk in ('rho', 'vanna', 'vomma', 'charm', 'iv'):
                    leg[gk] = g76[gk]
                leg['forward'] = round(F, 2)
                leg['tYears'] = T_leg
                leg['greeksSource'] = 'black76'
        except Exception as e76:
            print(f"WARN: Black-76 delta failed for {leg['symbol']}: {e76}", file=sys.stderr)

        if 'gamma' not in leg and matched_strike_data:
            cg = matched_strike_data.get(opt_type.lower(), {}).get('greeks', {}) or {}
            for gk in ('gamma', 'vega', 'theta'):
                leg[gk] = float(cg.get(gk) or 0.0)
            leg['iv'] = iv
            leg['forward'] = round(spot, 2)
            leg['tYears'] = max(0.5, float((datetime.strptime(exp, "%Y-%m-%d").date() - today_date).days)) / 365.0
            leg['greeksSource'] = 'chain'

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

        for gk in ('gamma', 'vega', 'theta'):
            leg[gk] = round(float(leg.get(gk) or 0.0), 6)
            net_greeks[gk] += (qty / lot_size) * leg[gk]
            net_greeks_units[gk] += qty * leg[gk]

        sgn = 1 if qty > 0 else -1
        one_lot['delta'] += sgn * delta
        for gk in ('gamma', 'vega', 'theta'):
            one_lot[gk] += sgn * leg[gk]

        total_net_delta += position_delta
        total_net_lot_delta += lot_delta

    print(json.dumps({
        'has_positions': True,
        'net_delta': round(total_net_delta, 2),
        'net_lot_delta': round(total_net_lot_delta, 2),
        'net_gamma': round(net_greeks['gamma'], 5),
        'net_vega': round(net_greeks['vega'], 3),
        'net_theta': round(net_greeks['theta'], 3),
        'net_gamma_units': round(net_greeks_units['gamma'], 4),
        'net_vega_units': round(net_greeks_units['vega'], 2),
        'net_theta_units': round(net_greeks_units['theta'], 2),
        'broker_basis': {k: round(v, 6) for k, v in one_lot.items()},
        'legs': legs_data,
        'timestamp': datetime.now(timezone.utc).isoformat()
    }))

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(0)
