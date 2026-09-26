"""
One-off helper for the Next.js API to fetch options data via Python.

Usage:
    python options_data_fetch.py expiries --underlying NIFTY
    python options_data_fetch.py chain    --underlying NIFTY --expiry 2026-06-27
    python options_data_fetch.py ltp      --underlying NIFTY

Prints a single JSON line to stdout. Logs go to stderr.
"""
import sys
import os
import json
import time
import argparse

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Per-underlying instrument resolution, mirroring UNDERLYINGS in
# options_chart_fetch.py. Two things vary independently and are NOT
# interchangeable:
#   chain_id / chain_seg  - what the option-chain and expiry-list APIs key on
#   spot_id  / spot_seg   - the index's own security id, for LTP / prev close
#
# For the NSE indices the two happen to coincide. SENSEX is the exception, and
# getting it wrong fails silently: the chain keys on security id 1 / BSE_FNO,
# NOT the index's 51. Probe-verified against the live API on 2026-08-16 —
# (1, BSE_FNO) and (51, IDX_I) both return 170 strikes, while the previous
# mapping here (bare symbol "SENSEX", which resolves to 51 through the master
# list, + BSE_IDX) returns an EMPTY chain and an EMPTY expiry list. Beware when
# re-probing: DhanHelper.get_option_chain caches 5 s on (security_id, expiry),
# so a bad combination can appear to work off a prior call's cache entry.
UNDERLYINGS = {
    'NIFTY':     {'chain_id': 13, 'chain_seg': 'IDX_I',   'spot_id': 13, 'spot_seg': 'IDX_I'},
    'BANKNIFTY': {'chain_id': 25, 'chain_seg': 'IDX_I',   'spot_id': 25, 'spot_seg': 'IDX_I'},
    'FINNIFTY':  {'chain_id': 27, 'chain_seg': 'IDX_I',   'spot_id': 27, 'spot_seg': 'IDX_I'},
    # SENSEX index intraday is served under IDX_I — BSE_IDX returns DH-905.
    'SENSEX':    {'chain_id': 1,  'chain_seg': 'BSE_FNO', 'spot_id': 51, 'spot_seg': 'IDX_I'},
}


def _index_spot(helper, under: str) -> float:
    """LTP for one of the UNDERLYINGS indices.

    SENSEX needs the numeric security id: the bare symbol resolves through the
    BSE master list to exchange BSE_IDX, which the quote API answers with an
    empty payload (get_ltp then returns 0.0). Passing the id with exchange
    "NSE" routes it to IDX_I, where BSE index quotes actually live. The NSE
    indices are unaffected either way, so one path serves all of them.
    """
    meta = UNDERLYINGS[under]
    return helper.get_ltp(meta['spot_id'], exchange='NSE', instrument='INDEX') or 0


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd')

    p_exp = sub.add_parser('expiries')
    p_exp.add_argument('--underlying', default='NIFTY')

    p_chain = sub.add_parser('chain')
    p_chain.add_argument('--underlying', default='NIFTY')
    p_chain.add_argument('--expiry', required=True)

    p_ltp = sub.add_parser('ltp')
    p_ltp.add_argument('--underlying', default='NIFTY')

    # Resolve the nearest MCX futures contract to a security id, so a Node caller
    # can then quote it directly over Dhan's batch OHLC endpoint instead of paying
    # a Python spawn (~1.5s of master-list load) on every poll. The contract rolls
    # monthly, so callers should cache the answer per trading day, not forever.
    p_fut = sub.add_parser('futsid')
    p_fut.add_argument('--underlying', default='CRUDEOIL')

    p_vol = sub.add_parser('volsurface')
    p_vol.add_argument('--underlying', default='NIFTY')
    p_vol.add_argument('--count', type=int, default=5)
    p_vol.add_argument('--window-pct', type=float, default=8.0)

    args = parser.parse_args()

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'error': 'auth_failed — run login.py to refresh the access token'}))
        sys.exit(0)

    helper = DhanHelper(dhan)

    if args.cmd == 'expiries':
        under = args.underlying.upper()
        if under in ('CRUDEOIL', 'CRUDEOILM'):
            from scripts.tools.premarket_data import _find_nearest_future
            fut = _find_nearest_future(helper, under, exchange="MCX", instrument="FUTCOM")
            if not fut:
                print(json.dumps({'error': f'{under} future contract not found'}))
                sys.exit(0)
            uid = int(fut["SECURITY_ID"])
            seg = 'MCX_COMM'
        elif under in UNDERLYINGS:
            uid = UNDERLYINGS[under]['chain_id']
            seg = UNDERLYINGS[under]['chain_seg']
        else:
            # Not a known index — treat as an equity F&O underlying (e.g. a
            # Nifty 50 stock). get_expiry_list needs the raw security id +
            # segment (no auto-resolve like get_option_chain has).
            eq = helper.find_equity(under)
            if not eq:
                print(json.dumps({'error': f'unknown underlying: {args.underlying}'}))
                sys.exit(0)
            uid = int(eq['SECURITY_ID'])
            seg = 'NSE_EQ'
        expiries = helper.get_expiry_list(
            under_security_id=uid,
            under_exchange_segment=seg,
        )
        print(json.dumps({'expiries': expiries}))

    elif args.cmd == 'chain':
        under = args.underlying.upper()
        is_crude = under in ('CRUDEOIL', 'CRUDEOILM')
        is_index = under in UNDERLYINGS
        # Leave seg=None for equity underlyings — get_option_chain() auto-resolves
        # the symbol and its segment (NSE_EQ -> NSE_FNO) via the master list.
        seg = 'MCX_COMM' if is_crude else (UNDERLYINGS[under]['chain_seg'] if is_index else None)

        # Resolve the underlying the SAME way the expiries/ltp branches do so the
        # chain never diverges from the expiry list after a contract rolls over.
        # For crude, that means the nearest non-expired FUTCOM contract; passing
        # its numeric security id makes get_option_chain trust it directly
        # (bypassing the un-filtered iloc[0] symbol lookup).
        # For indices, pass the numeric chain id rather than the bare symbol so
        # get_option_chain trusts it directly instead of resolving through the
        # master list — "SENSEX" resolves to the index id 51, whose chain is empty.
        chain_symbol = str(UNDERLYINGS[under]['chain_id']) if is_index else under
        fut_sid = None
        if is_crude:
            from scripts.tools.premarket_data import _find_nearest_future
            fut = _find_nearest_future(helper, under, exchange="MCX", instrument="FUTCOM")
            if not fut:
                print(json.dumps({'error': f'{under} future contract not found'}))
                sys.exit(0)
            fut_sid = int(fut["SECURITY_ID"])
            chain_symbol = str(fut_sid)

        target_expiry = args.expiry
        if str(target_expiry).lower() == 'nearest':
            exp_uid = UNDERLYINGS[under]['chain_id'] if is_index else (fut_sid if is_crude else int(helper.find_equity(under)['SECURITY_ID']))
            exp_list = helper.get_expiry_list(
                under_security_id=exp_uid,
                under_exchange_segment=seg or 'NSE_FNO',
            )
            if exp_list:
                target_expiry = exp_list[0]
            else:
                print(json.dumps({'error': f'Failed to resolve nearest expiry for {under}'}))
                sys.exit(0)

        # Empty chain almost always means the Dhan option-chain API rate
        # limit (~1 call/3s per token) was hit — the helper's in-process
        # spacing can't protect across processes. Retry a few times with
        # growing backoff before giving up and reporting empty.
        chain = None
        for backoff in (0, 3.5, 5.0):
            if backoff:
                time.sleep(backoff)
            chain = helper.get_option_chain(
                symbol=chain_symbol,
                expiry=target_expiry,
                exchange_segment=seg,
            )
            if chain:
                break

        # For CRUDEOIL: always fetch a dedicated live OHLC quote for the
        # futures LTP — chain.last_price is a Dhan snapshot that can lag
        # the actual market price by several minutes. Also carries
        # prev_close/change/change_pct so the dashboard doesn't need a
        # second concurrent spawn (options/spot) just to show those.
        # For indices: chain.last_price is usually fresh enough; fall back
        # to a dedicated LTP call only when it is missing.
        spot = 0
        prev_close = 0.0
        if is_crude and fut_sid is not None:
            ohlc_raw = helper.get_ohlc_data({"MCX_COMM": [fut_sid]})
            entry = ohlc_raw.get("MCX_COMM", {}).get(str(fut_sid), {})
            spot = entry.get("last_price") or 0.0
            prev_close = entry.get("ohlc", {}).get("close") or 0.0
            if not spot:
                # Final fallback: dedicated LTP call
                spot = helper.get_ltp(fut_sid, exchange="MCX", instrument="FUTCOM") or 0.0
        else:
            # Index/equity: prefer chain snapshot, fall back to dedicated LTP
            spot = (chain or {}).get('last_price') or 0
            if not spot:
                if is_index:
                    spot = _index_spot(helper, under)
                else:
                    spot = helper.get_ltp(under, exchange='NSE', instrument='EQUITY') or 0
            levels = helper.get_prev_day_levels(under)
            prev_close = levels['close'] if levels else 0.0
        change = round(spot - prev_close, 2) if (spot > 0 and prev_close > 0) else 0.0
        change_pct = round(change / prev_close * 100, 4) if prev_close > 0 else 0.0

        # Resolve nearest unexpired future contract for Black-76 Greeks & futures basis
        future_price = 0.0
        future_symbol = ''
        future_expiry = ''
        future_basis = 0.0
        try:
            fut_exch = 'MCX' if is_crude else ('BSE' if under == 'SENSEX' else 'NSE')
            fut_inst = 'FUTCOM' if is_crude else 'FUTIDX'
            fut_seg = 'MCX_COMM' if is_crude else ('BSE_FNO' if under == 'SENSEX' else 'NSE_FNO')
            fut_sec = helper.find_future(under, exchange=fut_exch, instrument=fut_inst)
            if fut_sec:
                fut_id = int(fut_sec['SECURITY_ID'])
                # master_list.csv has no TRADING_SYMBOL column — find_future() returns the raw
                # row dict, so this always fell back to '' and future_symbol never populated.
                future_symbol = str(fut_sec.get('SYMBOL_NAME', ''))
                future_expiry = str(fut_sec.get('SM_EXPIRY_DATE', ''))
                fut_quote = helper.get_ltp(fut_id, exchange=fut_seg, instrument=fut_inst)
                if fut_quote and fut_quote > 0:
                    future_price = float(fut_quote)
                    if spot > 0:
                        future_basis = round(future_price - spot, 2)
        except Exception as e:
            sys.stderr.write(f"[options_data_fetch] Warn: could not resolve future for {under}: {e}\n")

        print(json.dumps({
            'chain': chain,
            'spot': spot,
            'prev_close': prev_close,
            'change': change,
            'change_pct': change_pct,
            'future_price': future_price,
            'future_symbol': future_symbol,
            'future_expiry': future_expiry,
            'future_basis': future_basis,
        }))

    elif args.cmd == 'ltp':
        under = args.underlying.upper()
        is_crude = under in ('CRUDEOIL', 'CRUDEOILM')
        if is_crude:
            from scripts.tools.premarket_data import _find_nearest_future
            fut = _find_nearest_future(helper, under, exchange="MCX", instrument="FUTCOM")
            if fut:
                sid = int(fut["SECURITY_ID"])
                ohlc_raw = helper.get_ohlc_data({"MCX_COMM": [sid]})
                entry = ohlc_raw.get("MCX_COMM", {}).get(str(sid), {})
                spot = entry.get("last_price") or 0.0
                prev_close = entry.get("ohlc", {}).get("close") or 0.0
            else:
                spot, prev_close = 0, 0.0
        elif under in UNDERLYINGS:
            spot = _index_spot(helper, under)
            levels = helper.get_prev_day_levels(under)
            prev_close = levels['close'] if levels else 0.0
        else:
            spot = helper.get_ltp(under, exchange='NSE', instrument='EQUITY') or 0
            levels = helper.get_prev_day_levels(under)
            prev_close = levels['close'] if levels else 0.0
        change = round(spot - prev_close, 2) if (spot > 0 and prev_close > 0) else 0.0
        change_pct = round(change / prev_close * 100, 4) if prev_close > 0 else 0.0
        print(json.dumps({
            'spot': spot,
            'prev_close': prev_close,
            'change': change,
            'change_pct': change_pct
        }))

    elif args.cmd == 'futsid':
        from scripts.tools.premarket_data import _find_nearest_future
        under = args.underlying.upper()
        fut = _find_nearest_future(helper, under, exchange="MCX", instrument="FUTCOM")
        if not fut:
            print(json.dumps({'error': f'{under} future contract not found'}))
            sys.exit(0)
        print(json.dumps({
            'security_id': int(fut["SECURITY_ID"]),
            'symbol': str(fut.get("SEM_TRADING_SYMBOL") or fut.get("SYMBOL_NAME") or under),
            'expiry': str(fut.get("SM_EXPIRY_DATE") or fut.get("EXPIRY_DATE") or ''),
            'segment': 'MCX_COMM',
        }))

    elif args.cmd == 'volsurface':
        from datetime import datetime, date
        under = args.underlying.upper()
        is_index = under in UNDERLYINGS
        if is_index:
            uid = UNDERLYINGS[under]['chain_id']
            seg = UNDERLYINGS[under]['chain_seg']
            chain_seg = UNDERLYINGS[under]['chain_seg']
            chain_symbol = str(UNDERLYINGS[under]['chain_id'])
            spot = _index_spot(helper, under)
        else:
            eq = helper.find_equity(under)
            if not eq:
                print(json.dumps({'error': f'unknown underlying: {args.underlying}'}))
                sys.exit(0)
            uid = int(eq['SECURITY_ID'])
            seg = 'NSE_EQ'
            chain_seg = None
            chain_symbol = under
            spot = helper.get_ltp(under, exchange='NSE', instrument='EQUITY') or 0.0

        all_expiries = helper.get_expiry_list(
            under_security_id=uid,
            under_exchange_segment=seg,
        )
        if not all_expiries:
            print(json.dumps({'error': f'no expiries found for {under}'}))
            sys.exit(0)

        expiries = all_expiries[:max(1, min(args.count, 8))]

        levels = helper.get_prev_day_levels(under)
        prev_close = levels['close'] if levels else 0.0

        # Fetch chains for chosen expiries
        chains_by_exp = {}
        for exp in expiries:
            c = helper.get_option_chain(symbol=chain_symbol, expiry=exp, exchange_segment=chain_seg)
            if c and c.get('oc'):
                chains_by_exp[exp] = c
                if (not spot or spot == 0) and c.get('last_price'):
                    spot = float(c['last_price'])

        if not chains_by_exp:
            print(json.dumps({'error': 'failed to fetch option chains (rate-limited or token expired)'}))
            sys.exit(0)

        change = round(spot - prev_close, 2) if (spot > 0 and prev_close > 0) else 0.0
        change_pct = round(change / prev_close * 100, 4) if prev_close > 0 else 0.0

        window_pct = max(2.0, min(args.window_pct, 25.0))
        lower_bound = spot * (1.0 - window_pct / 100.0) if spot > 0 else 0
        upper_bound = spot * (1.0 + window_pct / 100.0) if spot > 0 else 9999999

        # Collect union of valid strikes across chains within window
        all_strikes_set = set()
        for exp, c in chains_by_exp.items():
            for s_str in c.get('oc', {}).keys():
                try:
                    s_val = float(s_str)
                    if lower_bound <= s_val <= upper_bound:
                        all_strikes_set.add(s_val)
                except ValueError:
                    pass

        sorted_strikes = sorted(list(all_strikes_set))
        if not sorted_strikes:
            print(json.dumps({'error': 'no strikes found in range'}))
            sys.exit(0)

        def _get_entry(oc_map, strike_num):
            for k in (f"{strike_num:.6f}", f"{strike_num:.2f}", f"{strike_num:.1f}", str(int(strike_num)) if strike_num.is_integer() else str(strike_num), str(strike_num)):
                if k in oc_map:
                    return oc_map[k]
            return {}

        today = date.today()
        expiry_meta = []
        surface_grid = []
        ce_iv_grid = []
        pe_iv_grid = []
        delta_grid = []

        atm_strike = min(sorted_strikes, key=lambda s: abs(s - spot))
        strike_index = {s: i for i, s in enumerate(sorted_strikes)}
        last_known_atm_iv = 0.0  # carried across expiries as a last-resort fallback
        total_synthetic_points = 0
        # Only treat a delta match as a genuine 25-delta point within this tolerance;
        # a thin/narrow strike window can otherwise return e.g. a 0.12-delta strike
        # mislabeled as "25-delta".
        DELTA_TOLERANCE = 0.08

        for exp in expiries:
            if exp not in chains_by_exp:
                continue
            c = chains_by_exp[exp]
            oc = c.get('oc', {})

            try:
                exp_dt = datetime.strptime(exp, "%Y-%m-%d").date()
                dte = max(0.5, float((exp_dt - today).days))
            except Exception:
                dte = 1.0

            atm_oc = _get_entry(oc, atm_strike)
            atm_ce_iv = float((atm_oc.get('ce') or {}).get('implied_volatility') or 0.0)
            atm_pe_iv = float((atm_oc.get('pe') or {}).get('implied_volatility') or 0.0)
            atm_iv = atm_ce_iv if atm_ce_iv > 0 and atm_pe_iv <= 0 else (
                atm_pe_iv if atm_pe_iv > 0 and atm_ce_iv <= 0 else (
                    (atm_ce_iv + atm_pe_iv) / 2.0 if atm_ce_iv > 0 else 0.0
                )
            )

            row_iv = []
            row_ce_iv = []
            row_pe_iv = []
            row_delta = []
            total_oi = 0
            ce_total_oi = 0
            pe_total_oi = 0

            for s in sorted_strikes:
                s_entry = _get_entry(oc, s)
                ce = s_entry.get('ce') or {}
                pe = s_entry.get('pe') or {}

                civ = float(ce.get('implied_volatility') or 0.0)
                piv = float(pe.get('implied_volatility') or 0.0)
                cdelta = float((ce.get('greeks') or {}).get('delta') or 0.0)
                pdelta = float((pe.get('greeks') or {}).get('delta') or 0.0)
                coi = int(ce.get('oi') or ce.get('open_interest') or 0)
                poi = int(pe.get('oi') or pe.get('open_interest') or 0)

                ce_total_oi += coi
                pe_total_oi += poi
                total_oi += (coi + poi)

                # Composite smile: OTM Put for K < spot, OTM Call for K >= spot
                if s < spot:
                    comp_iv = piv if piv > 0.1 else civ
                    eff_delta = pdelta if abs(pdelta) > 0.001 else (cdelta - 1.0)
                else:
                    comp_iv = civ if civ > 0.1 else piv
                    eff_delta = cdelta if abs(cdelta) > 0.001 else (pdelta + 1.0)

                row_ce_iv.append(round(civ, 2))
                row_pe_iv.append(round(piv, 2))
                row_iv.append(round(comp_iv, 2))
                row_delta.append(round(eff_delta, 3))

            # Interpolate zero-holes across adjacent strikes
            row_synthetic = [False] * len(row_iv)
            for i in range(len(row_iv)):
                if row_iv[i] <= 0.1:
                    prev_val = next((row_iv[j] for j in range(i - 1, -1, -1) if row_iv[j] > 0.1), None)
                    next_val = next((row_iv[j] for j in range(i + 1, len(row_iv)) if row_iv[j] > 0.1), None)
                    if prev_val and next_val:
                        row_iv[i] = round((prev_val + next_val) / 2.0, 2)
                    elif prev_val:
                        row_iv[i] = prev_val
                    elif next_val:
                        row_iv[i] = next_val
                    elif atm_iv > 0:
                        row_iv[i] = round(atm_iv, 2)
                        row_synthetic[i] = True
                    else:
                        # No real IV anywhere in this row and no ATM reading either —
                        # fall back to the last expiry that did have a real ATM IV
                        # rather than an arbitrary constant, and flag it as synthetic
                        # so callers (API/UI) can distinguish it from market data.
                        row_iv[i] = round(last_known_atm_iv, 2) if last_known_atm_iv > 0 else 15.0
                        row_synthetic[i] = True

            synthetic_points = sum(1 for flag in row_synthetic if flag)
            total_synthetic_points += synthetic_points

            surface_grid.append(row_iv)
            ce_iv_grid.append(row_ce_iv)
            pe_iv_grid.append(row_pe_iv)
            delta_grid.append(row_delta)

            if atm_iv <= 0.1:
                atm_idx = strike_index[atm_strike]
                atm_iv = row_iv[atm_idx]
            if atm_iv > 0:
                last_known_atm_iv = atm_iv

            # 25-Delta Skew calculation (Risk Reversal) — only accept a strike as the
            # 25-delta point if its delta is actually within tolerance; a narrow strike
            # window can otherwise mislabel a near-ATM or arbitrary-delta strike as "25d".
            c25_strike = min(sorted_strikes, key=lambda s: abs(row_delta[strike_index[s]] - 0.25))
            p25_strike = min(sorted_strikes, key=lambda s: abs(row_delta[strike_index[s]] - (-0.25)))
            c25_delta_err = abs(row_delta[strike_index[c25_strike]] - 0.25)
            p25_delta_err = abs(row_delta[strike_index[p25_strike]] - (-0.25))
            c25_valid = c25_delta_err <= DELTA_TOLERANCE
            p25_valid = p25_delta_err <= DELTA_TOLERANCE
            c25_iv = row_iv[strike_index[c25_strike]] if c25_valid else None
            p25_iv = row_iv[strike_index[p25_strike]] if p25_valid else None
            rr_25d = round(p25_iv - c25_iv, 2) if (c25_valid and p25_valid) else None

            pcr = round(pe_total_oi / ce_total_oi, 2) if ce_total_oi > 0 else 1.0

            expiry_meta.append({
                'expiry': exp,
                'dte': dte,
                'atm_strike': atm_strike,
                'atm_iv': round(atm_iv, 2),
                'rr_25d': rr_25d,
                'p25_iv': round(p25_iv, 2) if p25_iv is not None else None,
                'c25_iv': round(c25_iv, 2) if c25_iv is not None else None,
                'pcr': pcr,
                'total_oi': total_oi,
                'synthetic_points': synthetic_points,
            })

        # Term structure analysis
        front_iv = expiry_meta[0]['atm_iv'] if expiry_meta else 0.0
        back_iv = expiry_meta[-1]['atm_iv'] if len(expiry_meta) > 1 else front_iv
        spread_front_back = round(front_iv - back_iv, 2)

        if spread_front_back >= 1.5:
            regime = 'BACKWARDATION'
            regime_label = 'Inverted / Front-Month Vol Spike'
            regime_desc = 'Front-month implied volatility is elevated relative to back-month tenors. Calendar spreads selling front vol and buying back vol (or long calendar debit spreads) are favored.'
            calendar_play = 'Sell Front Vol / Buy Back Vol (Calendar Premium Seller)'
        elif spread_front_back <= -1.5:
            regime = 'CONTANGO'
            regime_label = 'Upward Sloping / Normal Contango'
            regime_desc = 'Longer-dated options trade at higher IV than near-term options. Long calendar spreads (buying long-dated vol, financing with short-dated decay) are favored.'
            calendar_play = 'Buy Front Vol / Sell Back Vol (Long Calendar Catalyst)'
        else:
            regime = 'FLAT'
            regime_label = 'Flat Term Structure'
            regime_desc = 'Implied volatility is uniform across tenors. Term structure slope is neutral.'
            calendar_play = 'Neutral Calendar / Strike Skew Arbitrage'

        print(json.dumps({
            'underlying': under,
            'spot': spot,
            'prev_close': prev_close,
            'change': change,
            'change_pct': change_pct,
            'strikes': sorted_strikes,
            'expiries': expiry_meta,
            'surface': surface_grid,
            'ce_surface': ce_iv_grid,
            'pe_surface': pe_iv_grid,
            'delta_surface': delta_grid,
            'has_synthetic_data': total_synthetic_points > 0,
            'term_structure': {
                'front_iv': front_iv,
                'back_iv': back_iv,
                'spread': spread_front_back,
                'regime': regime,
                'regime_label': regime_label,
                'regime_desc': regime_desc,
                'calendar_play': calendar_play,
            }
        }))

    else:
        print(json.dumps({'error': 'unknown command'}))
        sys.exit(0)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(0)
