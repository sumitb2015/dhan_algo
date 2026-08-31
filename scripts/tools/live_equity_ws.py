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
from zoneinfo import ZoneInfo

IST = ZoneInfo('Asia/Kolkata')

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib import market_hub_client as hub_client

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

    # Market data now comes from the shared market_data_hub.py process rather than
    # this bridge's own WebSocket connection — see lib/market_hub_client.py. The hub
    # is spawned lazily (idempotent) and re-spawned automatically if it ever dies
    # mid-session; ensure_hub_running() is called here and again periodically below.
    hub_client.ensure_hub_running()
    hub_client.register_wanted('live_equity', instruments)

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not hub_client.read_live_data():
        time.sleep(0.5)  # wait for the hub's first tick batch

    write_status('RUNNING', subscribed=n, index=args.index, started_at=started_at)
    print('[live_equity_ws] Registered with market data hub. Writing quotes every 2 s…', flush=True)

    # Stall detection (dead-but-silent hub connection, or a dead hub process itself)
    # is now centralized in market_data_hub.py — see its STALL_SEC watchdog. This
    # bridge's own responsibility is narrower: notice if the hub's shared tick file
    # has gone stale and re-trigger ensure_hub_running(), which is a no-op if the hub
    # is merely mid-reconnect-backoff (still alive, still heartbeating) and a real
    # respawn only if the hub process itself died.
    HUB_STALE_SEC = 8
    HUB_CHECK_INTERVAL_SEC = 5
    last_hub_check = time.monotonic()

    # Yesterday's close, keyed "<IST date>:<symbol>", populated by the first
    # genuine (non-flipped) tick seen each day and reused after that.
    #
    # Dhan's Quote packet 'close' field flips to equal the live LTP the moment
    # the 15:30 bell rings (same behaviour documented for the OHLC REST
    # endpoint in rs_dashboard/app/api/scalper/top-indices/route.ts) — without
    # this cache, every symbol would silently collapse to a confident 0.00%
    # change once the market closes.
    prev_close_cache: dict[str, float] = {}

    def ist_today() -> str:
        return datetime.now(IST).strftime('%Y-%m-%d')

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
                hub_client.unregister_wanted('live_equity')
                break

            now_monotonic = time.monotonic()
            if now_monotonic - last_hub_check >= HUB_CHECK_INTERVAL_SEC:
                last_hub_check = now_monotonic
                hub_updated = hub_client.live_data_updated_at()
                if hub_updated is None or time.time() - hub_updated > HUB_STALE_SEC:
                    # Idempotent — a no-op if the hub is alive and merely mid-backoff;
                    # only actually respawns if the hub process itself died.
                    hub_client.ensure_hub_running()

            live_ticks = hub_client.read_live_data()
            quotes: dict[str, dict] = {}
            day = ist_today()
            for key in [k for k in prev_close_cache if not k.startswith(f'{day}:')]:
                del prev_close_cache[key]
            for sid, sym in sid_to_symbol.items():
                tick = live_ticks.get(sid)
                if not tick:
                    continue

                ltp = float(tick.get('LTP') or tick.get('last_price') or 0)

                cache_key = f'{day}:{sym}'
                cached = prev_close_cache.get(cache_key)
                if cached is not None:
                    prev_close = cached
                else:
                    raw_close = float(tick.get('prev_close') or tick.get('close') or 0)
                    # A raw close equal to LTP is Dhan's post-close flip, not a
                    # genuine 0% day — treat it as unknown rather than cache it.
                    prev_close = raw_close if raw_close > 0 and raw_close != ltp else 0.0
                    if prev_close:
                        prev_close_cache[cache_key] = prev_close

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
        hub_client.unregister_wanted('live_equity')
    finally:
        write_status('STOPPED', subscribed=0, index=args.index, started_at=started_at)
        print('[live_equity_ws] Stopped.', flush=True)


if __name__ == '__main__':
    main()
