"""
Trade replication bridge: Dhan (parent) -> Zerodha and/or Kotak (child accounts).

Listens to Dhan's real-time order-update WebSocket (via
DhanHelper.start_order_update_websocket) and, for every TRADED or
PART_TRADED fill, mirrors the newly-traded delta to each enabled child
account in debug/copy_trade_config.json at quantity = delta * multiplier,
always as a MARKET order (sliced to that broker's freeze quantity).

Each child broker is a ChildBroker from scripts/tools/child_brokers.py, which
owns that broker's client, instrument cache, margin state and position
snapshot. Everything below is broker-agnostic: this module decides WHAT to
replicate and WHEN to give up, the broker decides HOW to talk to its API.

The WS is the primary, low-latency path but is NOT trusted alone: Dhan's
order-update WS has been observed (2026-07-22) to silently die — server
closes the socket with no exception raised, leaving the bridge "listening"
forever with nothing arriving. A REST poll of the order book every
ORDER_POLL_INTERVAL_SEC (poll_parent_orders()) runs alongside it as a
backup, replicating anything the WS misses via the same handle_update()
path. replicated_qty dedup makes the poll a no-op whenever the WS already
handled a fill, so it only ever acts as a fallback, never a duplicate.

Two independent safety gates:
  - This process running at all: safe by itself, only listens + logs
    what it WOULD replicate to debug/copy_trade_log.json.
  - config.json's "armed" flag: only when true does a child order
    actually get placed.

Safety mechanisms:
  - Singleton: a Windows named mutex guarantees at most one bridge process,
    acquired before the multi-second heavy imports (a second instance would
    replicate every fill twice).
  - Failed child orders go to a bounded retry queue (drained by the
    watchdog thread) instead of being silently dropped; failure counts are
    surfaced in copy_trade_status.json.
  - Heartbeat: status file rewritten every few seconds so the dashboard can
    tell a live bridge from a dead/hung one (the API route marks a stale
    heartbeat as STALE).
  - Watchdog: if the parent's NIFTY option book is flat on two consecutive
    checks while a child still holds cached-NIFTY-option positions,
    force-close those child positions — scoped per broker to that broker's
    own replication universe so unrelated positions are never touched, with
    per-symbol attempt caps + backoff and a market-hours gate.
  - Startup baseline: fills that happened while the bridge was down are
    NOT auto-replicated (placing catch-up market orders on a restart is
    riskier than surfacing the gap) — they are marked handled and logged
    loudly as 'baseline_skipped' for manual reconciliation.

NIFTY options only (matches the rest of the scalper/live-quotes scope).
One-directional: Dhan -> children. No reverse replication.

The startup OTM hedge (copy_trade_hedge.py) is Zerodha-only by design and is
skipped entirely when Zerodha is not among the configured children.

Usage:
    venv\\Scripts\\python.exe scripts/tools/copy_trade_bridge.py

Stop gracefully by writing debug/copy_trade_stop.trigger.
"""
import sys
import os
import json
import math
import time
import ctypes
import threading
import traceback
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
# load_zerodha_instruments_cache() reads a relative-path-free constant set, but
# credDemo/.env.zerodha loading elsewhere in this codebase assumes CWD == ROOT
# when spawned from the dashboard (see live_options_ws_zerodha.py's same fix).
os.chdir(ROOT)

# Safe to import eagerly despite the deferred-import discipline below: this
# module imports only stdlib at module scope (no pandas/DhanHelper/broker SDKs —
# those are all deferred inside the ChildBroker methods), so it does not widen
# the double-spawn window the singleton mutex exists to close.
from scripts.tools.child_brokers import (  # noqa: E402
    MARGIN_BLOCKED, create_broker, find_option_symbol,
)

# copy_trade_reconcile.py imports this name from here — keep it exported so the
# reconcile tool and the bridge can never diverge on how a symbol is resolved.
find_zerodha_symbol = find_option_symbol

DEBUG_DIR        = os.path.join(ROOT, 'debug')
CONFIG_FILE      = os.path.join(DEBUG_DIR, 'copy_trade_config.json')
STATUS_FILE      = os.path.join(DEBUG_DIR, 'copy_trade_status.json')
LOG_FILE         = os.path.join(DEBUG_DIR, 'copy_trade_log.json')
REPLICATED_FILE  = os.path.join(DEBUG_DIR, 'copy_trade_replicated.json')
RAW_EVENTS_FILE  = os.path.join(DEBUG_DIR, 'copy_trade_raw_events.json')
STOP_TRIGGER     = os.path.join(DEBUG_DIR, 'copy_trade_stop.trigger')

MAX_LOG_ENTRIES  = 200
WATCHDOG_INTERVAL_SEC = 7
HEARTBEAT_INTERVAL_SEC = 5

# Safety-exit tuning: require the parent flat on this many consecutive checks
# (a scalper can exit and re-enter within one watchdog interval), and never
# fire within REPLICATION_GRACE_SEC of the last replicated fill.
FLAT_CONFIRMATIONS = 2
REPLICATION_GRACE_SEC = 20
SAFETY_EXIT_MAX_ATTEMPTS = 3
SAFETY_EXIT_BACKOFF_SEC = 60

RETRY_MAX_ATTEMPTS = 3
RETRY_BACKOFF_SEC = 30

# A fast-path failure (place_child_order raised, e.g. transient
# RemoteDisconnected) gets ONE quick re-try via the retry queue rather than
# waiting the full RETRY_BACKOFF_SEC — on an exit, every second here is a
# naked Zerodha leg. Only the first queued attempt uses this; drain_retry_queue
# escalates back to RETRY_BACKOFF_SEC * attempts if that quick retry also fails,
# since a repeat failure is more likely a real problem than a network blip.
FAST_RETRY_DELAY_SEC = 2
# The retry queue is drained on this cadence — independent of, and much
# tighter than, WATCHDOG_INTERVAL_SEC (which still governs the slower
# flat-position safety-exit check further down in watchdog_loop).
RETRY_DRAIN_INTERVAL_SEC = 2

# KiteConnect drives every REST call through one keep-alive requests.Session
# with NO urllib3 retry policy. Fills arrive minutes apart, so by the time a
# replication runs, the pooled TCP socket has been idle long enough for
# Zerodha's load balancer to have closed it — requests then reuses the dead
# socket and place_order raises RemoteDisconnected. This was not theoretical:
# on 2026-07-27/28/29 EVERY first placement attempt failed this way (37 of 37
# 'error' entries in copy_trade_log.json), and only the 2-second fast retry
# landed the order. That is ~2s of naked leg on every single exit.
#
# Pinging a cheap endpoint on this cadence keeps that pooled socket warm so the
# first attempt succeeds. Prevention rather than an in-place retry: a blind
# retry of a POST whose response was lost risks duplicating a real order, so the
# existing retry queue (with find_recent_matching_order dedup) stays the
# backstop and this stops the situation arising in the first place.
KEEPALIVE_INTERVAL_SEC = 30

# NFO NIFTY options freeze quantity, used by the Zerodha-only startup hedge.
# Per-order slicing itself is the broker's own freeze_qty (Kotak publishes 1801
# in its master), so this constant is no longer the replication path's authority.
FREEZE_QTY = 1800
RAW_EVENTS_MAX = 20

# REST-polling backup for the order-update WS: Dhan's WS has been observed to
# silently die (server closes with no close frame, no exception raised until
# the next reconnect) — see debug notes from 2026-07-22. Polling this often
# keeps the backup's replication lag low without hammering the order-list
# endpoint (unlike the quote API, it isn't documented as ~1 req/s limited).
ORDER_POLL_INTERVAL_SEC = 3

_log_lock = threading.Lock()
_replicated_lock = threading.Lock()
_retry_lock = threading.Lock()
_fill_lock = threading.Lock()  # serializes handle_update() across the WS thread and the poll fallback

# Margin-gate state now lives per broker, on the ChildBroker instance
# (scripts/tools/child_brokers.py), along with the position snapshot and its
# lock. All the safety rules moved with it: reducing orders are never gated,
# unknown margin fails OPEN, and a stale position snapshot fails OPEN.

# How often the watchdog re-measures the representative per-lot margin. Much
# slower than the funds refresh because it costs a basket_order_margins call and
# the figure only moves with volatility, not with each fill.
PER_LOT_REFRESH_INTERVAL_SEC = 300

# Child position snapshot cadence. The age past which the fast path stops
# trusting the snapshot (and fails OPEN) is the broker's own
# child_brokers.POSITIONS_MAX_AGE_SEC.
POSITIONS_REFRESH_INTERVAL_SEC = 5

# If hedge_on_startup + armed are both set but the bridge starts before the
# exchange opens, a live BUY attempt right away would be rejected outright —
# Zerodha only accepts VARIETY_REGULAR orders on NFO from 9:15 to 15:30 IST.
# Placement is deferred to the watchdog thread instead, which retries once
# market_is_open() flips true. Backoff/attempt-cap mirrors the safety-exit
# pattern (SAFETY_EXIT_BACKOFF_SEC/SAFETY_EXIT_MAX_ATTEMPTS) so a hard failure
# once the market IS open (e.g. insufficient funds) doesn't hammer the API
# forever — it gives up loudly instead.
HEDGE_RETRY_BACKOFF_SEC = 60
HEDGE_RETRY_MAX_ATTEMPTS = 5


_singleton_handle = None  # kept referenced for the process lifetime; see below


def acquire_singleton() -> bool:
    """At most one bridge process, ever — two would replicate every fill twice.

    A Windows named mutex is auto-released on process death, so there is no
    stale-lock handling. The handle is deliberately never closed.

    Uses `use_last_error=True` + ctypes.get_last_error() rather than
    `windll.kernel32.GetLastError()`. The latter is unreliable: ctypes may issue
    its own Win32 calls between CreateMutexW and the GetLastError call, clobbering
    the thread's last-error value — so a first-and-only instance can read a stale
    183 and conclude another bridge is running. Observed on 2026-07-30: the bridge
    refused to start with no other process in existence, exiting 0 with only a
    console line to show for it. For a copy-trade bridge that is a silent
    outage — the parent trades all day with nothing mirroring it — so it fails
    OPEN on any ambiguity instead.
    """
    global _singleton_handle
    try:
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        handle = kernel32.CreateMutexW(None, False, 'dhan_algo_copy_trade_bridge')
        err = ctypes.get_last_error()
        if not handle:
            # Could not create the mutex at all — no basis to claim a duplicate.
            return True
        _singleton_handle = handle
        return err != 183  # ERROR_ALREADY_EXISTS
    except Exception:
        return True  # non-Windows / ctypes failure: fall back to the route's PID check


def market_is_open() -> bool:
    now = datetime.now()
    if now.weekday() >= 5:
        return False
    return (9, 15) <= (now.hour, now.minute) < (15, 30)


def atomic_write(path: str, data) -> bool:
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w') as f:
            json.dump(data, f)
        os.replace(tmp, path)
        return True
    except PermissionError as e:
        print(f"[copy_trade_bridge] Warning: {path} write blocked by a file lock ({e}) — will retry next write", flush=True)
        return False
    except Exception as e:
        print(f"[copy_trade_bridge] Warning: failed to write {path} ({e})", flush=True)
        return False


def write_status(status: str, started_at: str = '', detail: str = '', extra: dict = None):
    payload = {
        'status': status,
        'pid': os.getpid(),
        'detail': detail,
        'started_at': started_at or datetime.now().isoformat(),
        'last_update': datetime.now().isoformat(),
        # Epoch twin of last_update: the dashboard's stale-heartbeat check must
        # not depend on JS parsing a Python microsecond ISO timestamp.
        'last_update_ts': time.time(),
    }
    if extra:
        payload.update(extra)
    atomic_write(STATUS_FILE, payload)


def read_json(path: str, default):
    try:
        if not os.path.exists(path):
            return default
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def load_config() -> dict:
    # A torn read during a dashboard config write must not silently downgrade
    # a fill to logged_only — retry once before falling back to disarmed.
    for attempt in (0, 1):
        try:
            if not os.path.exists(CONFIG_FILE):
                break
            with open(CONFIG_FILE) as f:
                cfg = json.load(f)
            if isinstance(cfg, dict):
                cfg.setdefault('armed', False)
                cfg.setdefault('children', [])
                return cfg
            break
        except Exception:
            if attempt == 0:
                time.sleep(0.05)
    return {'armed': False, 'children': []}


def load_replicated() -> dict:
    """Replicated-qty map for TODAY only — Dhan order numbers are per-day, so
    carrying yesterday's entries forward just grows the file forever."""
    data = read_json(REPLICATED_FILE, {})
    if not isinstance(data, dict):
        return {}
    today = datetime.now().strftime('%Y-%m-%d')
    if 'orders' in data or 'date' in data:
        if data.get('date') != today:
            return {}
        orders = data.get('orders', {})
        return orders if isinstance(orders, dict) else {}
    # legacy flat {order_no: qty} format — trust it only if written today
    try:
        mtime_day = datetime.fromtimestamp(os.path.getmtime(REPLICATED_FILE)).strftime('%Y-%m-%d')
        if mtime_day == today:
            return data
    except OSError:
        pass
    return {}


def _load_symbols_by_broker() -> dict:
    """{broker: set(symbols)} for today, from disk. Empty on a new day."""
    data = read_json(REPLICATED_FILE, {})
    if not isinstance(data, dict) or data.get('date') != datetime.now().strftime('%Y-%m-%d'):
        return {}
    by_broker = data.get('symbols_by_broker')
    if isinstance(by_broker, dict):
        return {k: set(v) for k, v in by_broker.items() if isinstance(v, list)}
    # Pre-multi-broker file: the flat 'symbols' list was Zerodha's scope.
    syms = data.get('symbols', [])
    return {'zerodha': set(syms)} if isinstance(syms, list) and syms else {}


def load_replicated_symbols(broker: str = 'zerodha') -> set:
    """Per-day set of symbols the bridge has actually placed (or attempted)
    orders in for one broker — that broker's watchdog close scope. Persisted
    here rather than derived from the activity log, which is capped at
    MAX_LOG_ENTRIES and can scroll a morning's symbol out of scope on a busy day.

    Defaults to Zerodha so copy_trade_reconcile.py (Zerodha-only) keeps working
    against the same scope the bridge uses.
    """
    return _load_symbols_by_broker().get(broker, set())


def _write_replicated(orders: dict, by_broker: dict):
    """Persist both halves together. The flat 'symbols' key is still written
    with Zerodha's scope so an older reader (or a rolled-back build) sees the
    same thing it always did."""
    atomic_write(REPLICATED_FILE, {
        'date': datetime.now().strftime('%Y-%m-%d'),
        'orders': orders,
        'symbols': sorted(by_broker.get('zerodha', set())),
        'symbols_by_broker': {k: sorted(v) for k, v in by_broker.items()},
    })


def save_replicated(replicated: dict, symbols_by_broker=None):
    with _replicated_lock:
        if symbols_by_broker is None:
            symbols_by_broker = _load_symbols_by_broker()  # preserve what's on disk
        _write_replicated(replicated, symbols_by_broker)


def note_replicated_symbol(broker: str, sym: str, scopes: dict):
    """Add a symbol to that broker's watchdog close scope and persist
    immediately — BEFORE the child order is placed, so a crash mid-place still
    leaves the orphan covered after restart.

    `scopes` is the in-memory {broker: set} map, mutated in place.
    """
    if not sym:
        return
    scope = scopes.setdefault(broker, set())
    if sym in scope:
        return
    scope.add(sym)
    with _replicated_lock:
        data = read_json(REPLICATED_FILE, {})
        today = datetime.now().strftime('%Y-%m-%d')
        orders = {}
        if isinstance(data, dict) and data.get('date') == today and isinstance(data.get('orders'), dict):
            orders = data['orders']
        _write_replicated(orders, scopes)


def append_log(entry: dict):
    with _log_lock:
        log = read_json(LOG_FILE, {'entries': []})
        entries = log.get('entries', []) if isinstance(log, dict) else []
        entries.append(entry)
        if len(entries) > MAX_LOG_ENTRIES:
            entries = entries[-MAX_LOG_ENTRIES:]
        atomic_write(LOG_FILE, {'entries': entries})


def dump_raw_event(payload: dict):
    """Keep the first few raw fill payloads on disk so the TradedQty-cumulative
    and ExpiryDate-format assumptions can be verified against real data."""
    with _log_lock:
        raw = read_json(RAW_EVENTS_FILE, {'events': []})
        events = raw.get('events', []) if isinstance(raw, dict) else []
        if len(events) >= RAW_EVENTS_MAX:
            return
        events.append({'ts': datetime.now().isoformat(), 'payload': payload})
        atomic_write(RAW_EVENTS_FILE, {'events': events})


FILLED_STATUSES = ('TRADED', 'PARTTRADED')
_seen_other_statuses = set()


def normalize_status(raw) -> str:
    """Squash a Dhan order status to a punctuation/case-free form.

    The order-update WS and the REST order list use DIFFERENT vocabularies for
    the same state: the WS sends title case with no underscore ('Traded' — see
    debug/copy_trade_raw_events.json), while the REST order list sends
    'TRADED' / 'PART_TRADED'. A plain .upper() comparison against 'PART_TRADED'
    therefore matches the REST spelling but would NOT match the WS's likely
    'Part Traded'/'PartTraded' — silently dropping every partial fill on the
    primary (WS) path and leaving it to the 3-second REST poll to notice.

    Stripping non-alphanumerics collapses every spelling of both vocabularies
    onto one token, so 'Traded'/'TRADED' -> 'TRADED' and
    'Part Traded'/'PartTraded'/'PART_TRADED' -> 'PARTTRADED'.
    """
    return ''.join(ch for ch in str(raw or '') if ch.isalnum()).upper()


def note_unfilled_status(status: str, raw):
    """Print each novel non-fill status spelling once.

    Cheap insurance against a third vocabulary surprise: if Dhan ever reports a
    fill under a spelling normalize_status() doesn't collapse onto
    FILLED_STATUSES, it shows up here instead of being dropped in silence.
    Bounded so a busy day's PENDING/TRANSIT churn can't grow it without limit.
    """
    if status in _seen_other_statuses or len(_seen_other_statuses) >= 40:
        return
    _seen_other_statuses.add(status)
    print(f'[copy_trade_bridge] Note: ignoring order status {raw!r} '
          f'(normalized {status!r}) — not treated as a fill', flush=True)


def normalize_opt_type(raw):
    """CE/CALL/C -> 'CE', PE/PUT/P -> 'PE', anything else -> None.

    Fails CLOSED: an unrecognized value must skip the fill (loudly), never
    default to a leg — guessing wrong replicates the opposite option."""
    if not raw:
        return None
    o = str(raw).strip().upper()
    if o in ('CE', 'CALL', 'C'):
        return 'CE'
    if o in ('PE', 'PUT', 'P'):
        return 'PE'
    return None


def baseline_today_orders(helper, replicated_qty: dict) -> int:
    """Mark today's already-traded qty as handled, logging any gap loudly."""
    orders = helper.get_order_list()
    missed = 0
    for o in orders or []:
        status = normalize_status(o.get('orderStatus'))
        if status not in FILLED_STATUSES:
            continue
        order_no = str(o.get('orderId', '') or '')
        if not order_no:
            continue
        qty = 0
        for key in ('filledQty', 'filled_qty', 'tradedQuantity'):
            if o.get(key) is not None:
                try:
                    qty = int(float(o[key]))
                except (TypeError, ValueError):
                    qty = 0
                break
        if qty == 0 and status == 'TRADED':
            try:
                qty = int(float(o.get('quantity', 0) or 0))
            except (TypeError, ValueError):
                qty = 0
        gap = qty - int(replicated_qty.get(order_no, 0))
        if gap > 0:
            missed += 1
            append_log({
                'ts': datetime.now().isoformat(), 'order_no': order_no,
                'parent_symbol': o.get('tradingSymbol', ''), 'qty': gap,
                'result': 'baseline_skipped',
                'error': 'Filled while bridge was down — NOT replicated, reconcile manually',
            })
            replicated_qty[order_no] = qty
    if missed:
        save_replicated(replicated_qty)
        print(f'[copy_trade_bridge] WARNING: {missed} order(s) filled while bridge was down '
              f'were baselined (NOT replicated) — see copy_trade_log.json', flush=True)
    return missed


def maybe_place_deferred_hedge(kite, helper, cfg: dict, hedge_ctx: dict, hedge_qty: dict,
                               freeze_qty: int):
    """Retry a startup hedge that was deferred because the market wasn't open yet.

    Called every RETRY_DRAIN_INTERVAL_SEC from the watchdog thread, already gated
    by `if armed and market_is_open()` at the call site — never from the WS
    callback thread, and never before the exchange will actually accept the
    order.

    Reuses bootstrap()'s own build_plan + place_hedges, so a prior partial
    success (one leg placed before a crash, or before this function gave up on
    an earlier attempt) is topped up rather than re-bought from scratch — the
    same idempotent adoption logic a normal restart already relies on.

    Mutates `hedge_ctx` and `hedge_qty` IN PLACE, never reassigns them. Both are
    shared — without a lock — with main()'s WS-callback closures and its
    heartbeat writer, which read the SAME objects. Rebinding either name here
    would leave those readers holding a stale pre-market-open snapshot forever,
    since a name rebound on this thread is invisible to a closure that captured
    the object by reference on the other thread.
    """
    if not hedge_ctx.get('pending'):
        return
    now_ts = time.time()
    if now_ts < hedge_ctx.get('next_ts', 0.0):
        return

    try:
        from scripts.tools.copy_trade_hedge import bootstrap as hedge_bootstrap, hedge_qty_today
        rep = hedge_bootstrap(kite, helper, cfg, hedge_ctx['expiry'], armed=True, freeze_qty=freeze_qty)
        fresh_qty = hedge_qty_today()
    except Exception as e:
        rep = {'errors': [f'deferred hedge bootstrap crashed: {e}']}
        fresh_qty = None

    hedge_ctx['report'].clear()
    hedge_ctx['report'].update(rep)
    if fresh_qty is not None:
        # Whatever DID place — even one leg of two — is reflected immediately,
        # not only once every leg eventually succeeds, since a partial hedge
        # still reduces the shortfall the margin gate compares against.
        hedge_qty.clear()
        hedge_qty.update(fresh_qty)

    failed = [r for r in rep.get('placed', []) if r.get('result') == 'error']
    if not rep.get('errors') and not failed:
        hedge_ctx['pending'] = False
        print(f'[copy_trade_bridge] Deferred hedge placed now that the market is open: '
              f'{hedge_qty}', flush=True)
        return

    hedge_ctx['attempts'] = hedge_ctx.get('attempts', 0) + 1
    hedge_ctx['next_ts'] = now_ts + HEDGE_RETRY_BACKOFF_SEC * hedge_ctx['attempts']
    for e in rep.get('errors', []):
        print(f'[copy_trade_bridge] Deferred hedge attempt {hedge_ctx["attempts"]} failed: {e}', flush=True)
    for r in failed:
        print(f'[copy_trade_bridge] Deferred hedge leg {r.get("symbol")} failed: {r.get("error")}', flush=True)
    if hedge_ctx['attempts'] >= HEDGE_RETRY_MAX_ATTEMPTS:
        hedge_ctx['pending'] = False
        print(f'[copy_trade_bridge] WARNING: gave up placing the deferred startup hedge after '
              f'{HEDGE_RETRY_MAX_ATTEMPTS} attempts — child capacity may be below the parent, '
              f'so entries may be margin-blocked. Check debug/copy_trade_hedges.json and retry '
              f'manually: scripts/tools/copy_trade_hedge.py --live', flush=True)


def watchdog_loop(helper, brokers: dict, stop_event: threading.Event, state: dict,
                  retry_queue: list, replication_scopes: dict,
                  hedge_qty=None, cfg_product='MIS', hedge_ctx=None, ensure_broker=None):
    """
    The bridge's single background thread. Everything that needs to make a
    blocking broker call on a timer lives here, deliberately on ONE thread: the
    retry drain must never run concurrently with itself (two drains could place
    the same queued order twice), and the WS callback thread must never block.

    Five cadences, each gated by its own `last_*` timestamp, loosest last. Each
    runs for EVERY live child broker:

    1. RETRY_DRAIN_INTERVAL_SEC (2s)  — drain the failed-replication retry queue
       (bounded attempts + backoff), including the exact margin re-check; also
       retries a startup hedge that was deferred until market open
       (maybe_place_deferred_hedge), and lazily initialises a broker that was
       enabled in the config after the bridge started.
    2. POSITIONS_REFRESH_INTERVAL_SEC (5s) — refresh each child's position
       snapshot, which the fast-path margin gate uses to recognise exits.
    3. WATCHDOG_INTERVAL_SEC (7s) — the safety exit: if armed and the parent's
       NIFTY option book has been flat for FLAT_CONFIRMATIONS consecutive checks
       (and no replication landed within REPLICATION_GRACE_SEC), force-close each
       child's replicated NIFTY-option positions — and ONLY those, scoped per
       broker, with hedge quantities netted out; manual/unrelated positions are
       never touched.
    4. KEEPALIVE_INTERVAL_SEC (30s) — keep the broker's pooled socket warm, and
       capture the funds figure the margin gate compares against.
    5. PER_LOT_REFRESH_INTERVAL_SEC (300s) — re-measure the representative
       per-lot margin used by the fast-path gate.

    Deliberately conservative: if the Dhan positions call fails (as opposed
    to genuinely returning zero positions), helper.last_api_error will be
    set and this cycle is skipped rather than treated as "flat", to avoid
    force-closing legitimate child positions on a transient API hiccup.
    """
    # {broker: {symbol: {'n': attempts, 'next': earliest retry ts}}}
    safety_attempts = {}
    last_safety_check = 0.0
    last_keepalive = 0.0
    last_per_lot = 0.0
    last_positions = 0.0
    hedge_qty = hedge_qty if hedge_qty is not None else {}
    hedge_ctx = hedge_ctx if hedge_ctx is not None else {'pending': False, 'report': {}}
    while not stop_event.wait(RETRY_DRAIN_INTERVAL_SEC):
        try:
            # Keep each broker's pooled HTTPS socket warm so the next place_order
            # does not inherit a connection the broker already closed — see
            # KEEPALIVE_INTERVAL_SEC. Runs on this thread (never the WS callback
            # thread, which must not block) and independently of `armed`, so the
            # socket is already fresh for the day's first fill.
            #
            # The call doubles as the margin gate's funds refresh: it was already
            # hitting the funds endpoint every 30s and discarding the response, so
            # capturing it costs nothing and keeps the WS-path gate free of HTTP.
            if time.time() - last_keepalive >= KEEPALIVE_INTERVAL_SEC:
                last_keepalive = time.time()
                for broker in brokers.values():
                    broker.refresh_margin()

            # Refresh the child position snapshots the fast-path gate relies on to
            # recognise exits. Cheap, and far more frequent than the per-lot probe
            # because a stale snapshot degrades the gate to fail-open.
            if time.time() - last_positions >= POSITIONS_REFRESH_INTERVAL_SEC:
                last_positions = time.time()
                for broker in brokers.values():
                    broker.refresh_positions()

            # Re-measure the representative per-lot margin far less often — it
            # costs a margin API call and only drifts with volatility.
            if time.time() - last_per_lot >= PER_LOT_REFRESH_INTERVAL_SEC:
                last_per_lot = time.time()
                for broker in brokers.values():
                    broker.refresh_per_lot(cfg_product)

            cfg = load_config()
            armed = bool(cfg.get('armed'))
            children = [c for c in cfg.get('children', []) if c.get('enabled')]

            # A broker enabled in the dashboard AFTER the bridge started would
            # otherwise log broker_unavailable on every fill until a restart.
            # Initialising it here (blocking is fine on this thread) closes that
            # gap; ensure_broker caps its own retries.
            if ensure_broker:
                for child in children:
                    ensure_broker(child.get('broker'))

            if armed and market_is_open():
                drain_retry_queue(brokers, retry_queue, state, replication_scopes,
                                  margin_check=bool(cfg.get('margin_check', True)))
                zerodha = brokers.get('zerodha')
                if zerodha is not None:
                    maybe_place_deferred_hedge(zerodha.kite, helper, cfg, hedge_ctx,
                                               hedge_qty, FREEZE_QTY)

            now_ts = time.time()
            if now_ts - last_safety_check < WATCHDOG_INTERVAL_SEC:
                continue
            last_safety_check = now_ts

            if not armed or not children:
                state['flat_streak'] = 0
                continue

            df = helper.get_positions()
            if helper.last_api_error is not None:
                state['flat_streak'] = 0
                continue  # unknown state, not "flat" — skip this cycle

            dhan_open = 0
            if df is not None and not df.empty and 'netQty' in df.columns:
                mask = df['netQty'].astype(float) != 0
                # Scope to the replication universe (NIFTY NFO options) so an
                # unrelated open Dhan position (e.g. MCX futures) can't mask an
                # orphaned child, and vice versa. Missing columns fall back to
                # counting everything — which only makes the watchdog LESS
                # likely to fire, never more.
                if 'exchangeSegment' in df.columns:
                    mask &= df['exchangeSegment'].astype(str) == 'NSE_FNO'
                if 'tradingSymbol' in df.columns:
                    mask &= df['tradingSymbol'].astype(str).str.startswith('NIFTY')
                dhan_open = int(mask.sum())
            if dhan_open > 0:
                state['flat_streak'] = 0
                continue  # parent still has positions, nothing to do

            state['flat_streak'] += 1
            if state['flat_streak'] < FLAT_CONFIRMATIONS:
                continue
            if time.time() - state['last_replication_ts'] < REPLICATION_GRACE_SEC:
                continue  # a fill just replicated — parent may be re-entering
            if not market_is_open():
                continue  # market orders would just be rejected in a loop

            # Each enabled child is checked against ITS OWN replication scope and
            # instrument universe. A symbol is only ever closed on the broker
            # that actually traded it — the two brokers use different trading
            # symbols for the same contract, so a shared scope would both miss
            # orphans and reach for positions it never opened.
            ts = datetime.now().isoformat()
            now_ts = time.time()
            for child in children:
                bname = child.get('broker', 'zerodha')
                broker = brokers.get(bname)
                if broker is None:
                    continue  # not initialised — handle_update already logs this loudly
                attempts = safety_attempts.setdefault(bname, {})
                scope = replication_scopes.get(bname, set())
                universe = broker.symbols()

                try:
                    rows = broker.positions_rows()
                except Exception as e:
                    # Unknown, not flat. Closing on a failed read would be the
                    # same mistake the Dhan-side last_api_error guard prevents.
                    print(f'[copy_trade_bridge] Safety check skipped for {bname}: '
                          f'positions unavailable ({e})', flush=True)
                    continue

                # Scope closes to symbols the bridge itself traded today (the
                # persisted per-day set — durable across restarts and immune to
                # the activity log's 200-entry cap scrolling a symbol out).
                #
                # Hedges are long OTM options the bridge bought for margin
                # headroom. They have no parent counterpart by design, so "parent
                # is flat" is never evidence a hedge is orphaned, and
                # force-closing one would destroy the margin relief mid-session
                # just as the parent may be re-entering.
                #
                # They are NETTED OUT rather than skipped by symbol. The hedge
                # sits only ~600 points OTM, so the parent rolling into that exact
                # strike is realistic — and a symbol-level exclusion would then
                # hide a genuinely orphaned short behind the hedge, defeating the
                # watchdog on the one case it exists for. Subtracting the known
                # hedge quantity leaves the residual: zero for a pure hedge
                # (skip), still-short for a hedge sharing a strike with an orphan
                # (close the residual, keeping the hedge intact).
                #
                # hedge_qty is Zerodha-only, so it nets out only there; on any
                # other broker there are no hedges to confuse with orphans.
                hedges = hedge_qty if bname == 'zerodha' else {}
                open_positions = []
                for row in rows:
                    sym = row['symbol']
                    if sym not in universe or sym not in scope:
                        continue
                    residual = row['qty'] - int(hedges.get(sym, 0))
                    if residual == 0:
                        continue
                    open_positions.append({'row': row, 'symbol': sym, 'residual': residual})

                open_symbols = {e['symbol'] for e in open_positions}
                for sym in list(attempts):
                    if sym not in open_symbols:
                        del attempts[sym]  # closed (or fresh) — reset its attempt budget
                if not open_positions:
                    continue  # this child is already flat too

                closed = 0
                for item in open_positions:
                    row, symbol, residual = item['row'], item['symbol'], item['residual']
                    att = attempts.get(symbol, {'n': 0, 'next': 0.0})
                    if att['n'] >= SAFETY_EXIT_MAX_ATTEMPTS:
                        continue  # gave up on this symbol (already logged below)
                    if now_ts < att['next']:
                        continue

                    # Close the residual, not the raw net — so a hedge sharing this
                    # strike survives while the orphaned leg is flattened.
                    qty = abs(residual)
                    side = 'SELL' if residual > 0 else 'BUY'
                    entry = {
                        'ts': ts, 'order_no': f'watchdog-{bname}-{symbol}',
                        'parent_symbol': '(parent flat)',
                        'child_symbol': symbol, 'zerodha_symbol': symbol,
                        'side': side, 'child_qty': qty,
                        'broker': bname, 'armed': True, 'attempt': att['n'] + 1,
                    }
                    try:
                        order_id = broker.close_position(row, qty, side)
                        entry['result'] = 'safety_exit'
                        entry['child_order_id'] = order_id
                        closed += 1
                        print(f'[copy_trade_bridge] SAFETY EXIT ({bname}): parent flat, force-closed '
                              f'{symbol} ({side} {qty}) -> order {order_id}', flush=True)
                    except Exception as e:
                        entry['result'] = 'safety_exit_error'
                        entry['error'] = str(e)
                        print(f'[copy_trade_bridge] ERROR in {bname} safety exit for {symbol}: {e}', flush=True)
                    append_log(entry)

                    # Placement != fill: if the order is rejected async the position
                    # survives to the next cycle — back off instead of spamming.
                    attempts[symbol] = {'n': att['n'] + 1, 'next': now_ts + SAFETY_EXIT_BACKOFF_SEC}
                    if attempts[symbol]['n'] >= SAFETY_EXIT_MAX_ATTEMPTS:
                        append_log({'ts': ts, 'order_no': f'watchdog-{bname}-{symbol}',
                                    'child_symbol': symbol, 'zerodha_symbol': symbol, 'broker': bname,
                                    'result': 'safety_exit_gave_up',
                                    'error': f'{SAFETY_EXIT_MAX_ATTEMPTS} exit attempts failed to close — manual action needed'})
                        state['failed_count'] += 1

                if closed:
                    print(f'[copy_trade_bridge] Safety watchdog: parent flat, force-closed {closed} '
                          f'{bname} position(s).', flush=True)

        except Exception as e:
            print(f'[copy_trade_bridge] ERROR in watchdog_loop: {e}', flush=True)


def drain_retry_queue(brokers: dict, retry_queue: list, state: dict,
                      replication_scopes: dict = None, margin_check: bool = False):
    now = time.time()
    with _retry_lock:
        due = [r for r in retry_queue if now >= r['next_ts']]
    for item in due:
        bname = item.get('broker', 'zerodha')
        broker = brokers.get(bname)
        if broker is None:
            # The broker died (or was never initialised) after this item was
            # queued. Drop it loudly rather than spinning: nothing here can place
            # the order, and a silent queue entry would look like it was handled.
            with _retry_lock:
                if item in retry_queue:
                    retry_queue.remove(item)
            state['failed_count'] += 1
            append_log({'ts': datetime.now().isoformat(), 'order_no': item['order_no'],
                        'broker': bname, 'side': item['side'], 'qty': item['qty'],
                        'result': 'retry_exhausted',
                        'error': f'{bname} child is not available — NOT replicated, '
                                 f'parent/child DESYNCED, reconcile manually'})
            continue

        # Items enqueued with an unresolved symbol (strike not in the cache at
        # fill time — e.g. one the exchange added intraday) are resolved here,
        # where a blocking cache refresh is safe; never in the WS callback thread.
        if not item.get('child_symbol'):
            sym = broker.resolve_symbol(item.get('strike'), item.get('expiry'), item.get('opt_type'))
            if sym is None:
                item['attempts'] += 1
                item['next_ts'] = time.time() + RETRY_BACKOFF_SEC * item['attempts']
                if item['attempts'] >= RETRY_MAX_ATTEMPTS:
                    with _retry_lock:
                        if item in retry_queue:
                            retry_queue.remove(item)
                    state['failed_count'] += 1
                    append_log({'ts': datetime.now().isoformat(), 'order_no': item['order_no'],
                                'broker': bname, 'side': item['side'], 'qty': item['qty'],
                                'result': 'retry_exhausted',
                                'error': 'Instrument never resolved to a cached NIFTY option — NOT replicated'})
                continue
            item['child_symbol'] = sym
            # The product was mapped for whichever broker the fill was first
            # routed to; re-map it here now that the real target is known.
            item['product'] = broker.map_product(*item.get('product_hints', ()))

        if replication_scopes is not None:
            note_replicated_symbol(bname, item['child_symbol'], replication_scopes)

        entry = {
            'ts': datetime.now().isoformat(), 'order_no': item['order_no'],
            'child_symbol': item['child_symbol'],
            # Kept for the dashboard's existing log rendering and
            # copy_trade_reconcile.py, which both read `zerodha_symbol`.
            'zerodha_symbol': item['child_symbol'],
            'side': item['side'],
            'child_qty': item['qty'], 'broker': bname, 'armed': True,
            'attempt': item['attempts'] + 1,
        }

        blk = {}
        # A previous attempt for this item raised (response lost) — verify it
        # didn't actually land before placing what could be a duplicate.
        dup_order_id = None
        if item.get('queued_at') is not None:
            dup_order_id = broker.find_recent_matching_order(
                item['child_symbol'], item['side'], item['qty'], item['queued_at'])

        if dup_order_id is not None:
            placed, order_ids, err, verified_dup = item['qty'], [dup_order_id], None, True
        else:
            # This thread already makes blocking broker calls
            # (find_recent_matching_order above), so the exact priced check is
            # affordable here — on the brokers that can actually price a basket.
            placed, order_ids, err = broker.place_child_order(
                item['child_symbol'], item['side'], item['qty'],
                product=item.get('product') or broker.default_product,
                margin_check=margin_check, exact_margin=True,
                detail_out=blk,
            )
            verified_dup = False

        if err == MARGIN_BLOCKED:
            if not broker.supports_exact_margin:
                # This broker cannot price a real basket, so the "exact" recheck
                # was the same estimate the fast path used — and that estimate
                # over-states a far-OTM leg. Treating it as final would desync
                # the child over an arithmetic approximation, so keep retrying
                # within the normal attempt budget instead.
                item['attempts'] += 1
                item['next_ts'] = time.time() + RETRY_BACKOFF_SEC * item['attempts']
                entry['result'] = 'margin_blocked_estimate'
                entry['required'] = blk.get('required')
                entry['available'] = blk.get('available')
                entry['shortfall'] = blk.get('shortfall')
                entry['error'] = (f'{bname} margin estimate says short by {blk.get("shortfall")} '
                                  f'(needs {blk.get("required")}, has {blk.get("available")}); '
                                  f'{bname} has no basket-margin API so this is an estimate — retrying')
                if item['attempts'] >= RETRY_MAX_ATTEMPTS:
                    with _retry_lock:
                        if item in retry_queue:
                            retry_queue.remove(item)
                    state['failed_count'] += 1
                    entry['result'] = 'margin_blocked'
                    entry['error'] = (f'Insufficient {bname} margin after {item["attempts"]} attempts: '
                                      f'needs {blk.get("required")}, has {blk.get("available")} '
                                      f'(short {blk.get("shortfall")}) — NOT replicated, '
                                      f'parent/child DESYNCED, reconcile manually')
                append_log(entry)
                continue
            # Terminal: this was the EXACT basket price, not the cached estimate,
            # so there is nothing left to re-check. Drop rather than retry —
            # re-attempting an order the account cannot fund only burns the
            # attempt budget and floods the log (three such attempts per fill is
            # what the 07-27/28 'Insufficient funds' desyncs actually looked like).
            with _retry_lock:
                if item in retry_queue:
                    retry_queue.remove(item)
            state['failed_count'] += 1
            entry['result'] = 'margin_blocked'
            entry['required'] = blk.get('required')
            entry['available'] = blk.get('available')
            entry['shortfall'] = blk.get('shortfall')
            entry['error'] = (f'Insufficient {bname} margin: needs {blk.get("required")}, '
                              f'has {blk.get("available")} (short {blk.get("shortfall")}) — '
                              f'NOT replicated, parent/child DESYNCED, reconcile manually')
            append_log(entry)
            continue

        if placed:
            state['last_replication_ts'] = time.time()
        if err is None:
            entry['result'] = 'retry_verified_already_placed' if verified_dup else 'retry_success'
            entry['child_order_id'] = ','.join(str(o) for o in order_ids)
            if verified_dup:
                entry['error'] = 'Previous attempt raised but the order was already on the book — skipped duplicate retry'
            with _retry_lock:
                if item in retry_queue:
                    retry_queue.remove(item)
            print(f'[copy_trade_bridge] Retry {"verified already placed" if verified_dup else "succeeded"} for '
                  f'{item["order_no"]} -> {bname} ({item["side"]} {item["qty"]} {item["child_symbol"]})',
                  flush=True)
        else:
            item['qty'] -= placed  # never re-place slices that went through
            item['attempts'] += 1
            item['next_ts'] = time.time() + RETRY_BACKOFF_SEC * item['attempts']
            item['queued_at'] = datetime.now()  # this attempt also raised — recheck from here next time
            entry['result'] = 'retry_error'
            entry['error'] = err
            if item['attempts'] >= RETRY_MAX_ATTEMPTS or item['qty'] <= 0:
                with _retry_lock:
                    if item in retry_queue:
                        retry_queue.remove(item)
                entry['result'] = 'retry_exhausted'
                entry['error'] = f'Gave up after {item["attempts"]} attempts: {err} — parent/child DESYNCED, reconcile manually'
                state['failed_count'] += 1
                print(f'[copy_trade_bridge] RETRY EXHAUSTED for {item["order_no"]} ({bname}): {err}', flush=True)
        append_log(entry)


def main():
    started_at = datetime.now().isoformat()
    os.makedirs(DEBUG_DIR, exist_ok=True)

    if not acquire_singleton():
        # Exit WITHOUT touching the status file — the live bridge owns it.
        print('[copy_trade_bridge] Another bridge instance is already running — exiting.', flush=True)
        sys.exit(0)

    write_status('STARTING', started_at=started_at)
    print('[copy_trade_bridge] Starting…', flush=True)

    # Heavy imports are deferred so the singleton mutex + STARTING marker land
    # within milliseconds of process start; pandas/DhanHelper imports take
    # seconds, which was a wide-open double-spawn window.
    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper

    dhan = get_dhan_client()
    if not dhan:
        write_status('ERROR', started_at=started_at, detail='Dhan auth failed — run login.py')
        print('[copy_trade_bridge] ERROR: Dhan auth failed', flush=True)
        sys.exit(1)
    helper = DhanHelper(dhan)

    # ---- child brokers -------------------------------------------------
    #
    # Only ENABLED children are initialised. The scalper's ARM control writes a
    # row for every known broker (disabled ones included, so their multiplier
    # survives), so keying off "configured" would make the bridge attempt a
    # Kotak login for users who never enable it — and then report a permanent
    # "kotak child UNAVAILABLE" in the dashboard for a broker nobody asked for.
    #
    # Enabling one later does NOT need a restart: the watchdog's ensure_broker
    # picks it up within a couple of seconds.
    #
    # With nothing enabled there is nothing to replicate, but the bridge still
    # runs as a logger — fall back to whatever is configured so a disarmed dry
    # run still shows what each child would have received.
    startup_cfg = load_config()
    _children = startup_cfg.get('children', [])
    enabled = [str(c.get('broker', '')).lower() for c in _children
               if c.get('broker') and c.get('enabled')]
    configured = [str(c.get('broker', '')).lower() for c in _children if c.get('broker')]
    wanted = list(dict.fromkeys(enabled or configured)) or ['zerodha']

    brokers = {}
    broker_failures = {}

    def ensure_broker(name) -> bool:
        """Initialise a child broker on demand. Returns True if it is live.

        Called at startup and again from the watchdog thread whenever the config
        names a broker we do not have. A broker that has already failed is not
        retried — a second TOTP/token failure means operator action is needed,
        and retrying on a timer would just bury the reason.
        """
        name = str(name or '').lower()
        if not name:
            return False
        if name in brokers:
            return True
        if name in broker_failures:
            return False
        try:
            broker = create_broker(
                name, log=lambda m: print(f'[copy_trade_bridge] {m}', flush=True))
            ok, detail = broker.verify_session()
            if not ok:
                raise RuntimeError(detail)
            print(f'[copy_trade_bridge] {detail}', flush=True)
            broker.init_instruments()
            brokers[name] = broker
            print(f'[copy_trade_bridge] {name} child ready '
                  f'({len(broker.instruments)} contracts, freeze qty {broker.freeze_qty})', flush=True)
            return True
        except Exception as e:
            broker_failures[name] = str(e)
            print(f'[copy_trade_bridge] ERROR: {name} child unavailable: {e}', flush=True)
            return False

    for name in wanted:
        ensure_broker(name)

    if not brokers:
        detail = '; '.join(f'{k}: {v}' for k, v in broker_failures.items()) or 'no children configured'
        write_status('ERROR', started_at=started_at, detail=f'No child broker available — {detail}')
        print(f'[copy_trade_bridge] ERROR: no child broker available — {detail}', flush=True)
        sys.exit(1)

    replicated_qty = load_replicated()
    replication_scopes = _load_symbols_by_broker()
    baseline_today_orders(helper, replicated_qty)

    state = {
        'last_replication_ts': 0.0,
        'failed_count': 0,
        'flat_streak': 0,
        'last_poll_ts': 0.0,
        'poll_count': 0,
    }
    retry_queue = []

    # ---- margin gate + startup hedge bootstrap -------------------------
    # MIS by default — matches the parent's actual product on the NIFTY option
    # fills that get replicated (real captured payloads are 'INTRADAY', never
    # 'MARGIN'; see copy_trade_hedge.build_plan for the measurement). A hedge
    # only offsets a short of the SAME product (warn_product_mismatch below),
    # so this must track whatever product the parent is really trading in.
    hedge_product = str(startup_cfg.get('hedge_product', 'MIS')).upper()
    hedge_qty = {}      # {symbol: long qty} — the watchdog nets this out; the
                        # single source of truth for what counts as a hedge.
                        # Mutated in place everywhere, never reassigned once
                        # the watchdog thread starts (see maybe_place_deferred_hedge).
    hedge_ctx = {'pending': False, 'expiry': None, 'attempts': 0, 'next_ts': 0.0, 'report': {}}

    # Nearest future expiry drives the hedge, which is Zerodha-only — so it is
    # read from Zerodha when present, else from whichever child we do have.
    _today = datetime.now().strftime('%Y-%m-%d')
    _expiry_source = brokers.get('zerodha') or next(iter(brokers.values()))
    _expiries = _expiry_source.expiries(on_or_after=_today)
    near_expiry = _expiries[0] if _expiries else None

    # Seed each child's gate before any fill can arrive — otherwise the first
    # fills of the day sail through on the fail-open path while waiting for the
    # first keep-alive tick.
    atm_now = None
    try:
        atm_now = round(float(helper.get_ltp('NIFTY', instrument='INDEX')) / 50) * 50
    except Exception as e:
        print(f'[copy_trade_bridge] Could not read NIFTY spot for the margin probe: {e}', flush=True)

    for _bname, _broker in brokers.items():
        if atm_now is not None:
            # Each broker picks the probe from ITS OWN nearest expiry. Borrowing
            # another broker's would silently fail to resolve whenever the two
            # caches disagree (one refreshed across an expiry roll, the other
            # not), leaving that broker's gate permanently fail-open.
            _b_expiries = _broker.expiries(on_or_after=_today)
            if _b_expiries:
                _broker.set_margin_probe(_broker.find_symbol(atm_now, _b_expiries[0], 'CE'))
        if _broker.refresh_margin():
            _net = _broker.margin['available'] or 0.0
            _cash = _broker.margin['cash']
            print(f"[copy_trade_bridge] {_bname} margin: net Rs {_net:,.2f}, "
                  f"cash Rs {(_cash or 0.0):,.2f}", flush=True)
            # A collateral-only account can WRITE options (margin is backed by
            # pledged holdings) but has no money for a premium debit — and
            # buying back a short to EXIT it is a premium debit. Surfacing this
            # at startup beats discovering it on a rejected exit.
            if _net > 0 and (_cash or 0.0) < 0.01:
                print(f'[copy_trade_bridge] WARNING: {_bname} has Rs {_net:,.2f} of margin but '
                      f'ZERO cash — the balance is collateral (pledged holdings), not money. '
                      f'Option WRITES should go through, but any premium debit (a BUY, '
                      f'including buying back a short to close it) may be rejected. '
                      f'Add funds before arming replication to this child.', flush=True)
        else:
            print(f"[copy_trade_bridge] WARNING: {_bname} margins unavailable at startup "
                  f"({_broker.margin['error']}) — margin gate will fail OPEN until a refresh "
                  f"succeeds", flush=True)
        # Seed the position snapshot too — without it the fast-path gate fails
        # open (correctly, but uselessly) until the watchdog's first refresh.
        if not _broker.refresh_positions():
            print(f'[copy_trade_bridge] WARNING: could not read {_bname} positions at startup — '
                  f'margin gate will fail OPEN until the first refresh', flush=True)
        if _broker.margin_probe_symbol:
            if _broker.refresh_per_lot(hedge_product):
                print(f"[copy_trade_bridge] {_bname} margin per lot "
                      f"({_broker.margin_probe_symbol}, {hedge_product}): "
                      f"Rs {_broker.margin['per_lot']:,.2f}", flush=True)
            else:
                print(f"[copy_trade_bridge] WARNING: {_bname} per-lot margin probe failed "
                      f"({_broker.margin['error']})", flush=True)
        else:
            # Silent failure here would leave the gate permanently fail-open while
            # the status file still reported margin_check_enabled: true.
            print(f'[copy_trade_bridge] WARNING: no {_bname} margin probe contract resolved '
                  f'(expiry={near_expiry}) — its fast-path margin gate is DISABLED '
                  f'(fails open); the exact check on retries still applies', flush=True)

    # The startup OTM hedge is Zerodha-only by design (see the module docstring).
    kite = brokers['zerodha'].kite if 'zerodha' in brokers else None

    if kite is not None and startup_cfg.get('hedge_on_startup') and near_expiry:
        startup_armed = bool(startup_cfg.get('armed'))
        market_open_now = market_is_open()
        # Only a LIVE placement needs the exchange open — a disarmed dry run
        # never sends an order, so it is safe (and useful, per the design goal
        # of proving the gate before arming) to run it any time of day.
        can_place_now = startup_armed and market_open_now

        if startup_armed and not market_open_now:
            # A VARIETY_REGULAR BUY placed now would be rejected outright —
            # Zerodha only accepts NFO regular orders 9:15-15:30 IST. Defer to
            # the watchdog thread's maybe_place_deferred_hedge, which retries
            # once market_is_open() flips true.
            hedge_ctx['pending'] = True
            hedge_ctx['expiry'] = near_expiry
            print(f'[copy_trade_bridge] Hedge: market not open yet — deferring hedge '
                  f'placement until 9:15 (bridge started early, armed and '
                  f'hedge_on_startup are both set)', flush=True)
        else:
            try:
                from scripts.tools.copy_trade_hedge import bootstrap as hedge_bootstrap
                rep = hedge_bootstrap(
                    kite, helper, startup_cfg, near_expiry,
                    armed=can_place_now, freeze_qty=FREEZE_QTY,
                )
                hedge_ctx['report'].update(rep)
                # hedge_qty is the single source of truth. It reflects what is
                # really on the book — including intent recorded just before a
                # crash — rather than only what this run planned.
                #
                # Planned-but-unpersisted legs are folded in at qty 0 so a DRY
                # RUN still reports them, without claiming a quantity to net out.
                from scripts.tools.copy_trade_hedge import hedge_qty_today
                hedge_qty.update(hedge_qty_today())
                for leg in rep.get('plan', []):
                    hedge_qty.setdefault(leg['symbol'], 0)
                for ad in rep.get('adopted', []):
                    hedge_qty.setdefault(ad['symbol'], int(ad.get('held_qty') or 0))
                for e in rep.get('errors', []):
                    print(f'[copy_trade_bridge] Hedge: {e}', flush=True)
                # A half-placed hedge is worse than none planned: capacity no
                # longer matches the parent, so the margin gate starts refusing
                # entries. Retry it the same way a pre-market defer would.
                failed = [r for r in rep.get('placed', []) if r.get('result') == 'error']
                if failed:
                    print(f'[copy_trade_bridge] WARNING: {len(failed)} hedge leg(s) FAILED to buy '
                          f'({", ".join(r["symbol"] for r in failed)}) — the hedge is incomplete, so '
                          f'child capacity is below the parent and entries may be margin-blocked. '
                          f'Retrying on the watchdog thread.', flush=True)
                    hedge_ctx['pending'] = True
                    hedge_ctx['expiry'] = near_expiry
                    hedge_ctx['attempts'] = 1
                    hedge_ctx['next_ts'] = time.time() + HEDGE_RETRY_BACKOFF_SEC
                if rep.get('note'):
                    print(f"[copy_trade_bridge] Hedge: {rep['note']}", flush=True)
                if hedge_qty:
                    print(f'[copy_trade_bridge] Hedge positions (netted out of watchdog scope): '
                          f'{hedge_qty}', flush=True)
                # Hedges change the margin picture — re-read it before trading, and
                # re-read positions so the fast-path gate does not mistake the new
                # hedge longs for something else. Zerodha only: the hedge legs are
                # bought there and nowhere else.
                brokers['zerodha'].refresh_margin()
                brokers['zerodha'].refresh_positions()
            except Exception as e:
                print(f'[copy_trade_bridge] Hedge bootstrap failed: {e}', flush=True)
    else:
        # Adopt any hedges left over from an earlier run today even when
        # hedge_on_startup is off, so the watchdog still nets them out.
        try:
            from scripts.tools.copy_trade_hedge import hedge_qty_today
            hedge_qty.update(hedge_qty_today())
            if hedge_qty:
                print(f'[copy_trade_bridge] Adopted existing hedge positions '
                      f'(netted out of watchdog scope): {hedge_qty}', flush=True)
        except Exception as e:
            print(f'[copy_trade_bridge] Could not read hedge state: {e}', flush=True)

    # A hedge only offsets a short of the SAME product — verified 2026-07-30:
    # SELL MIS + BUY NRML yields zero benefit. Warn once per distinct mismatch
    # rather than per fill.
    _warned_products = set()

    def warn_product_mismatch(product):
        if not hedge_qty:
            return
        p = str(product).upper()
        if p == hedge_product or p in _warned_products:
            return
        _warned_products.add(p)
        print(f'[copy_trade_bridge] WARNING: replicating a {p} order while hedges are '
              f'{hedge_product}. Zerodha gives NO margin offset across products, so the '
              f'hedges are not helping this order and the margin gate may block it. '
              f'Set hedge_product={p} in copy_trade_config.json.', flush=True)

    def handle_update(payload: dict):
        # Serialize against poll_parent_orders() below — both read-check-act on
        # replicated_qty for the same order_no, and without this lock a fill
        # landing right as a poll cycle runs could get replicated twice.
        _fill_lock.acquire()
        try:
            data = payload.get('Data', {})

            # Robust case-insensitive key lookups
            status_raw = data.get('Status') or data.get('status')
            status = normalize_status(status_raw)
            if status not in FILLED_STATUSES:
                note_unfilled_status(status, status_raw)
                return

            dump_raw_event(payload)

            order_no = str(data.get('OrderNo') or data.get('orderNo') or '')
            if not order_no:
                return

            traded_qty = int(float(data.get('TradedQty') or data.get('tradedQty') or 0))
            already = int(replicated_qty.get(order_no, 0))
            delta = traded_qty - already
            if delta <= 0:
                return

            symbol = data.get('Symbol') or data.get('symbol') or order_no
            txn_type = str(data.get('TxnType') or data.get('txnType') or '').upper()
            side = 'BUY' if txn_type in ('B', 'BUY') else 'SELL' if txn_type in ('S', 'SELL') else None
            strike = data.get('StrikePrice') or data.get('strikePrice')
            expiry = data.get('ExpiryDate') or data.get('expiryDate')

            opt_type_raw = data.get('OptType') or data.get('optType')
            opt_type = normalize_opt_type(opt_type_raw)

            # Order matters: the unambiguous long-form names first, the
            # single-letter WS 'product' code last. See ChildBroker.map_product.
            # Kept as raw hints because each broker maps them to its own product
            # constants.
            product_hints = (
                data.get('ProductType') or data.get('productType'),
                data.get('ProductName') or data.get('productName'),
                data.get('Product') or data.get('product'),
            )

            ts = datetime.now().isoformat()

            if side is None:
                append_log({'ts': ts, 'order_no': order_no, 'symbol': symbol,
                            'result': 'error', 'error': f'Unrecognized TxnType: {txn_type!r}'})
                replicated_qty[order_no] = traded_qty
                save_replicated(replicated_qty)
                return

            cfg = load_config()
            armed = bool(cfg.get('armed'))
            children = [c for c in cfg.get('children', []) if c.get('enabled')]

            is_option = strike is not None and expiry and opt_type

            if not is_option:
                # Distinguish "never in scope" from "should have matched but
                # didn't". Dhan stamps optType 'XX' on every non-derivative
                # order, so equity/ETF/MCX fills (GOLDBEES, BEL, CRUDEOIL…)
                # used to be logged as "Unrecognized OptType 'XX' — refusing
                # to guess the leg", which reads like a replication failure
                # on a NIFTY option. They are simply out of scope, and
                # mislabelling them also spends the capped log budget that
                # genuine desync records need.
                # The WS reports scope via `instrument` ('OPTIDX'/'EQUITY'/…);
                # the REST order list has no such field, so the poll path
                # supplies `exchangeSegment` ('NSE_FNO'/'NSE_EQ'/'MCX_COMM')
                # instead. Either is enough to prove a fill was never in
                # scope; both absent falls through to the checks below.
                instrument = str(data.get('Instrument') or data.get('instrument') or '').upper()
                segment = str(data.get('ExchangeSegment') or data.get('exchangeSegment') or '').upper()
                scope_label = instrument or segment
                if (instrument and not instrument.startswith('OPT')) or (segment and segment != 'NSE_FNO'):
                    reason = f'Out of scope: {scope_label} (bridge replicates NIFTY options only) — skipped'
                elif opt_type_raw and opt_type is None:
                    reason = f'Unrecognized OptType {opt_type_raw!r} — refusing to guess the leg, skipped'
                else:
                    reason = 'Unsupported instrument (not a NIFTY option) — skipped'
                append_log({'ts': ts, 'order_no': order_no, 'symbol': symbol, 'side': side,
                            'qty': delta, 'result': 'skipped', 'error': reason})
                replicated_qty[order_no] = traded_qty
                save_replicated(replicated_qty)
                return

            for child in children:
                bname = str(child.get('broker', 'zerodha')).lower()
                try:
                    multiplier = int(child.get('multiplier', 1))
                except (TypeError, ValueError):
                    multiplier = 1
                if multiplier < 1:
                    multiplier = 1
                child_qty = delta * multiplier

                entry = {
                    'ts': ts, 'order_no': order_no, 'parent_symbol': symbol,
                    'side': side, 'parent_qty': delta, 'broker': bname,
                    'multiplier': multiplier, 'child_qty': child_qty, 'armed': armed,
                }

                broker = brokers.get(bname)
                if broker is None:
                    # Never silently dropped: a child enabled in the dashboard but
                    # not initialised here (auth failed, or enabled seconds ago and
                    # the watchdog has not picked it up yet) would otherwise look
                    # replicated. The watchdog's ensure_broker retries it once.
                    entry['result'] = 'broker_unavailable'
                    entry['error'] = (f'{bname} child is not initialised '
                                      f'({broker_failures.get(bname, "not yet started")}) — '
                                      f'fill NOT replicated to it')
                    append_log(entry)
                    print(f'[copy_trade_bridge] {bname} child unavailable — {order_no} '
                          f'NOT replicated to it', flush=True)
                    continue

                # Fast in-memory lookup only — a cache refresh is a multi-second
                # call that must never run in this WS callback (it would stall
                # event delivery and can drop the connection). A miss on a real
                # option goes to the retry queue, where the watchdog thread
                # refreshes the cache and resolves it.
                child_symbol = broker.find_symbol(strike, expiry, opt_type)
                product = broker.map_product(*product_hints)

                if child_symbol is None:
                    if armed:
                        with _retry_lock:
                            retry_queue.append({
                                'order_no': order_no, 'broker': bname, 'child_symbol': None,
                                'strike': strike, 'expiry': expiry, 'opt_type': opt_type,
                                'side': side, 'qty': child_qty, 'attempts': 0,
                                'next_ts': 0.0, 'product': product,
                                'product_hints': product_hints,
                            })
                        entry['result'] = 'queued_resolution'
                        entry['error'] = ('Strike not in instrument cache — queued for '
                                          'refresh + replication')
                    else:
                        entry['result'] = 'skipped'
                        entry['error'] = f'Strike not in the {bname} instrument cache — skipped'
                    append_log(entry)
                    continue

                entry['child_symbol'] = child_symbol
                # Kept for the dashboard's existing log rendering and
                # copy_trade_reconcile.py, which both read `zerodha_symbol`.
                entry['zerodha_symbol'] = child_symbol

                if not armed:
                    # Record what the margin gate WOULD have decided, so a
                    # disarmed session still proves the gate works before real
                    # money depends on it.
                    if cfg.get('margin_check', True):
                        ok, mdetail = broker.check_margin(child_symbol, side, child_qty,
                                                          product, exact=False)
                        entry['margin'] = mdetail
                        entry['would_block'] = not ok
                    entry['result'] = 'logged_only'
                    append_log(entry)
                    continue

                if bname == 'zerodha':
                    warn_product_mismatch(product)
                note_replicated_symbol(bname, child_symbol, replication_scopes)
                # Cached (non-blocking) check only: this runs on the order-update
                # WS callback thread, where an HTTP round-trip would stall event
                # delivery and can drop the connection.
                blk = {}
                placed, order_ids, err = broker.place_child_order(
                    child_symbol, side, child_qty, product=product,
                    margin_check=bool(cfg.get('margin_check', True)), exact_margin=False,
                    detail_out=blk,
                )

                if err == MARGIN_BLOCKED:
                    # The fast path prices this against a cached ATM per-lot
                    # figure, which over-states a far-OTM leg — so a block here is
                    # a suspicion, not a verdict. Hand it to the retry queue,
                    # where the watchdog thread can afford the exact call and
                    # either places it or blocks it terminally. Dropping it on
                    # an estimate would desync the child over an arithmetic
                    # approximation.
                    with _retry_lock:
                        retry_queue.append({
                            'order_no': order_no, 'broker': bname,
                            'child_symbol': child_symbol,
                            'side': side, 'qty': child_qty, 'attempts': 0,
                            'next_ts': time.time() + FAST_RETRY_DELAY_SEC,
                            'product': product, 'product_hints': product_hints,
                            # No 'queued_at': nothing was sent to the broker, so
                            # there is no lost-response duplicate to guard against.
                        })
                    entry['result'] = 'margin_recheck_queued'
                    entry['required'] = blk.get('required')
                    entry['available'] = blk.get('available')
                    entry['shortfall'] = blk.get('shortfall')
                    entry['error'] = (f'Cached margin estimate says short by {blk.get("shortfall")} '
                                      f'(needs {blk.get("required")}, has {blk.get("available")}) — '
                                      f'queued for a re-check before giving up')
                    append_log(entry)
                    continue
                if placed:
                    state['last_replication_ts'] = time.time()
                if err is None:
                    entry['result'] = 'success'
                    entry['child_order_id'] = ','.join(str(o) for o in order_ids)
                    print(f'[copy_trade_bridge] Replicated {order_no} -> {bname} '
                          f'({side} {child_qty} {child_symbol})', flush=True)
                else:
                    # Queue exactly the unplaced remainder for bounded retry —
                    # replicated_qty still advances below so a later event for
                    # this order can't double-place; the queue owns the gap.
                    remaining = child_qty - placed
                    entry['result'] = 'error'
                    entry['error'] = err
                    entry['queued_for_retry'] = remaining
                    state['failed_count'] += 1
                    with _retry_lock:
                        retry_queue.append({
                            'order_no': order_no, 'broker': bname,
                            'child_symbol': child_symbol,
                            'side': side, 'qty': remaining, 'attempts': 1,
                            'next_ts': time.time() + FAST_RETRY_DELAY_SEC,
                            # This placement attempt just raised — before the
                            # NEXT attempt (in drain_retry_queue), verify it
                            # didn't actually go through (response lost, e.g.
                            # RemoteDisconnected or a read timeout on Kotak)
                            # before placing a duplicate.
                            'queued_at': datetime.now(),
                            'product': product, 'product_hints': product_hints,
                        })
                    print(f'[copy_trade_bridge] ERROR replicating {order_no} to {bname}: {err} '
                          f'(queued {remaining} for retry)', flush=True)

                append_log(entry)

            replicated_qty[order_no] = traded_qty
            save_replicated(replicated_qty)

        except Exception as e:
            print(f'[copy_trade_bridge] ERROR in handle_update: {e}', flush=True)
        finally:
            _fill_lock.release()

    def poll_parent_orders():
        """REST-polling backup for the order-update WS. The WS is the primary,
        low-latency path; this exists because it has been observed to silently
        die (server closes the connection with no exception raised) and leave
        the bridge listening forever with nothing arriving. Reuses
        handle_update()'s exact replication/resolve/retry path via a synthetic
        payload shaped like a WS order_alert, so replicated_qty dedup makes
        this a no-op for anything the WS already handled — it only acts on
        fills the WS missed."""
        try:
            orders = helper.get_order_list()
        except Exception as e:
            print(f'[copy_trade_bridge] Order-list poll failed: {e}', flush=True)
            return

        state['last_poll_ts'] = time.time()
        state['poll_count'] += 1

        for o in orders or []:
            status = normalize_status(o.get('orderStatus'))
            if status not in FILLED_STATUSES:
                continue
            order_no = str(o.get('orderId', '') or '')
            if not order_no:
                continue

            traded_qty = 0
            for key in ('filledQty', 'filled_qty', 'tradedQuantity'):
                if o.get(key) is not None:
                    try:
                        traded_qty = int(float(o[key]))
                    except (TypeError, ValueError):
                        traded_qty = 0
                    break
            if traded_qty == 0 and status == 'TRADED':
                try:
                    traded_qty = int(float(o.get('quantity', 0) or 0))
                except (TypeError, ValueError):
                    traded_qty = 0

            # Cheap pre-check before building a payload — handle_update() does
            # the authoritative (lock-protected) delta check again itself.
            if traded_qty <= int(replicated_qty.get(order_no, 0)):
                continue

            handle_update({
                'Type': 'order_alert',
                'Data': {
                    'Status': status,
                    'OrderNo': order_no,
                    'TradedQty': traded_qty,
                    'Symbol': o.get('tradingSymbol'),
                    'TxnType': o.get('transactionType'),
                    'StrikePrice': o.get('drvStrikePrice'),
                    'ExpiryDate': o.get('drvExpiryDate'),
                    'OptType': o.get('drvOptionType'),
                    'ProductType': o.get('productType'),
                    # No `instrument` field on REST orders — pass the segment so
                    # handle_update can still tell an out-of-scope fill (equity,
                    # MCX) apart from a NIFTY option it failed to resolve.
                    'ExchangeSegment': o.get('exchangeSegment'),
                },
            })

    helper.start_order_update_websocket(on_update=handle_update)

    watchdog_stop = threading.Event()
    watchdog_thread = threading.Thread(
        target=watchdog_loop,
        args=(helper, brokers, watchdog_stop, state, retry_queue, replication_scopes,
              hedge_qty, hedge_product, hedge_ctx, ensure_broker),
        daemon=True, name='copy-trade-watchdog',
    )
    watchdog_thread.start()

    write_status('RUNNING', started_at=started_at)
    print('[copy_trade_bridge] Listening for Dhan order updates…', flush=True)

    last_heartbeat = 0.0
    last_order_poll = 0.0
    try:
        while True:
            if os.path.exists(STOP_TRIGGER):
                try:
                    os.remove(STOP_TRIGGER)
                except OSError:
                    pass
                print('[copy_trade_bridge] Stop trigger detected — exiting.', flush=True)
                break
            now = time.time()
            if market_is_open() and now - last_order_poll >= ORDER_POLL_INTERVAL_SEC:
                last_order_poll = now
                poll_parent_orders()
            if now - last_heartbeat >= HEARTBEAT_INTERVAL_SEC:
                last_heartbeat = now
                with _retry_lock:
                    pending_retries = len(retry_queue)
                # Real connection death is already handled independently of order
                # traffic: websockets' own ping/pong keepalive (20s interval/timeout)
                # raises inside connect_order_update() on a truly dead socket, which
                # run_ou()'s retry loop catches and reconnects. A separate "no order
                # event in N seconds" staleness check was tried here previously but
                # produced constant false positives (and needless reconnect churn)
                # on any day the parent account was simply quiet — order silence is
                # normal, not a sign of a dead WS.
                # ws_thread_alive alone is a weak signal: run_ou() retries
                # forever, so the thread stays alive through hours of failed
                # reconnects. ws_connected reflects the actual socket, so a feed
                # that is down now looks different from a merely quiet one.
                ws_health = helper.get_order_update_ws_health()
                ws_alive = ws_health['thread_alive']

                notes = []
                if state['failed_count'] or pending_retries:
                    notes.append(f"{state['failed_count']} failed replication(s), "
                                 f"{pending_retries} pending retry(ies)")
                if not ws_health['connected']:
                    notes.append('order-update WS DISCONNECTED (REST poll is covering replication)')
                for _bn, _b in brokers.items():
                    if _b.margin['blocked_count']:
                        notes.append(f"{_b.margin['blocked_count']} {_bn} order(s) margin-blocked")
                    if _b.margin['available'] is None:
                        notes.append(f'{_bn} margin state UNKNOWN — gate failing open')
                # A configured child that could not be initialised is the one
                # failure the dashboard must not miss: fills are silently not
                # reaching that account.
                for _bn, _reason in broker_failures.items():
                    notes.append(f'{_bn} child UNAVAILABLE ({_reason})')
                detail = '; '.join(notes)

                # Zerodha's figures stay at the top level so the existing
                # dashboard panels keep working unchanged; every broker (Zerodha
                # included) also appears under 'brokers'.
                _primary = brokers.get('zerodha') or next(iter(brokers.values()))
                write_status('RUNNING', started_at=started_at, detail=detail, extra={
                    'ws_thread_alive': ws_alive,
                    'ws_connected': ws_health['connected'],
                    'ws_connected_for_sec': ws_health['connected_for_sec'],
                    'ws_last_event_age_sec': ws_health['last_event_age_sec'],
                    'ws_connect_failures': ws_health['connect_failures'],
                    'ws_last_error': ws_health['last_error'],
                    'last_poll_ts': state['last_poll_ts'],
                    'poll_count': state['poll_count'],
                    'failed_replications': state['failed_count'],
                    'pending_retries': pending_retries,
                    'margin_available': _primary.margin['available'],
                    'margin_cash': _primary.margin['cash'],
                    'margin_per_lot': (round(_primary.margin['per_lot'], 2)
                                       if _primary.margin['per_lot'] else None),
                    'margin_updated_ts': _primary.margin['updated_ts'],
                    'margin_error': _primary.margin['error'],
                    'margin_blocked_count': _primary.margin['blocked_count'],
                    'margin_check_enabled': bool(load_config().get('margin_check', True)),
                    'brokers': {n: b.status() for n, b in brokers.items()},
                    'broker_failures': dict(broker_failures),
                    # hedge_qty/hedge_ctx are read directly (never snapshotted
                    # into a separate variable) so a deferred hedge that lands
                    # later — see maybe_place_deferred_hedge — shows up here on
                    # the very next heartbeat instead of staying stale forever.
                    'hedge_symbols': sorted(hedge_qty),
                    'hedge_product': hedge_product,
                    'hedge_pending': bool(hedge_ctx.get('pending')),
                    'hedge_pending_attempts': hedge_ctx.get('attempts', 0),
                    'hedge_premium_estimate': hedge_ctx['report'].get('premium_estimate'),
                    'capacity_lots_dhan': hedge_ctx['report'].get('dhan_capacity_lots'),
                    'capacity_lots_target_met': hedge_ctx['report'].get('target_met'),
                })
            time.sleep(1)
    except KeyboardInterrupt:
        print('[copy_trade_bridge] KeyboardInterrupt — shutting down.', flush=True)
        stop_detail = ''
    except Exception as e:
        print('[copy_trade_bridge] CRASHED:\n' + traceback.format_exc(), flush=True)
        stop_detail = f'Crashed: {e}'
    else:
        stop_detail = ''
    finally:
        watchdog_stop.set()
        try:
            helper.stop_order_update_websocket()
        except Exception:
            pass
        # Square off the startup hedges on a graceful stop. This is best-effort
        # by nature: a kill -9 never reaches this block, which is exactly why
        # copy_trade_hedges.json is authoritative and the next startup adopts
        # whatever it finds still open rather than buying a second set.
        if kite is not None and hedge_qty and load_config().get('armed'):
            try:
                from scripts.tools.copy_trade_hedge import close_hedges
                for r in close_hedges(kite, armed=True):
                    append_log({
                        'ts': datetime.now().isoformat(), 'order_no': f"hedge-{r['symbol']}",
                        'broker': 'zerodha', 'child_symbol': r['symbol'],
                        'zerodha_symbol': r['symbol'], 'side': 'SELL', 'child_qty': r.get('qty'),
                        'result': f"hedge_{r['result']}", 'error': r.get('error'),
                    })
            except Exception as e:
                print(f'[copy_trade_bridge] Hedge close on shutdown failed: {e} — '
                      f'hedges may still be open, see copy_trade_hedges.json', flush=True)
        write_status('STOPPED', started_at=started_at, detail=stop_detail)


if __name__ == '__main__':
    main()
