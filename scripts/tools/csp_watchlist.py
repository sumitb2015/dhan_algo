"""
CLI for the Cash Secured Puts dashboard page.

Usage:
    python csp_watchlist.py list  --symbols RELIANCE,TCS,NIFTY
    python csp_watchlist.py place --symbol RELIANCE --expiry 2026-08-28 --strike 1400 \
                                   --quantity 500 --order-type LIMIT --price 12.5 --product-type MARGIN
    python csp_watchlist.py cancel --order-id 1100...
    python csp_watchlist.py exit   --security-id 49081 --exchange-segment NSE_FNO \
                                    --quantity 500 --product-type MARGIN

Prints a single JSON line to stdout. Logs go to stderr.
"""
import sys
import os
import json
import logging
import argparse
from datetime import datetime, timezone

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


def _fail(base_message: str) -> dict:
    detail = _helper_errors.messages[-1] if _helper_errors.messages else ''
    return {"success": False, "error": f"{base_message}: {detail}" if detail else base_message}


def _get_helper() -> DhanHelper:
    dhan = get_dhan_client()
    if not dhan:
        raise RuntimeError("Failed to authenticate with Dhan")
    return DhanHelper(dhan)


def _underlying_of(trading_symbol: str) -> str:
    return trading_symbol.split('-')[0].strip().upper() if trading_symbol else ''


def _option_instrument(helper: DhanHelper, symbol: str) -> str:
    """Stock underlyings trade OPTSTK contracts; only indices are OPTIDX."""
    return "OPTIDX" if helper.find_index(symbol) else "OPTSTK"


def _fo_lot_size(helper: DhanHelper, symbol: str) -> int:
    """Option-contract lot size. get_lot_size() returns the equity placeholder
    of 1 for stock underlyings, so read it off the derivative contracts."""
    try:
        df = helper._load_master_list()
        fo = df[(df['UNDERLYING_SYMBOL'] == symbol) &
                (df['INSTRUMENT'].isin(['OPTSTK', 'OPTIDX', 'FUTSTK', 'FUTIDX']))]
        if not fo.empty:
            return int(float(fo.iloc[0]['LOT_SIZE']))
    except Exception:
        pass
    try:
        return int(helper.get_lot_size(symbol))
    except Exception:
        return 0


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
        return {"success": True, "strikes": []}

    strikes = []
    for strike, row in df.iterrows():
        strikes.append({
            "strike": float(strike),
            "ltp": float(row.get('pe_last_price', 0) or 0),
            "oi": int(row.get('pe_oi', 0) or 0),
            "iv": float(row.get('pe_implied_volatility', 0) or 0),
        })
    return {"success": True, "strikes": strikes}


def cmd_place(helper: DhanHelper, args) -> dict:
    instrument = _option_instrument(helper, args.symbol)
    sec = helper.find_option(args.symbol, args.expiry, args.strike, "PE", instrument=instrument)
    if not sec:
        return {"success": False, "error": f"Option not found: {args.symbol} {args.expiry} {args.strike} PE ({instrument})"}

    order_id = helper.place_order(
        security_id=str(int(sec['SECURITY_ID'])),
        # Raw master-list SEGMENT is 'D' which the order API rejects (DH-905);
        # _auto_detect_segment maps INSTRUMENT+EXCH_ID -> 'NSE_FNO'.
        exchange_segment=helper._auto_detect_segment(sec),
        transaction_type=helper.SELL,
        quantity=args.quantity,
        order_type=args.order_type,
        product_type=args.product_type,
        price=args.price if args.order_type == "LIMIT" else 0,
    )
    if order_id:
        return {"success": True, "orderId": order_id}
    return _fail("Failed to place Cash Secured Put order")


def cmd_cancel(helper: DhanHelper, args) -> dict:
    ok = helper.cancel_order(args.order_id)
    if ok:
        return {"success": True}
    return _fail("Failed to cancel order")


def cmd_exit(helper: DhanHelper, args) -> dict:
    order_id = helper.place_order(
        security_id=args.security_id,
        exchange_segment=args.exchange_segment,
        transaction_type=helper.BUY,
        quantity=args.quantity,
        order_type=helper.MARKET,
        product_type=args.product_type,
    )
    if order_id:
        return {"success": True, "orderId": order_id}
    return _fail("Failed to place exit order")


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
    p_place.add_argument('--order-type', default='MARKET', choices=['MARKET', 'LIMIT'], dest='order_type')
    p_place.add_argument('--price', type=float, default=0)
    p_place.add_argument('--product-type', default='MARGIN', choices=['MARGIN', 'CNC'], dest='product_type')

    p_cancel = sub.add_parser('cancel')
    p_cancel.add_argument('--order-id', required=True, dest='order_id')

    p_exit = sub.add_parser('exit')
    p_exit.add_argument('--security-id', required=True, dest='security_id')
    p_exit.add_argument('--exchange-segment', required=True, dest='exchange_segment')
    p_exit.add_argument('--quantity', required=True, type=int)
    p_exit.add_argument('--product-type', default='MARGIN', dest='product_type')

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
