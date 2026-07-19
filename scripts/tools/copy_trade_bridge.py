"""
Trade replication bridge: Dhan (parent) -> Zerodha (child accounts).

Listens to Dhan's real-time order-update WebSocket (via
DhanHelper.start_order_update_websocket) and, for every TRADED fill,
mirrors it to each enabled child account in debug/copy_trade_config.json
at quantity = filled_qty * multiplier, always as a MARKET order.

Two independent safety gates:
  - This process running at all: safe by itself, only listens + logs
    what it WOULD replicate to debug/copy_trade_log.json.
  - config.json's "armed" flag: only when true does a child order
    actually get placed.

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
import threading
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
# load_zerodha_instruments_cache() reads a relative-path-free constant set, but
# credDemo/.env.zerodha loading elsewhere in this codebase assumes CWD == ROOT
# when spawned from the dashboard (see live_options_ws_zerodha.py's same fix).
os.chdir(ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from scripts.tools.zerodha_instruments_cache import restore_session_from_json
from scripts.tools.live_options_ws_zerodha import load_zerodha_instruments_cache

DEBUG_DIR        = os.path.join(ROOT, 'debug')
CONFIG_FILE      = os.path.join(DEBUG_DIR, 'copy_trade_config.json')
STATUS_FILE      = os.path.join(DEBUG_DIR, 'copy_trade_status.json')
LOG_FILE         = os.path.join(DEBUG_DIR, 'copy_trade_log.json')
REPLICATED_FILE  = os.path.join(DEBUG_DIR, 'copy_trade_replicated.json')
STOP_TRIGGER     = os.path.join(DEBUG_DIR, 'copy_trade_stop.trigger')

MAX_LOG_ENTRIES  = 200
WATCHDOG_INTERVAL_SEC = 7

_log_lock = threading.Lock()
_replicated_lock = threading.Lock()


def atomic_write(path: str, data) -> bool:
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w') as f:
            json.dump(data, f)
        os.replace(tmp, path)
        return True
    except PermissionError:
        return False
    except Exception as e:
        print(f"[copy_trade_bridge] Warning: failed to write {path} ({e})", flush=True)
        return False


def write_status(status: str, started_at: str = '', detail: str = ''):
    atomic_write(STATUS_FILE, {
        'status': status,
        'pid': os.getpid(),
        'detail': detail,
        'started_at': started_at or datetime.now().isoformat(),
        'last_update': datetime.now().isoformat(),
    })


def read_json(path: str, default):
    try:
        if not os.path.exists(path):
            return default
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def load_config() -> dict:
    cfg = read_json(CONFIG_FILE, {'armed': False, 'children': []})
    if not isinstance(cfg, dict):
        return {'armed': False, 'children': []}
    cfg.setdefault('armed', False)
    cfg.setdefault('children', [])
    return cfg


def load_replicated() -> dict:
    data = read_json(REPLICATED_FILE, {})
    return data if isinstance(data, dict) else {}


def save_replicated(replicated: dict):
    with _replicated_lock:
        atomic_write(REPLICATED_FILE, replicated)


def append_log(entry: dict):
    with _log_lock:
        log = read_json(LOG_FILE, {'entries': []})
        entries = log.get('entries', []) if isinstance(log, dict) else []
        entries.append(entry)
        if len(entries) > MAX_LOG_ENTRIES:
            entries = entries[-MAX_LOG_ENTRIES:]
        atomic_write(LOG_FILE, {'entries': entries})


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


def watchdog_loop(helper, kite, stop_event: threading.Event):
    """
    Independent safety net, separate from per-fill replication: every
    WATCHDOG_INTERVAL_SEC, if armed, checks whether the parent (Dhan) is
    flat while the child (Zerodha) still has open positions — regardless of
    *why* the parent went flat (P&L Guard, EXIT ALL, a strategy's own exit,
    or a missed order-update event) — and force-closes the child if so.

    Deliberately conservative: if the Dhan positions call fails (as opposed
    to genuinely returning zero positions), helper.last_api_error will be
    set and this cycle is skipped rather than treated as "flat", to avoid
    force-closing legitimate Zerodha positions on a transient API hiccup.
    """
    while not stop_event.wait(WATCHDOG_INTERVAL_SEC):
        try:
            cfg = load_config()
            if not cfg.get('armed'):
                continue
            children = [c for c in cfg.get('children', []) if c.get('enabled')]
            if not children:
                continue

            df = helper.get_positions()
            if helper.last_api_error is not None:
                continue  # unknown state, not "flat" — skip this cycle

            dhan_open = 0
            if df is not None and not df.empty and 'netQty' in df.columns:
                dhan_open = int((df['netQty'].astype(float) != 0).sum())
            if dhan_open > 0:
                continue  # parent still has positions, nothing to do

            positions = kite.positions()
            open_positions = [p for p in positions.get('net', []) if int(p.get('quantity', 0) or 0) != 0]
            if not open_positions:
                continue  # child already flat too

            ts = datetime.now().isoformat()
            closed = 0
            for pos in open_positions:
                qty = abs(int(pos.get('quantity', 0)))
                side = 'SELL' if int(pos.get('quantity', 0)) > 0 else 'BUY'
                symbol = pos.get('tradingsymbol', '')
                entry = {
                    'ts': ts, 'order_no': f'watchdog-{symbol}', 'parent_symbol': '(parent flat)',
                    'zerodha_symbol': symbol, 'side': side, 'child_qty': qty,
                    'broker': 'zerodha', 'armed': True,
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

            if closed:
                print(f'[copy_trade_bridge] Safety watchdog: parent flat, force-closed {closed} '
                      f'Zerodha position(s).', flush=True)

        except Exception as e:
            print(f'[copy_trade_bridge] ERROR in watchdog_loop: {e}', flush=True)


def main():
    started_at = datetime.now().isoformat()
    os.makedirs(DEBUG_DIR, exist_ok=True)
    write_status('STARTING', started_at=started_at)
    print('[copy_trade_bridge] Starting…', flush=True)

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

    replicated_qty = load_replicated()

    def handle_update(payload: dict):
        try:
            data = payload.get('Data', {})
            status = str(data.get('Status', '')).upper()
            if status != 'TRADED':
                return

            order_no = str(data.get('OrderNo', ''))
            if not order_no:
                return

            traded_qty = int(data.get('TradedQty', 0) or 0)
            already = int(replicated_qty.get(order_no, 0))
            delta = traded_qty - already
            if delta <= 0:
                return

            symbol = data.get('Symbol', order_no)
            txn_type = str(data.get('TxnType', '')).upper()
            side = 'BUY' if txn_type == 'B' else 'SELL' if txn_type == 'S' else None
            strike = data.get('StrikePrice')
            expiry = data.get('ExpiryDate')
            opt_type = data.get('OptType')

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

            zerodha_symbol = None
            if strike is not None and expiry and opt_type:
                zerodha_symbol = find_zerodha_symbol(instruments, strike, expiry, opt_type)

            if zerodha_symbol is None:
                append_log({'ts': ts, 'order_no': order_no, 'symbol': symbol, 'side': side,
                            'qty': delta, 'result': 'skipped',
                            'error': 'Unsupported instrument (not a cached NIFTY option) — skipped'})
                replicated_qty[order_no] = traded_qty
                save_replicated(replicated_qty)
                return

            for child in children:
                broker = child.get('broker', 'zerodha')
                multiplier = int(child.get('multiplier', 1) or 1)
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

                try:
                    order_id = kite.place_order(
                        variety=kite.VARIETY_REGULAR,
                        exchange=kite.EXCHANGE_NFO,
                        tradingsymbol=zerodha_symbol,
                        transaction_type=kite.TRANSACTION_TYPE_BUY if side == 'BUY' else kite.TRANSACTION_TYPE_SELL,
                        quantity=child_qty,
                        product=kite.PRODUCT_MIS,
                        order_type=kite.ORDER_TYPE_MARKET,
                        validity=kite.VALIDITY_DAY,
                    )
                    entry['result'] = 'success'
                    entry['child_order_id'] = order_id
                    print(f'[copy_trade_bridge] Replicated {order_no} -> {broker} order {order_id} '
                          f'({side} {child_qty} {zerodha_symbol})', flush=True)
                except Exception as e:
                    entry['result'] = 'error'
                    entry['error'] = str(e)
                    print(f'[copy_trade_bridge] ERROR replicating {order_no} to {broker}: {e}', flush=True)

                append_log(entry)

            replicated_qty[order_no] = traded_qty
            save_replicated(replicated_qty)

        except Exception as e:
            print(f'[copy_trade_bridge] ERROR in handle_update: {e}', flush=True)

    helper.start_order_update_websocket(on_update=handle_update)

    watchdog_stop = threading.Event()
    watchdog_thread = threading.Thread(
        target=watchdog_loop, args=(helper, kite, watchdog_stop),
        daemon=True, name='copy-trade-watchdog',
    )
    watchdog_thread.start()

    write_status('RUNNING', started_at=started_at)
    print('[copy_trade_bridge] Listening for Dhan order updates…', flush=True)

    try:
        while True:
            if os.path.exists(STOP_TRIGGER):
                try:
                    os.remove(STOP_TRIGGER)
                except OSError:
                    pass
                print('[copy_trade_bridge] Stop trigger detected — exiting.', flush=True)
                break
            time.sleep(1)
    except KeyboardInterrupt:
        print('[copy_trade_bridge] KeyboardInterrupt — shutting down.', flush=True)
    finally:
        watchdog_stop.set()
        try:
            helper.stop_order_update_websocket()
        except Exception:
            pass
        write_status('STOPPED', started_at=started_at)


if __name__ == '__main__':
    main()
