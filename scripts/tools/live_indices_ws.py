"""
Live indices WebSocket bridge for the RS dashboard Normalized Charts tab.

Subscribes to NSE index instruments via Dhan WebSocket and writes
debug/live_indices_history.json every 2 seconds — full intraday tick history
from session open, used by the Next.js /live Normalized tab.

Usage:
    venv\\Scripts\\python.exe scripts/tools/live_indices_ws.py

Stop gracefully by writing debug/live_indices_stop.trigger (done automatically
by the dashboard's /api/live-indices POST {action:"stop"} endpoint).
"""
import sys
import os
import io
import json
import time
import argparse
from datetime import datetime, timezone

# Force UTF-8 stdout/stderr on Windows so Unicode print statements don't fail
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

DEBUG_DIR    = os.path.join(ROOT, 'debug')
HISTORY_FILE = os.path.join(DEBUG_DIR, 'live_indices_history.json')
STATUS_FILE  = os.path.join(DEBUG_DIR, 'live_indices_status.json')
STOP_TRIGGER = os.path.join(DEBUG_DIR, 'live_indices_stop.trigger')

# MarketFeed segment/type constants (from dhanhq SDK)
IDX        = 0   # Index segment
FEED_QUOTE = 17  # Quote packet: LTP + OHLC + prev_close

# Index catalogue — (SYMBOL_NAME as in master_list.csv, label, category)
# Symbols must match DhanHelper.find_index() which does an exact SYMBOL_NAME match.
INDEX_CATALOGUE = [
    # Broad Market
    ('NIFTY',              'Nifty 50',           'Broad Market'),
    ('NIFTYNXT50',         'Nifty Next 50',       'Broad Market'),
    ('NIFTY 100',          'Nifty 100',           'Broad Market'),
    ('NIFTY 200',          'Nifty 200',           'Broad Market'),
    ('NIFTY 500',          'Nifty 500',           'Broad Market'),
    ('NIFTY MIDCAP 150',   'Nifty Midcap 150',   'Broad Market'),
    ('NIFTY SMALLCAP 100', 'Nifty Smallcap 100', 'Broad Market'),
    ('MIDCPNIFTY',         'Nifty Midcap 50',    'Broad Market'),
    # Sectoral
    ('BANKNIFTY',          'Nifty Bank',          'Sectoral'),
    ('FINNIFTY',           'Nifty Fin Services',  'Sectoral'),
    ('NIFTYIT',            'Nifty IT',            'Sectoral'),
    ('NIFTY AUTO',         'Nifty Auto',          'Sectoral'),
    ('NIFTY PHARMA',       'Nifty Pharma',        'Sectoral'),
    ('NIFTY FMCG',         'Nifty FMCG',          'Sectoral'),
    ('NIFTY METAL',        'Nifty Metal',         'Sectoral'),
    ('NIFTY REALTY',       'Nifty Realty',        'Sectoral'),
    ('NIFTY PSU BANK',     'Nifty PSU Bank',      'Sectoral'),
    ('NIFTY PVT BANK',     'Nifty Private Bank',  'Sectoral'),
    ('NIFTY ENERGY',       'Nifty Energy',        'Sectoral'),
    ('NIFTYINFRA',         'Nifty Infra',         'Sectoral'),
    ('NIFTY MEDIA',        'Nifty Media',         'Sectoral'),
    ('NIFTY HEALTHCARE',   'Nifty Healthcare',    'Sectoral'),
    ('NIFTY OIL AND GAS',  'Nifty Oil and Gas',   'Sectoral'),
    ('NIFTY CONSR DURBL',  'Nifty Consumer Durables', 'Sectoral'),
    ('NIFTY FINSRV25 50',  'Nifty Fin Services 25/50', 'Sectoral'),
    # Volatility
    ('INDIA VIX',          'India VIX',           'Volatility'),
]


def atomic_write(path: str, data: dict):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f)
    os.replace(tmp, path)


def write_status(status: str, subscribed: int = 0, started_at: str = ''):
    atomic_write(STATUS_FILE, {
        'status': status,
        'pid': os.getpid(),
        'subscribed': subscribed,
        'started_at': started_at or datetime.now().isoformat(),
        'last_update': datetime.now().isoformat(),
    })


def ist_time() -> str:
    """Return current IST wall-clock time as HH:MM:SS string."""
    # IST = UTC+5:30; use local time since the machine is in IST.
    return datetime.now().strftime('%H:%M:%S')


def main():
    parser = argparse.ArgumentParser(description='Live indices WebSocket bridge')
    parser.add_argument('--interval', type=float, default=2.0,
                        help='Write interval in seconds (default: 2)')
    args = parser.parse_args()

    os.makedirs(DEBUG_DIR, exist_ok=True)
    started_at = datetime.now().isoformat()
    write_status('STARTING', started_at=started_at)
    print('[live_indices_ws] Starting...', flush=True)

    dhan = get_dhan_client()
    if not dhan:
        print('[live_indices_ws] ERROR: authentication failed', flush=True)
        write_status('ERROR', started_at=started_at)
        sys.exit(1)

    helper = DhanHelper(dhan)

    # ── Resolve security IDs ─────────────────────────────────────────────────
    sid_to_symbol: dict[str, str] = {}
    labels:   dict[str, str] = {}
    categories: dict[str, str] = {}
    instruments = []

    for sym, label, category in INDEX_CATALOGUE:
        try:
            sec = helper.find_index(sym)
            if sec is None:
                print(f'[live_indices_ws] WARNING: {sym} not found - skipping', flush=True)
                continue
            sid = str(int(sec['SECURITY_ID']))
            sid_to_symbol[sid] = sym
            labels[sym]     = label
            categories[sym] = category
            instruments.append((IDX, sid, FEED_QUOTE))
            print(f'[live_indices_ws] Resolved {sym} -> SID {sid}', flush=True)
        except Exception as e:
            print(f'[live_indices_ws] WARNING: could not resolve {sym}: {e}', flush=True)

    n = len(instruments)
    if n == 0:
        print('[live_indices_ws] ERROR: no instruments resolved - aborting', flush=True)
        write_status('ERROR', started_at=started_at)
        sys.exit(1)

    print(f'[live_indices_ws] Subscribing to {n} indices...', flush=True)

    helper.start_websocket(instruments)
    time.sleep(3)  # wait for connection + first tick batch

    # ── Restore session open baseline if same calendar day ───────────────────
    session_date = datetime.now().strftime('%Y-%m-%d')
    opens:      dict[str, float] = {}
    ticks:      list[dict]       = []
    last_known: dict[str, float] = {}  # forward-fill buffer

    try:
        if os.path.exists(HISTORY_FILE):
            existing = json.loads(open(HISTORY_FILE).read())
            if existing.get('session_date') == session_date:
                opens = existing.get('opens', {})
                ticks = existing.get('ticks', [])
                print(f'[live_indices_ws] Restored {len(opens)} opens and '
                      f'{len(ticks)} ticks from existing history', flush=True)
    except Exception as e:
        print(f'[live_indices_ws] WARNING: could not restore history: {e}', flush=True)

    write_status('RUNNING', subscribed=n, started_at=started_at)
    print('[live_indices_ws] WebSocket connected. Writing history every '
          f'{args.interval}s...', flush=True)

    try:
        while True:
            # ── Graceful stop ─────────────────────────────────────────────────
            if os.path.exists(STOP_TRIGGER):
                try:
                    os.remove(STOP_TRIGGER)
                except OSError:
                    pass
                print('[live_indices_ws] Stop trigger detected - exiting.', flush=True)
                break

            # ── Collect snapshot ──────────────────────────────────────────────
            snapshot: dict[str, float] = {}
            for sid, sym in sid_to_symbol.items():
                tick = helper.live_data.get(sid)
                if tick:
                    ltp = float(tick.get('LTP') or tick.get('last_price') or 0)
                    if ltp > 0:
                        last_known[sym] = ltp
                # forward-fill if no new tick
                if sym in last_known:
                    snapshot[sym] = last_known[sym]

            if snapshot:
                # Capture session open on first valid tick per symbol
                for sym, ltp in snapshot.items():
                    if sym not in opens:
                        opens[sym] = ltp

                entry: dict = {'t': ist_time()}
                entry.update(snapshot)
                ticks.append(entry)

            # ── Build current LTPs map ────────────────────────────────────────
            ltps = {sym: last_known[sym] for sym in last_known}

            # ── Write history file ────────────────────────────────────────────
            available = list(sid_to_symbol.values())
            atomic_write(HISTORY_FILE, {
                'session_date': session_date,
                'updated_at':   datetime.now().isoformat(),
                'available':    available,
                'labels':       labels,
                'categories':   categories,
                'opens':        opens,
                'ltps':         ltps,
                'ticks':        ticks,
            })
            write_status('RUNNING', subscribed=n, started_at=started_at)

            time.sleep(args.interval)

    except KeyboardInterrupt:
        print('[live_indices_ws] KeyboardInterrupt - shutting down.', flush=True)
    finally:
        write_status('STOPPED', subscribed=0, started_at=started_at)
        print('[live_indices_ws] Stopped.', flush=True)


if __name__ == '__main__':
    main()
