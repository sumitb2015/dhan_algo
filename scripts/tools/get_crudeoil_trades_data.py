"""
Outputs a JSON snapshot of crude oil / crude oil mini (MCX) positions,
order book, and trade book for the CrudeOilOptions dashboard section.
Called by the Next.js /api/crudeoil-trades route.
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper


def is_crude(symbol: str) -> bool:
    return "CRUDEOIL" in str(symbol).upper()


def main():
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"success": False, "error": "Failed to authenticate with Dhan"}))
        sys.exit(1)

    helper = DhanHelper(dhan)

    # --- Positions ---
    positions_list = []
    try:
        df_positions = helper.get_positions()
        if not df_positions.empty:
            for _, row in df_positions.iterrows():
                symbol = str(row.get('tradingSymbol', ''))
                if not is_crude(symbol):
                    continue
                ltp = float(row.get('lastPrice', 0) or row.get('lastTradedPrice', 0) or 0)
                
                # Check if it is a crude oil option contract to multiply P&L by the lot size (100)
                is_option = any(suffix in symbol.upper() for suffix in ["-CE", "-PE", "CALL", "PUT"])
                multiplier = 100 if is_option else 1

                positions_list.append({
                    "symbol": symbol,
                    "positionType": str(row.get('positionType', '')),
                    "netQty": int(row.get('netQty', 0) or 0),
                    "buyAvg": float(row.get('buyAvg', 0) or 0),
                    "sellAvg": float(row.get('sellAvg', 0) or 0),
                    "lastPrice": ltp,
                    "realizedProfit": float(row.get('realizedProfit', 0) or 0),
                    "unrealizedProfit": float(row.get('unrealizedProfit', 0) or 0) * multiplier,
                })
    except Exception:
        pass

    # --- Order Book ---
    orders_list = []
    try:
        for o in helper.get_order_list():
            symbol = str(o.get('tradingSymbol', ''))
            if not is_crude(symbol):
                continue
            orders_list.append({
                "orderId": str(o.get('orderId', '')),
                "symbol": symbol,
                "exchange": str(o.get('exchangeSegment', '')),
                "orderType": str(o.get('orderType', '')),
                "transactionType": str(o.get('transactionType', '')),
                "productType": str(o.get('productType', '')),
                "quantity": int(o.get('quantity', 0) or 0),
                "filledQty": int(o.get('filledQty', 0) or 0),
                "price": float(o.get('price', 0) or 0),
                "triggerPrice": float(o.get('triggerPrice', 0) or 0),
                "tradedPrice": float(o.get('tradedPrice', 0) or 0),
                "status": str(o.get('orderStatus', '')),
                "validity": str(o.get('validity', '')),
                "createTime": str(o.get('createTime', '')),
                "updateTime": str(o.get('updateTime', '')),
            })
    except Exception:
        pass

    # --- Trade Book ---
    trades_list = []
    try:
        for t in helper.get_trade_book():
            symbol = str(t.get('tradingSymbol', ''))
            if not is_crude(symbol):
                continue
            trades_list.append({
                "orderId": str(t.get('orderId', '')),
                "symbol": symbol,
                "exchange": str(t.get('exchangeSegment', '')),
                "transactionType": str(t.get('transactionType', '')),
                "productType": str(t.get('productType', '')),
                "tradedQuantity": int(t.get('tradedQuantity', 0) or 0),
                "tradedPrice": float(t.get('tradedPrice', 0) or 0),
                "tradeId": str(t.get('exchangeTradeId', '') or t.get('tradeId', '')),
                "createTime": str(t.get('createTime', '')),
                "exchangeTime": str(t.get('exchangeTime', '')),
            })
    except Exception:
        pass

    print(json.dumps({
        "success": True,
        "positions": positions_list,
        "orders": orders_list,
        "trades": trades_list,
    }))


if __name__ == "__main__":
    main()
