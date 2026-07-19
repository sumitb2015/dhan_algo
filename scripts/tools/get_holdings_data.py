"""
Outputs a JSON snapshot of Dhan holdings and positions for the portfolio dashboard.
Called by the Next.js /api/portfolio-holdings route.
"""
import sys
import os
import json
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

IST = timezone(timedelta(hours=5, minutes=30))
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HISTORY_FILE = os.path.join(PROJECT_ROOT, 'debug', 'portfolio_value_history.json')


def snapshot_value_history(total_invested: float, total_current_value: float, equity_value: float, etf_value: float) -> None:
    """Upsert today's (IST) total portfolio value into debug/portfolio_value_history.json."""
    today = datetime.now(IST).strftime('%Y-%m-%d')
    try:
        with open(HISTORY_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        data = {"history": []}

    history = data.get("history", [])
    entry = {
        "date": today,
        "totalInvested": round(total_invested, 2),
        "totalCurrentValue": round(total_current_value, 2),
        "equityValue": round(equity_value, 2),
        "etfValue": round(etf_value, 2),
    }
    history = [h for h in history if h.get("date") != today]
    history.append(entry)
    history.sort(key=lambda h: h["date"])
    data["history"] = history

    try:
        os.makedirs(os.path.dirname(HISTORY_FILE), exist_ok=True)
        with open(HISTORY_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f)
    except Exception:
        pass

ETF_SUFFIXES = ('BEES', 'ETF', 'FUND', 'IETF', 'LIQUIDCASE', 'GOLDETF', 'SILVERETF')
ETF_CONTAINS = ('GOLDBEES', 'NIFTYBEES', 'BANKBEES', 'LIQUIDBEES', 'JUNIORBEES',
                'CPSEETF', 'NIFTYETF', 'HDFCNIFTY', 'ICICINIFTY', 'SBINIFTY',
                'KOTAKNIFTY', 'UTINIFTY', 'MAFANG', 'SETFNN50', 'BSLNIFTY')


def classify_asset(symbol: str) -> str:
    upper = symbol.upper().replace('-', '').replace('_', '')
    if any(upper.endswith(s) for s in ETF_SUFFIXES):
        return 'ETF'
    if any(k in upper for k in ETF_CONTAINS):
        return 'ETF'
    return 'EQUITY'


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

    # --- Holdings ---
    holdings_list = []
    total_invested = 0.0
    total_current_value = 0.0
    total_equity_value = 0.0
    total_etf_value = 0.0

    df_holdings = helper.get_holdings()
    if not df_holdings.empty:
        # Normalise LTP field across SDK versions
        if 'lastTradedPrice' not in df_holdings.columns:
            for alias in ('lastPrice', 'currentMarketPrice', 'ltp'):
                if alias in df_holdings.columns:
                    df_holdings['lastTradedPrice'] = df_holdings[alias]
                    break
        if 'lastTradedPrice' not in df_holdings.columns:
            df_holdings['lastTradedPrice'] = 0.0

        for _, row in df_holdings.iterrows():
            symbol = str(row.get('tradingSymbol', '')).removesuffix('-EQ')
            qty = int(row.get('totalQty', 0) or 0)
            avg_cost = float(row.get('avgCostPrice', 0) or 0)
            ltp = float(row.get('lastTradedPrice', 0) or 0)
            invested = round(qty * avg_cost, 2)
            current_val = round(qty * ltp, 2)
            pnl = round(current_val - invested, 2)
            pnl_pct = round((pnl / invested * 100) if invested > 0 else 0.0, 2)

            asset_type = classify_asset(symbol)
            total_invested += invested
            total_current_value += current_val
            if asset_type == 'ETF':
                total_etf_value += current_val
            else:
                total_equity_value += current_val

            holdings_list.append({
                "symbol": symbol,
                "isin": str(row.get('isin', '')),
                "exchange": str(row.get('exchangeSegment', 'NSE')),
                "totalQty": qty,
                "dpQty": int(row.get('dpQty', qty) or qty),
                "t1Qty": int(row.get('t1Qty', 0) or 0),
                "avgCostPrice": avg_cost,
                "lastTradedPrice": ltp,
                "investedValue": invested,
                "currentValue": current_val,
                "pnl": pnl,
                "pnlPct": pnl_pct,
                "assetType": asset_type,
            })

    holdings_list.sort(key=lambda x: x['currentValue'], reverse=True)

    # --- Positions (F&O / intraday) ---
    positions_list = []
    total_realized = 0.0
    total_unrealized = 0.0

    df_positions = helper.get_positions()
    if not df_positions.empty:
        for _, row in df_positions.iterrows():
            realized = float(row.get('realizedProfit', 0) or 0)
            unrealized = float(row.get('unrealizedProfit', 0) or 0)
            total_realized += realized
            total_unrealized += unrealized
            ltp = float(row.get('lastPrice', 0) or row.get('lastTradedPrice', 0) or 0)
            positions_list.append({
                "symbol": str(row.get('tradingSymbol', '')).removesuffix('-EQ'),
                "positionType": str(row.get('positionType', '')),
                "netQty": int(row.get('netQty', 0) or 0),
                "buyAvg": float(row.get('buyAvg', 0) or 0),
                "sellAvg": float(row.get('sellAvg', 0) or 0),
                "lastPrice": ltp,
                "realizedProfit": realized,
                "unrealizedProfit": unrealized,
            })

    # --- Order Book ---
    orders_list = []
    try:
        for o in helper.get_order_list():
            orders_list.append({
                "orderId": str(o.get('orderId', '')),
                "symbol": str(o.get('tradingSymbol', '')).removesuffix('-EQ'),
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
                "remarks": str(o.get('drvOptionType', '') or o.get('remarks', '')),
            })
    except Exception:
        pass

    # --- Trade Book ---
    trades_list = []
    try:
        for t in helper.get_trade_book():
            trades_list.append({
                "orderId": str(t.get('orderId', '')),
                "symbol": str(t.get('tradingSymbol', '')).removesuffix('-EQ'),
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

    total_pnl = round(total_current_value - total_invested, 2)
    total_pnl_pct = round((total_pnl / total_invested * 100) if total_invested > 0 else 0.0, 2)

    if total_invested > 0:
        snapshot_value_history(total_invested, total_current_value, total_equity_value, total_etf_value)

    print(json.dumps({
        "success": True,
        "available_funds": round(available_funds, 2),
        "holdings": holdings_list,
        "positions": positions_list,
        "orders": orders_list,
        "trades": trades_list,
        "summary": {
            "holdingsCount": len(holdings_list),
            "positionsCount": len(positions_list),
            "ordersCount": len(orders_list),
            "tradesCount": len(trades_list),
            "totalInvested": round(total_invested, 2),
            "totalCurrentValue": round(total_current_value, 2),
            "totalPnl": total_pnl,
            "totalPnlPct": total_pnl_pct,
            "realizedPnl": round(total_realized, 2),
            "unrealizedPnl": round(total_unrealized, 2),
        }
    }))


if __name__ == "__main__":
    main()
