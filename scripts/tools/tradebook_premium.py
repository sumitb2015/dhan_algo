"""
Outputs minute-by-minute combined open sell premium from today's FNO tradebook.
Called by the Next.js /api/options/premium-chart route.
"""
import sys
import os
import json
import re
from collections import deque
from datetime import datetime, date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

SESSION_START = "09:15"
SESSION_END   = "15:30"


def extract_underlying(symbol: str) -> str:
    """Extract underlying from option symbol, e.g. NIFTY2470725000CE → NIFTY."""
    m = re.match(r'^([A-Z&]+)\d{6}', symbol)
    return m.group(1) if m else symbol


def get_trade_minute(trade: dict) -> str:
    """Return HH:MM from trade dict, preferring exchangeTime over createTime."""
    raw = trade.get('exchangeTime') or trade.get('createTime') or ''
    try:
        for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%dT%H:%M:%S'):
            try:
                return datetime.strptime(raw[:19], fmt).strftime('%H:%M')
            except ValueError:
                continue
    except Exception:
        pass
    return raw[11:16] if len(raw) >= 16 else SESSION_START


def build_minute_series(
    events: list[tuple[str, float]],
    is_post_session: bool,
) -> list[dict]:
    """
    Expand (HH:MM, premium) events into a per-minute flat series.
    Holds last known value between events.
    """
    now_str  = datetime.now().strftime('%H:%M')
    end_str  = SESSION_END if is_post_session or now_str >= SESSION_END else now_str

    start_dt = datetime.strptime(SESSION_START, '%H:%M')
    end_dt   = datetime.strptime(end_str,       '%H:%M')

    # Last event per minute wins
    event_map: dict[str, float] = {}
    for t, p in events:
        event_map[t] = p

    series: list[dict] = []
    current      = start_dt
    last_premium = 0.0

    while current <= end_dt:
        t = current.strftime('%H:%M')
        if t in event_map:
            last_premium = event_map[t]
        series.append({'time': t, 'premium': round(last_premium, 2)})
        current += timedelta(minutes=1)

    return series


def main() -> None:
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'success': False, 'error': 'Failed to authenticate'}))
        sys.exit(1)

    helper = DhanHelper(dhan)

    trades     = helper.get_trade_book()
    fno_trades = [t for t in trades if t.get('exchangeSegment') == 'NSE_FNO']

    today = date.today().isoformat()

    if not fno_trades:
        print(json.dumps({
            'success': True,
            'data': [],
            'current_premium': 0.0,
            'session_date': today,
            'trades_count': 0,
        }))
        return

    # Resolve lot sizes for each unique underlying
    underlyings = {extract_underlying(t['tradingSymbol']) for t in fno_trades}
    lot_sizes: dict[str, int] = {}
    for u in underlyings:
        try:
            lot_sizes[u] = int(helper.get_lot_size(u) or 1)
        except Exception:
            lot_sizes[u] = 1

    # Sort trades chronologically
    fno_trades.sort(key=lambda t: (t.get('exchangeTime') or t.get('createTime') or ''))

    # FIFO open-position tracking
    # open_positions[symbol] = deque of {'lots': float, 'sell_price': float}
    open_positions: dict[str, deque] = {}
    combined_premium = 0.0
    events: list[tuple[str, float]] = []

    for trade in fno_trades:
        symbol     = trade.get('tradingSymbol', '')
        underlying = extract_underlying(symbol)
        lot_size   = lot_sizes.get(underlying, 1)
        raw_qty    = float(trade.get('tradedQuantity') or 0)
        qty_lots   = raw_qty / lot_size
        price      = float(trade.get('tradedPrice') or 0)
        txn        = trade.get('transactionType', '')
        minute     = get_trade_minute(trade)

        if txn == 'SELL':
            if symbol not in open_positions:
                open_positions[symbol] = deque()
            open_positions[symbol].append({'lots': qty_lots, 'sell_price': price})
            combined_premium += qty_lots * price

        elif txn == 'BUY':
            q         = open_positions.get(symbol, deque())
            remaining = qty_lots
            while remaining > 0 and q:
                front = q[0]
                if front['lots'] <= remaining:
                    combined_premium -= front['lots'] * front['sell_price']
                    remaining        -= front['lots']
                    q.popleft()
                else:
                    combined_premium      -= remaining * front['sell_price']
                    front['lots']         -= remaining
                    remaining              = 0

        events.append((minute, round(combined_premium, 2)))

    now_hm  = datetime.now().strftime('%H:%M')
    is_post = now_hm > SESSION_END
    series  = build_minute_series(events, is_post)

    print(json.dumps({
        'success':         True,
        'data':            series,
        'current_premium': round(combined_premium, 2),
        'session_date':    today,
        'trades_count':    len(fno_trades),
    }))


if __name__ == '__main__':
    main()
