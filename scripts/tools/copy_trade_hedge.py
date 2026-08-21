"""
Startup OTM hedging for the Dhan->Zerodha copy-trade bridge.

Problem this solves: the Zerodha child account has less margin capacity than the
Dhan parent, so the parent can open positions the child cannot afford. That is
not hypothetical — on 2026-07-27 and 07-28 the bridge's retry queue exhausted on
Zerodha "Insufficient funds" (short by Rs 26,270 and Rs 9,925), leaving the two
accounts desynced.

Mechanism: buying a far-OTM option turns a naked short into a spread, which
collapses its SPAN requirement. Measured live on 2026-07-30 for NIFTY:

    SELL 1 lot 24000CE naked                 margin Rs 1,71,509
    SELL 1 lot 24000CE + BUY 1 lot 25000CE   margin Rs   73,875   (-57%)
    ...for Rs 169 of premium (25000CE @ 2.60 x 65)

So ~Rs 169 of premium frees ~Rs 97,634 of margin. Buying a few cheap hedges up
front raises the child's lot capacity to match the parent's, which removes the
shortfalls at their source instead of blocking trades after the fact.

Selection rule: among contracts priced at or below `premium_cap`, take the one
NEAREST to spot. Cheapness bounds the cash cost; nearest-to-spot maximises the
hedge benefit per rupee spent.

Three constraints that are easy to get wrong (all verified, see notes inline):
  1. The hedge's product MUST match the short's product. SELL MIS + BUY NRML
     yields ZERO benefit.
  2. Option premium is a CASH debit and cannot be paid from pledged collateral.
     Sizing is bounded by `available.live_balance`, not by `net`.
  3. Hedges must never enter the bridge's replicated-symbol set, or its safety
     watchdog force-closes them the moment the parent goes flat.

Safe by default: places nothing unless called with armed=True (or --live on the
CLI), matching the rest of this repo.

Usage:
    venv\\Scripts\\python.exe scripts/tools/copy_trade_hedge.py            # dry run
    venv\\Scripts\\python.exe scripts/tools/copy_trade_hedge.py --json
    venv\\Scripts\\python.exe scripts/tools/copy_trade_hedge.py --live     # really buys
"""
import sys
import os
import json
import math
import argparse
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

from lib.zerodha.margin import (  # noqa: E402
    get_margin_snapshot, get_required_margin, build_order_param,
)

DEBUG_DIR  = os.path.join(ROOT, 'debug')
HEDGE_FILE = os.path.join(DEBUG_DIR, 'copy_trade_hedges.json')

# Kite's quote endpoint caps instruments per request; one NIFTY expiry is ~186
# contracts so this is really only a guard for multi-expiry callers.
QUOTE_BATCH = 400

# Ceiling on the search for "how many hedge lots do we need". Independent of the
# config's hedge_max_lots (which is the user's own cap) — this only stops the
# solver looping forever if hedging somehow fails to improve capacity.
SOLVER_MAX_LOTS = 50


def read_json(path, default):
    try:
        if not os.path.exists(path):
            return default
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def atomic_write(path, data) -> bool:
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w') as f:
            json.dump(data, f, indent=1)
        os.replace(tmp, path)
        return True
    except Exception as e:
        print(f'[copy_trade_hedge] Warning: failed to write {path} ({e})', flush=True)
        return False


def load_hedge_state() -> dict:
    """Today's hedge state, or an empty record.

    Scoped to today because hedges are per-expiry and per-day: carrying
    yesterday's symbols forward would make the bridge 'adopt' positions that no
    longer exist and skip hedging entirely.
    """
    data = read_json(HEDGE_FILE, {})
    if not isinstance(data, dict) or data.get('date') != datetime.now().strftime('%Y-%m-%d'):
        return {'date': datetime.now().strftime('%Y-%m-%d'), 'hedges': [], 'premium_paid': 0.0}
    data.setdefault('hedges', [])
    data.setdefault('premium_paid', 0.0)
    return data


def save_hedge_state(state: dict) -> bool:
    state['date'] = datetime.now().strftime('%Y-%m-%d')
    state['updated_at'] = datetime.now().isoformat()
    return atomic_write(HEDGE_FILE, state)


def entry_broker(h: dict) -> str:
    """Which child account a hedge entry belongs to.

    Entries written before the reactive child hedge existed carry no `broker`
    key and are all Zerodha, so that is the default. Every caller must go
    through this rather than reading the key directly, or legacy entries would
    silently belong to nobody.
    """
    return str(h.get('broker') or 'zerodha').lower()


def hedge_qty_today(broker: str = 'zerodha') -> dict:
    """{symbol: long qty} the bridge holds as hedges today for `broker`.

    Quantities, not just symbols, because the safety watchdog must be able to
    NET the hedge out of a position rather than skip the symbol wholesale. The
    hedge sits only ~600 points OTM, so the parent rolling into that strike
    during the day is realistic — and a symbol-level exclusion would then hide a
    genuinely orphaned short from the watchdog, which is the one thing it exists
    to catch.

    Scoped per broker because the same strike can be hedged in more than one
    child account: netting Kotak's hedge out of a Zerodha position would hide a
    real orphan there.

    Uses placed_qty where known (what actually went through) and falls back to
    the intended qty for entries recorded just before a crash.
    """
    out = {}
    for h in load_hedge_state().get('hedges', []):
        sym = h.get('symbol')
        if not sym or entry_broker(h) != str(broker).lower():
            continue
        # Squared off earlier today: counting it would net a phantom long out of
        # the safety exit, which then over-closes a real short at that strike
        # (residual = -130 - 130 -> BUY 260) and flips it into a naked long.
        if h.get('closed_at'):
            continue
        q = h.get('placed_qty')
        if q is None:
            q = h.get('qty') or 0
        try:
            out[sym] = out.get(sym, 0) + int(q)
        except (TypeError, ValueError):
            continue
    return out


def hedge_symbols_today(broker: str = None) -> set:
    """Symbols the bridge holds (or intended to hold) as hedges today.

    The bridge uses this to keep hedges OUT of its watchdog close scope, and
    copy_trade_reconcile uses it to avoid reporting them as zombies. Includes
    intended-but-unconfirmed hedges on purpose: a crash between 'about to buy'
    and 'bought' must not leave a position nothing knows about.

    `broker=None` returns every child's hedge symbols, which is what the
    zombie check wants — a symbol hedged anywhere is never a zombie.
    """
    return {h.get('symbol') for h in load_hedge_state().get('hedges', [])
            if h.get('symbol') and (broker is None or entry_broker(h) == str(broker).lower())}


def child_hedge_lots_today(broker: str) -> int:
    """Hedge lots bought for `broker` today — the daily cap's running total.

    Read from the state file rather than a counter in memory so the cap
    survives a bridge restart; load_hedge_state is day-scoped, so it resets
    itself at the date rollover without any explicit cleanup.
    """
    total = 0
    for h in load_hedge_state().get('hedges', []):
        if entry_broker(h) != str(broker).lower():
            continue
        try:
            total += int(h.get('lots') or 0)
        except (TypeError, ValueError):
            continue
    return total


def get_spot(kite) -> float:
    q = kite.ltp(['NSE:NIFTY 50'])
    return float(q['NSE:NIFTY 50']['last_price'])


def pick_hedge_candidates(kite, instruments, expiry: str, spot: float, premium_cap: float):
    """Cheapest-under-cap, nearest-to-spot CE and PE for `expiry`.

    Returns ({'CE': {...}, 'PE': {...}}, error). A leg is absent from the dict if
    nothing in the chain met the cap.
    """
    chain = [i for i in instruments if i.get('expiry') == expiry]
    if not chain:
        return {}, f'no contracts for expiry {expiry} in the instrument cache'

    quotes = {}
    syms = ['NFO:' + i['tradingsymbol'] for i in chain]
    try:
        for i in range(0, len(syms), QUOTE_BATCH):
            quotes.update(kite.quote(syms[i:i + QUOTE_BATCH]))
    except Exception as e:
        return {}, f'quote fetch failed: {e}'

    picks = {}
    for opt_type in ('CE', 'PE'):
        affordable = []
        for c in chain:
            if c.get('instrument_type') != opt_type:
                continue
            q = quotes.get('NFO:' + c['tradingsymbol'])
            if not q:
                continue
            ltp = float(q.get('last_price') or 0.0)
            # ltp > 0 filters illiquid/untraded strikes that would quote 0 and
            # look 'free' while being unfillable.
            if 0 < ltp <= premium_cap:
                affordable.append((abs(float(c['strike']) - spot), c, ltp))
        if not affordable:
            continue
        affordable.sort(key=lambda t: t[0])
        _, c, ltp = affordable[0]
        picks[opt_type] = {
            'symbol': c['tradingsymbol'],
            'strike': float(c['strike']),
            'opt_type': opt_type,
            'lot_size': int(c.get('lot_size') or 65),
            'ltp': ltp,
            'premium_per_lot': round(ltp * int(c.get('lot_size') or 65), 2),
        }
    return picks, None


def reference_legs(atm_strike: float, lots: int):
    """The position shape used as the capacity yardstick, as (strike, type, lots).

    A short STRADDLE (CE + PE at the ATM strike), not a single leg. This is not a
    cosmetic choice — it was the source of a real under-hedging bug.

    SPAN prices a two-sided book very differently from one leg, and the parent's
    main strategy group (value_imbalance) sells straddles/strangles. Measured
    2026-07-30 on Zerodha, per hedge lot added:

        single ATM CE leg   saves Rs 1,06,012/hedge lot
        ATM straddle        saves Rs   79,921/hedge lot

    So modelling one leg both over-states the parent's lot capacity AND
    over-states each hedge lot's benefit. For 8 straddle lots it concluded 1
    hedge lot was enough when the true answer is 2 — the child would have been
    left Rs 17,278 short, i.e. exactly the "Insufficient funds" desync this whole
    mechanism exists to prevent.

    The straddle is also the conservative choice: it needs more margin for a
    given lot count than a single leg, so capacity is never over-stated.
    """
    return [
        {'strike': atm_strike, 'type': 'CE', 'side': 'SELL', 'qtyLots': lots},
        {'strike': atm_strike, 'type': 'PE', 'side': 'SELL', 'qtyLots': lots},
    ]


def dhan_capacity(helper, underlying: str, expiry: str, atm_strike: float, product_type: str = 'MARGIN'):
    """(available_funds, margin_per_lot, max_lots, error) for the Dhan parent.

    `margin_per_lot` and `max_lots` are per STRADDLE lot (see reference_legs).

    One measurement suffices: Dhan's margin for N short straddles is exactly
    linear (verified 2026-07-30 — Rs 2,04,876.62 x N held at N = 1, 4, 8, 9, 10,
    11 to the paisa), because Dhan grants no portfolio benefit for scaling an
    unhedged position. The Zerodha side is measured per candidate hedge size
    instead, since there the benefit is precisely what we are buying.
    """
    try:
        funds = float(helper.get_available_funds() or 0.0)
    except Exception as e:
        return None, None, None, f'Dhan funds call failed: {e}'
    if funds <= 0:
        # get_available_funds() returns 0.0 both for an empty account and for an
        # API failure, so this is genuinely ambiguous — say so rather than
        # reporting a capacity of zero as fact.
        return None, None, None, 'Dhan available funds reported as 0 (empty account, or a silent API failure)'
    try:
        scripts = helper.resolve_option_legs_to_margin_scripts(
            reference_legs(atm_strike, 1),
            underlying=underlying, expiry=expiry, product_type=product_type,
        )
        res = helper.get_margin_calculator_multi(scripts, include_position=False, include_orders=False)
    except Exception as e:
        return None, None, None, f'Dhan margin calculator failed: {e}'
    per_lot = float((res or {}).get('totalMargin') or 0.0)
    if per_lot <= 0:
        return None, None, None, 'Dhan margin calculator returned no totalMargin'
    return funds, per_lot, int(math.floor(funds / per_lot)), None


def _margin_for(kite, short_symbols, hedge_syms, product, lot_size, short_lots, hedge_lots):
    """Margin for `short_lots` of each short leg alongside `hedge_lots` of each hedge.

    `short_symbols` is the reference shape's legs — both sides of the straddle,
    not one leg (see reference_legs).
    """
    basket = [build_order_param(s, 'SELL', lot_size * short_lots, product)
              for s in short_symbols]
    for hs in hedge_syms:
        if hedge_lots > 0:
            basket.append(build_order_param(hs, 'BUY', lot_size * hedge_lots, product))
    return get_required_margin(kite, basket, consider_positions=True)


def solve_hedge_lots(kite, short_symbols, hedge_syms, product: str, lot_size: int,
                     zerodha_net: float, target_lots: int, max_lots: int):
    """Fewest hedge lots that let the child actually carry `target_lots` straddles.

    Asks the question directly — "does SELL target_lots of the reference shape +
    BUY H hedges fit inside available margin?" — instead of deriving a per-lot
    rate and extrapolating. That distinction is not academic. Hedge benefit
    accrues **per matched pair**, not to the book as a whole (measured
    2026-07-30, NRML, 2026-08-04 expiry, ATM straddle):

        8 straddles, 0 hedges  ->  Rs 15,03,869   (exceeds net by 97,204)
        8 straddles, 1 hedge   ->  Rs 14,23,943   (still exceeds by 17,278)
        8 straddles, 2 hedges  ->  Rs 13,44,022   (fits, headroom 62,643)

    Each hedge lot saves a flat ~Rs 79,921 on a straddle book, so the saving is
    linear in H and can be solved for in a few calls rather than scanned.

    Deriving a rate from the fully-hedged figure instead would over-state
    capacity several-fold and under-buy hedges — which is exactly the failure
    that left the earlier single-leg model one lot short.

    Costs 3 basket calls in the normal case (H=0 probe, H=1 probe, one
    verification), which matters because this runs during bridge startup.

    Returns (lots, margin_at_target, target_met, error). lots == 0 means the
    child can already carry the target unhedged.
    """
    naked, err = _margin_for(kite, short_symbols, hedge_syms, product, lot_size, target_lots, 0)
    if err:
        return None, None, None, f'naked margin probe failed: {err}'
    if naked <= 0:
        return None, None, None, 'naked margin probe returned 0'
    if naked <= zerodha_net:
        return 0, naked, True, None

    ceiling = max(1, min(max_lots, SOLVER_MAX_LOTS, target_lots))

    one, err = _margin_for(kite, short_symbols, hedge_syms, product, lot_size, target_lots, 1)
    if err:
        return None, None, None, f'hedged margin probe failed: {err}'

    saving = naked - one
    if saving <= 0:
        # Hedging is not helping — most likely a product mismatch (a BUY whose
        # product differs from the SELL yields zero offset) or an illiquid strike.
        return None, one, False, ('hedging produced no margin benefit '
                                  f'(naked Rs {naked:,.2f} vs hedged Rs {one:,.2f}) — '
                                  'check that hedge_product matches the parent product')

    need = int(math.ceil((naked - zerodha_net) / saving))
    lots = max(1, min(need, ceiling))

    total, err = _margin_for(kite, short_symbols, hedge_syms, product, lot_size, target_lots, lots) \
        if lots != 1 else (one, None)
    if err:
        return None, None, None, f'hedge verification probe failed: {err}'

    # Linear extrapolation can land a hair short; nudge up rather than silently
    # returning a size that does not actually fit.
    while total > zerodha_net and lots < ceiling:
        lots += 1
        total, err = _margin_for(kite, short_symbols, hedge_syms, product, lot_size, target_lots, lots)
        if err:
            return None, None, None, f'hedge top-up probe failed at {lots} lot(s): {err}'

    return lots, total, total <= zerodha_net, None


def place_hedges(kite, plan, product: str, freeze_qty: int, armed: bool, state: dict):
    """Buy the planned hedges. Records intent BEFORE placing (crash safety)."""
    results = []
    for leg in plan:
        symbol, qty = leg['symbol'], leg['qty']
        entry = {
            'symbol': symbol, 'qty': qty, 'product': product,
            'opt_type': leg.get('opt_type'), 'strike': leg.get('strike'),
            'premium_estimate': leg.get('premium_estimate'),
            'placed_at': datetime.now().isoformat(), 'order_ids': [], 'armed': armed,
        }
        if not armed:
            entry['result'] = 'dry_run'
            results.append(entry)
            continue

        # Persist intent first: if we die mid-placement, the bridge and the
        # reconcile tool still know this symbol is a hedge and not a zombie.
        state.setdefault('hedges', []).append(entry)
        save_hedge_state(state)

        remaining, placed, err = qty, 0, None
        while remaining > 0:
            chunk = min(remaining, freeze_qty)
            try:
                oid = kite.place_order(
                    variety=kite.VARIETY_REGULAR,
                    exchange=kite.EXCHANGE_NFO,
                    tradingsymbol=symbol,
                    transaction_type=kite.TRANSACTION_TYPE_BUY,
                    quantity=chunk,
                    product=product,
                    order_type=kite.ORDER_TYPE_MARKET,
                    validity=kite.VALIDITY_DAY,
                    market_protection=-1,
                )
                entry['order_ids'].append(oid)
                placed += chunk
                remaining -= chunk
            except Exception as e:
                err = str(e)
                break
        entry['placed_qty'] = placed
        entry['result'] = 'placed' if err is None else 'error'
        if err:
            entry['error'] = err
            print(f'[copy_trade_hedge] ERROR buying hedge {symbol}: {err}', flush=True)
        else:
            print(f'[copy_trade_hedge] Bought hedge {symbol} x{placed} ({product}) '
                  f'-> {entry["order_ids"]}', flush=True)
        state['premium_paid'] = round(
            float(state.get('premium_paid') or 0.0)
            + (leg.get('premium_estimate') or 0.0) * (placed / qty if qty else 0), 2)
        save_hedge_state(state)
        results.append(entry)
    return results


# ── reactive child hedge (broker-agnostic, via the ChildBroker interface) ────
#
# The solver above is Zerodha-only because it prices every candidate size with
# kite.basket_order_margins. Kotak has no basket endpoint, so nothing there can
# answer "how many lots do I need" up front. What follows takes the opposite
# approach and needs no such API: buy a small fixed step, retry the blocked
# order, and let the RETRY be the measurement. Repeat until it clears or the
# daily lot cap stops it.
#
# Prices come from Dhan's option chain, not the child's: Kotak exposes no quote
# API in this repo at all (its instrument cache has no price field, and an
# illiquid strike is only discovered when a MARKET order comes back with
# stCode 1041). Dhan gives every strike for an expiry in one call, and both
# sides key strikes as plain rupee floats and expiries as YYYY-MM-DD, so they
# line up with no conversion.


def pick_child_hedge(helper, broker, short_strike, expiry: str, opt_type: str,
                     premium_cap: float = 5.0, underlying: str = 'NIFTY'):
    """Nearest affordable OTM strike that hedges a blocked short leg.

    Returns (pick, error). `pick` mirrors pick_hedge_candidates' shape so both
    paths log identically.

    NEAREST to the short, not cheapest: margin relief scales with how narrow
    the spread is, so the closest strike we can still buy under the cap frees
    the most. Blocking (an HTTP call to Dhan) — watchdog thread only.
    """
    opt_type = str(opt_type or '').upper()
    if opt_type not in ('CE', 'PE'):
        return None, f'unhedgeable opt_type {opt_type!r}'
    try:
        short_strike = float(short_strike)
    except (TypeError, ValueError):
        return None, f'unusable short strike {short_strike!r}'

    if expiry:
        expiry = str(expiry).split(' ')[0].split('T')[0]
    try:
        df = helper.get_option_chain_df(underlying, expiry)
    except Exception as e:
        return None, f'option chain fetch failed: {e}'
    if df is None or df.empty:
        # Data-API errors are silent by default — surface the real reason
        # rather than reporting "no strikes" for an expired subscription.
        return None, (f'option chain empty for {expiry}'
                      + (f' ({helper.last_api_error})' if helper.last_api_error else ''))

    col = 'ce_last_price' if opt_type == 'CE' else 'pe_last_price'
    if col not in df.columns:
        return None, f'option chain has no {col} column'

    candidates = []
    for strike, row in df.iterrows():
        try:
            strike = float(strike)
        except (TypeError, ValueError):
            continue
        # A hedge must sit FURTHER OTM than the short or it is not the spread
        # we are trying to build.
        if opt_type == 'CE' and strike <= short_strike:
            continue
        if opt_type == 'PE' and strike >= short_strike:
            continue
        try:
            ltp = float(row.get(col) or 0.0)
        except (TypeError, ValueError):
            continue
        # ltp > 0 filters untraded strikes that quote 0 and look free while
        # being unfillable — the same guard pick_hedge_candidates relies on.
        if not (0 < ltp <= premium_cap):
            continue
        candidates.append((abs(strike - short_strike), strike, ltp))

    if not candidates:
        return None, (f'no {opt_type} strike beyond {short_strike:g} priced at or under '
                      f'Rs {premium_cap:g} in the {expiry} chain')

    candidates.sort(key=lambda t: t[0])
    for _, strike, ltp in candidates:
        # The child may not carry every strike Dhan quotes; fall through to the
        # next-nearest rather than abandoning the hedge.
        symbol = broker.find_symbol(strike, expiry, opt_type)
        if not symbol:
            continue
        lot_size = int(broker.lot_size_for(symbol) or 0) or 65
        return {
            'symbol': symbol, 'strike': strike, 'opt_type': opt_type,
            'lot_size': lot_size, 'ltp': ltp,
            'premium_per_lot': round(ltp * lot_size, 2),
        }, None
    return None, (f'{len(candidates)} affordable {opt_type} strike(s) found but none resolve '
                  f'in the {broker.name} instrument cache')


def place_child_hedge(broker, pick: dict, lots: int, product: str, armed: bool, state: dict):
    """Buy `lots` of the picked hedge on `broker`. Returns the state entry.

    Never raises — place_child_order reports failure by return value, and a
    hedge that could not be bought must degrade to "no extra capacity", not
    take down the retry drain.
    """
    lot_size = int(pick.get('lot_size') or 65)
    qty = int(lots) * lot_size
    entry = {
        'broker': broker.name, 'symbol': pick['symbol'], 'qty': qty, 'lots': int(lots),
        'product': product, 'opt_type': pick.get('opt_type'), 'strike': pick.get('strike'),
        'premium_estimate': round(float(pick.get('ltp') or 0.0) * qty, 2),
        'placed_at': datetime.now().isoformat(), 'order_ids': [], 'armed': armed,
        'reason': 'margin_topup',
    }
    if not armed:
        entry['result'] = 'dry_run'
        return entry

    # Persist intent first: if we die mid-placement the bridge and the reconcile
    # tool still know this symbol is a hedge and not a zombie. This is also what
    # makes the daily lot cap crash-safe — the lots are counted from here.
    state.setdefault('hedges', []).append(entry)
    save_hedge_state(state)

    # margin_check=False deliberately: this order IS the cure for the shortfall,
    # so gating it on that shortfall would deadlock the ladder. It is a small
    # premium debit (2 lots at <=Rs 5 is ~Rs 650), not a margin consumer.
    placed, order_ids, err = broker.place_child_order(
        pick['symbol'], 'BUY', qty, product=product,
        margin_check=False, price=pick.get('ltp'),
    )
    entry['placed_qty'] = placed
    entry['order_ids'] = [str(o) for o in order_ids]
    entry['lots'] = int(placed // lot_size) if lot_size else 0
    if err is None and placed:
        entry['result'] = 'placed'
        print(f'[copy_trade_hedge] Bought {broker.name} top-up hedge {pick["symbol"]} '
              f'x{placed} ({product}) -> {entry["order_ids"]}', flush=True)
    else:
        entry['result'] = 'error'
        entry['error'] = err or 'nothing placed'
        print(f'[copy_trade_hedge] ERROR buying {broker.name} top-up hedge '
              f'{pick["symbol"]}: {entry["error"]}', flush=True)
    state['premium_paid'] = round(
        float(state.get('premium_paid') or 0.0)
        + float(pick.get('ltp') or 0.0) * placed, 2)
    save_hedge_state(state)
    return entry


def close_child_hedges(broker, armed: bool = True):
    """Square off `broker`'s top-up hedges. Returns per-symbol result dicts.

    Sells only what the broker still shows, so a hedge already closed by hand
    (or never actually filled) is reported rather than turned into a new short.
    """
    state = load_hedge_state()
    mine = [h for h in state.get('hedges', [])
            if entry_broker(h) == broker.name and not h.get('closed_at')]
    if not mine:
        return []

    try:
        rows = {r['symbol']: r for r in broker.positions_rows()}
    except Exception as e:
        return [{'symbol': h.get('symbol'), 'result': 'error',
                 'error': f'position fetch failed: {e}'} for h in mine]

    results = []
    for h in mine:
        symbol = h.get('symbol')
        intended = int(h.get('placed_qty') or h.get('qty') or 0)
        row = rows.get(symbol)
        live = int(row['qty']) if row else 0
        # Clamp to what is actually held and long: never flip a hedge into a
        # short by selling more than the broker still shows.
        qty = min(intended, live) if live > 0 else 0
        res = {'symbol': symbol, 'qty': qty, 'broker': broker.name}
        if qty <= 0:
            res['result'] = 'already_flat'
        elif not armed:
            res['result'] = 'dry_run'
        else:
            try:
                res['order_id'] = broker.close_position(row, qty, 'SELL')
                res['result'] = 'closed'
                print(f'[copy_trade_hedge] Closed {broker.name} hedge {symbol} x{qty} '
                      f'-> {res["order_id"]}', flush=True)
            except Exception as e:
                res['result'] = 'error'
                res['error'] = str(e)
                print(f'[copy_trade_hedge] ERROR closing {broker.name} hedge '
                      f'{symbol}: {e}', flush=True)
        if res['result'] in ('closed', 'already_flat'):
            h['closed_at'] = datetime.now().isoformat()
        h.setdefault('close_results', []).append(res)
        results.append(res)
    save_hedge_state(state)
    return results


def build_plan(kite, helper, cfg: dict, expiry: str, underlying: str = 'NIFTY',
               freeze_qty: int = 1800):
    """Work out what to hedge. Pure analysis — places nothing.

    Returns a report dict; `report['plan']` is the legs to buy (possibly empty),
    `report['errors']` explains any refusal.
    """
    report = {
        'ts': datetime.now().isoformat(), 'expiry': expiry, 'underlying': underlying,
        'plan': [], 'errors': [], 'adopted': [],
    }
    # MIS by default: the order-update WS's real captured payloads (2026-07-21)
    # show the parent's NIFTY option fills are placed 'INTRADAY' (-> MIS on
    # Zerodha) — zero were 'MARGIN'/'NRML'. Matching that means the hedge
    # actually offsets the trades that get replicated, per the product-match
    # constraint above. Caveat: Zerodha auto-squares MIS positions around
    # 15:20, so an MIS hedge stops providing relief before the child's own
    # MIS shorts do if the parent runs unusually late — acceptable since this
    # bridge's strategies exit by 15:17 (see CLAUDE.md's hardcoded auto-exit).
    product        = str(cfg.get('hedge_product', 'MIS')).upper()
    premium_cap    = float(cfg.get('hedge_premium_cap', 5.0))
    premium_budget = float(cfg.get('hedge_premium_budget', 3000))
    max_lots       = int(cfg.get('hedge_max_lots', 20))
    report.update({'product': product, 'premium_cap': premium_cap,
                   'premium_budget': premium_budget, 'max_lots': max_lots})

    snap, err = get_margin_snapshot(kite)
    if err:
        report['errors'].append(f'Zerodha margins unavailable: {err}')
        return report
    report['zerodha_net'] = snap['net']
    report['zerodha_cash'] = snap['cash']

    try:
        spot = get_spot(kite)
    except Exception as e:
        report['errors'].append(f'spot fetch failed: {e}')
        return report
    report['spot'] = spot
    atm = round(spot / 50) * 50
    report['atm_strike'] = atm

    funds, d_per_lot, d_lots, err = dhan_capacity(helper, underlying, expiry, atm)
    if err:
        report['errors'].append(err)
        return report
    report.update({'dhan_funds': funds, 'dhan_margin_per_lot': round(d_per_lot, 2),
                   'dhan_capacity_lots': d_lots})
    if d_lots <= 0:
        # Nothing to match, and solving for 0 target lots would send zero-quantity
        # legs to basket_order_margins and fail with a confusing broker error.
        report['errors'].append(
            f'Dhan cannot fund even one {underlying} straddle lot '
            f'(Rs {d_per_lot:,.2f} needed, Rs {funds:,.2f} available) — no hedge to size')
        return report

    from scripts.tools.live_options_ws_zerodha import load_zerodha_instruments_cache
    try:
        instruments = load_zerodha_instruments_cache(underlying)
    except Exception as e:
        report['errors'].append(f'instrument cache load failed: {e}')
        return report

    # Reference shape: BOTH legs of the ATM straddle, mirroring the Dhan probe so
    # the two capacities are measured on the same yardstick (see reference_legs).
    short_symbols = []
    for ot in ('CE', 'PE'):
        sym = next((i['tradingsymbol'] for i in instruments
                    if i.get('expiry') == expiry and i.get('instrument_type') == ot
                    and float(i.get('strike', -1)) == atm), None)
        if sym is None:
            report['errors'].append(f'no {underlying} {expiry} {atm:.0f}{ot} in the instrument cache')
            return report
        short_symbols.append(sym)
    report['reference_legs'] = short_symbols
    lot_size = next((int(i.get('lot_size') or 65) for i in instruments
                     if i['tradingsymbol'] == short_symbols[0]), 65)
    report['lot_size'] = lot_size

    picks, err = pick_hedge_candidates(kite, instruments, expiry, spot, premium_cap)
    if err:
        report['errors'].append(err)
        return report
    if not picks:
        report['errors'].append(
            f'no contract priced <= {premium_cap} in the {expiry} chain — raise hedge_premium_cap')
        return report
    report['candidates'] = picks

    # Already-held hedges count toward the target; only top up the difference.
    # Adoption is tracked PER SYMBOL, not as one aggregate: a leftover CE with no
    # matching PE must still buy the PE, and an aggregate (min/max across legs)
    # would either skip a missing leg or re-buy one already held.
    state = load_hedge_state()
    existing = {h['symbol']: h for h in state.get('hedges', []) if h.get('symbol')}
    open_now = {}
    if existing:
        try:
            open_now = {p['tradingsymbol']: int(p.get('quantity', 0) or 0)
                        for p in kite.positions().get('net', [])}
        except Exception as e:
            report['errors'].append(f'position check for hedge adoption failed: {e}')
            return report
        for sym in existing:
            held = open_now.get(sym, 0)
            if held > 0:
                report['adopted'].append({'symbol': sym, 'held_qty': held})

    hedge_syms = [picks[t]['symbol'] for t in ('CE', 'PE') if t in picks]
    lots, margin_at_target, target_met, err = solve_hedge_lots(
        kite, short_symbols, hedge_syms, product, lot_size, snap['net'], d_lots, max_lots)
    if err:
        report['errors'].append(err)
        if margin_at_target is not None:
            report['margin_at_target'] = round(margin_at_target, 2)
        return report
    report.update({
        'target_lots': d_lots,
        'margin_at_target': round(margin_at_target, 2) if margin_at_target else None,
        'hedge_lots_needed': lots,
        'target_met': target_met,
    })
    if not target_met:
        report['errors'].append(
            f'even {lots} hedge lot(s) leaves the child short: carrying {d_lots} lots would need '
            f'Rs {margin_at_target:,.2f} against Rs {snap["net"]:,.2f} available — '
            f'raise hedge_max_lots or accept lower child capacity')

    if lots == 0:
        report['note'] = (f'child can already carry the parent\'s {d_lots} lots unhedged '
                          f'(needs Rs {margin_at_target:,.2f} of Rs {snap["net"]:,.2f}) — no hedge needed')
        return report

    # Per-leg shortfall against the target, so each leg is topped up on its own
    # merits. `min(lots, ...)` guards the case where more is already held than the
    # target needs — we never sell hedge down here, just decline to buy more.
    held_lots = {t: max(0, open_now.get(picks[t]['symbol'], 0) // lot_size) for t in picks}
    need_lots = {t: max(0, lots - held_lots[t]) for t in picks}
    report['already_hedged_lots'] = held_lots
    report['top_up_lots'] = max(need_lots.values()) if need_lots else 0
    if not any(need_lots.values()):
        report['note'] = (f'hedge already in place at {lots} lot(s) per leg '
                          f'({held_lots}) — nothing to top up')
        return report

    per_lot_premium = {t: picks[t]['premium_per_lot'] for t in picks}
    premium = sum(per_lot_premium[t] * need_lots[t] for t in picks)
    report['premium_estimate'] = round(premium, 2)

    # Premium is a cash debit and pledged collateral cannot pay for bought
    # options, so `cash` is a real ceiling in principle. But it is NOT treated as
    # a hard cap by default: the reported live_balance understates what is
    # actually fundable here, and silently shrinking the hedge is the worst
    # outcome available — it under-hedges while reporting success, which is the
    # very failure this mechanism exists to prevent. Set
    # hedge_respect_cash: true in copy_trade_config.json to make it binding.
    #
    # hedge_premium_budget still applies unconditionally — that one is a
    # deliberate user-set spend limit, not an inferred broker figure.
    respect_cash = bool(cfg.get('hedge_respect_cash', False))
    cash_cap = min(premium_budget, snap['cash']) if respect_cash else premium_budget
    if premium > snap['cash']:
        report['cash_warning'] = (
            f'hedge premium Rs {premium:,.2f} exceeds reported free cash '
            f'Rs {snap["cash"]:,.2f}'
            + (' — hedge reduced (hedge_respect_cash is on)' if respect_cash else
               ' — placing anyway (hedge_respect_cash is off); a leg may be '
               'rejected for want of cash, which will show as a hedge error'))
    if premium > cash_cap:
        # Scale every leg down by the same factor so the hedge stays balanced —
        # funding one side fully and starving the other leaves directional risk.
        cost_per_lot_all_legs = sum(per_lot_premium[t] for t in picks if need_lots[t] > 0)
        affordable = int(cash_cap // cost_per_lot_all_legs) if cost_per_lot_all_legs else 0
        if affordable <= 0:
            report['errors'].append(
                f'hedge needs Rs {premium:,.2f} premium but only Rs {cash_cap:,.2f} is available '
                f'(budget Rs {premium_budget:,.2f}'
                + (f', cash Rs {snap["cash"]:,.2f}' if respect_cash else '')
                + ') — no hedge placed')
            return report
        report['capped_from_lots'] = report['top_up_lots']
        need_lots = {t: min(need_lots[t], affordable) for t in picks}
        report['top_up_lots'] = max(need_lots.values()) if need_lots else 0
        report['premium_estimate'] = round(
            sum(per_lot_premium[t] * need_lots[t] for t in picks), 2)
        # Loud, because a capped hedge no longer matches parent capacity: the
        # margin gate will start blocking entries the parent takes.
        report['errors'].append(
            f'hedge CAPPED to {report["top_up_lots"]} lot(s) by the Rs {cash_cap:,.2f} limit — '
            f'{lots} lot(s) were needed to match parent capacity, so the child will be '
            f'short of margin and entries may be blocked. Raise hedge_premium_budget.')

    for t in ('CE', 'PE'):
        if t not in picks or need_lots.get(t, 0) <= 0:
            continue
        p = picks[t]
        report['plan'].append({
            'symbol': p['symbol'], 'opt_type': t, 'strike': p['strike'],
            'qty': lot_size * need_lots[t], 'lots': need_lots[t],
            'already_held_lots': held_lots[t],
            'premium_estimate': round(p['premium_per_lot'] * need_lots[t], 2),
        })
    return report


def bootstrap(kite, helper, cfg: dict, expiry: str, armed: bool,
              underlying: str = 'NIFTY', freeze_qty: int = 1800):
    """Plan + (optionally) place. This is the bridge's entry point."""
    report = build_plan(kite, helper, cfg, expiry, underlying, freeze_qty)
    if report['plan']:
        state = load_hedge_state()
        report['placed'] = place_hedges(kite, report['plan'], report['product'],
                                        freeze_qty, armed, state)
    return report


def close_hedges(kite, armed: bool = True):
    """Square off today's hedges — called when the bridge stops gracefully.

    Sells `min(open qty, this hedge's own qty)`, never the raw net position. Two
    distinct hazards that guards against:
      - The parent may have rolled into the hedge's strike (it is only ~600 points
        OTM), so the net there can include a replicated leg. Selling the whole net
        would close that leg too — or, if the net is short, open a fresh short.
      - A partially-filled or manually-closed hedge must not be over-sold.
    """
    state = load_hedge_state()
    # Zerodha's entries only. The file is shared with the reactive per-child
    # hedge now, and a Kotak symbol here would be looked up in a Zerodha
    # position map that cannot contain it (the two brokers use different
    # tradingsymbol formats — NIFTY2680424750CE vs NIFTY26AUG24750CE), so it
    # would report a misleading 'not_open' for a hedge that is very much open.
    # close_child_hedges() owns those.
    hedges = [h for h in state.get('hedges', [])
              if h.get('symbol') and entry_broker(h) == 'zerodha' and not h.get('closed_at')]
    if not hedges:
        return []
    try:
        open_now = {p['tradingsymbol']: int(p.get('quantity', 0) or 0)
                    for p in kite.positions().get('net', [])}
    except Exception as e:
        print(f'[copy_trade_hedge] Cannot close hedges — position fetch failed: {e}', flush=True)
        return []

    results = []
    for h in hedges:
        sym = h['symbol']
        held = open_now.get(sym, 0)
        own = h.get('placed_qty')
        if own is None:
            own = h.get('qty') or 0
        try:
            own = int(own)
        except (TypeError, ValueError):
            own = 0
        qty = min(held, own)
        if qty <= 0:
            results.append({'symbol': sym, 'result': 'not_open',
                            'held_qty': held, 'hedge_qty': own})
            continue
        if not armed:
            results.append({'symbol': sym, 'result': 'dry_run', 'qty': qty})
            continue
        try:
            oid = kite.place_order(
                variety=kite.VARIETY_REGULAR, exchange=kite.EXCHANGE_NFO,
                tradingsymbol=sym, transaction_type=kite.TRANSACTION_TYPE_SELL,
                quantity=qty, product=h.get('product', 'MIS'),  # place_hedges always records
                                                                 # 'product'; this only guards a
                                                                 # malformed/pre-upgrade state file
                order_type=kite.ORDER_TYPE_MARKET, validity=kite.VALIDITY_DAY,
                market_protection=-1,
            )
            results.append({'symbol': sym, 'result': 'closed', 'qty': qty, 'order_id': oid})
            print(f'[copy_trade_hedge] Closed hedge {sym} x{qty} (net held {held}) -> {oid}', flush=True)
        except Exception as e:
            results.append({'symbol': sym, 'result': 'error', 'error': str(e)})
            print(f'[copy_trade_hedge] ERROR closing hedge {sym}: {e}', flush=True)
    # Per-entry, not just file-level: hedge_qty_today() reads these to decide
    # what is still held, and a same-day restart must not re-adopt a hedge that
    # was already squared off.
    closed_syms = {r['symbol'] for r in results if r.get('result') in ('closed', 'not_open')}
    for h in hedges:
        if h.get('symbol') in closed_syms:
            h['closed_at'] = datetime.now().isoformat()
    state['closed_at'] = datetime.now().isoformat()
    state['close_results'] = results
    save_hedge_state(state)
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--expiry', help='YYYY-MM-DD; default = nearest expiry in the instrument cache')
    ap.add_argument('--underlying', default='NIFTY')
    ap.add_argument('--live', action='store_true', help='actually place the hedge orders')
    ap.add_argument('--close', action='store_true', help='square off today\'s hedges instead')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper
    from scripts.tools.zerodha_instruments_cache import restore_session_from_json
    from scripts.tools.live_options_ws_zerodha import load_zerodha_instruments_cache

    kite = restore_session_from_json()
    if kite is None:
        print(json.dumps({'error': 'No Zerodha session — run zerodha_autologin.py'}))
        return 2
    try:
        kite.profile()
    except Exception as e:
        print(json.dumps({'error': f'Zerodha token rejected ({e}) — run zerodha_autologin.py'}))
        return 2

    if args.close:
        res = close_hedges(kite, armed=args.live)
        print(json.dumps({'closed': res}, indent=1))
        return 0

    expiry = args.expiry
    if not expiry:
        instruments = load_zerodha_instruments_cache(args.underlying)
        today = datetime.now().strftime('%Y-%m-%d')
        future = sorted({i['expiry'] for i in instruments if i.get('expiry', '') >= today})
        if not future:
            print(json.dumps({'error': 'no future expiry in the instrument cache'}))
            return 2
        expiry = future[0]

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'error': 'Dhan auth failed — run login.py'}))
        return 2
    helper = DhanHelper(dhan)

    cfg = read_json(os.path.join(DEBUG_DIR, 'copy_trade_config.json'), {}) or {}
    report = bootstrap(kite, helper, cfg, expiry, armed=args.live, underlying=args.underlying)

    if args.json:
        print(json.dumps(report, indent=1))
        return 0 if not report['errors'] else 1

    print('=' * 72)
    print(f"COPY-TRADE HEDGE PLAN  {report['ts']}   {'*** LIVE ***' if args.live else '(dry run)'}")
    print('=' * 72)
    print(f"  expiry={report['expiry']}  spot={report.get('spot')}  atm={report.get('atm_strike')}")
    print(f"  product={report.get('product')}  premium_cap={report.get('premium_cap')}  "
          f"budget={report.get('premium_budget')}  max_lots={report.get('max_lots')}")
    print()
    print(f"  Dhan   funds Rs {report.get('dhan_funds', 0):>14,.2f}  per-lot Rs "
          f"{report.get('dhan_margin_per_lot', 0):>12,.2f}  capacity {report.get('dhan_capacity_lots')} lots")
    print(f"  Zerodha net   Rs {report.get('zerodha_net', 0):>14,.2f}  cash    Rs "
          f"{report.get('zerodha_cash', 0):>12,.2f}")
    if report.get('margin_at_target') is not None:
        print(f"  carrying {report.get('target_lots')} lots needs Rs {report['margin_at_target']:>12,.2f} "
              f"with {report.get('hedge_lots_needed')} hedge lot(s)"
              f"  -> {'FITS' if report.get('target_met') else 'STILL SHORT'}")
    for t in ('CE', 'PE'):
        c = (report.get('candidates') or {}).get(t)
        if c:
            print(f"  hedge {t}: {c['symbol']:22s} strike={c['strike']:>8.0f} ltp={c['ltp']:>6.2f} "
                  f"Rs {c['premium_per_lot']:>8,.2f}/lot")
    if report.get('adopted'):
        print(f"  adopted existing: {report['adopted']}")
    if report.get('note'):
        print(f"  note: {report['note']}")
    for e in report['errors']:
        print(f'  !! {e}')
    if report['plan']:
        print(f"\n  PLAN ({report.get('top_up_lots')} lot(s), premium ~Rs "
              f"{report.get('premium_estimate', 0):,.2f}):")
        for leg in report['plan']:
            print(f"    BUY {leg['symbol']:22s} qty={leg['qty']:>5d}  ~Rs {leg['premium_estimate']:>9,.2f}")
        for r in report.get('placed', []):
            print(f"    -> {r['symbol']:22s} {r['result']}"
                  + (f" ids={r['order_ids']}" if r.get('order_ids') else '')
                  + (f" ERR={r['error']}" if r.get('error') else ''))
    else:
        print('\n  PLAN: nothing to buy')
    print('=' * 72)
    return 0 if not report['errors'] else 1


if __name__ == '__main__':
    sys.exit(main())
