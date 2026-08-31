"""
Market Data Hub — the single shared Dhan WebSocket connection for the dashboard's
read-only quote bridges.

live_equity_ws.py, live_indices_ws.py, live_options_ws.py (Dhan) and focus_tool_ws.py
each used to call helper.start_websocket() themselves, opening 4 independent Dhan
connections. Dhan caps concurrent WebSocket connections per account, and opening
several of these dashboard pages at once was hitting that cap. This process owns the
ONE connection; each bridge registers what it wants via lib/market_hub_client.py and
reads merged ticks back from this hub's shared live_data.json.

Not involved: live_positions_ws.py, focus_tool_rows_worker.py, copy_trade_bridge.py,
live_options_ws_zerodha.py, or any live strategy — all keep their own independent
connections (see the plan doc for why: order-placing paths shouldn't depend on IPC to
a separate process for their price feed).

Usage:
    venv\\Scripts\\python.exe scripts/tools/market_data_hub.py

Not meant to be started manually in normal operation — each of the 4 bridges calls
lib.market_hub_client.ensure_hub_running() at startup and periodically thereafter, so
the hub is spawned (and respawned if it dies) automatically. Stop gracefully by writing
debug/market_hub/hub_stop.trigger.
"""
import os
import sys
import time
import logging
import threading
from datetime import datetime
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib import market_hub_client as hub_client

IST = ZoneInfo('Asia/Kolkata')

REGISTRY_SCAN_SEC = 3          # how often to re-union wanted_*.json and diff-subscribe
WRITE_MIN_INTERVAL_SEC = 0.15  # ceiling on live_data.json write frequency (~6.6/s)
STALL_SEC = 20                 # centralized version of live_equity_ws.py's watchdog
FEED_READY_TIMEOUT_SEC = 10
STOP_TRIGGER = os.path.join(hub_client.HUB_DIR, 'hub_stop.trigger')

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger('market_data_hub')


def market_open(now_ist: datetime) -> bool:
    if now_ist.weekday() >= 5:
        return False
    t = now_ist.time()
    return (9, 15) <= (t.hour, t.minute) <= (15, 30)


def write_status(status: str, started_at: str, subscribed_count: int = 0, active_consumers=None):
    hub_client._atomic_write(hub_client.hub_status_file(), {
        'status': status,
        'pid': os.getpid(),
        'started_at': started_at,
        'last_update': datetime.now().isoformat(),
        'subscribed_count': subscribed_count,
        'active_consumers': sorted(active_consumers or []),
    })


def _dedup_wanted(entries):
    """Union instrument tuples across all live consumers, deduped by (segment,
    security_id). When two consumers want the same instrument at different feed
    types, keep the richer one (Full=21 > Quote=17 > Ticker=15) since Full is a
    superset — cheaper than subscribing the same instrument twice."""
    best = {}
    for entry in entries:
        for seg, sid, feed_type in entry.get('instruments', []):
            key = (str(seg), str(sid))
            if key not in best or feed_type > best[key][2]:
                best[key] = (seg, sid, feed_type)
    return best  # {(seg, sid): (seg, sid, feed_type)}


def main():
    os.makedirs(hub_client.HUB_DIR, exist_ok=True)
    started_at = datetime.now().isoformat()
    write_status('STARTING', started_at)
    log.info('Market data hub starting…')

    dhan = get_dhan_client()
    if not dhan:
        log.error('Authentication failed — aborting.')
        write_status('ERROR', started_at)
        sys.exit(1)

    helper = DhanHelper(dhan)

    # The hub maintains its OWN merged-tick dict, keyed by tick_key(segment, sid)
    # — deliberately NOT reading from helper.live_data, which DhanHelper keys by
    # raw security_id alone. That's safe for a single bridge subscribed to only
    # one kind of instrument space, but the hub subscribes across every segment at
    # once, and Dhan's security IDs are only unique WITHIN a segment (confirmed
    # live: ADANIENT/NSE_EQ and BANKNIFTY/IDX both use id 25 — see
    # lib.market_hub_client.tick_key's docstring for the full story). Replicating
    # DhanHelper._on_ws_message's merge-not-replace behavior here, just keyed
    # correctly.
    merged_ticks: dict = {}
    merged_lock = threading.Lock()
    dirty = threading.Event()

    def on_message(inst, msg):
        seg = msg.get('exchange_segment')
        sid = msg.get('security_id')
        if sid is not None:
            key = hub_client.tick_key(seg, sid)
            with merged_lock:
                if key in merged_ticks:
                    merged_ticks[key].update(msg)
                else:
                    merged_ticks[key] = dict(msg)
        dirty.set()

    helper.start_websocket([], on_message=on_message)

    # Wait for the feed object to actually exist before the first registry scan —
    # subscribe_instruments()/unsubscribe_instruments() no-op with a warning until
    # helper.feed is set by the background connection thread.
    deadline = time.monotonic() + FEED_READY_TIMEOUT_SEC
    while time.monotonic() < deadline and not getattr(helper, 'feed', None):
        time.sleep(0.2)
    if not getattr(helper, 'feed', None):
        log.warning('Feed not confirmed ready after %ss — proceeding anyway; the '
                     'first registry scan may need a retry.', FEED_READY_TIMEOUT_SEC)

    write_status('RUNNING', started_at)
    log.info('Hub running. Watching %s for consumer registrations…', hub_client.HUB_DIR)

    current = {}  # (seg, sid) -> (seg, sid, feed_type), the hub's own confirmed-subscribed set
    last_scan = 0.0
    last_write = 0.0
    last_tick_signature = None
    last_tick_change_ts = time.monotonic()

    try:
        while True:
            if os.path.exists(STOP_TRIGGER):
                try:
                    os.remove(STOP_TRIGGER)
                except OSError:
                    pass
                log.info('Stop trigger detected — exiting.')
                break

            now = time.monotonic()

            # ── Registry scan: union wanted_*.json, diff-subscribe the delta ──────
            if now - last_scan >= REGISTRY_SCAN_SEC:
                last_scan = now
                entries = hub_client.list_live_registry_entries()
                wanted = _dedup_wanted(entries)

                to_add = [v for k, v in wanted.items() if k not in current]
                to_remove_keys = [k for k in current if k not in wanted]
                to_remove = [current[k] for k in to_remove_keys]

                if to_add:
                    if helper.subscribe_instruments(to_add):
                        for seg, sid, feed_type in to_add:
                            current[(str(seg), str(sid))] = (seg, sid, feed_type)
                        log.info('Subscribed %d new instrument(s), %d total.',
                                  len(to_add), len(current))
                    # else: feed not ready yet — leave out of `current` so the next
                    # scan retries automatically.

                if to_remove:
                    if helper.unsubscribe_instruments(to_remove):
                        for key in to_remove_keys:
                            current.pop(key, None)
                        log.info('Unsubscribed %d instrument(s) no longer wanted, %d total.',
                                  len(to_remove), len(current))

                write_status('RUNNING', started_at, subscribed_count=len(current),
                             active_consumers=[e['consumer'] for e in entries])

                # ── Stall watchdog (centralized) ──────────────────────────────
                # Signature over every currently-subscribed instrument's LTP. With
                # ~hundreds of instruments unioned across 4 consumers instead of one
                # bridge's own small universe, a genuinely dead socket is somewhat
                # more likely to still show 1-2 laggard "moving" values from partial
                # buffered packets before the connection is fully recognized as gone
                # — a known trade-off of centralizing this, documented rather than
                # solved by hardcoding specific "canary" instrument IDs into what is
                # otherwise a generic, domain-agnostic multiplexer.
                if current:
                    subscribed_keys = {hub_client.tick_key(seg, sid) for seg, sid in current}
                    with merged_lock:
                        signature = tuple(sorted(
                            (key, round(float(tick.get('LTP') or tick.get('last_price') or 0), 2))
                            for key, tick in merged_ticks.items()
                            if key in subscribed_keys
                        ))
                    if signature != last_tick_signature:
                        last_tick_signature = signature
                        last_tick_change_ts = now
                    elif (market_open(datetime.now(IST))
                          and now - last_tick_change_ts > STALL_SEC):
                        log.warning('No tick movement for %ss during market hours — '
                                    'forcing reconnect.', STALL_SEC)
                        try:
                            if getattr(helper, 'feed', None):
                                helper.feed.close_connection()
                        except Exception as e:
                            log.warning('Forced close_connection failed: %s', e)
                        last_tick_change_ts = now

            # ── Tick write (debounced) ────────────────────────────────────────────
            if dirty.wait(timeout=0.25):
                dirty.clear()
                time.sleep(0.02)  # let a burst of same-tick packets settle
                if now - last_write >= WRITE_MIN_INTERVAL_SEC:
                    last_write = now
                    with merged_lock:
                        snapshot = dict(merged_ticks)
                    hub_client._atomic_write(hub_client.hub_live_data_file(), {
                        'updated_at': datetime.now().isoformat(),
                        'ticks': snapshot,
                    })
    except KeyboardInterrupt:
        log.info('Interrupted — exiting.')


if __name__ == '__main__':
    main()
