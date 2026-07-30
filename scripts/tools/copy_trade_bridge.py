"""
Trade replication bridge: Dhan (parent) -> Zerodha (child accounts).

Listens to Dhan's real-time order-update WebSocket (via
DhanHelper.start_order_update_websocket) and, for every TRADED or
PART_TRADED fill, mirrors the newly-traded delta to each enabled child
account in debug/copy_trade_config.json at quantity = delta * multiplier,
always as a MARKET order (sliced to the NFO freeze quantity).

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
    checks while the child still holds cached-NIFTY-option positions,
    force-close those child positions — scoped to the replication universe
    so unrelated Zerodha positions are never touched, with per-symbol
    attempt caps + backoff and a market-hours gate.
  - Startup baseline: fills that happened while the bridge was down are
    NOT auto-replicated (placing catch-up market orders on a restart is
    riskier than surfacing the gap) — they are marked handled and logged
    loudly as 'baseline_skipped' for manual reconciliation.

NIFTY options only (matches the rest of the scalper/live-quotes scope).
One-directional: Dhan -> Zerodha. No reverse replication.

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
# module imports nothing but `typing` (no pandas/DhanHelper), so it does not
# widen the double-spawn window the singleton mutex exists to close.
from lib.zerodha.margin import (  # noqa: E402
    get_margin_snapshot, get_required_margin, build_order_param,
)

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

FREEZE_QTY = 1800  # NFO NIFTY options freeze quantity — market orders above this are rejected
INSTRUMENTS_REFRESH_MIN_INTERVAL_SEC = 600
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
_positions_lock = threading.Lock()  # guards _margin_state['positions'] RMW vs wholesale rebind

# Margin gate state, refreshed on the watchdog thread and read by the WS callback
# thread. The SCALAR fields need no lock: each is replaced by a single
# assignment, so a reader sees either the old or the new value, never a torn one.
#
# 'positions' is the exception and needs `_positions_lock`, because it is
# read-modify-written by note_position_delta (WS thread) while the watchdog
# rebinds it wholesale. Unsynchronised, a delta applied between the watchdog's
# read and its assignment lands on the discarded dict and is lost — and a lost
# delta means a just-opened position looks flat, so the exit that follows is
# classified as an entry and can be margin-blocked. Small window, but it is the
# dangerous direction, and it is the same failure the reducing-order rule exists
# to prevent.
#
# `available` is None until the first successful kite.margins() call, and goes
# back to None whenever one fails. The gate treats None as "unknown" and FAILS
# OPEN — a blocked entry is itself a desync, so refusing to replicate on the
# basis of a margin figure we could not fetch would trade one failure mode for
# a worse one.
_margin_state = {
    'available': None,      # kite.margins()['net']
    'cash': None,           # available.live_balance — what hedge premium can use
    'per_lot': None,        # measured margin for a 1-lot short, for the fast path
    'lot_size': 65,
    'updated_ts': 0.0,
    'error': None,
    'blocked_count': 0,
    # Cached child positions {tradingsymbol: signed qty} + when they were read.
    # Exists so the WS callback thread can tell an EXIT from an ENTRY without an
    # HTTP call. Without it the fast path cannot apply the never-gate-an-exit
    # rule at all, and a parent exit arriving while the account is near full
    # utilisation gets refused — stranding a naked child position, which is
    # strictly worse than the margin rejection the gate exists to avoid.
    'positions': None,
    'positions_ts': 0.0,
}

# How often the watchdog re-measures the representative per-lot margin. Much
# slower than the funds refresh because it costs a basket_order_margins call and
# the figure only moves with volatility, not with each fill.
PER_LOT_REFRESH_INTERVAL_SEC = 300

# Child position snapshot cadence, and the age past which the fast path stops
# trusting it. Beyond POSITIONS_MAX_AGE_SEC the gate fails OPEN rather than risk
# mistaking an exit for an entry.
POSITIONS_REFRESH_INTERVAL_SEC = 5
POSITIONS_MAX_AGE_SEC = 20

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


def note_position_delta(symbol: str, side: str, qty: int):
    """Optimistically fold a just-placed order into the cached position map.

    Only ever makes the bridge MORE aware of exposure it holds, so its only
    possible effect on check_margin is to classify a follow-up order as reducing
    and skip the gate. It can never manufacture a false block — which is why it
    is safe to apply before the fill is confirmed, and why an order that is later
    rejected leaves the cache merely pessimistic rather than dangerous.

    The next snapshot refresh replaces this with broker truth.
    """
    signed = int(qty) if str(side).upper() == 'BUY' else -int(qty)
    with _positions_lock:
        pos = _margin_state.get('positions')
        if pos is None:
            return
        pos[symbol] = pos.get(symbol, 0) + signed


def set_position_snapshot(positions: dict):
    """Replace the cached position map with broker truth, under the lock so a
    concurrent note_position_delta cannot be silently dropped."""
    with _positions_lock:
        _margin_state['positions'] = positions
        _margin_state['positions_ts'] = time.time()


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


def load_replicated_symbols() -> set:
    """Per-day set of Zerodha symbols the bridge has actually placed (or
    attempted) orders in — the watchdog's close scope. Persisted here rather
    than derived from the activity log, which is capped at MAX_LOG_ENTRIES and
    can scroll a morning's symbol out of scope on a busy day."""
    data = read_json(REPLICATED_FILE, {})
    if not isinstance(data, dict) or data.get('date') != datetime.now().strftime('%Y-%m-%d'):
        return set()
    syms = data.get('symbols', [])
    return set(syms) if isinstance(syms, list) else set()


def save_replicated(replicated: dict, symbols=None):
    with _replicated_lock:
        if symbols is None:
            symbols = load_replicated_symbols()  # preserve what's on disk
        atomic_write(REPLICATED_FILE, {
            'date': datetime.now().strftime('%Y-%m-%d'),
            'orders': replicated,
            'symbols': sorted(symbols),
        })


def note_replicated_symbol(sym: str, symbols_set: set):
    """Add a symbol to the watchdog's close scope and persist immediately —
    BEFORE the child order is placed, so a crash mid-place still leaves the
    orphan covered after restart."""
    if not sym or sym in symbols_set:
        return
    symbols_set.add(sym)
    with _replicated_lock:
        data = read_json(REPLICATED_FILE, {})
        today = datetime.now().strftime('%Y-%m-%d')
        orders = {}
        if isinstance(data, dict) and data.get('date') == today and isinstance(data.get('orders'), dict):
            orders = data['orders']
        atomic_write(REPLICATED_FILE, {'date': today, 'orders': orders, 'symbols': sorted(symbols_set)})


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


def find_zerodha_symbol(instruments: list, strike, expiry: str, opt_type: str):
    try:
        strike_f = float(strike)
    except (TypeError, ValueError):
        return None
    for inst in instruments:
        if (inst.get('expiry') == expiry
                and inst.get('instrument_type') == opt_type
                and float(inst.get('strike', -1)) == strike_f):
            return inst.get('tradingsymbol')
    return None


def map_product_to_zerodha(kite, *hints):
    """Map a Dhan order's product to the equivalent Zerodha product, trying
    each hint in order and using the first one that is recognized.

    Multiple hints are required because the two fill sources disagree on field
    names. Verified against the real WS payloads captured in
    debug/copy_trade_raw_events.json (2026-07-21): the order-update WS carries
    NO 'productType' key at all — it sends 'productName' ('INTRADAY' / 'MARGIN'
    / 'CNC') plus a single-letter 'product' ('I' / 'M' / 'C'). Only the REST
    order list (the poll fallback) sends 'productType'. Reading just
    'productType' therefore silently mapped EVERY WS-delivered fill to MIS.

    That is not cosmetic. Replicating a MARGIN/NRML parent as MIS means Zerodha
    auto-squares the child off at ~15:20 while the parent still holds, and MIS
    orders are rejected outright after 15:26 — which is precisely how the
    2026-07-23 'retry_exhausted' entries left two open Zerodha legs behind
    ("Intraday orders (MIS) are allowed only till 3.26 PM").

    CNC maps to NRML rather than kite.PRODUCT_CNC: this bridge only ever places
    NFO option orders, where CNC is not a valid product. Unrecognized/missing
    values fall back to MIS, matching the previous behavior.
    """
    for hint in hints:
        h = str(hint or '').strip().upper()
        if h in ('MARGIN', 'NRML', 'M'):
            return kite.PRODUCT_NRML
        if h in ('CNC', 'C'):
            return kite.PRODUCT_NRML
        if h in ('INTRADAY', 'MIS', 'I'):
            return kite.PRODUCT_MIS
    return kite.PRODUCT_MIS


MARGIN_BLOCKED = 'MARGIN_BLOCKED'


def check_margin(kite, symbol: str, side: str, qty: int, product, exact: bool = False):
    """Can the child afford this order? Returns (ok, detail_dict).

    Two safety rules are baked in, and both matter more than the check itself:

    1. **Exposure-reducing orders are never blocked.** Refusing an exit strands a
       naked position, which is far worse than any margin rejection, and closing
       a position releases margin rather than consuming it. Side alone cannot
       tell an exit from an entry (a SELL opens a short when flat but closes a
       long when long), so the child's current holding decides.
    2. **Unknown margin state fails OPEN.** A blocked entry is itself a
       parent/child desync, so we never block on a figure we could not fetch.

    `exact=False` (the WS callback thread) uses only cached scalars — no HTTP, so
    event delivery is never stalled. `exact=True` (the watchdog thread, where
    find_recent_matching_order already blocks) prices the real basket.
    """
    from lib.zerodha.margin import (
        get_required_margin, build_order_param, is_reducing, held_qty_for,
    )
    detail = {'mode': 'exact' if exact else 'cached'}

    # Rule 1 — reducing orders bypass the gate entirely, on BOTH paths.
    #
    # The exact path (watchdog thread) can afford to ask the broker. The fast path
    # (WS callback thread) must not block, so it uses the cached snapshot the
    # watchdog maintains — and if that snapshot is missing or too old to trust, it
    # FAILS OPEN rather than risk mistaking a parent's exit for a new entry.
    # Getting this wrong strands a naked child position, so every uncertain branch
    # here deliberately allows the order through.
    if exact:
        try:
            held = held_qty_for(kite.positions().get('net', []), symbol)
        except Exception as e:
            detail['error'] = f'position fetch failed: {e}'
            detail['failed_open'] = True
            return True, detail
    else:
        positions = _margin_state.get('positions')
        age = time.time() - (_margin_state.get('positions_ts') or 0.0)
        if positions is None or age > POSITIONS_MAX_AGE_SEC:
            detail['error'] = (f'position snapshot {"missing" if positions is None else f"stale ({age:.0f}s)"}'
                              ' — cannot prove this is not an exit')
            detail['failed_open'] = True
            return True, detail
        held = int(positions.get(symbol, 0))
        detail['positions_age_sec'] = round(age, 1)
    detail['held_qty'] = held
    if is_reducing(held, side, qty):
        detail['skipped'] = 'reducing existing exposure — not gated'
        return True, detail

    available = _margin_state['available']
    if available is None:
        detail['error'] = _margin_state.get('error') or 'margin state not yet populated'
        detail['failed_open'] = True
        return True, detail
    detail['available'] = round(available, 2)

    if exact:
        required, err = get_required_margin(
            kite, [build_order_param(symbol, side, qty, product)], consider_positions=True)
        if err:
            detail['error'] = f'basket margin failed: {err}'
            detail['failed_open'] = True
            return True, detail
    else:
        per_lot = _margin_state['per_lot']
        if per_lot is None:
            detail['error'] = 'per-lot margin not yet measured'
            detail['failed_open'] = True
            return True, detail
        lot_size = _margin_state.get('lot_size') or 65
        # Deliberately a ceiling: a part-lot quantity still reserves a whole
        # lot's worth of risk, and rounding down here would wave through the
        # order that tips the account over.
        lots = max(1, math.ceil(qty / lot_size))
        required = per_lot * lots
        detail['per_lot'] = round(per_lot, 2)
        detail['lots'] = lots

    detail['required'] = round(required, 2)
    if required <= available:
        return True, detail
    detail['shortfall'] = round(required - available, 2)
    return False, detail


def place_child_order(kite, symbol: str, side: str, qty: int, product=None,
                      margin_check: bool = False, exact_margin: bool = False,
                      detail_out: dict = None):
    """Place a MARKET order sliced to the freeze quantity.

    `product` is the Zerodha product constant (e.g. kite.PRODUCT_MIS /
    kite.PRODUCT_NRML) to mirror the parent order's actual product type;
    defaults to MIS if not supplied.

    With `margin_check=True`, an unaffordable order is refused before anything is
    placed and the error is the MARGIN_BLOCKED sentinel. Callers must NOT queue
    that for retry: re-attempting an order the account cannot fund just burns the
    retry budget and floods the log, which is exactly what happened on
    2026-07-27/28 when three attempts each failed on "Insufficient funds".

    Returns (placed_qty, order_ids, error) — never raises. On a mid-slice
    failure, placed_qty reflects what actually went through so the caller can
    queue exactly the remainder for retry (re-placing the full qty would
    duplicate the successful slices)."""
    if product is None:
        product = kite.PRODUCT_MIS
    if margin_check:
        ok, detail = check_margin(kite, symbol, side, qty, product, exact=exact_margin)
        # Report via a caller-supplied dict, not shared state: the WS thread and
        # the watchdog thread can both be in here at once, and a shared
        # "last block" slot lets one thread's numbers end up in the other's log
        # entry.
        if detail_out is not None:
            detail_out.clear()
            detail_out.update(detail)
        if not ok:
            _margin_state['blocked_count'] += 1
            print(f'[copy_trade_bridge] MARGIN BLOCKED ({detail.get("mode")}) {side} {qty} {symbol}: '
                  f'needs Rs {detail.get("required", 0):,.2f}, have Rs {detail.get("available", 0):,.2f} '
                  f'(short Rs {detail.get("shortfall", 0):,.2f})', flush=True)
            return 0, [], MARGIN_BLOCKED
    order_ids = []
    placed = 0
    remaining = qty
    while remaining > 0:
        chunk = min(remaining, FREEZE_QTY)
        try:
            order_id = kite.place_order(
                variety=kite.VARIETY_REGULAR,
                exchange=kite.EXCHANGE_NFO,
                tradingsymbol=symbol,
                transaction_type=kite.TRANSACTION_TYPE_BUY if side == 'BUY' else kite.TRANSACTION_TYPE_SELL,
                quantity=chunk,
                product=product,
                order_type=kite.ORDER_TYPE_MARKET,
                validity=kite.VALIDITY_DAY,
                # Zerodha rejects API market orders on options without market
                # protection; -1 = automatic system-managed protection band.
                market_protection=-1,
            )
            order_ids.append(order_id)
            placed += chunk
            remaining -= chunk
            # Keep the cached position map current between snapshot refreshes so
            # an exit arriving seconds after its entry is still recognised as
            # reducing (and therefore never gated).
            note_position_delta(symbol, side, chunk)
        except Exception as e:
            return placed, order_ids, str(e)
    return placed, order_ids, None


def find_recent_matching_order(kite, symbol: str, side: str, qty: int, since_ts):
    """Best-effort dedup check before RE-trying a chunk whose previous
    kite.place_order call raised (e.g. RemoteDisconnected) — the request may
    have actually reached Zerodha even though the response was lost, and a
    blind retry would then double the position. Kite Connect has no
    client-supplied idempotency key, so this can only match on
    symbol/side/qty/time, not guarantee identity — but it catches the common
    "order placed, response dropped" case. Only called from the watchdog
    thread (never the WS callback thread) since it's an extra blocking call.

    Returns the matching order_id, or None (verify failed or no match — the
    caller should fall through to a normal retry either way)."""
    try:
        orders = kite.orders()
    except Exception:
        return None
    txn = kite.TRANSACTION_TYPE_BUY if side == 'BUY' else kite.TRANSACTION_TYPE_SELL
    for o in orders or []:
        if o.get('tradingsymbol') != symbol:
            continue
        if o.get('transaction_type') != txn:
            continue
        if int(o.get('quantity', 0) or 0) != qty:
            continue
        if str(o.get('status', '') or '').upper() in ('REJECTED', 'CANCELLED'):
            continue
        ts = o.get('order_timestamp')
        if isinstance(ts, str):
            try:
                ts = datetime.fromisoformat(ts)
            except ValueError:
                ts = None
        # Fail CLOSED: an unparseable/missing timestamp must NOT count as a
        # match — misidentifying an unrelated older order as "already placed"
        # would skip the real retry and leave the leg unreplicated, which is
        # worse than the rare duplicate this check exists to prevent.
        if ts is None or since_ts is None or ts < since_ts:
            continue
        return o.get('order_id')
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


def watchdog_loop(helper, kite, stop_event: threading.Event, state: dict,
                  retry_queue: list, get_nifty_symbols, resolve_symbol, replicated_symbols,
                  hedge_qty=None, margin_probe_symbol=None, cfg_product='MIS', hedge_ctx=None):
    """
    The bridge's single background thread. Everything that needs to make a
    blocking broker call on a timer lives here, deliberately on ONE thread: the
    retry drain must never run concurrently with itself (two drains could place
    the same queued order twice), and the WS callback thread must never block.

    Five cadences, each gated by its own `last_*` timestamp, loosest last:

    1. RETRY_DRAIN_INTERVAL_SEC (2s)  — drain the failed-replication retry queue
       (bounded attempts + backoff), including the exact margin re-check; also
       retries a startup hedge that was deferred until market open
       (maybe_place_deferred_hedge).
    2. POSITIONS_REFRESH_INTERVAL_SEC (5s) — refresh the child position snapshot
       the fast-path margin gate uses to recognise exits.
    3. WATCHDOG_INTERVAL_SEC (7s) — the safety exit: if armed and the parent's
       NIFTY option book has been flat for FLAT_CONFIRMATIONS consecutive checks
       (and no replication landed within REPLICATION_GRACE_SEC), force-close the
       child's replicated NIFTY-option positions — and ONLY those, with hedge
       quantities netted out; manual/unrelated Zerodha positions are never
       touched.
    4. KEEPALIVE_INTERVAL_SEC (30s) — keep Kite's pooled socket warm, and capture
       the funds figure the margin gate compares against.
    5. PER_LOT_REFRESH_INTERVAL_SEC (300s) — re-measure the representative
       per-lot margin used by the fast-path gate.

    Deliberately conservative: if the Dhan positions call fails (as opposed
    to genuinely returning zero positions), helper.last_api_error will be
    set and this cycle is skipped rather than treated as "flat", to avoid
    force-closing legitimate Zerodha positions on a transient API hiccup.
    """
    safety_attempts = {}  # tradingsymbol -> {'n': attempts, 'next': earliest retry ts}
    last_safety_check = 0.0
    last_keepalive = 0.0
    last_per_lot = 0.0
    last_positions = 0.0
    hedge_qty = hedge_qty if hedge_qty is not None else {}
    hedge_ctx = hedge_ctx if hedge_ctx is not None else {'pending': False, 'report': {}}
    while not stop_event.wait(RETRY_DRAIN_INTERVAL_SEC):
        try:
            # Keep Kite's pooled HTTPS socket warm so the next place_order does
            # not inherit a connection Zerodha already closed — see
            # KEEPALIVE_INTERVAL_SEC. Runs on this thread (never the WS callback
            # thread, which must not block) and independently of `armed`, so the
            # socket is already fresh for the day's first fill.
            #
            # The call doubles as the margin gate's funds refresh: it was already
            # hitting /user/margins every 30s and discarding the response, so
            # capturing it costs nothing and keeps the WS-path gate free of HTTP.
            if time.time() - last_keepalive >= KEEPALIVE_INTERVAL_SEC:
                last_keepalive = time.time()
                snap, merr = get_margin_snapshot(kite)
                if merr:
                    # Drop to "unknown" rather than keeping a stale figure: the
                    # gate fails open on None, which is the right call when we
                    # cannot see the account. Stale numbers could block real
                    # trades (or wave through unaffordable ones) for hours.
                    _margin_state['available'] = None
                    _margin_state['cash'] = None
                    _margin_state['error'] = merr
                else:
                    _margin_state['available'] = snap['net']
                    _margin_state['cash'] = snap['cash']
                    _margin_state['error'] = None
                    _margin_state['updated_ts'] = time.time()

            # Refresh the child position snapshot the fast-path gate relies on to
            # recognise exits. Cheap, and far more frequent than the per-lot probe
            # because a stale snapshot degrades the gate to fail-open.
            if time.time() - last_positions >= POSITIONS_REFRESH_INTERVAL_SEC:
                last_positions = time.time()
                try:
                    snap_pos = {}
                    for p in kite.positions().get('net', []):
                        sym = p.get('tradingsymbol')
                        if sym:
                            snap_pos[sym] = int(p.get('quantity', 0) or 0)
                    # Broker truth replaces the optimistic in-memory deltas.
                    set_position_snapshot(snap_pos)
                except Exception:
                    # Leave the previous snapshot in place; check_margin ages it
                    # out on its own and fails open once it is too old to trust.
                    pass

            # Re-measure the representative per-lot margin far less often — it
            # costs a basket call and only drifts with volatility.
            if (margin_probe_symbol
                    and time.time() - last_per_lot >= PER_LOT_REFRESH_INTERVAL_SEC):
                last_per_lot = time.time()
                per_lot, perr = get_required_margin(
                    kite,
                    [build_order_param(margin_probe_symbol, 'SELL',
                                       _margin_state.get('lot_size') or 65,
                                       str(cfg_product))],
                    # consider_positions=True on purpose: this must be the
                    # MARGINAL cost of one more lot given what the account
                    # already holds, which is exactly what Zerodha itself checks
                    # at order time. The standalone rate ignores offsets from
                    # existing hedges and would over-state the requirement,
                    # false-blocking affordable orders — and a false block is
                    # itself a parent/child desync.
                    consider_positions=True,
                )
                if perr:
                    _margin_state['error'] = f'per-lot probe failed: {perr}'
                elif per_lot and per_lot > 0:
                    _margin_state['per_lot'] = per_lot

            cfg = load_config()
            armed = bool(cfg.get('armed'))
            children = [c for c in cfg.get('children', []) if c.get('enabled')]

            if armed and market_is_open():
                drain_retry_queue(kite, retry_queue, state, resolve_symbol, replicated_symbols,
                                  margin_check=bool(cfg.get('margin_check', True)))
                maybe_place_deferred_hedge(kite, helper, cfg, hedge_ctx, hedge_qty, FREEZE_QTY)

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

            nifty_symbols = get_nifty_symbols()
            positions = kite.positions()

            # Scope closes to symbols the bridge itself traded today (the
            # persisted per-day set — durable across restarts and immune to
            # the activity log's 200-entry cap scrolling a symbol out).
            #
            # Hedges are long OTM options the bridge bought for margin headroom.
            # They have no parent counterpart by design, so "parent is flat" is
            # never evidence a hedge is orphaned, and force-closing one would
            # destroy the margin relief mid-session just as the parent may be
            # re-entering.
            #
            # They are NETTED OUT rather than skipped by symbol. The hedge sits
            # only ~600 points OTM, so the parent rolling into that exact strike
            # is realistic — and a symbol-level exclusion would then hide a
            # genuinely orphaned short behind the hedge, defeating the watchdog on
            # the one case it exists for. Subtracting the known hedge quantity
            # leaves the residual: zero for a pure hedge (skip), still-short for a
            # hedge sharing a strike with an orphan (close the residual, keeping
            # the hedge intact).
            open_positions = []
            for p in positions.get('net', []):
                sym = p.get('tradingsymbol')
                if sym not in nifty_symbols or sym not in replicated_symbols:
                    continue
                try:
                    net_qty = int(p.get('quantity', 0) or 0)
                except (TypeError, ValueError):
                    continue
                residual = net_qty - int(hedge_qty.get(sym, 0))
                if residual == 0:
                    continue
                open_positions.append({'pos': p, 'symbol': sym, 'residual': residual})
            open_symbols = {e['symbol'] for e in open_positions}
            for sym in list(safety_attempts):
                if sym not in open_symbols:
                    del safety_attempts[sym]  # closed (or fresh) — reset its attempt budget
            if not open_positions:
                continue  # child already flat too

            ts = datetime.now().isoformat()
            now_ts = time.time()
            closed = 0
            for item in open_positions:
                pos, symbol, residual = item['pos'], item['symbol'], item['residual']
                att = safety_attempts.get(symbol, {'n': 0, 'next': 0.0})
                if att['n'] >= SAFETY_EXIT_MAX_ATTEMPTS:
                    continue  # gave up on this symbol (already logged below)
                if now_ts < att['next']:
                    continue

                # Close the residual, not the raw net — so a hedge sharing this
                # strike survives while the orphaned leg is flattened.
                qty = abs(residual)
                side = 'SELL' if residual > 0 else 'BUY'
                entry = {
                    'ts': ts, 'order_no': f'watchdog-{symbol}', 'parent_symbol': '(parent flat)',
                    'zerodha_symbol': symbol, 'side': side, 'child_qty': qty,
                    'broker': 'zerodha', 'armed': True, 'attempt': att['n'] + 1,
                }
                try:
                    order_id = kite.place_order(
                        variety=kite.VARIETY_REGULAR,
                        exchange=pos.get('exchange', 'NFO'),
                        tradingsymbol=symbol,
                        transaction_type=side,
                        quantity=qty,
                        product=pos.get('product', kite.PRODUCT_MIS),
                        order_type=kite.ORDER_TYPE_MARKET,
                        validity=kite.VALIDITY_DAY,
                        market_protection=-1,
                    )
                    entry['result'] = 'safety_exit'
                    entry['child_order_id'] = order_id
                    closed += 1
                    print(f'[copy_trade_bridge] SAFETY EXIT: parent flat, force-closed {symbol} '
                          f'({side} {qty}) -> order {order_id}', flush=True)
                except Exception as e:
                    entry['result'] = 'safety_exit_error'
                    entry['error'] = str(e)
                    print(f'[copy_trade_bridge] ERROR in safety exit for {symbol}: {e}', flush=True)
                append_log(entry)

                # Placement != fill: if the order is rejected async the position
                # survives to the next cycle — back off instead of spamming.
                safety_attempts[symbol] = {'n': att['n'] + 1, 'next': now_ts + SAFETY_EXIT_BACKOFF_SEC}
                if safety_attempts[symbol]['n'] >= SAFETY_EXIT_MAX_ATTEMPTS:
                    append_log({'ts': ts, 'order_no': f'watchdog-{symbol}', 'zerodha_symbol': symbol,
                                'result': 'safety_exit_gave_up',
                                'error': f'{SAFETY_EXIT_MAX_ATTEMPTS} exit attempts failed to close — manual action needed'})
                    state['failed_count'] += 1

            if closed:
                print(f'[copy_trade_bridge] Safety watchdog: parent flat, force-closed {closed} '
                      f'Zerodha position(s).', flush=True)

        except Exception as e:
            print(f'[copy_trade_bridge] ERROR in watchdog_loop: {e}', flush=True)


def drain_retry_queue(kite, retry_queue: list, state: dict, resolve_symbol=None,
                      replicated_symbols=None, margin_check: bool = False):
    now = time.time()
    with _retry_lock:
        due = [r for r in retry_queue if now >= r['next_ts']]
    for item in due:
        # Items enqueued with an unresolved symbol (strike not in the cache at
        # fill time — e.g. one NSE added intraday) are resolved here, where a
        # blocking cache refresh is safe; never in the WS callback thread.
        if not item.get('zerodha_symbol'):
            sym = resolve_symbol(item.get('strike'), item.get('expiry'), item.get('opt_type')) if resolve_symbol else None
            if sym is None:
                item['attempts'] += 1
                item['next_ts'] = time.time() + RETRY_BACKOFF_SEC * item['attempts']
                if item['attempts'] >= RETRY_MAX_ATTEMPTS:
                    with _retry_lock:
                        if item in retry_queue:
                            retry_queue.remove(item)
                    state['failed_count'] += 1
                    append_log({'ts': datetime.now().isoformat(), 'order_no': item['order_no'],
                                'side': item['side'], 'qty': item['qty'], 'result': 'retry_exhausted',
                                'error': 'Instrument never resolved to a cached NIFTY option — NOT replicated'})
                continue
            item['zerodha_symbol'] = sym

        if replicated_symbols is not None:
            note_replicated_symbol(item['zerodha_symbol'], replicated_symbols)

        entry = {
            'ts': datetime.now().isoformat(), 'order_no': item['order_no'],
            'zerodha_symbol': item['zerodha_symbol'], 'side': item['side'],
            'child_qty': item['qty'], 'broker': 'zerodha', 'armed': True,
            'attempt': item['attempts'] + 1,
        }

        blk = {}
        # A previous attempt for this item raised (response lost) — verify it
        # didn't actually land before placing what could be a duplicate.
        dup_order_id = None
        if item.get('queued_at') is not None:
            dup_order_id = find_recent_matching_order(
                kite, item['zerodha_symbol'], item['side'], item['qty'], item['queued_at'])

        if dup_order_id is not None:
            placed, order_ids, err, verified_dup = item['qty'], [dup_order_id], None, True
        else:
            # This thread already makes blocking Kite calls (find_recent_matching_order
            # above), so the exact basket-priced check is affordable here.
            placed, order_ids, err = place_child_order(
                kite, item['zerodha_symbol'], item['side'], item['qty'],
                product=item.get('product', kite.PRODUCT_MIS),
                margin_check=margin_check, exact_margin=True,
                detail_out=blk,
            )
            verified_dup = False

        if err == MARGIN_BLOCKED:
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
            entry['error'] = (f'Insufficient Zerodha margin: needs {blk.get("required")}, '
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
                  f'{item["order_no"]} ({item["side"]} {item["qty"]} {item["zerodha_symbol"]})', flush=True)
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
                print(f'[copy_trade_bridge] RETRY EXHAUSTED for {item["order_no"]}: {err}', flush=True)
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
    from scripts.tools.zerodha_instruments_cache import restore_session_from_json
    from scripts.tools.live_options_ws_zerodha import load_zerodha_instruments_cache

    dhan = get_dhan_client()
    if not dhan:
        write_status('ERROR', started_at=started_at, detail='Dhan auth failed — run login.py')
        print('[copy_trade_bridge] ERROR: Dhan auth failed', flush=True)
        sys.exit(1)
    helper = DhanHelper(dhan)

    kite = restore_session_from_json()
    if kite is None:
        write_status('ERROR', started_at=started_at, detail='Zerodha auth failed — run zerodha_autologin.py')
        print('[copy_trade_bridge] ERROR: Zerodha auth failed', flush=True)
        sys.exit(1)

    # restore_session_from_json() only builds a KiteConnect object from the
    # token file — it never calls Zerodha, so a token that expired overnight
    # (Zerodha access tokens die daily around 06:00 IST, and this bridge is
    # started every morning) yields a perfectly healthy-looking client. Without
    # this probe the bridge reaches 'RUNNING', then fails EVERY replication with
    # TokenException, burns all 3 retries per fill, and desyncs the whole
    # session while the dashboard still shows a green heartbeat.
    try:
        profile = kite.profile()
        print(f"[copy_trade_bridge] Zerodha session OK ({profile.get('user_id', '?')})", flush=True)
    except Exception as e:
        write_status('ERROR', started_at=started_at,
                     detail=f'Zerodha token rejected ({e}) — run zerodha_autologin.py')
        print(f'[copy_trade_bridge] ERROR: Zerodha token rejected: {e}', flush=True)
        sys.exit(1)

    try:
        instruments = load_zerodha_instruments_cache()
    except Exception as e:
        write_status('ERROR', started_at=started_at, detail=f'Failed to load Zerodha instrument cache: {e}')
        print(f'[copy_trade_bridge] ERROR: instrument cache load failed: {e}', flush=True)
        sys.exit(1)

    instruments_state = {
        'instruments': instruments,
        'nifty_symbols': {i.get('tradingsymbol') for i in instruments},
        'refreshed_at': time.time(),
    }

    def get_nifty_symbols():
        return instruments_state['nifty_symbols']

    def refresh_instruments():
        """On a lookup miss (e.g. a strike NSE added intraday), regenerate the
        cache once and reload — throttled so a genuinely-unsupported instrument
        can't hammer the Kite API."""
        if time.time() - instruments_state['refreshed_at'] < INSTRUMENTS_REFRESH_MIN_INTERVAL_SEC:
            return False
        instruments_state['refreshed_at'] = time.time()
        try:
            import subprocess
            subprocess.run(
                [sys.executable, os.path.join(ROOT, 'scripts', 'tools', 'zerodha_instruments_cache.py')],
                check=True, timeout=120,
            )
            fresh = load_zerodha_instruments_cache()
            instruments_state['instruments'] = fresh
            instruments_state['nifty_symbols'] = {i.get('tradingsymbol') for i in fresh}
            print(f'[copy_trade_bridge] Instrument cache refreshed ({len(fresh)} contracts)', flush=True)
            return True
        except Exception as e:
            print(f'[copy_trade_bridge] Instrument cache refresh failed: {e}', flush=True)
            return False

    def resolve_symbol(strike, expiry, opt_type):
        """Lookup with a one-shot (throttled) cache refresh on miss. Blocking —
        only ever called from the watchdog thread, never the WS callback."""
        sym = find_zerodha_symbol(instruments_state['instruments'], strike, expiry, opt_type)
        if sym is None and refresh_instruments():
            sym = find_zerodha_symbol(instruments_state['instruments'], strike, expiry, opt_type)
        return sym

    replicated_qty = load_replicated()
    replicated_symbols = load_replicated_symbols()
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
    startup_cfg = load_config()
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

    # Nearest future expiry drives both the per-lot margin probe and the hedge.
    _today = datetime.now().strftime('%Y-%m-%d')
    _expiries = sorted({i.get('expiry') for i in instruments if (i.get('expiry') or '') >= _today})
    near_expiry = _expiries[0] if _expiries else None

    margin_probe_symbol = None
    if near_expiry:
        try:
            spot_now = helper.get_ltp('NIFTY', instrument='INDEX')
            atm_now = round(float(spot_now) / 50) * 50
            margin_probe_symbol = find_zerodha_symbol(instruments, atm_now, near_expiry, 'CE')
            _ls = next((int(i.get('lot_size') or 65) for i in instruments
                        if i.get('tradingsymbol') == margin_probe_symbol), 65)
            _margin_state['lot_size'] = _ls
        except Exception as e:
            print(f'[copy_trade_bridge] Could not pick a margin probe contract: {e}', flush=True)

    # Seed the gate before any fill can arrive — otherwise the first fills of the
    # day sail through on the fail-open path while waiting for the first
    # keep-alive tick.
    _snap, _serr = get_margin_snapshot(kite)
    if _serr:
        _margin_state['error'] = _serr
        print(f'[copy_trade_bridge] WARNING: Zerodha margins unavailable at startup ({_serr}) — '
              f'margin gate will fail OPEN until a refresh succeeds', flush=True)
    else:
        _margin_state['available'] = _snap['net']
        _margin_state['cash'] = _snap['cash']
        _margin_state['updated_ts'] = time.time()
        print(f"[copy_trade_bridge] Zerodha margin: net Rs {_snap['net']:,.2f}, "
              f"cash Rs {_snap['cash']:,.2f}", flush=True)
    # Seed the position snapshot too — without it the fast-path gate fails open
    # (correctly, but uselessly) until the watchdog's first refresh.
    try:
        set_position_snapshot({
            p['tradingsymbol']: int(p.get('quantity', 0) or 0)
            for p in kite.positions().get('net', []) if p.get('tradingsymbol')
        })
    except Exception as e:
        print(f'[copy_trade_bridge] WARNING: could not read child positions at startup ({e}) — '
              f'margin gate will fail OPEN until the first refresh', flush=True)

    if margin_probe_symbol:
        # consider_positions=True — see the watchdog's refresh: the gate needs the
        # marginal cost given the current book, not a standalone rate.
        _pl, _perr = get_required_margin(
            kite, [build_order_param(margin_probe_symbol, 'SELL',
                                     _margin_state['lot_size'], hedge_product)],
            consider_positions=True)
        if _perr:
            print(f'[copy_trade_bridge] WARNING: per-lot margin probe failed ({_perr})', flush=True)
        elif _pl and _pl > 0:
            _margin_state['per_lot'] = _pl
            print(f'[copy_trade_bridge] Margin per lot ({margin_probe_symbol}, '
                  f'{hedge_product}): Rs {_pl:,.2f}', flush=True)
    else:
        # Silent failure here would leave the gate permanently fail-open while the
        # status file still reported margin_check_enabled: true.
        print(f'[copy_trade_bridge] WARNING: no margin probe contract resolved '
              f'(expiry={near_expiry}) — the fast-path margin gate is DISABLED '
              f'(fails open); the exact check on retries still applies', flush=True)

    if startup_cfg.get('hedge_on_startup') and near_expiry:
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
                # hedge longs for something else.
                _snap2, _e2 = get_margin_snapshot(kite)
                if not _e2:
                    _margin_state['available'] = _snap2['net']
                    _margin_state['cash'] = _snap2['cash']
                try:
                    set_position_snapshot({
                        p['tradingsymbol']: int(p.get('quantity', 0) or 0)
                        for p in kite.positions().get('net', []) if p.get('tradingsymbol')
                    })
                except Exception:
                    pass
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
            # single-letter WS 'product' code last. See map_product_to_zerodha.
            product = map_product_to_zerodha(
                kite,
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
            zerodha_symbol = None
            if is_option:
                # Fast in-memory lookup only — a cache refresh is a multi-second
                # subprocess that must never run in this WS callback (it would
                # stall event delivery and can drop the connection). A miss on
                # a real option goes to the retry queue, where the watchdog
                # thread refreshes the cache and resolves it.
                zerodha_symbol = find_zerodha_symbol(instruments_state['instruments'], strike, expiry, opt_type)

            if zerodha_symbol is None:
                if is_option and armed and children:
                    for child in children:
                        try:
                            multiplier = int(child.get('multiplier', 1))
                        except (TypeError, ValueError):
                            multiplier = 1
                        if multiplier < 1:
                            multiplier = 1
                        with _retry_lock:
                            retry_queue.append({
                                'order_no': order_no, 'zerodha_symbol': None,
                                'strike': strike, 'expiry': expiry, 'opt_type': opt_type,
                                'side': side, 'qty': delta * multiplier, 'attempts': 0,
                                'next_ts': 0.0, 'product': product,
                            })
                    append_log({'ts': ts, 'order_no': order_no, 'symbol': symbol, 'side': side,
                                'qty': delta, 'result': 'queued_resolution',
                                'error': 'Strike not in instrument cache — queued for refresh + replication'})
                else:
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
                        reason = 'Unsupported instrument (not a cached NIFTY option) — skipped'
                    append_log({'ts': ts, 'order_no': order_no, 'symbol': symbol, 'side': side,
                                'qty': delta, 'result': 'skipped', 'error': reason})
                replicated_qty[order_no] = traded_qty
                save_replicated(replicated_qty)
                return

            for child in children:
                broker = child.get('broker', 'zerodha')
                try:
                    multiplier = int(child.get('multiplier', 1))
                except (TypeError, ValueError):
                    multiplier = 1
                if multiplier < 1:
                    multiplier = 1
                child_qty = delta * multiplier

                entry = {
                    'ts': ts, 'order_no': order_no, 'parent_symbol': symbol,
                    'zerodha_symbol': zerodha_symbol, 'side': side,
                    'parent_qty': delta, 'broker': broker, 'multiplier': multiplier,
                    'child_qty': child_qty, 'armed': armed,
                }

                if not armed:
                    # Record what the margin gate WOULD have decided, so a
                    # disarmed session still proves the gate works before real
                    # money depends on it.
                    if cfg.get('margin_check', True):
                        ok, mdetail = check_margin(kite, zerodha_symbol, side, child_qty,
                                                   product, exact=False)
                        entry['margin'] = mdetail
                        entry['would_block'] = not ok
                    entry['result'] = 'logged_only'
                    append_log(entry)
                    continue

                warn_product_mismatch(product)
                note_replicated_symbol(zerodha_symbol, replicated_symbols)
                # Cached (non-blocking) check only: this runs on the order-update
                # WS callback thread, where an HTTP round-trip would stall event
                # delivery and can drop the connection.
                blk = {}
                placed, order_ids, err = place_child_order(
                    kite, zerodha_symbol, side, child_qty, product=product,
                    margin_check=bool(cfg.get('margin_check', True)), exact_margin=False,
                    detail_out=blk,
                )

                if err == MARGIN_BLOCKED:
                    # The fast path prices this against a cached ATM per-lot
                    # figure, which over-states a far-OTM leg — so a block here is
                    # a suspicion, not a verdict. Hand it to the retry queue,
                    # where the watchdog thread can afford the exact basket call
                    # and either places it or blocks it terminally. Dropping it on
                    # an estimate would desync the child over an arithmetic
                    # approximation.
                    with _retry_lock:
                        retry_queue.append({
                            'order_no': order_no, 'zerodha_symbol': zerodha_symbol,
                            'side': side, 'qty': child_qty, 'attempts': 0,
                            'next_ts': time.time() + FAST_RETRY_DELAY_SEC,
                            'product': product,
                            # No 'queued_at': nothing was sent to Zerodha, so there
                            # is no lost-response duplicate to guard against.
                        })
                    entry['result'] = 'margin_recheck_queued'
                    entry['required'] = blk.get('required')
                    entry['available'] = blk.get('available')
                    entry['shortfall'] = blk.get('shortfall')
                    entry['error'] = (f'Cached margin estimate says short by {blk.get("shortfall")} '
                                      f'(needs {blk.get("required")}, has {blk.get("available")}) — '
                                      f'queued for an exact re-check before giving up')
                    append_log(entry)
                    continue
                if placed:
                    state['last_replication_ts'] = time.time()
                if err is None:
                    entry['result'] = 'success'
                    entry['child_order_id'] = ','.join(str(o) for o in order_ids)
                    print(f'[copy_trade_bridge] Replicated {order_no} -> {broker} '
                          f'({side} {child_qty} {zerodha_symbol})', flush=True)
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
                            'order_no': order_no, 'zerodha_symbol': zerodha_symbol,
                            'side': side, 'qty': remaining, 'attempts': 1,
                            'next_ts': time.time() + FAST_RETRY_DELAY_SEC,
                            # This placement attempt just raised — before the
                            # NEXT attempt (in drain_retry_queue), verify it
                            # didn't actually go through (response lost, e.g.
                            # RemoteDisconnected) before placing a duplicate.
                            'queued_at': datetime.now(),
                            'product': product,
                        })
                    print(f'[copy_trade_bridge] ERROR replicating {order_no} to {broker}: {err} '
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
        args=(helper, kite, watchdog_stop, state, retry_queue, get_nifty_symbols, resolve_symbol,
              replicated_symbols, hedge_qty, margin_probe_symbol, hedge_product, hedge_ctx),
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

                detail = ''
                if state['failed_count'] or pending_retries:
                    detail = f"{state['failed_count']} failed replication(s), {pending_retries} pending retry(ies)"
                if not ws_health['connected']:
                    ws_note = 'order-update WS DISCONNECTED (REST poll is covering replication)'
                    detail = f'{detail}; {ws_note}' if detail else ws_note
                if _margin_state['blocked_count']:
                    detail = (f"{detail}; {_margin_state['blocked_count']} order(s) margin-blocked"
                              if detail else
                              f"{_margin_state['blocked_count']} order(s) margin-blocked")
                if _margin_state['available'] is None:
                    mnote = 'margin state UNKNOWN — gate failing open'
                    detail = f'{detail}; {mnote}' if detail else mnote
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
                    'margin_available': _margin_state['available'],
                    'margin_cash': _margin_state['cash'],
                    'margin_per_lot': (round(_margin_state['per_lot'], 2)
                                       if _margin_state['per_lot'] else None),
                    'margin_updated_ts': _margin_state['updated_ts'],
                    'margin_error': _margin_state['error'],
                    'margin_blocked_count': _margin_state['blocked_count'],
                    'margin_check_enabled': bool(load_config().get('margin_check', True)),
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
        if hedge_qty and load_config().get('armed'):
            try:
                from scripts.tools.copy_trade_hedge import close_hedges
                for r in close_hedges(kite, armed=True):
                    append_log({
                        'ts': datetime.now().isoformat(), 'order_no': f"hedge-{r['symbol']}",
                        'zerodha_symbol': r['symbol'], 'side': 'SELL', 'child_qty': r.get('qty'),
                        'result': f"hedge_{r['result']}", 'error': r.get('error'),
                    })
            except Exception as e:
                print(f'[copy_trade_bridge] Hedge close on shutdown failed: {e} — '
                      f'hedges may still be open, see copy_trade_hedges.json', flush=True)
        write_status('STOPPED', started_at=started_at, detail=stop_detail)


if __name__ == '__main__':
    main()
