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


def acquire_singleton() -> bool:
    """At most one bridge process, ever — two would replicate every fill twice.

    A Windows named mutex is auto-released on process death, so there is no
    stale-lock handling. The handle is deliberately never closed."""
    try:
        kernel32 = ctypes.windll.kernel32
        kernel32.CreateMutexW(None, False, 'dhan_algo_copy_trade_bridge')
        return kernel32.GetLastError() != 183  # ERROR_ALREADY_EXISTS
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


def map_product_to_zerodha(kite, dhan_product_type):
    """Map a Dhan order's productType (e.g. 'MARGIN', 'INTRADAY') to the
    equivalent Zerodha product. Unrecognized/missing values default to MIS,
    matching the bridge's previous (hardcoded) behavior."""
    if str(dhan_product_type or '').upper() in ('MARGIN', 'NRML'):
        return kite.PRODUCT_NRML
    return kite.PRODUCT_MIS


def place_child_order(kite, symbol: str, side: str, qty: int, product=None):
    """Place a MARKET order sliced to the freeze quantity.

    `product` is the Zerodha product constant (e.g. kite.PRODUCT_MIS /
    kite.PRODUCT_NRML) to mirror the parent order's actual product type;
    defaults to MIS if not supplied.

    Returns (placed_qty, order_ids, error) — never raises. On a mid-slice
    failure, placed_qty reflects what actually went through so the caller can
    queue exactly the remainder for retry (re-placing the full qty would
    duplicate the successful slices)."""
    if product is None:
        product = kite.PRODUCT_MIS
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
        status = str(o.get('orderStatus', '') or '').upper()
        if status not in ('TRADED', 'PART_TRADED'):
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


def watchdog_loop(helper, kite, stop_event: threading.Event, state: dict,
                  retry_queue: list, get_nifty_symbols, resolve_symbol, replicated_symbols):
    """
    Runs two cadences on one thread — deliberately not two threads, so there is
    never a chance of two drains racing on the same retry-queue item (which
    could place the same order twice):

    1. Every RETRY_DRAIN_INTERVAL_SEC: drains the failed-replication retry
       queue (bounded attempts + backoff).
    2. Every WATCHDOG_INTERVAL_SEC (unchanged, gated by `last_safety_check`
       below): if armed and the parent's NIFTY option book has been flat for
       FLAT_CONFIRMATIONS consecutive checks (and no replication landed within
       REPLICATION_GRACE_SEC), force-close the child's cached-NIFTY-option
       positions — and ONLY those; manual/unrelated Zerodha positions are
       never touched.

    Deliberately conservative: if the Dhan positions call fails (as opposed
    to genuinely returning zero positions), helper.last_api_error will be
    set and this cycle is skipped rather than treated as "flat", to avoid
    force-closing legitimate Zerodha positions on a transient API hiccup.
    """
    safety_attempts = {}  # tradingsymbol -> {'n': attempts, 'next': earliest retry ts}
    last_safety_check = 0.0
    while not stop_event.wait(RETRY_DRAIN_INTERVAL_SEC):
        try:
            cfg = load_config()
            armed = bool(cfg.get('armed'))
            children = [c for c in cfg.get('children', []) if c.get('enabled')]

            if armed and market_is_open():
                drain_retry_queue(kite, retry_queue, state, resolve_symbol, replicated_symbols)

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
            open_positions = [
                p for p in positions.get('net', [])
                if int(p.get('quantity', 0) or 0) != 0
                and p.get('tradingsymbol') in nifty_symbols
                and p.get('tradingsymbol') in replicated_symbols
            ]
            open_symbols = {p.get('tradingsymbol') for p in open_positions}
            for sym in list(safety_attempts):
                if sym not in open_symbols:
                    del safety_attempts[sym]  # closed (or fresh) — reset its attempt budget
            if not open_positions:
                continue  # child already flat too

            ts = datetime.now().isoformat()
            now_ts = time.time()
            closed = 0
            for pos in open_positions:
                symbol = pos.get('tradingsymbol', '')
                att = safety_attempts.get(symbol, {'n': 0, 'next': 0.0})
                if att['n'] >= SAFETY_EXIT_MAX_ATTEMPTS:
                    continue  # gave up on this symbol (already logged below)
                if now_ts < att['next']:
                    continue

                qty = abs(int(pos.get('quantity', 0)))
                side = 'SELL' if int(pos.get('quantity', 0)) > 0 else 'BUY'
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


def drain_retry_queue(kite, retry_queue: list, state: dict, resolve_symbol=None, replicated_symbols=None):
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

        # A previous attempt for this item raised (response lost) — verify it
        # didn't actually land before placing what could be a duplicate.
        dup_order_id = None
        if item.get('queued_at') is not None:
            dup_order_id = find_recent_matching_order(
                kite, item['zerodha_symbol'], item['side'], item['qty'], item['queued_at'])

        if dup_order_id is not None:
            placed, order_ids, err, verified_dup = item['qty'], [dup_order_id], None, True
        else:
            placed, order_ids, err = place_child_order(
                kite, item['zerodha_symbol'], item['side'], item['qty'],
                product=item.get('product', kite.PRODUCT_MIS),
            )
            verified_dup = False

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

    def handle_update(payload: dict):
        # Serialize against poll_parent_orders() below — both read-check-act on
        # replicated_qty for the same order_no, and without this lock a fill
        # landing right as a poll cycle runs could get replicated twice.
        _fill_lock.acquire()
        try:
            data = payload.get('Data', {})

            # Robust case-insensitive key lookups
            status = str(data.get('Status') or data.get('status') or '').upper()
            if status not in ('TRADED', 'PART_TRADED'):
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

            product_type_raw = data.get('ProductType') or data.get('productType')
            product = map_product_to_zerodha(kite, product_type_raw)

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
                    reason = 'Unsupported instrument (not a cached NIFTY option) — skipped'
                    if opt_type_raw and opt_type is None:
                        reason = f'Unrecognized OptType {opt_type_raw!r} — refusing to guess the leg, skipped'
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
                    entry['result'] = 'logged_only'
                    append_log(entry)
                    continue

                note_replicated_symbol(zerodha_symbol, replicated_symbols)
                placed, order_ids, err = place_child_order(kite, zerodha_symbol, side, child_qty, product=product)
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
            status = str(o.get('orderStatus', '') or '').upper()
            if status not in ('TRADED', 'PART_TRADED'):
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
                },
            })

    helper.start_order_update_websocket(on_update=handle_update)

    watchdog_stop = threading.Event()
    watchdog_thread = threading.Thread(
        target=watchdog_loop,
        args=(helper, kite, watchdog_stop, state, retry_queue, get_nifty_symbols, resolve_symbol, replicated_symbols),
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
                ws_alive = helper._ou_thread is not None and helper._ou_thread.is_alive()

                detail = ''
                if state['failed_count'] or pending_retries:
                    detail = f"{state['failed_count']} failed replication(s), {pending_retries} pending retry(ies)"
                write_status('RUNNING', started_at=started_at, detail=detail, extra={
                    'ws_thread_alive': ws_alive,
                    'last_poll_ts': state['last_poll_ts'],
                    'poll_count': state['poll_count'],
                    'failed_replications': state['failed_count'],
                    'pending_retries': pending_retries,
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
        write_status('STOPPED', started_at=started_at, detail=stop_detail)


if __name__ == '__main__':
    main()
