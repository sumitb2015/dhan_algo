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
from lib import market_hub_client as hub_client

DEBUG_DIR        = os.path.join(ROOT, 'debug')
HISTORY_FILE     = os.path.join(DEBUG_DIR, 'live_indices_history.json')
STATUS_FILE      = os.path.join(DEBUG_DIR, 'live_indices_status.json')
STOP_TRIGGER     = os.path.join(DEBUG_DIR, 'live_indices_stop.trigger')
SELECTION_FILE   = os.path.join(DEBUG_DIR, 'live_indices_selection.json')
SETTINGS_FILE    = os.path.join(DEBUG_DIR, 'live_indices_settings.json')

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


def read_selection() -> set | None:
    """Return set of selected symbols from selection file, or None if not set."""
    try:
        if os.path.exists(SELECTION_FILE):
            with open(SELECTION_FILE) as f:
                data = json.loads(f.read())
            sel = data.get('selected')
            if isinstance(sel, list):
                return set(sel)
    except Exception:
        pass
    return None


def read_interval(default: float = 20.0) -> float:
    """Read the tick interval (seconds) from the settings file. Clamped 1–300."""
    try:
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE) as f:
                data = json.loads(f.read())
            interval = float(data.get('interval', default))
            return max(1.0, min(300.0, interval))
    except Exception:
        pass
    return default


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
    parser.add_argument('--interval', type=float, default=20.0,
                        help='Write interval in seconds (default: 20; overridden by settings file)')
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

    # Market data now comes from the shared market_data_hub.py process — see
    # lib/market_hub_client.py. All 26 indices subscribe unconditionally here,
    # matching current behavior exactly (the "selection" file below has always been
    # output-side filtering only, never a real subscribe/unsubscribe).
    hub_client.ensure_hub_running()
    hub_client.register_wanted('live_indices', instruments)

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not hub_client.read_live_data():
        time.sleep(0.5)  # wait for the hub's first tick batch

    # ── Restore session open baseline if same calendar day ───────────────────
    session_date = datetime.now().strftime('%Y-%m-%d')
    opens:      dict[str, float] = {}
    ticks:      list[dict]       = []
    last_known: dict[str, float] = {}  # forward-fill buffer

    try:
        if os.path.exists(HISTORY_FILE):
            with open(HISTORY_FILE) as f:
                existing = json.loads(f.read())
            if existing.get('session_date') == session_date:
                opens      = existing.get('opens', {})
                ticks      = existing.get('ticks', [])
                # Restore forward-fill buffer so slow-ticking symbols don't gap
                last_known = dict(existing.get('ltps', {}))
                print(f'[live_indices_ws] Restored {len(opens)} opens, '
                      f'{len(ticks)} ticks, {len(last_known)} last-known LTPs', flush=True)
            else:
                # New trading day — explicitly delete stale data to avoid leakage
                old_date = existing.get('session_date', 'unknown')
                print(f'[live_indices_ws] New session day ({old_date} -> {session_date}) '
                      f'- clearing history file.', flush=True)
                try:
                    os.remove(HISTORY_FILE)
                except OSError as rm_err:
                    print(f'[live_indices_ws] WARNING: could not delete old history: {rm_err}', flush=True)
    except Exception as e:
        print(f'[live_indices_ws] WARNING: could not restore history: {e}', flush=True)

    # Use the current selection to report the correct initial subscribed count
    initial_sel    = read_selection()
    all_syms       = set(sid_to_symbol.values())
    initial_active = (initial_sel & all_syms) if initial_sel is not None else all_syms
    write_status('RUNNING', subscribed=len(initial_active), started_at=started_at)
    print('[live_indices_ws] Registered with market data hub. Writing history every '
          f'{args.interval}s...', flush=True)

    # Stall detection lives in the hub now; this bridge only needs to notice if the
    # hub's shared tick file has gone stale and re-trigger ensure_hub_running() (a
    # no-op unless the hub process itself died — see live_equity_ws.py for the same
    # pattern, applied identically here).
    HUB_STALE_SEC = 8
    HUB_CHECK_INTERVAL_SEC = 5
    last_hub_check = time.monotonic()

    try:
        while True:
            # ── Graceful stop ─────────────────────────────────────────────────
            if os.path.exists(STOP_TRIGGER):
                try:
                    os.remove(STOP_TRIGGER)
                except OSError:
                    pass
                print('[live_indices_ws] Stop trigger detected - exiting.', flush=True)
                hub_client.unregister_wanted('live_indices')
                break

            now_monotonic = time.monotonic()
            if now_monotonic - last_hub_check >= HUB_CHECK_INTERVAL_SEC:
                last_hub_check = now_monotonic
                # Refresh the registry entry on this cadence (well under
                # WANTED_STALE_SEC=60s) — see live_equity_ws.py for why a
                # register-once-at-startup bridge silently ages out of the hub's
                # stale-registry backstop after a hub restart.
                hub_client.register_wanted('live_indices', instruments)
                hub_updated = hub_client.live_data_updated_at()
                if hub_updated is None or time.time() - hub_updated > HUB_STALE_SEC:
                    hub_client.ensure_hub_running()

            # ── Determine active symbols from selection file ──────────────────
            selection = read_selection()
            all_syms  = set(sid_to_symbol.values())
            active_symbols = (selection & all_syms) if selection is not None else all_syms

            # ── Collect snapshot for ALL subscribed (keeps last_known complete) ─
            live_ticks = hub_client.read_live_data()
            snapshot: dict[str, float] = {}
            for sid, sym in sid_to_symbol.items():
                tick = live_ticks.get(hub_client.tick_key(IDX, sid))
                if tick:
                    ltp = float(tick.get('LTP') or tick.get('last_price') or 0)
                    if ltp > 0:
                        last_known[sym] = ltp
                if sym in last_known:
                    snapshot[sym] = last_known[sym]

            if snapshot:
                # Preserve session opens for ALL symbols (so re-adding a symbol
                # keeps its original open for correct normalisation)
                for sym, ltp in snapshot.items():
                    if sym not in opens:
                        opens[sym] = ltp

                # Tick entry: only active symbols
                active_snapshot = {sym: ltp for sym, ltp in snapshot.items()
                                   if sym in active_symbols}
                if active_snapshot:
                    entry: dict = {'t': ist_time()}
                    entry.update(active_snapshot)
                    ticks.append(entry)

            # ── Build LTPs for active symbols only ────────────────────────────
            ltps = {sym: last_known[sym] for sym in active_symbols if sym in last_known}

            # ── Write history file ────────────────────────────────────────────
            catalogue = list(sid_to_symbol.values())  # all subscribed
            available = [sym for sym in catalogue if sym in active_symbols]
            atomic_write(HISTORY_FILE, {
                'session_date': session_date,
                'updated_at':   datetime.now().isoformat(),
                'catalogue':    catalogue,
                'available':    available,
                'labels':       labels,
                'categories':   categories,
                'opens':        opens,
                'ltps':         ltps,
                'ticks':        ticks,
            })
            write_status('RUNNING', subscribed=len(active_symbols), started_at=started_at)

            # Re-read interval each cycle so UI changes take effect without restart
            interval = read_interval(default=args.interval)
            time.sleep(interval)

    except KeyboardInterrupt:
        print('[live_indices_ws] KeyboardInterrupt - shutting down.', flush=True)
        hub_client.unregister_wanted('live_indices')
    finally:
        write_status('STOPPED', subscribed=0, started_at=started_at)
        print('[live_indices_ws] Stopped.', flush=True)


if __name__ == '__main__':
    main()
