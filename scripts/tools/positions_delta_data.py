"""
Fetch the raw inputs the Portfolio Greeks page (/options/delta) needs for the open NSE F&O option legs.

DATA ONLY — no pricing maths lives here. Implied volatility, every Greek, the forward roll and the spot-from-futures
estimate are computed in the browser by rs_dashboard/lib/optionsPricing.ts (the single options-maths library), so a
number can only be wrong in one place.

Prints one JSON line:
  has_positions, timestamp, legs[]
Each leg: securityId, symbol, displayName, underlying, expiry, strike, type (CE/PE), side, netQty, lotSize,
  ltp (chain last_price, else get_ltp — Dhan's positions payload has no last price), entryPrice (costPrice), pnl,
  spot (chain spot, else index quote after one retry, else 0 — the page then estimates it from futPrice),
  atmIv (percent, ATM IV of this leg's expiry), futPrice / futExpiry (nearest monthly future, the Black-76 forward),
  chainGreeks {delta,gamma,theta,vega,iv} (Dhan's own chain values; fallback only when a leg has no live price).
"""
import sys
import os
import json
import re
import time
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper


def _empty():
    return {
        'has_positions': False,
        'legs': [],
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }


def _num(v, default=0.0):
    try:
        return float(v) if v is not None else default
    except (TypeError, ValueError):
        return default


def main():
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'error': 'auth_failed'}))
        return

    helper = DhanHelper(dhan)

    # 1. Live positions
    pos_df = helper.get_positions()
    if pos_df is None or pos_df.empty:
        print(json.dumps(_empty()))
        return

    # 2. Open NSE F&O option legs
    opt_rows = []
    for _, row in pos_df.iterrows():
        seg = str(row.get('exchangeSegment', '') or '')
        opt_type = str(row.get('drvOptionType', '') or '')
        sym = str(row.get('tradingSymbol', '') or '')
        qty = int(row.get('netQty', 0) or 0)
        is_opt = seg == 'NSE_FNO' and (opt_type in ('CALL', 'PUT') or bool(re.search(r'-(CE|PE)', sym, re.I)))
        if is_opt and qty != 0:
            opt_rows.append(row)

    if not opt_rows:
        print(json.dumps(_empty()))
        return

    # 3. Contract details from the master list
    legs = []
    chains_to_fetch = set()
    for row in opt_rows:
        sid = str(row.get('securityId', '') or '')
        qty = int(row.get('netQty', 0) or 0)
        sym = str(row.get('tradingSymbol', '') or '')
        sec = helper.get_security_id(symbol=sid, quiet=True)
        if not sec:
            # Unresolvable contract: skip rather than invent strike/expiry. The page shows fewer legs, not wrong ones.
            print(f"WARN: security {sid} ({sym}) not in master list; skipped", file=sys.stderr)
            continue
        underlying = sec.get('UNDERLYING_SYMBOL', 'NIFTY')
        expiry = sec.get('SM_EXPIRY_DATE')
        legs.append({
            'securityId': sid,
            'symbol': sym,
            'displayName': sec.get('DISPLAY_NAME', sym),
            'underlying': underlying,
            'expiry': expiry,
            'strike': _num(sec.get('STRIKE_PRICE')),
            'type': sec.get('OPTION_TYPE', 'CE'),
            'side': 'SELL' if qty < 0 else 'BUY',
            'netQty': qty,
            'lotSize': int(sec.get('LOT_SIZE') or 0) or (helper.get_lot_size(underlying) or 0),
            'ltp': 0.0,
            'entryPrice': round(_num(row.get('costPrice')), 2),
            'pnl': round(_num(row.get('unrealizedProfit')), 2),
        })
        if underlying and expiry:
            chains_to_fetch.add((underlying, expiry))

    # 4. One option chain per (underlying, expiry)
    chains, chain_spots = {}, {}
    for under, exp in chains_to_fetch:
        try:
            chain = helper.get_option_chain(under, exp)
            if chain:
                chains[(under, exp)] = chain.get('oc', {}) or {}
                chain_spots[(under, exp)] = _num(chain.get('spot'))
        except Exception as e:
            print(f"WARN: option chain failed for {under} {exp}: {e}", file=sys.stderr)

    # 5. Nearest future per underlying = the Black-76 forward
    futs = {}
    for under in {l['underlying'] for l in legs}:
        try:
            f = helper.find_future(under)
            price = _num(helper.get_future_ltp(under, f['SM_EXPIRY_DATE']))
            if price > 0:
                futs[under] = {'price': price, 'expiry': f['SM_EXPIRY_DATE']}
        except Exception as e:
            print(f"WARN: no future for {under}: {e}", file=sys.stderr)

    # 6. One spot per underlying (chain spot -> index quote, one retry past the ~1 req/s limit -> 0)
    spots = {}

    def spot_for(under):
        if under in spots:
            return spots[under]
        spot = next((v for (u, _e), v in chain_spots.items() if u == under and v > 0), 0.0)
        for attempt in range(2):
            if spot > 0:
                break
            try:
                spot = _num(helper.get_ltp(under, exchange='IDX_I', instrument='INDEX'))
            except Exception:
                spot = 0.0
            if spot <= 0 and attempt == 0:
                time.sleep(1.2)
        spots[under] = spot
        return spot

    # 7. Attach per-leg market data
    for leg in legs:
        under, exp, strike = leg['underlying'], leg['expiry'], leg['strike']
        oc = chains.get((under, exp), {})
        side_key = leg['type'].lower()

        entry = None
        for k, v in oc.items():
            try:
                if abs(float(k) - strike) < 0.1:
                    entry = (v or {}).get(side_key) or {}
                    break
            except ValueError:
                continue

        if entry:
            leg['ltp'] = round(_num(entry.get('last_price')), 2)
            g = entry.get('greeks') or {}
            leg['chainGreeks'] = {
                'delta': _num(g.get('delta')), 'gamma': _num(g.get('gamma')),
                'theta': _num(g.get('theta')), 'vega': _num(g.get('vega')),
                'iv': _num(entry.get('implied_volatility')),
            }
        if not leg['ltp']:
            try:
                leg['ltp'] = round(_num(helper.get_ltp(leg['securityId'], exchange='NSE_FNO', instrument='OPTIDX')), 2)
            except Exception:
                pass

        # ATM IV of this expiry (SD bands use ATM IV, never VIX and never the leg's own strike IV)
        try:
            spot_ref = spot_for(under)
            atm_k = min((k for k in oc if float(k) > 0), key=lambda k: abs(float(k) - spot_ref), default=None)
            if atm_k is not None:
                ivs = [_num((oc[atm_k].get(s) or {}).get('implied_volatility')) for s in ('ce', 'pe')]
                ivs = [v for v in ivs if v > 0]
                if ivs:
                    leg['atmIv'] = round(sum(ivs) / len(ivs), 3)
        except Exception:
            pass

        leg['spot'] = round(spot_for(under), 2)
        if under in futs:
            leg['futPrice'] = futs[under]['price']
            leg['futExpiry'] = futs[under]['expiry']

    print(json.dumps({
        'has_positions': bool(legs),
        'legs': legs,
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(0)
