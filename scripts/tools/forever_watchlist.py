"""
CLI for the Equity Forever Order Watchlist dashboard page.

Usage:
    python forever_watchlist.py list   --symbols RELIANCE,TCS,INFY
    python forever_watchlist.py place  --symbol RELIANCE --transaction BUY --quantity 10 \
                                        --price 1400 --trigger-price 1405 --order-flag SINGLE
    python forever_watchlist.py modify --order-id 1100... --order-flag SINGLE --quantity 10 \
                                        --price 1410 --trigger-price 1415
    python forever_watchlist.py cancel --order-id 1100...

Prints a single JSON line to stdout. Logs go to stderr.
"""
import sys
import os
import json
import argparse
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper


def _get_helper() -> DhanHelper:
    dhan = get_dhan_client()
    if not dhan:
        raise RuntimeError("Failed to authenticate with Dhan")
    return DhanHelper(dhan)


def cmd_list(helper: DhanHelper, symbols: list) -> dict:
    security_ids = {}
    for sym in symbols:
        sec = helper.find_equity(sym)
        if sec:
            security_ids[sym] = int(sec['SECURITY_ID'])

    ohlc_by_id = {}
    if security_ids:
        ohlc = helper.get_ohlc_data({"NSE_EQ": list(security_ids.values())})
        ohlc_by_id = ohlc.get("NSE_EQ", {}) if isinstance(ohlc, dict) else {}

    orders_by_symbol = {}
    for o in helper.get_forever_orders():
        sym = str(o.get('tradingSymbol', '')).removesuffix('-EQ')
        orders_by_symbol.setdefault(sym, []).append({
            "orderId": str(o.get('orderId', '')),
            # Dhan's Forever order response carries the SINGLE/OCO flag under
            # `orderType` (not `orderFlag`, despite the request field being named that).
            "orderFlag": str(o.get('orderType', 'SINGLE')),
            "transactionType": str(o.get('transactionType', '')),
            "quantity": int(o.get('quantity', 0) or 0),
            "price": float(o.get('price', 0) or 0),
            "triggerPrice": float(o.get('triggerPrice', 0) or 0),
            "status": str(o.get('orderStatus', '')),
            "legName": o.get('legName'),
            "createTime": str(o.get('createTime', '')),
            "updateTime": str(o.get('updateTime', '')),
        })

    holdings_by_symbol = {}
    df_holdings = helper.get_holdings()
    if not df_holdings.empty:
        for _, row in df_holdings.iterrows():
            sym = str(row.get('tradingSymbol', '')).removesuffix('-EQ')
            holdings_by_symbol[sym] = {
                "portfolioQty": int(row.get('totalQty', 0) or 0),
                "avgCostPrice": float(row.get('avgCostPrice', 0) or 0),
            }

    rows = []
    for sym in symbols:
        sec_id = security_ids.get(sym)
        quote = ohlc_by_id.get(str(sec_id), {}) if sec_id is not None else {}
        ltp = float(quote.get('last_price', 0) or 0)
        prev_close = float((quote.get('ohlc') or {}).get('close', 0) or 0)
        day_change_pct = round(((ltp - prev_close) / prev_close * 100), 2) if prev_close else 0.0
        holding = holdings_by_symbol.get(sym, {"portfolioQty": 0, "avgCostPrice": 0.0})

        rows.append({
            "symbol": sym,
            "ltp": ltp,
            "prevClose": prev_close,
            "dayChangePct": day_change_pct,
            "portfolioQty": holding["portfolioQty"],
            "avgCostPrice": holding["avgCostPrice"],
            "foreverOrders": orders_by_symbol.get(sym, []),
        })

    return {
        "success": True,
        "asOf": datetime.now(timezone.utc).isoformat(),
        "rows": rows,
    }


def cmd_place(helper: DhanHelper, args) -> dict:
    order_id = helper.place_forever(
        symbol=args.symbol,
        transaction_type=args.transaction,
        quantity=args.quantity,
        price=args.price,
        trigger_price=args.trigger_price,
        order_type=helper.LIMIT,
        product_type=helper.CNC,
        order_flag=args.order_flag,
        price1=args.price1 or 0,
        trigger_price1=args.trigger_price1 or 0,
        quantity1=args.quantity1 or 0,
        instrument="EQUITY",
    )
    if order_id:
        return {"success": True, "orderId": order_id}
    return {"success": False, "error": "Failed to place Forever order"}


def cmd_modify(helper: DhanHelper, args) -> dict:
    ok = helper.modify_forever_order(
        order_id=args.order_id,
        order_flag=args.order_flag,
        order_type=helper.LIMIT,
        leg_name=args.leg_name,
        quantity=args.quantity,
        price=args.price,
        trigger_price=args.trigger_price,
    )
    if ok:
        return {"success": True}
    return {"success": False, "error": "Failed to modify Forever order"}


def cmd_cancel(helper: DhanHelper, args) -> dict:
    ok = helper.cancel_forever_order(args.order_id)
    if ok:
        return {"success": True}
    return {"success": False, "error": "Failed to cancel Forever order"}


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd')

    p_list = sub.add_parser('list')
    p_list.add_argument('--symbols', required=True, help="Comma-separated symbol list")

    p_place = sub.add_parser('place')
    p_place.add_argument('--symbol', required=True)
    p_place.add_argument('--transaction', required=True, choices=['BUY', 'SELL'])
    p_place.add_argument('--quantity', required=True, type=int)
    p_place.add_argument('--price', required=True, type=float)
    p_place.add_argument('--trigger-price', required=True, type=float, dest='trigger_price')
    p_place.add_argument('--order-flag', default='SINGLE', choices=['SINGLE', 'OCO'], dest='order_flag')
    p_place.add_argument('--price1', type=float, default=0)
    p_place.add_argument('--trigger-price1', type=float, default=0, dest='trigger_price1')
    p_place.add_argument('--quantity1', type=int, default=0)

    p_modify = sub.add_parser('modify')
    p_modify.add_argument('--order-id', required=True, dest='order_id')
    p_modify.add_argument('--order-flag', required=True, choices=['SINGLE', 'OCO'], dest='order_flag')
    p_modify.add_argument('--leg-name', required=True, choices=['TARGET_LEG', 'STOP_LOSS_LEG'], dest='leg_name')
    p_modify.add_argument('--quantity', required=True, type=int)
    p_modify.add_argument('--price', required=True, type=float)
    p_modify.add_argument('--trigger-price', required=True, type=float, dest='trigger_price')

    p_cancel = sub.add_parser('cancel')
    p_cancel.add_argument('--order-id', required=True, dest='order_id')

    args = parser.parse_args()

    helper = _get_helper()

    if args.cmd == 'list':
        symbols = [s.strip().upper() for s in args.symbols.split(',') if s.strip()]
        result = cmd_list(helper, symbols)
    elif args.cmd == 'place':
        result = cmd_place(helper, args)
    elif args.cmd == 'modify':
        result = cmd_modify(helper, args)
    elif args.cmd == 'cancel':
        result = cmd_cancel(helper, args)
    else:
        result = {"success": False, "error": "unknown command"}

    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}))
        sys.exit(0)
