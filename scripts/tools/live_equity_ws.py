"""
Live equity WebSocket bridge for the RS dashboard live page.

Subscribes to NSE equity stocks (Nifty 50) via Dhan WebSocket and writes
debug/live_equity_quotes.json every 2 seconds for the Next.js dashboard to poll.

Usage:
    venv\\Scripts\\python.exe scripts/tools/live_equity_ws.py [--index nifty50]

Stop gracefully by writing debug/live_equity_stop.trigger  (done automatically
by the dashboard's /api/live-equity  POST {action:"stop"}  endpoint).
"""
import sys
import os
import json
import time
import argparse
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

DEBUG_DIR    = os.path.join(ROOT, 'debug')
QUOTES_FILE  = os.path.join(DEBUG_DIR, 'live_equity_quotes.json')
STATUS_FILE  = os.path.join(DEBUG_DIR, 'live_equity_status.json')
STOP_TRIGGER = os.path.join(DEBUG_DIR, 'live_equity_stop.trigger')

# Must match rs_dashboard/lib/nifty50.ts
NIFTY50_SYMBOLS = [
    'ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK',
    'BAJAJ-AUTO', 'BAJFINANCE', 'BAJAJFINSV', 'BHARTIARTL', 'BPCL',
    'BRITANNIA', 'CIPLA', 'COALINDIA', 'DIVISLAB', 'DRREDDY',
    'EICHERMOT', 'ETERNAL', 'GRASIM', 'HCLTECH', 'HDFCBANK',
    'HDFCLIFE', 'HEROMOTOCO', 'HINDALCO', 'HINDUNILVR', 'ICICIBANK',
    'INDUSINDBK', 'INFY', 'ITC', 'JIOFIN', 'KOTAKBANK',
    'LT', 'M&M', 'MARUTI', 'NESTLEIND', 'NTPC',
    'ONGC', 'POWERGRID', 'RELIANCE', 'SBILIFE', 'SBIN',
    'SHRIRAMFIN', 'SUNPHARMA', 'TATACONSUM', 'TATASTEEL',
    'TCS', 'TECHM', 'TITAN', 'TMPV', 'ULTRACEMCO', 'WIPRO',
]

# MarketFeed exchange constants (from dhanhq SDK)
NSE_EQ    = 1   # NSE cash / equity segment
FEED_QUOTE = 17  # Quote packet: LTP + OHLC + volume (no OI)


def atomic_write(path: str, data: dict):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f)
    os.replace(tmp, path)


def write_status(status: str, subscribed: int = 0, index: str = 'nifty50', started_at: str = ''):
    atomic_write(STATUS_FILE, {
        'status': status,
        'pid': os.getpid(),
        'index': index,
        'subscribed': subscribed,
        'started_at': started_at or datetime.now().isoformat(),
        'last_update': datetime.now().isoformat(),
    })


def main():
    parser = argparse.ArgumentParser(description='Live equity WebSocket bridge')
    parser.add_argument('--index', default='nifty50', choices=['nifty50'],
                        help='Index universe to subscribe (default: nifty50)')
    args = parser.parse_args()

    os.makedirs(DEBUG_DIR, exist_ok=True)
    started_at = datetime.now().isoformat()
    write_status('STARTING', index=args.index, started_at=started_at)

    print(f'[live_equity_ws] Starting — index={args.index}', flush=True)

    dhan = get_dhan_client()
    if not dhan:
        print('[live_equity_ws] ERROR: authentication failed', flush=True)
        write_status('ERROR', index=args.index, started_at=started_at)
        sys.exit(1)

    helper = DhanHelper(dhan)

    symbols = NIFTY50_SYMBOLS

    # ── Resolve security IDs from master list ────────────────────────────────
    print(f'[live_equity_ws] Resolving security IDs for {len(symbols)} symbols…', flush=True)
    sid_to_symbol: dict[str, str] = {}
    instruments = []

    for sym in symbols:
        try:
            sec = helper.find_equity(sym)
            if sec is None:
                print(f'[live_equity_ws] WARNING: {sym} not found in master list', flush=True)
                continue
            sid = str(int(sec['SECURITY_ID']))
            sid_to_symbol[sid] = sym
            instruments.append((NSE_EQ, sid, FEED_QUOTE))
        except Exception as e:
            print(f'[live_equity_ws] WARNING: could not resolve {sym}: {e}', flush=True)

    n = len(instruments)
    print(f'[live_equity_ws] Subscribing to {n} instruments via WebSocket…', flush=True)

    if n == 0:
        print('[live_equity_ws] ERROR: no instruments resolved — aborting', flush=True)
        write_status('ERROR', index=args.index, started_at=started_at)
        sys.exit(1)

    helper.start_websocket(instruments)
    time.sleep(3)  # wait for connection + first tick batch

    write_status('RUNNING', subscribed=n, index=args.index, started_at=started_at)
    print('[live_equity_ws] WebSocket connected. Writing quotes every 2 s…', flush=True)

    # ── Main loop ────────────────────────────────────────────────────────────
    try:
        while True:
            # Graceful stop via trigger file
            if os.path.exists(STOP_TRIGGER):
                try:
                    os.remove(STOP_TRIGGER)
                except OSError:
                    pass
                print('[live_equity_ws] Stop trigger detected — exiting.', flush=True)
                break

            quotes: dict[str, dict] = {}
            for sid, sym in sid_to_symbol.items():
                tick = helper.live_data.get(sid)
                if not tick:
                    continue

                ltp        = float(tick.get('LTP') or tick.get('last_price') or 0)
                prev_close = float(tick.get('prev_close') or tick.get('close') or 0)
                open_      = float(tick.get('open') or 0)
                high       = float(tick.get('high') or 0)
                low        = float(tick.get('low') or 0)
                volume     = int(tick.get('volume') or 0)

                change     = ltp - prev_close if prev_close else 0.0
                change_pct = (change / prev_close * 100) if prev_close else 0.0

                quotes[sym] = {
                    'ltp':        round(ltp, 2),
                    'open':       round(open_, 2),
                    'high':       round(high, 2),
                    'low':        round(low, 2),
                    'prev_close': round(prev_close, 2),
                    'volume':     volume,
                    'change':     round(change, 2),
                    'change_pct': round(change_pct, 4),
                }

            atomic_write(QUOTES_FILE, {
                'updated_at': datetime.now().isoformat(),
                'count': len(quotes),
                'quotes': quotes,
            })
            write_status('RUNNING', subscribed=n, index=args.index, started_at=started_at)

            time.sleep(2)

    except KeyboardInterrupt:
        print('[live_equity_ws] KeyboardInterrupt — shutting down.', flush=True)
    finally:
        write_status('STOPPED', subscribed=0, index=args.index, started_at=started_at)
        print('[live_equity_ws] Stopped.', flush=True)


if __name__ == '__main__':
    main()
