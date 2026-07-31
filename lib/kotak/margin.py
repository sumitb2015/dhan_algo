"""
Kotak Neo margin/funds and position helpers.

Counterpart to lib/zerodha/margin.py, with the same contract: every function
returns `(value, error)` and NEVER collapses a failed API call into a zero. A
margin gate that reads "API failed" as "balance is 0" blocks every trade; one
that reads it as "plenty available" places trades it cannot afford.

Two structural differences from Zerodha, both of which shape how the copy-trade
gate can work:

  - **There is no basket-margin endpoint.** Kotak's check-margin API prices a
    single order and does not model hedge offset against the existing book, so
    there is no equivalent of kite.basket_order_margins(). The gate therefore has
    no "exact" mode — it uses a measured per-lot figure times the lot count on
    both the fast and the recheck path, and callers should treat a Kotak block as
    an estimate (non-terminal) rather than broker truth.
  - **Positions carry no net quantity.** Only day and carry-forward legs are
    reported, so net has to be computed from four fields.

`is_reducing` / `signed_qty` are deliberately imported from lib.zerodha.margin
rather than duplicated — they operate on a held quantity and a side, with no
broker-specific content at all.
"""
from typing import Dict, List, Optional, Tuple

from lib.kotak.responses import unwrap_list, error_message
# Broker-agnostic despite living under lib/zerodha — they take (held_qty, side,
# qty) and know nothing about either broker's API.
from lib.zerodha.margin import is_reducing, signed_qty  # noqa: F401  (re-exported)


def get_margin_snapshot(client) -> Tuple[Optional[Dict], Optional[str]]:
    """Fetch account margin in ONE call.

    Returns ({'net': float, 'cash': float, 'collateral': float, 'utilised': float}, None)
    or (None, error).

    Kotak exposes NO cash field, so `cash` is what is left after both collateral
    components are removed:

        Net = Collateral + CollateralValue + cash

    Measured on a real account (2026-07-31): Net 954,701.99 = Collateral
    925,581.66 + CollateralValue 29,120.33, i.e. cash **0.00** — and indeed every
    cash-ish field (NotionalCash, RmsPayInAmt, AdhocMargin, RmsCollateral,
    RmsMutualFundAmt) was zero, against ~10.3L of unpledged equity holdings.
    Subtracting only `Collateral` would report 29,120 of cash that does not
    exist.

    The `net`/`cash` split is not cosmetic:
      - `net` is margin capacity and is what Kotak checks when you WRITE an
        option — collateral backs that fine (check-margin returned insufFund 0
        for a 1-lot short on this very account).
      - `cash` is real money. Option *premium* on a BUY is a cash debit that
        collateral cannot pay, so buying (e.g. hedges) is limited by `cash`.
    On a collateral-only account like the one above these differ by the whole
    balance, so treating `net` as spendable would authorise buys that the
    exchange then rejects.

    Do NOT "fix" this to Kotak's own `avlCash` from check-margin: that field
    reports Net (it counts collateral as cash) and would reintroduce exactly the
    over-statement this guards against.
    """
    try:
        res = client.limits(segment='ALL', exchange='ALL', product='ALL')
    except Exception as e:
        return None, str(e)
    err = error_message(res)
    if err:
        return None, err
    if not isinstance(res, dict):
        return None, f'unexpected limits response type: {type(res).__name__}'

    def num(*keys) -> float:
        """First of `keys` that parses as a number, else 0.0 (NOT a sum)."""
        for key in keys:
            if res.get(key) is not None:
                try:
                    return float(res[key])
                except (TypeError, ValueError):
                    continue
        return 0.0

    try:
        net = num('Net', 'net')
        # BOTH fields are collateral components and must be ADDED — `num` picks
        # one key, it does not total them. Summing only 'Collateral' is what
        # produced a phantom Rs 29,120 of "cash" on a zero-cash account.
        collateral = num('Collateral', 'collateral') + num('CollateralValue', 'collateralValue')
        return {
            'net': net,
            'cash': max(0.0, net - collateral),
            'collateral': collateral,
            'utilised': num('MarginUsed', 'marginUsed'),
        }, None
    except (TypeError, ValueError) as e:
        return None, f'unparseable limits response: {e}'


def get_available_margin(client) -> Tuple[Optional[float], Optional[str]]:
    """Total margin capacity (`Net`), including pledged collateral."""
    snap, err = get_margin_snapshot(client)
    return (None, err) if err else (snap['net'], None)


def net_qty_of(row: Dict) -> int:
    """Signed net quantity for one Kotak position row.

    Kotak reports only day (`fl*`) and carry-forward (`cf*`) legs — there is no
    net-quantity field to read, so it must be computed. Getting this wrong makes
    an open position look flat, which in the copy-trade gate turns an exit into a
    gated entry.
    """
    def num(*keys) -> float:
        total = 0.0
        for key in keys:
            try:
                total += float(row.get(key, 0) or 0)
            except (TypeError, ValueError):
                continue
        return total

    return int(num('cfBuyQty', 'flBuyQty') - num('cfSellQty', 'flSellQty'))


def get_positions(client) -> Tuple[Optional[List[Dict]], Optional[str]]:
    """Raw position rows. ([], None) when the book is genuinely empty."""
    try:
        res = client.positions()
    except Exception as e:
        return None, str(e)
    return unwrap_list(res)


def positions_map(client) -> Tuple[Optional[Dict[str, int]], Optional[str]]:
    """{trading_symbol: signed net qty} for the whole book, or (None, error).

    Symbols with a zero net (fully closed intraday) are dropped: they are
    indistinguishable from "not held" for gating purposes and only bloat the
    snapshot the WS callback thread reads on every fill.
    """
    rows, err = get_positions(client)
    if err:
        return None, err
    out = {}
    for row in rows or []:
        symbol = str(row.get('trdSym') or row.get('sym') or '').strip()
        if not symbol:
            continue
        qty = net_qty_of(row)
        if qty:
            out[symbol] = out.get(symbol, 0) + qty
    return out, None


def held_qty_for(positions_by_symbol: Dict[str, int], symbol: str) -> int:
    """Signed net quantity for `symbol` from a positions_map() result."""
    try:
        return int((positions_by_symbol or {}).get(symbol, 0) or 0)
    except (TypeError, ValueError):
        return 0
