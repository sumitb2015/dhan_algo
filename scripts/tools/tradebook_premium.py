"""
Outputs minute-by-minute combined open sell premium (mark-to-market) from today's FNO tradebook.
For each open position at each minute, uses the current 1-min candle close price × lots,
so that real option premium decay is visible rather than fixed entry prices.
"""
import sys
import os
import json
import time
from collections import deque
from datetime import datetime, date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

SESSION_START = "09:15"
SESSION_END   = "15:30"


def get_trade_minute(trade: dict) -> str:
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


def build_minute_list(is_post_session: bool) -> list[str]:
    now_str  = datetime.now().strftime('%H:%M')
    end_str  = SESSION_END if is_post_session or now_str >= SESSION_END else now_str
    start_dt = datetime.strptime(SESSION_START, '%H:%M')
    end_dt   = datetime.strptime(end_str, '%H:%M')
    minutes: list[str] = []
    current = start_dt
    while current <= end_dt:
        minutes.append(current.strftime('%H:%M'))
        current += timedelta(minutes=1)
    return minutes


def fetch_price_series(
    helper: DhanHelper,
    sid: str,
    instrument: str,
    today: str,
    all_minutes: list[str],
) -> dict[str, float]:
    """Fetch 1-min candles for a security and forward-fill into a {HH:MM: close} map."""
    try:
        df = helper.get_intraday_minute_data(
            security_id=sid,
            exchange_segment='NSE_FNO',
            instrument_type=instrument,
            interval='1',
            from_date=today,
            to_date=today,
        )
    except Exception:
        return {}

    if df.empty or 'close' not in df.columns or 'timestamp' not in df.columns:
        return {}

    # Build raw {HH:MM: close} from epoch timestamps
    raw: dict[str, float] = {}
    for _, row in df.iterrows():
        try:
            dt  = datetime.fromtimestamp(int(row['timestamp']))
            raw[dt.strftime('%H:%M')] = float(row['close'])
        except Exception:
            continue

    # Forward-fill across all session minutes
    filled: dict[str, float] = {}
    last = 0.0
    for m in all_minutes:
        if m in raw:
            last = raw[m]
        filled[m] = last
    return filled


def main() -> None:
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'success': False, 'error': 'Failed to authenticate'}))
        sys.exit(1)

    helper = DhanHelper(dhan)
    today  = date.today().isoformat()

    trades     = helper.get_trade_book()
    fno_trades = [t for t in trades if t.get('exchangeSegment') == 'NSE_FNO']

    if not fno_trades:
        print(json.dumps({'success': True, 'data': [], 'current_premium': 0.0,
                          'session_date': today, 'trades_count': 0}))
        return

    # Look up lot sizes and instrument types by securityId from master list
    master        = helper._load_master_list()
    master_by_sid = master.copy()
    master_by_sid['_sid_str'] = master_by_sid['SECURITY_ID'].astype(str)
    master_by_sid = master_by_sid.set_index('_sid_str')

    def get_lot_size(sid: str) -> float:
        try:
            return float(master_by_sid.loc[sid, 'LOT_SIZE']) or 1.0
        except (KeyError, TypeError, ValueError):
            return 1.0

    def get_instrument(sid: str) -> str:
        try:
            return str(master_by_sid.loc[sid, 'INSTRUMENT'])
        except (KeyError, TypeError):
            return 'OPTIDX'

    # Sort trades chronologically
    fno_trades.sort(key=lambda t: (t.get('exchangeTime') or t.get('createTime') or ''))

    # FIFO open-position tracking → position windows
    # Each window: {security_id, lots, open_minute, close_minute (None = still open)}
    position_windows: list[dict] = []
    open_queues: dict[str, deque] = {}

    for trade in fno_trades:
        sid    = str(trade.get('securityId', ''))
        lots   = float(trade.get('tradedQuantity') or 0) / get_lot_size(sid)
        txn    = trade.get('transactionType', '')
        minute = get_trade_minute(trade)

        if txn == 'SELL':
            if sid not in open_queues:
                open_queues[sid] = deque()
            open_queues[sid].append({'lots': lots, 'open_minute': minute})

        elif txn == 'BUY':
            q         = open_queues.get(sid, deque())
            remaining = lots
            while remaining > 0 and q:
                front = q[0]
                if front['lots'] <= remaining:
                    position_windows.append({
                        'security_id': sid, 'lots': front['lots'],
                        'open_minute': front['open_minute'], 'close_minute': minute,
                    })
                    remaining -= front['lots']
                    q.popleft()
                else:
                    position_windows.append({
                        'security_id': sid, 'lots': remaining,
                        'open_minute': front['open_minute'], 'close_minute': minute,
                    })
                    front['lots'] -= remaining
                    remaining      = 0

    # Still-open positions
    for sid, q in open_queues.items():
        for entry in q:
            position_windows.append({
                'security_id': sid, 'lots': entry['lots'],
                'open_minute': entry['open_minute'], 'close_minute': None,
            })

    now_hm      = datetime.now().strftime('%H:%M')
    is_post     = now_hm > SESSION_END
    all_minutes = build_minute_list(is_post)

    # Fetch 1-min candle price series for each unique security
    unique_sids = {pw['security_id'] for pw in position_windows}
    price_maps: dict[str, dict[str, float]] = {}
    for sid in unique_sids:
        instrument = get_instrument(sid)
        price_maps[sid] = fetch_price_series(helper, sid, instrument, today, all_minutes)
        time.sleep(0.3)  # avoid rate-limit bursts when fetching many symbols

    # Build minute-by-minute mark-to-market combined premium
    series: list[dict] = []
    for minute in all_minutes:
        combined = 0.0
        for pw in position_windows:
            if pw['open_minute'] > minute:
                continue
            if pw['close_minute'] is not None and pw['close_minute'] <= minute:
                continue
            price     = price_maps.get(pw['security_id'], {}).get(minute, 0.0)
            combined += pw['lots'] * price
        series.append({'time': minute, 'premium': round(combined, 2)})

    current_premium = series[-1]['premium'] if series else 0.0

    print(json.dumps({
        'success':         True,
        'data':            series,
        'current_premium': round(current_premium, 2),
        'session_date':    today,
        'trades_count':    len(fno_trades),
    }))


if __name__ == '__main__':
    main()
