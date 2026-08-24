"""
Live WebSocket bridge for the Focus Tool terminal (straddles/strangles page).

Unlike scripts/tools/live_options_ws.py (one bridge process per broker, one
underlying at a time — built for AdvancedScalper's single-select dropdown),
the Focus Tool shows NIFTY, BANKNIFTY and SENSEX rows concurrently, so this
bridge subscribes to all three underlyings' option ladders in ONE WebSocket
connection (DhanHelper.start_websocket() already multiplexes an arbitrary
instrument list over a single socket) and pushes one combined payload keyed
by underlying.

This is deliberately standalone — it shares no files, ports, or process
lifecycle with live_options_ws.py, so nothing here can affect AdvancedScalper,
Scalper or Baskets. Like the Zerodha scalper bridge, it always sources market
data from Dhan regardless of which broker Focus Tool has selected for order
routing — an option's LTP is the exchange's, not the broker's, and Zerodha's
own quote API needs a separately-billed data pack this project doesn't use.

Usage:
    venv\\Scripts\\python.exe scripts/tools/focus_tool_ws.py \\
        --nifty-expiry 2026-06-27 --banknifty-expiry 2026-06-25 --sensex-expiry 2026-06-26

Stop gracefully by writing debug/focus_tool_ws_stop_dhan.trigger (done
automatically by the dashboard's /api/focus-tool/live-ws POST {action:"stop"}).
"""
import sys
import os
import json
import time
import asyncio
import argparse
import threading
from datetime import datetime, timezone

from websockets.asyncio.server import serve as ws_serve, broadcast as ws_broadcast

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from scripts.tools.premarket_data import _find_nearest_future

DEBUG_DIR    = os.path.join(ROOT, 'debug')
QUOTES_FILE  = os.path.join(DEBUG_DIR, 'focus_tool_ws_quotes_dhan.json')
STATUS_FILE  = os.path.join(DEBUG_DIR, 'focus_tool_ws_status_dhan.json')
STOP_TRIGGER = os.path.join(DEBUG_DIR, 'focus_tool_ws_stop_dhan.trigger')

# MarketFeed constants (mirrors live_options_ws.py)
NSE_FNO    = 2   # NSE F&O segment
BSE_FNO    = 8   # BSE F&O segment
IDX        = 0   # Index segment (shared across exchanges, differentiated by security ID)
FEED_QUOTE = 17  # Quote packet — LTP + OHLC + prev_close (required for Index)
FULL       = 21  # Full packet — includes OI (for F&O contracts)

UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']

UNDERLYING_SIDS = {'NIFTY': '13', 'BANKNIFTY': '25', 'SENSEX': '51'}
# Cash-market exchange each underlying's options trade on — SENSEX is BSE, the rest NSE.
UNDERLYING_EXCHANGE = {'NIFTY': 'NSE', 'BANKNIFTY': 'NSE', 'SENSEX': 'BSE'}
STRIKE_STEP = {'NIFTY': 50, 'BANKNIFTY': 100, 'SENSEX': 100}
OPTION_FEED_SEGMENT = {'NSE': NSE_FNO, 'BSE': BSE_FNO}


def _f(val, default: float = 0.0) -> float:
    if val is None:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def atomic_write(path: str, data: dict) -> bool:
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w') as f:
            json.dump(data, f)
        os.replace(tmp, path)
        return True
    except PermissionError:
        # File locked by a concurrent reader (the Next.js API route) — skip this
        # cycle. Caller must not advance its "last written" bookkeeping on
        # failure, or the dropped write goes stale until the next real change.
        return False
    except Exception as e:
        print(f'[focus_tool_ws] Warning: failed to write {path} ({e})', flush=True)
        return False


def write_status(status: str, expiries: dict | None = None, subscribed: int = 0,
                  started_at: str = '', ws_port=None):
    try:
        atomic_write(STATUS_FILE, {
            'status': status,
            'broker': 'dhan',
            'pid': os.getpid(),
            'expiries': expiries or {},
            'subscribed': subscribed,
            'ws_port': ws_port,
            'started_at': started_at or datetime.now().isoformat(),
            'last_update': datetime.now().isoformat(),
        })
    except Exception as e:
        print(f'[focus_tool_ws] Warning: failed to write status ({e})', flush=True)


class QuotePushServer:
    """Localhost WebSocket push server — identical shape to live_options_ws.py's
    class of the same name, copied rather than imported so this bridge has zero
    dependency on the AdvancedScalper-serving script. Runs in its own thread
    with its own asyncio loop; the main loop hands it pre-serialized JSON via
    broadcast(), which is thread-safe. Bound to 127.0.0.1 only."""

    def __init__(self, port: int):
        self.port = port
        self.clients: set = set()
        self.loop = None
        self.server = None
        self.thread = None
        self.bound = False
        self._latest_payload: str | None = None
        self._started = threading.Event()

    async def _handler(self, ws):
        self.clients.add(ws)
        try:
            if self._latest_payload:
                await ws.send(self._latest_payload)
            async for _ in ws:
                pass
        except Exception:
            pass
        finally:
            self.clients.discard(ws)

    def _run(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)

        async def _bind():
            self.server = await ws_serve(self._handler, '127.0.0.1', self.port)
            self.bound = True

        try:
            self.loop.run_until_complete(_bind())
        except OSError as e:
            print(f'[focus_tool_ws] WARN: WS push server failed to bind port {self.port}: {e} '
                  f'— continuing file-only', flush=True)
        finally:
            self._started.set()

        if self.bound:
            try:
                self.loop.run_forever()
            finally:
                try:
                    self.server.close()
                    self.loop.run_until_complete(self.server.wait_closed())
                except Exception:
                    pass
                self.loop.close()

    def start(self) -> bool:
        self.thread = threading.Thread(target=self._run, daemon=True, name='focus-tool-ws-push')
        self.thread.start()
        self._started.wait(timeout=5)
        return self.bound

    def _do_broadcast(self, payload: str):
        self._latest_payload = payload
        if self.clients:
            ws_broadcast(self.clients, payload)

    def broadcast(self, payload: str):
        if not self.bound or self.loop is None:
            self._latest_payload = payload
            return
        try:
            self.loop.call_soon_threadsafe(self._do_broadcast, payload)
        except RuntimeError:
            pass  # loop already closed during shutdown

    def stop(self):
        if self.bound and self.loop is not None:
            try:
                self.loop.call_soon_threadsafe(self.loop.stop)
            except RuntimeError:
                pass
        if self.thread is not None:
            self.thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description='Focus Tool live WebSocket bridge — all three indices at once')
    parser.add_argument('--nifty-expiry', required=True, help='NIFTY expiry YYYY-MM-DD')
    parser.add_argument('--banknifty-expiry', required=True, help='BANKNIFTY expiry YYYY-MM-DD')
    parser.add_argument('--sensex-expiry', required=True, help='SENSEX expiry YYYY-MM-DD')
    parser.add_argument('--num-strikes', type=int, default=12,
                        help='Number of strikes each side of ATM, per underlying (default 12)')
    parser.add_argument('--ws-port', type=int, default=8965,
                        help='Localhost WebSocket push server port (default 8965)')
    args = parser.parse_args()

    expiries = {'NIFTY': args.nifty_expiry, 'BANKNIFTY': args.banknifty_expiry, 'SENSEX': args.sensex_expiry}

    os.makedirs(DEBUG_DIR, exist_ok=True)
    started_at = datetime.now().isoformat()

    push_server = QuotePushServer(args.ws_port)
    ws_port = args.ws_port if push_server.start() else None
    if ws_port:
        print(f'[focus_tool_ws] WS push server listening on ws://127.0.0.1:{ws_port}', flush=True)

    write_status('STARTING', expiries=expiries, started_at=started_at, ws_port=ws_port)
    print(f'[focus_tool_ws] Starting — expiries={expiries}', flush=True)

    dhan = get_dhan_client()
    if not dhan:
        print('[focus_tool_ws] ERROR: authentication failed', flush=True)
        write_status('ERROR', expiries=expiries, started_at=started_at)
        sys.exit(1)

    helper = DhanHelper(dhan)

    # ── Resolve spot/ATM/strike ladder/contracts for all three underlyings ──
    state: dict[str, dict] = {}   # underlying -> {step, exchange, spot, atm, sid, sid_map, fut}
    instruments: list = []

    for u in UNDERLYINGS:
        step = STRIKE_STEP[u]
        exchange = UNDERLYING_EXCHANGE[u]
        sid = UNDERLYING_SIDS[u]
        expiry = expiries[u]

        print(f'[focus_tool_ws] {u}: fetching spot…', flush=True)
        spot = 0.0
        for attempt in range(5):
            spot = helper.get_ltp(sid, exchange='IDX_I', instrument='INDEX') or 0.0
            if spot > 0:
                break
            print(f'[focus_tool_ws] {u}: WARN spot fetch failed (attempt {attempt + 1}/5), retrying in 5s…', flush=True)
            time.sleep(5)
        atm = round(spot / step) * step if spot > 0 else 0
        print(f'[focus_tool_ws] {u}: spot={spot:.2f} atm={atm} step={step}', flush=True)

        strikes = [atm + i * step for i in range(-args.num_strikes, args.num_strikes + 1)] if atm > 0 else []
        sid_map: dict[str, dict] = {}   # sid -> {underlying, strike, type}
        option_feed_segment = OPTION_FEED_SEGMENT[exchange]

        for strike in strikes:
            for opt_type in ('CE', 'PE'):
                opt = helper.find_option(u, expiry, float(strike), opt_type, exchange=exchange)
                if opt is None:
                    continue
                osid = str(int(opt['SECURITY_ID']))
                sid_map[osid] = {'underlying': u, 'strike': int(strike), 'type': opt_type}
                instruments.append((option_feed_segment, osid, FULL))

        # Index spot canary — strictly FEED_QUOTE (17), not FULL (21)
        instruments.append((IDX, sid, FEED_QUOTE))

        # Near-month futures contract
        fut_info = None
        try:
            fut_contract = _find_nearest_future(helper, u, exchange=exchange, instrument='FUTIDX')
            if fut_contract:
                fut_sid = str(int(fut_contract['SECURITY_ID']))
                fut_sym = str(fut_contract.get('TRADING_SYMBOL') or fut_contract.get('DISPLAY_NAME') or f'{u} FUT').strip()
                fut_prev = _f(fut_contract.get('PREV_CLOSE') or fut_contract.get('PDC'))
                instruments.append((option_feed_segment, fut_sid, FULL))
                fut_info = {
                    'sid': fut_sid,
                    'symbol': fut_sym,
                    'prev_close': fut_prev,
                    'ltp': 0.0,
                    'change_pct': None,
                }
                print(f'[focus_tool_ws] {u}: resolved future SID={fut_sid} ({fut_sym})', flush=True)
        except Exception as e:
            print(f'[focus_tool_ws] {u}: WARNING could not resolve future contract: {e}', flush=True)

        state[u] = {'step': step, 'exchange': exchange, 'spot': spot, 'atm': atm, 'sid': sid,
                    'expiry': expiry, 'sid_map': sid_map, 'fut': fut_info}
        print(f'[focus_tool_ws] {u}: resolved {len(sid_map)} option contracts', flush=True)

    total_contracts = sum(len(s['sid_map']) for s in state.values())
    total_futs = sum(1 for s in state.values() if s.get('fut'))
    print(f'[focus_tool_ws] Subscribing to {total_contracts} option contracts + {total_futs} futures + 3 index canaries…', flush=True)

    if total_contracts == 0:
        print('[focus_tool_ws] ERROR: no contracts resolved for any underlying — aborting', flush=True)
        write_status('ERROR', expiries=expiries, started_at=started_at, ws_port=ws_port)
        sys.exit(1)

    dirty = threading.Event()
    helper.start_websocket(instruments, on_message=lambda inst, msg: dirty.set())
    time.sleep(3)  # wait for connection + first tick batch

    for u, s in state.items():
        idx_initial = helper.live_data.get(s['sid'])
        if idx_initial:
            initial_ltp = _f(idx_initial.get('LTP') or idx_initial.get('last_price'))
            print(f'[focus_tool_ws] {u}: index tick received — LTP={initial_ltp:.2f}', flush=True)
        else:
            print(f'[focus_tool_ws] {u}: WARNING no index tick after 3s; will use REST spot as fallback', flush=True)

    write_status('RUNNING', expiries=expiries, subscribed=total_contracts, started_at=started_at, ws_port=ws_port)
    print('[focus_tool_ws] WebSocket connected. Pushing on tick; file every 0.5s…', flush=True)

    last_print = 0.0
    last_quotes = None
    last_pushed = None
    last_file_write = 0.0

    try:
        while True:
            # Event-driven pacing: wake instantly on a market tick, or every
            # 250ms as a heartbeat for the stop-trigger check. After a wake,
            # sleep 20ms so a multi-packet burst (Full + OI + PrevClose) across
            # three underlyings coalesces into one snapshot build + push.
            if dirty.wait(timeout=0.25):
                dirty.clear()
                time.sleep(0.02)

            if os.path.exists(STOP_TRIGGER):
                try:
                    os.remove(STOP_TRIGGER)
                except OSError:
                    pass
                print('[focus_tool_ws] Stop trigger detected — exiting.', flush=True)
                break

            now_iso = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
            payload: dict = {'type': 'quotes', 'updated_at': now_iso}

            for u, s in state.items():
                idx_tick = helper.live_data.get(s['sid'])
                if idx_tick:
                    live_spot = _f(idx_tick.get('LTP') or idx_tick.get('last_price'))
                    if live_spot > 0:
                        s['spot'] = live_spot
                        s['atm'] = round(live_spot / s['step']) * s['step']

                # Futures quote
                fut_payload = None
                if s.get('fut'):
                    f_meta = s['fut']
                    f_tick = helper.live_data.get(f_meta['sid'])
                    if f_tick:
                        f_ltp = _f(f_tick.get('LTP') or f_tick.get('last_price'))
                        f_prev = _f(f_tick.get('prev_close') or f_tick.get('close') or f_tick.get('previous_close_price'))
                        if f_prev > 0:
                            f_meta['prev_close'] = f_prev
                        if f_ltp > 0:
                            f_meta['ltp'] = f_ltp
                    
                    cur_ltp = f_meta.get('ltp', 0.0)
                    cur_prev = f_meta.get('prev_close', 0.0)
                    chg_pct = round(((cur_ltp - cur_prev) / cur_prev) * 100, 2) if (cur_ltp > 0 and cur_prev > 0) else None
                    if cur_ltp > 0:
                        fut_payload = {
                            'ltp': round(cur_ltp, 2),
                            'change_pct': chg_pct,
                        }

                strikes_data: dict[str, dict] = {}
                for sid, meta in s['sid_map'].items():
                    sk_key = str(meta['strike'])
                    if sk_key not in strikes_data:
                        strikes_data[sk_key] = {'strike': meta['strike'], 'ce': {'ltp': 0}, 'pe': {'ltp': 0}}
                    tick = helper.live_data.get(sid)
                    if tick:
                        ltp = _f(tick.get('LTP') or tick.get('last_price'))
                        strikes_data[sk_key][meta['type'].lower()] = {'ltp': round(ltp, 2)}

                payload[u] = {
                    'spot': round(s['spot'], 2),
                    'atm': s['atm'],
                    'expiry': s['expiry'],
                    'fut': fut_payload,
                    'strikes': strikes_data,
                }

            now_ts = time.time()

            # WS push (hot path): push immediately whenever the combined snapshot
            # changed. Compare before stamping the volatile updated_at/pushed_at
            # fields so identical market data never re-pushes.
            comparable = {k: v for k, v in payload.items() if k != 'updated_at'}
            if comparable != last_pushed:
                push_payload = dict(payload)
                push_payload['pushed_at'] = now_ts
                push_server.broadcast(json.dumps(push_payload))
                last_pushed = comparable

            # Quotes file (fallback for the poll transport): relaxed 500ms cadence.
            if comparable != last_quotes and now_ts - last_file_write >= 0.5:
                if atomic_write(QUOTES_FILE, payload):
                    last_quotes = comparable
                    last_file_write = now_ts
                # else: write dropped (lock contention) — leave last_quotes so
                # this same state is retried next loop rather than going stale.

            if now_ts - last_print > 10:
                spots = ' | '.join(f'{u}={state[u]["spot"]:.2f}' for u in UNDERLYINGS)
                print(f'[focus_tool_ws] {spots} | Subscribed={total_contracts} | WS clients={len(push_server.clients)}',
                      flush=True)
                last_print = now_ts

    except KeyboardInterrupt:
        print('[focus_tool_ws] KeyboardInterrupt — shutting down.', flush=True)
    finally:
        push_server.stop()
        write_status('STOPPED', expiries=expiries, subscribed=0, started_at=started_at, ws_port=None)
        print('[focus_tool_ws] Stopped.', flush=True)


if __name__ == '__main__':
    main()
