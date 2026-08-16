"""
CLI for the Cash Secured Puts dashboard page.

Usage:
    python csp_watchlist.py list  --symbols RELIANCE,TCS,NIFTY
    python csp_watchlist.py place --symbol RELIANCE --expiry 2026-08-28 --strike 1400 \
                                   --quantity 500 --order-type LIMIT --price 12.5 --product-type MARGIN \
                                   [--trigger-price 12.0] [--after-market-order --amo-time OPEN]
    python csp_watchlist.py cancel --order-id 1100...
    python csp_watchlist.py exit   --security-id 49081 --exchange-segment NSE_FNO \
                                    --quantity 500 --product-type MARGIN
    python csp_watchlist.py reconcile --positions '[{"id":"csp_1","securityId":"49081"}]'

Prints a single JSON line to stdout. Logs go to stderr.
"""
import sys
import os
import json
import math
import logging
import argparse
from datetime import datetime, timezone, date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Orders in these statuses are still working and can be cancelled/modified.
ACTIVE_ORDER_STATUSES = {"TRANSIT", "PENDING", "TRIGGER_PENDING", "MODIFIED", "PART_TRADED"}


class _ErrorCapture(logging.Handler):
    """Captures helper WARNING+ log records so the API rejection reason can be
    returned in the JSON payload instead of dying silently on stderr."""

    def __init__(self):
        super().__init__(level=logging.WARNING)
        self.messages: list = []

    def emit(self, record):
        self.messages.append(record.getMessage())


_helper_errors = _ErrorCapture()
logging.getLogger('lib.dhan_helper').addHandler(_helper_errors)


def _fail(base_message: str, helper: DhanHelper = None) -> dict:
    detail = _helper_errors.messages[-1] if _helper_errors.messages else ''
    if not detail and helper is not None and getattr(helper, 'last_api_error', None):
        detail = str(helper.last_api_error)
    return {"success": False, "error": f"{base_message}: {detail}" if detail else base_message}


def _get_helper() -> DhanHelper:
    dhan = get_dhan_client()
    if not dhan:
        raise RuntimeError("Failed to authenticate with Dhan")
    return DhanHelper(dhan)


def prob_above(spot: float, strike: float, years: float, iv: float, r: float = 0.065) -> float:
    """Risk-neutral probability spot finishes above strike — the sold PUT expiring
    worthless. Same formula as riskNeutralProbAbove() in lib/optionsStrategy.ts
    and prob_above() in csp_scanner.py."""
    if years <= 0 or iv <= 0 or spot <= 0 or strike <= 0:
        return 1.0 if spot > strike else 0.0
    d2 = (math.log(spot / strike) + (r - (iv * iv) / 2) * years) / (iv * math.sqrt(years))
    return 0.5 * (1.0 + math.erf(d2 / math.sqrt(2.0)))


def _underlying_of(trading_symbol: str) -> str:
    return trading_symbol.split('-')[0].strip().upper() if trading_symbol else ''


def _option_instrument(helper: DhanHelper, symbol: str) -> str:
    """Stock underlyings trade OPTSTK contracts; only indices are OPTIDX."""
    return "OPTIDX" if helper.find_index(symbol) else "OPTSTK"


def _fo_lot_size(helper: DhanHelper, symbol: str, expiry: str = '') -> int:
    """Option-contract lot size. get_lot_size() returns the equity placeholder
    of 1 for stock underlyings, so read it off the derivative contracts.

    Resolved per (symbol, expiry) when an expiry is given: NSE revises lot sizes
    on a forward expiry while the near month keeps the old one, so any single
    row's LOT_SIZE would be the wrong quantity for half the chain."""
    try:
        df = helper._load_master_list()
        fo = df[(df['UNDERLYING_SYMBOL'] == symbol) &
                (df['INSTRUMENT'].isin(['OPTSTK', 'OPTIDX', 'FUTSTK', 'FUTIDX']))]
        if expiry:
            exact = fo[fo['SM_EXPIRY_DATE'].astype(str).str[:10] == expiry[:10]]
            if not exact.empty:
                fo = exact
        if not fo.empty:
            return int(float(fo.iloc[0]['LOT_SIZE']))
    except Exception:
        pass
    try:
        return int(helper.get_lot_size(symbol))
    except Exception:
        return 0


def _positions_by_security(helper: DhanHelper) -> tuple:
    """Every open position keyed by securityId, plus an api_failed flag:
    ({securityId: position_dict}, api_failed).

    `api_failed` distinguishes "the account is genuinely flat" from "the
    positions call errored" — the two are the same empty DataFrame, and an exit
    must not be refused on the strength of a failed lookup."""
    df = helper.get_positions()
    if df.empty:
        return {}, bool(getattr(helper, 'last_api_error', None))

    by_security = {}
    for _, row in df.iterrows():
        net_qty = int(row.get('netQty', 0) or 0)
        if net_qty == 0:
            continue
        # A short's entry price is its sell average; a carried position reports
        # sellAvg 0 and keeps the carry cost in costPrice instead.
        sell_avg = float(row.get('sellAvg', 0) or 0)
        cost_price = float(row.get('costPrice', 0) or 0)
        by_security[str(row.get('securityId', '') or '')] = {
            "securityId": str(row.get('securityId', '') or ''),
            "tradingSymbol": str(row.get('tradingSymbol', '') or ''),
            "symbol": _underlying_of(str(row.get('tradingSymbol', '') or '')),
            "netQty": net_qty,
            "avgPrice": round(sell_avg if sell_avg > 0 else cost_price, 2),
            "strike": float(row.get('drvStrikePrice', 0) or 0),
            "expiry": str(row.get('drvExpiryDate', '') or '')[:10],
            "optionType": str(row.get('drvOptionType', '') or ''),
            "productType": str(row.get('productType', '') or ''),
            "exchangeSegment": str(row.get('exchangeSegment', '') or ''),
        }
    return by_security, False


def cmd_list(helper: DhanHelper, symbols: list) -> dict:
    ltp_by_symbol = {}
    lot_by_symbol = {}
    for sym in symbols:
        try:
            ltp_by_symbol[sym] = helper.get_ltp(sym, instrument="INDEX" if helper.find_index(sym) else "EQUITY")
        except Exception:
            ltp_by_symbol[sym] = 0.0
        lot_by_symbol[sym] = _fo_lot_size(helper, sym)

    orders_by_underlying: dict = {}
    for o in helper.get_order_list():
        trading_symbol = str(o.get('tradingSymbol', '') or '')
        opt_type = str(o.get('drvOptionType', '') or '')
        status = str(o.get('orderStatus', '') or '')
        if opt_type != 'PUT' or status not in ACTIVE_ORDER_STATUSES:
            continue
        underlying = _underlying_of(trading_symbol)
        orders_by_underlying.setdefault(underlying, []).append({
            "orderId": str(o.get('orderId', '')),
            "tradingSymbol": trading_symbol,
            "transactionType": str(o.get('transactionType', '')),
            "strike": float(o.get('drvStrikePrice', 0) or 0),
            "expiry": str(o.get('drvExpiryDate', '') or ''),
            "quantity": int(o.get('quantity', 0) or 0),
            "price": float(o.get('price', 0) or 0),
            "triggerPrice": float(o.get('triggerPrice', 0) or 0),
            "orderType": str(o.get('orderType', '')),
            "productType": str(o.get('productType', '')),
            "status": status,
            "securityId": str(o.get('securityId', '')),
            "exchangeSegment": str(o.get('exchangeSegment', '')),
            "createTime": str(o.get('createTime', '')),
            "updateTime": str(o.get('updateTime', '')),
        })

    trades_by_underlying: dict = {}
    df_positions = helper.get_positions()
    if not df_positions.empty:
        for _, row in df_positions.iterrows():
            opt_type = str(row.get('drvOptionType', '') or '')
            net_qty = int(row.get('netQty', 0) or 0)
            if opt_type != 'PUT' or net_qty == 0:
                continue
            trading_symbol = str(row.get('tradingSymbol', '') or '')
            underlying = _underlying_of(trading_symbol)
            trades_by_underlying.setdefault(underlying, []).append({
                "tradingSymbol": trading_symbol,
                "side": "SELL" if net_qty < 0 else "BUY",
                "netQty": net_qty,
                "strike": float(row.get('drvStrikePrice', 0) or 0),
                "expiry": str(row.get('drvExpiryDate', '') or ''),
                "costPrice": float(row.get('costPrice', 0) or 0),
                "unrealizedProfit": float(row.get('unrealizedProfit', 0) or 0),
                "realizedProfit": float(row.get('realizedProfit', 0) or 0),
                "productType": str(row.get('productType', '')),
                "securityId": str(row.get('securityId', '')),
                "exchangeSegment": str(row.get('exchangeSegment', '')),
            })

    rows = []
    for sym in symbols:
        rows.append({
            "symbol": sym,
            "ltp": round(float(ltp_by_symbol.get(sym, 0.0)), 2),
            "lotSize": lot_by_symbol.get(sym, 0),
            "activeOrders": orders_by_underlying.get(sym, []),
            "activeTrades": trades_by_underlying.get(sym, []),
        })

    return {
        "success": True,
        "asOf": datetime.now(timezone.utc).isoformat(),
        "rows": rows,
    }


def cmd_expiries(helper: DhanHelper, args) -> dict:
    return {"success": True, "expiries": helper.get_expiries(args.symbol)}


def cmd_chain(helper: DhanHelper, args) -> dict:
    df = helper.get_option_chain_df(args.symbol, args.expiry)
    if df.empty:
        # An empty chain is almost always a throttled/failed API call, not a
        # genuinely strikeless expiry. Reporting it as success would let the
        # caller silently replace a good chain with nothing.
        return _fail(f"No option chain returned for {args.symbol} {args.expiry}", helper)

    try:
        spot = float(helper.get_ltp(
            args.symbol, instrument="INDEX" if helper.find_index(args.symbol) else "EQUITY") or 0)
    except Exception:
        spot = 0.0
    dte = max((datetime.strptime(args.expiry[:10], "%Y-%m-%d").date() - date.today()).days, 0)
    years = max(dte, 1) / 365.0

    strikes = []
    for strike, row in df.iterrows():
        strike = float(strike)
        iv = float(row.get('pe_implied_volatility', 0) or 0)
        strikes.append({
            "strike": strike,
            "ltp": float(row.get('pe_last_price', 0) or 0),
            "oi": int(row.get('pe_oi', 0) or 0),
            "iv": iv,
            "noHitProb": round(prob_above(spot, strike, years, iv / 100.0) * 100, 1),
        })
    return {"success": True, "strikes": strikes, "spot": round(spot, 2), "dte": dte}


def cmd_sync(helper: DhanHelper, args) -> dict:
    """Live spot + PE mark for tracked rows. `--positions` is a JSON array of
    {id, symbol, expiry, strike} — one entry per open tracked put."""
    try:
        positions = json.loads(args.positions)
    except (ValueError, TypeError) as exc:
        return {"success": False, "error": f"Invalid --positions payload: {exc}"}

    chain_cache: dict = {}
    out = []
    for p in positions:
        # One malformed row must not take down the marks for every other
        # position, so each is resolved independently and reports its own error.
        try:
            symbol = str(p.get('symbol', '') or '').upper()
            expiry = str(p.get('expiry', '') or '')[:10]
            strike = float(p.get('strike', 0) or 0)
            if not symbol or not expiry:
                raise ValueError("symbol and expiry are required")
            expiry_date = datetime.strptime(expiry, "%Y-%m-%d").date()
        except (ValueError, TypeError) as exc:
            out.append({"id": p.get('id'), "error": f"Invalid tracked row: {exc}"})
            continue

        # The chain call self-throttles to one request every 3s, so cache per
        # symbol+expiry — several tracked rows usually share one chain. The
        # chain response already carries the underlying LTP, so no extra
        # rate-limited get_ltp call is needed.
        key = (symbol, expiry)
        if key not in chain_cache:
            try:
                chain_cache[key] = helper.get_option_chain_df(symbol, expiry)
            except Exception:
                chain_cache[key] = None

        df = chain_cache[key]
        if df is None or df.empty:
            out.append({"id": p.get('id'),
                        "error": f"No option chain for {symbol} {expiry} — marks unavailable"})
            continue

        spot = float(df.attrs.get('underlying_ltp', 0) or 0)
        if spot <= 0:
            try:
                spot = float(helper.get_ltp(
                    symbol, instrument="INDEX" if helper.find_index(symbol) else "EQUITY") or 0)
            except Exception:
                spot = 0.0

        pe_ltp, iv = 0.0, 0.0
        if strike in df.index:
            row = df.loc[strike]
            pe_ltp = float(row.get('pe_last_price', 0) or 0)
            iv = float(row.get('pe_implied_volatility', 0) or 0)

        dte = max((expiry_date - date.today()).days, 0)
        entry = {
            "id": p.get('id'),
            "spot": round(spot, 2),
            "peLtp": round(pe_ltp, 2),
            "iv": round(iv, 2),
            "dte": dte,
        }
        # With no IV or no spot the model degenerates to a certainty (1.0). That
        # would render as "100% no-hit" exactly when the mark is unknown, so the
        # probability is omitted instead of being fabricated.
        if iv > 0 and spot > 0:
            entry["noHitProb"] = round(prob_above(spot, strike, max(dte, 1) / 365.0, iv / 100.0) * 100, 1)
        out.append(entry)

    return {"success": True, "asOf": datetime.now(timezone.utc).isoformat(), "rows": out}


def _finalize_order(helper: DhanHelper, order_id: str, wait: bool) -> dict:
    """Resolve an order to its real outcome. Callers that book P&L must not
    infer a fill price from a UI mark — a MARKET order's actual traded price is
    the only honest basis, and a post-acceptance rejection must be visible."""
    out = {"success": True, "orderId": order_id, "status": "PENDING", "tradedPrice": None}
    if not wait:
        return out
    try:
        filled = helper.wait_for_fill(order_id, timeout=25)
    except Exception:
        filled = False
    detail = helper.get_order_by_id(order_id) or {}
    status = str(detail.get('orderStatus', '') or ('TRADED' if filled else 'PENDING'))
    out["status"] = status
    for key in ('averageTradedPrice', 'tradedPrice', 'price'):
        val = detail.get(key)
        if val not in (None, '', 0, '0'):
            try:
                out["tradedPrice"] = float(val)
                break
            except (TypeError, ValueError):
                continue
    if status in ("REJECTED", "CANCELLED", "EXPIRED"):
        out["success"] = False
        out["error"] = f"Order {order_id} ended {status}"
    return out


def cmd_place(helper: DhanHelper, args) -> dict:
    instrument = _option_instrument(helper, args.symbol)
    sec = helper.find_option(args.symbol, args.expiry, args.strike, "PE", instrument=instrument)
    if not sec:
        return {"success": False, "error": f"Option not found: {args.symbol} {args.expiry} {args.strike} PE ({instrument})"}

    order_type = args.order_type
    price = args.price if order_type in ("LIMIT", "STOP_LOSS") else 0
    trigger_price = args.trigger_price if order_type in ("STOP_LOSS", "STOP_LOSS_MARKET") else 0

    order_id = helper.place_order(
        security_id=str(int(sec['SECURITY_ID'])),
        # Raw master-list SEGMENT is 'D' which the order API rejects (DH-905);
        # _auto_detect_segment maps INSTRUMENT+EXCH_ID -> 'NSE_FNO'.
        exchange_segment=helper._auto_detect_segment(sec),
        transaction_type=helper.SELL,
        quantity=args.quantity,
        order_type=order_type,
        product_type=args.product_type,
        price=price,
        trigger_price=trigger_price,
        after_market_order=args.after_market_order,
        amo_time=args.amo_time,
    )
    if order_id:
        result = _finalize_order(helper, order_id, getattr(args, 'wait_fill', False))
        # The caller needs these to later square the position off; resolving the
        # contract again from the UI would risk picking a different one.
        result["securityId"] = str(int(sec['SECURITY_ID']))
        result["exchangeSegment"] = helper._auto_detect_segment(sec)
        result["lotSize"] = _fo_lot_size(helper, args.symbol, args.expiry)
        return result
    return _fail("Failed to place Cash Secured Put order", helper)


def cmd_cancel(helper: DhanHelper, args) -> dict:
    ok = helper.cancel_order(args.order_id)
    if ok:
        return {"success": True}
    return _fail("Failed to cancel order")


def cmd_exit(helper: DhanHelper, args) -> dict:
    """Buy back a sold option. The quantity is taken from the broker's own
    position, never from the caller's record of it.

    Two ways the caller's number goes wrong, both of which turn a square-off
    into a fresh long: the entry only part-filled, or the exit already went
    through and the tracked row was never updated. So a positions lookup that
    *succeeds* is authoritative — flat or long means refuse. A lookup that
    *fails* falls back to the requested quantity, because refusing to close a
    real position on a transient API error is the worse failure."""
    quantity = int(args.quantity)
    verified = False
    positions, api_failed = _positions_by_security(helper)

    if not api_failed:
        pos = positions.get(str(args.security_id))
        net_qty = int(pos.get('netQty', 0)) if pos else 0
        if net_qty >= 0:
            return {
                "success": False,
                "error": (f"Broker shows no open short for security {args.security_id} "
                          f"(net qty {net_qty}) — nothing to exit. The tracked row is stale; "
                          f"reconcile before retrying."),
                "netQty": net_qty,
            }
        verified = True
        if abs(net_qty) < quantity:
            # Part-filled entry, or a partial manual exit. Buying the requested
            # quantity would leave a long.
            quantity = abs(net_qty)

    order_id = helper.place_order(
        security_id=args.security_id,
        exchange_segment=args.exchange_segment,
        transaction_type=helper.BUY,
        quantity=quantity,
        order_type=helper.MARKET,
        product_type=args.product_type,
    )
    if order_id:
        result = _finalize_order(helper, order_id, getattr(args, 'wait_fill', False))
        result["quantity"] = quantity
        result["quantityVerified"] = verified
        return result
    return _fail("Failed to place exit order", helper)


def cmd_reconcile(helper: DhanHelper, args) -> dict:
    """Broker truth for tracked rows. `--positions` is a JSON array of
    {id, securityId}.

    Returns the live net quantity and entry average for each tracked row, plus
    any short option position the dashboard is not tracking at all — an order
    that filled after its route timed out leaves exactly that footprint."""
    try:
        tracked = json.loads(args.positions)
    except (ValueError, TypeError) as exc:
        return {"success": False, "error": f"Invalid --positions payload: {exc}"}

    positions, api_failed = _positions_by_security(helper)
    if api_failed:
        return _fail("Could not read positions from the broker", helper)

    rows = []
    claimed = set()
    for t in tracked:
        security_id = str(t.get('securityId', '') or '')
        pos = positions.get(security_id) if security_id else None
        if pos:
            claimed.add(security_id)
        rows.append({
            "id": t.get('id'),
            "found": bool(pos),
            "netQty": int(pos['netQty']) if pos else 0,
            "avgPrice": pos['avgPrice'] if pos else 0.0,
            "productType": pos['productType'] if pos else '',
        })

    # Only shorts are adoptable: a long option was never a cash-secured put.
    untracked = []
    for security_id, pos in positions.items():
        if security_id in claimed or pos['netQty'] >= 0 or pos['optionType'] != 'PUT':
            continue
        entry = dict(pos)
        entry["lotSize"] = _fo_lot_size(helper, pos['symbol'], pos['expiry'])
        untracked.append(entry)

    return {
        "success": True,
        "asOf": datetime.now(timezone.utc).isoformat(),
        "rows": rows,
        "untracked": untracked,
    }


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd')

    p_list = sub.add_parser('list')
    p_list.add_argument('--symbols', required=True, help="Comma-separated underlying symbol list")

    p_expiries = sub.add_parser('expiries')
    p_expiries.add_argument('--symbol', required=True)

    p_chain = sub.add_parser('chain')
    p_chain.add_argument('--symbol', required=True)
    p_chain.add_argument('--expiry', required=True)

    p_place = sub.add_parser('place')
    p_place.add_argument('--symbol', required=True)
    p_place.add_argument('--expiry', required=True)
    p_place.add_argument('--strike', required=True, type=float)
    p_place.add_argument('--quantity', required=True, type=int)
    p_place.add_argument('--order-type', default='MARKET',
                          choices=['MARKET', 'LIMIT', 'STOP_LOSS', 'STOP_LOSS_MARKET'], dest='order_type')
    p_place.add_argument('--price', type=float, default=0)
    p_place.add_argument('--trigger-price', type=float, default=0, dest='trigger_price')
    p_place.add_argument('--after-market-order', action='store_true', dest='after_market_order')
    p_place.add_argument('--amo-time', default='OPEN', choices=['OPEN', 'OPEN_30', 'OPEN_60'], dest='amo_time')
    p_place.add_argument('--product-type', default='MARGIN', choices=['MARGIN', 'CNC'], dest='product_type')
    p_place.add_argument('--wait-fill', action='store_true', dest='wait_fill',
                          help="Block until the order fills and report its traded price")

    p_cancel = sub.add_parser('cancel')
    p_cancel.add_argument('--order-id', required=True, dest='order_id')

    p_sync = sub.add_parser('sync')
    p_sync.add_argument('--positions', required=True,
                        help="JSON array of {id, symbol, expiry, strike}")

    p_reconcile = sub.add_parser('reconcile')
    p_reconcile.add_argument('--positions', required=True,
                             help="JSON array of {id, securityId}")

    p_exit = sub.add_parser('exit')
    p_exit.add_argument('--security-id', required=True, dest='security_id')
    p_exit.add_argument('--exchange-segment', required=True, dest='exchange_segment')
    p_exit.add_argument('--quantity', required=True, type=int)
    p_exit.add_argument('--product-type', default='MARGIN', dest='product_type')
    p_exit.add_argument('--wait-fill', action='store_true', dest='wait_fill',
                         help="Block until the order fills and report its traded price")

    args = parser.parse_args()

    helper = _get_helper()

    if args.cmd == 'list':
        symbols = [s.strip().upper() for s in args.symbols.split(',') if s.strip()]
        result = cmd_list(helper, symbols)
    elif args.cmd == 'expiries':
        result = cmd_expiries(helper, args)
    elif args.cmd == 'chain':
        result = cmd_chain(helper, args)
    elif args.cmd == 'place':
        result = cmd_place(helper, args)
    elif args.cmd == 'cancel':
        result = cmd_cancel(helper, args)
    elif args.cmd == 'sync':
        result = cmd_sync(helper, args)
    elif args.cmd == 'reconcile':
        result = cmd_reconcile(helper, args)
    elif args.cmd == 'exit':
        result = cmd_exit(helper, args)
    else:
        result = {"success": False, "error": "unknown command"}

    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}))
        sys.exit(0)
