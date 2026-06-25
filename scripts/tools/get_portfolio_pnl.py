"""
Outputs a JSON snapshot of the Dhan account's P&L and open positions to stdout.
Called by the Next.js /api/portfolio route.
"""
import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper


def main():
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"success": False, "error": "Failed to authenticate with Dhan"}))
        sys.exit(1)

    helper = DhanHelper(dhan)

    available_funds = 0.0
    try:
        available_funds = helper.get_available_funds() or 0.0
    except Exception:
        pass

    df = helper.get_positions()

    total_realized = 0.0
    total_unrealized = 0.0
    positions = []

    if not df.empty:
        for _, row in df.iterrows():
            realized = float(row.get('realizedProfit', 0) or 0)
            unrealized = float(row.get('unrealizedProfit', 0) or 0)
            total_realized += realized
            total_unrealized += unrealized
            positions.append({
                "symbol": str(row.get('tradingSymbol', '')),
                "positionType": str(row.get('positionType', '')),
                "netQty": int(row.get('netQty', 0) or 0),
                "buyAvg": float(row.get('buyAvg', 0) or 0),
                "sellAvg": float(row.get('sellAvg', 0) or 0),
                "lastPrice": float(row.get('lastPrice', 0) or 0),
                "realizedProfit": realized,
                "unrealizedProfit": unrealized,
            })

    print(json.dumps({
        "success": True,
        "available_funds": round(available_funds, 2),
        "total_realized_pnl": round(total_realized, 2),
        "total_unrealized_pnl": round(total_unrealized, 2),
        "total_pnl": round(total_realized + total_unrealized, 2),
        "positions": positions,
    }))


if __name__ == "__main__":
    main()
