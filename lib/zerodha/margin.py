"""
Zerodha margin/funds helpers.

Wraps the three Kite Connect endpoints needed to answer "can this account
afford this order":

  - GET  /user/margins          (kite.margins)              -> what we have
  - POST /margins/basket        (kite.basket_order_margins)  -> what an order needs

Every function returns a `(value, error)` tuple and **never** collapses a failed
API call into a zero. That distinction is the whole point: a margin gate that
reads "API failed" as "balance is 0" blocks every trade, and one that reads it as
"plenty available" places trades it cannot afford. Callers must branch on
`error is not None` and decide explicitly which way to fail.

(`DhanHelper.get_available_funds` has the opposite behaviour — it returns 0.0 on
failure, indistinguishable from a genuinely empty account. Do not copy it.)

Takes `kite` as a parameter and imports nothing from `lib.zerodha.config`, so it
is safe to use from standalone scripts that build their own KiteConnect session
(e.g. via scripts/tools/zerodha_instruments_cache.restore_session_from_json).
"""
from typing import Dict, List, Optional, Tuple

# Zerodha reports F&O margin under the 'equity' segment — there is no separate
# 'fno' segment in the margins response.
DEFAULT_SEGMENT = 'equity'


def get_margin_snapshot(kite, segment: str = DEFAULT_SEGMENT) -> Tuple[Optional[Dict], Optional[str]]:
    """Fetch net margin and cash balance in ONE call.

    Prefer this over calling get_available_margin() and get_cash_balance()
    separately — each of those is a full HTTP round-trip to the same endpoint.

    Returns ({'net': float, 'cash': float, 'collateral': float, 'utilised': float}, None)
    or (None, error).

    The `net`/`cash` split matters and is not cosmetic:
      - `net` is total margin capacity, and is what Zerodha checks when you
        write (sell) an option. It includes pledged collateral.
      - `cash` (`available.live_balance`) is actual money. Option *premium* on a
        BUY is a cash debit and CANNOT be paid from pledged collateral, so
        buying hedges is limited by `cash`, not by `net`.
    On a collateral-heavy account these differ by orders of magnitude.
    """
    try:
        m = kite.margins(segment=segment)
    except Exception as e:
        return None, str(e)
    if not isinstance(m, dict):
        return None, f'unexpected margins response type: {type(m).__name__}'
    avail = m.get('available') or {}
    utilised = m.get('utilised') or {}
    try:
        return {
            'net': float(m.get('net') or 0.0),
            'cash': float(avail.get('live_balance') or 0.0),
            'collateral': float(avail.get('collateral') or 0.0),
            'utilised': float(utilised.get('debits') or 0.0),
        }, None
    except (TypeError, ValueError) as e:
        return None, f'unparseable margins response: {e}'


def get_available_margin(kite, segment: str = DEFAULT_SEGMENT) -> Tuple[Optional[float], Optional[str]]:
    """Total margin capacity (`net`), including pledged collateral."""
    snap, err = get_margin_snapshot(kite, segment)
    return (None, err) if err else (snap['net'], None)


def get_cash_balance(kite, segment: str = DEFAULT_SEGMENT) -> Tuple[Optional[float], Optional[str]]:
    """Free cash (`available.live_balance`) — the ceiling on option premium spend."""
    snap, err = get_margin_snapshot(kite, segment)
    return (None, err) if err else (snap['cash'], None)


def build_order_param(symbol: str, side: str, qty: int, product: str,
                      exchange: str = 'NFO', order_type: str = 'MARKET') -> Dict:
    """One order in the shape kite.basket_order_margins() expects.

    Deliberately plain strings rather than kite.* constants so this can be
    called without a live client (e.g. in tests): Kite's constants are already
    these exact values (VARIETY_REGULAR == 'regular', PRODUCT_MIS == 'MIS').
    """
    return {
        'exchange': exchange,
        'tradingsymbol': symbol,
        'transaction_type': 'BUY' if str(side).upper() == 'BUY' else 'SELL',
        'variety': 'regular',
        'product': str(product).upper(),
        'order_type': str(order_type).upper(),
        'quantity': int(qty),
    }


def get_required_margin(kite, orders: List[Dict], consider_positions: bool = True
                        ) -> Tuple[Optional[float], Optional[str]]:
    """Margin required for a basket of orders, in rupees.

    Returns the **final** total, not the initial one. `final` accounts for
    hedge/offset benefit against the rest of the book, which is exactly what we
    need — measured on 2026-07-30, a naked short NIFTY lot needs ₹1,71,509 while
    the same short paired with a far-OTM long needs ₹73,875. Charging the
    initial figure would over-reserve by ~2.3x and block affordable trades.

    `consider_positions=True` folds in currently-open positions, so a
    position-reducing order can legitimately come back cheaper than a new one.
    """
    if not orders:
        return 0.0, None
    try:
        r = kite.basket_order_margins(orders, consider_positions=consider_positions, mode='compact')
    except Exception as e:
        return None, str(e)
    if not isinstance(r, dict):
        return None, f'unexpected basket margin response type: {type(r).__name__}'
    final = r.get('final')
    if not isinstance(final, dict) or final.get('total') is None:
        # Fall back to `initial` rather than failing outright — over-reserving is
        # the safe direction for a gate, and a missing `final` is more likely a
        # response-shape change than an outage.
        initial = r.get('initial')
        if isinstance(initial, dict) and initial.get('total') is not None:
            try:
                return float(initial['total']), None
            except (TypeError, ValueError):
                pass
        return None, "basket margin response had no usable 'final'/'initial' total"
    try:
        return float(final['total']), None
    except (TypeError, ValueError) as e:
        return None, f'unparseable basket margin total: {e}'


def signed_qty(side: str, qty: int) -> int:
    """+qty for BUY, -qty for SELL."""
    return int(qty) if str(side).upper() == 'BUY' else -int(qty)


def is_reducing(held_qty: int, side: str, qty: int) -> bool:
    """Does this order shrink an existing position rather than grow one?

    `held_qty` is the child's current signed net quantity in that symbol
    (negative = short). An order is reducing when it points the opposite way to
    what is held.

    This gates the gate: a **reducing order must never be margin-blocked**.
    Refusing an exit leaves a naked position, which is far worse than any margin
    rejection, and closing a position releases margin rather than consuming it —
    so checking affordability there is both dangerous and meaningless.

    Side alone cannot answer this, which is why held_qty is required: a SELL
    opens a short when flat but closes a long when long.

    Flat (held_qty == 0) counts as increasing, not reducing.
    """
    if held_qty == 0:
        return False
    return (held_qty > 0) != (signed_qty(side, qty) > 0)


def held_qty_for(positions: List[Dict], symbol: str) -> int:
    """Current signed net quantity for `symbol` from a kite.positions()['net'] list."""
    for p in positions or []:
        if p.get('tradingsymbol') == symbol:
            try:
                return int(p.get('quantity', 0) or 0)
            except (TypeError, ValueError):
                return 0
    return 0
