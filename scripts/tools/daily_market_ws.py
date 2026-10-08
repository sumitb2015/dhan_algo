"""
Daily Market WebSocket bridge for RS Dashboard.

Subscribes to all Nifty 500 equity stocks via the shared market_data_hub.py
and runs a local WebSocket push server for the Bloomberg-style Daily Market terminal.

Features:
- On startup: checks database (Daily_Historical_Data_Fresh/*_Daily_2Y.csv) and caches
  the previous day's close, 52W High, and 52W Low for all Nifty 500 stocks.
- Previous close: Dhan's own tick prev_close/close when it is genuine (not the
  post-15:30 flip where close == LTP), cached per day; else the CSV close.
  change = ltp - prev_close
  change_pct = (change / prev_close) * 100
- 52W high/low start from the CSV and are widened by live day high/low.
- Serves live real-time frames over local WebSocket (ws://127.0.0.1:<port>) and writes
  debug/daily_market_quotes.json & debug/daily_market_status.json for HTTP seeding.
- Graceful stop via debug/daily_market_stop.trigger.
"""
import sys
import os
import json
import time
import glob
import asyncio
import argparse
import threading
import signal
from http import HTTPStatus
from urllib.parse import urlparse
from datetime import datetime
from zoneinfo import ZoneInfo
from typing import Dict, Any, List, Optional, Tuple

from websockets.asyncio.server import serve as ws_serve, broadcast as ws_broadcast

IST = ZoneInfo('Asia/Kolkata')

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib import market_hub_client as hub_client

DEBUG_DIR     = os.path.join(ROOT, 'debug')
QUOTES_FILE   = os.path.join(DEBUG_DIR, 'daily_market_quotes.json')
STATUS_FILE   = os.path.join(DEBUG_DIR, 'daily_market_status.json')
BASELINE_FILE = os.path.join(DEBUG_DIR, 'daily_market_baseline.json')
STOP_TRIGGER  = os.path.join(DEBUG_DIR, 'daily_market_stop.trigger')
NIFTY500_CSV  = os.path.join(ROOT, 'ind_nifty500list.csv')
SMALLCAP250_CSV = os.path.join(ROOT, 'index_constituents', 'niftysmallcap250.csv')
DATA_DIR      = os.path.join(ROOT, 'Daily_Historical_Data_Fresh')

NSE_EQ     = 1   # NSE cash / equity segment
FEED_QUOTE = 17  # Quote packet: LTP + OHLC + volume


def atomic_write(path: str, data: dict) -> bool:
    tmp = path + '.tmp'
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, 'w') as f:
            json.dump(data, f)
        os.replace(tmp, path)
        return True
    except Exception as e:
        print(f'[daily_market_ws] atomic_write error for {path}: {e}', flush=True)
        return False


class QuotePushServer:
    """Localhost WebSocket push server for pushing quote updates directly to browser clients."""

    def __init__(self, port: int):
        self.port = port
        self.clients: set = set()
        self.loop = None
        self.server = None
        self.thread = None
        self.bound = False
        self._latest_payload: Optional[str] = None
        self._started = threading.Event()

    @staticmethod
    def _check_origin(connection, request):
        """Browsers always send Origin; refuse any page that isn't served from localhost
        so an arbitrary website open in the same browser can't read the feed."""
        origin = request.headers.get('Origin')
        if origin:
            host = (urlparse(origin).hostname or '').lower()
            if host not in ('localhost', '127.0.0.1', '::1'):
                return connection.respond(HTTPStatus.FORBIDDEN, 'Forbidden origin\n')
        return None

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
            self.server = await ws_serve(self._handler, '127.0.0.1', self.port, process_request=self._check_origin)
            self.bound = True

        try:
            self.loop.run_until_complete(_bind())
        except OSError as e:
            print(f'[daily_market_ws] WARN: WS push server failed to bind port {self.port}: {e}', flush=True)
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
        self.thread = threading.Thread(target=self._run, daemon=True, name='daily-market-ws-push')
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
            pass

    def stop(self):
        if self.bound and self.loop is not None:
            try:
                self.loop.call_soon_threadsafe(self.loop.stop)
            except RuntimeError:
                pass
        if self.thread is not None:
            self.thread.join(timeout=2)


def load_nifty500_meta() -> List[Dict[str, str]]:
    """Nifty 500 plus any Smallcap 250 names the (older) Nifty 500 list lacks."""
    items = _load_constituent_meta(NIFTY500_CSV)
    seen = {i['symbol'] for i in items}
    for it in _load_constituent_meta(SMALLCAP250_CSV):
        if it['symbol'] not in seen:
            seen.add(it['symbol'])
            items.append(it)
    return items


def _load_constituent_meta(path: str) -> List[Dict[str, str]]:
    """Loads symbol, company name, industry from an NSE constituent CSV."""
    items = []
    if not os.path.exists(path):
        print(f'[daily_market_ws] ERROR: {path} not found', flush=True)
        return items

    with open(path, 'r', encoding='utf-8', errors='ignore') as f:
        lines = [l.strip() for l in f if l.strip()]

    if len(lines) < 2:
        return items

    headers = [h.strip().upper() for h in lines[0].split(',')]
    try:
        sym_idx = headers.index('SYMBOL')
    except ValueError:
        sym_idx = 2
    try:
        comp_idx = headers.index('COMPANY NAME')
    except ValueError:
        comp_idx = 0
    try:
        ind_idx = headers.index('INDUSTRY')
    except ValueError:
        ind_idx = 1

    for line in lines[1:]:
        parts = [p.strip() for p in line.split(',')]
        if len(parts) > sym_idx:
            sym = parts[sym_idx]
            if sym.startswith('DUMMY') or not sym:
                continue
            comp = parts[comp_idx] if len(parts) > comp_idx else sym
            ind = parts[ind_idx] if len(parts) > ind_idx else 'General'
            items.append({
                'symbol': sym,
                'company': comp,
                'industry': ind,
            })
    return items


def build_database_baseline(symbols_meta: List[Dict[str, str]]) -> Dict[str, Dict[str, Any]]:
    """
    Scans Daily_Historical_Data_Fresh to cache:
    - prev_close: close of the last completed session strictly before today IST
    - high_52w, low_52w: max/min over past 250 bars
    - initial OHLCV if today's bar already exists in CSV
    """
    today_ist = datetime.now(IST).strftime('%Y-%m-%d')
    baseline: Dict[str, Dict[str, Any]] = {}
    found_count = 0

    print(f'[daily_market_ws] Checking database for previous day close (Today IST: {today_ist})...', flush=True)

    for item in symbols_meta:
        sym = item['symbol']
        csv_path = os.path.join(DATA_DIR, f'{sym}_Daily_2Y.csv')

        prev_close = 0.0
        high_52w = 0.0
        low_52w = 0.0
        seed_open = 0.0
        seed_high = 0.0
        seed_low = 0.0
        seed_close = 0.0
        seed_volume = 0
        last_date = ''

        if os.path.exists(csv_path):
            try:
                with open(csv_path, 'r', encoding='utf-8', errors='ignore') as f:
                    lines = [l.strip() for l in f if l.strip()]

                if len(lines) >= 2:
                    # Skip header
                    data_rows = lines[1:]
                    # Check recent 250 bars for 52W High / Low
                    bars_52w = data_rows[-250:]
                    highs = []
                    lows = []
                    for b in bars_52w:
                        cols = b.split(',')
                        if len(cols) >= 5:
                            try:
                                highs.append(float(cols[2]))
                                lows.append(float(cols[3]))
                            except ValueError:
                                pass
                    if highs:
                        high_52w = max(highs)
                    if lows:
                        low_52w = min(lows)

                    # Determine previous day's close
                    # Look from the end backwards for the first row with date < today_ist
                    for row_str in reversed(data_rows):
                        cols = row_str.split(',')
                        if len(cols) >= 5:
                            row_date = cols[0].strip()
                            if not last_date:
                                last_date = row_date
                                # If today's row already exists, save as seed
                                if row_date == today_ist:
                                    try:
                                        seed_open = float(cols[1])
                                        seed_high = float(cols[2])
                                        seed_low = float(cols[3])
                                        seed_close = float(cols[4])
                                        seed_volume = int(float(cols[5])) if len(cols) > 5 else 0
                                    except (ValueError, TypeError):
                                        pass
                            if row_date < today_ist:
                                try:
                                    prev_close = float(cols[4])
                                    found_count += 1
                                    break
                                except (ValueError, TypeError):
                                    pass
            except Exception as e:
                print(f'[daily_market_ws] Warning reading {csv_path}: {e}', flush=True)

        baseline[sym] = {
            'symbol': sym,
            'company': item['company'],
            'industry': item['industry'],
            'prev_close': round(prev_close, 2),
            'high_52w': round(high_52w, 2),
            'low_52w': round(low_52w, 2),
            'seed_open': round(seed_open, 2),
            'seed_high': round(seed_high, 2),
            'seed_low': round(seed_low, 2),
            'seed_close': round(seed_close, 2),
            'seed_volume': seed_volume,
            'last_date': last_date,
        }

    print(f'[daily_market_ws] Baseline cache ready: {found_count}/{len(symbols_meta)} stocks cached with yesterday close.', flush=True)
    atomic_write(BASELINE_FILE, {
        'cached_at': datetime.now(IST).isoformat(),
        'today_ist': today_ist,
        'stocks_count': len(baseline),
        'baseline': baseline,
    })
    return baseline


def write_status(status: str, ws_port: Optional[int] = None, subscribed: int = 0, started_at: str = ''):
    atomic_write(STATUS_FILE, {
        'status': status,
        'pid': os.getpid(),
        'ws_port': ws_port,
        'subscribed': subscribed,
        'started_at': started_at or datetime.now().isoformat(),
        'last_update': datetime.now().isoformat(),
    })


def main():
    parser = argparse.ArgumentParser(description='Daily Market WebSocket bridge')
    parser.add_argument('--ws-port', type=int, default=8975, help='Localhost WebSocket push port (default: 8975)')
    args = parser.parse_args()

    os.makedirs(DEBUG_DIR, exist_ok=True)

    # Single-instance guard: the dashboard route dedups too, but a manual run must not
    # start a second bridge next to a live one. The route writes STARTING with the child's
    # own pid, so our own pid is never a conflict.
    try:
        with open(STATUS_FILE, 'r') as f:
            prev = json.load(f)
        prev_pid = prev.get('pid')
        if (prev.get('status') in ('RUNNING', 'STARTING') and prev_pid
                and int(prev_pid) != os.getpid() and hub_client.is_pid_running(int(prev_pid))):
            print(f'[daily_market_ws] Already running (pid {prev_pid}) — exiting.', flush=True)
            sys.exit(0)
    except (OSError, ValueError, TypeError):
        pass

    # Treat SIGTERM like Ctrl-C so the finally block unregisters from the hub.
    try:
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    except (ValueError, OSError):
        pass

    started_at = datetime.now().isoformat()
    write_status('STARTING', ws_port=args.ws_port, started_at=started_at)
    print(f'[daily_market_ws] Starting Daily Market Bridge on port {args.ws_port}...', flush=True)

    # 1. Load Nifty 500 Metadata
    symbols_meta = load_nifty500_meta()
    if not symbols_meta:
        print('[daily_market_ws] ERROR: No symbols loaded from ind_nifty500list.csv', flush=True)
        write_status('ERROR', ws_port=args.ws_port, started_at=started_at)
        sys.exit(1)

    # 2. Check Database & Build Baseline Cache for previous day close
    baseline = build_database_baseline(symbols_meta)

    # 3. Resolve Security IDs using DhanHelper
    dhan = get_dhan_client()
    if not dhan:
        print('[daily_market_ws] ERROR: Dhan authentication failed', flush=True)
        write_status('ERROR', ws_port=args.ws_port, started_at=started_at)
        sys.exit(1)

    helper = DhanHelper(dhan)
    sid_to_sym: Dict[str, str] = {}
    instruments: List[Tuple[int, str, int]] = []

    print(f'[daily_market_ws] Resolving security IDs for {len(symbols_meta)} stocks...', flush=True)
    for item in symbols_meta:
        sym = item['symbol']
        try:
            sec = helper.find_equity(sym)
            if sec is not None:
                sid = str(int(sec['SECURITY_ID']))
                sid_to_sym[sid] = sym
                instruments.append((NSE_EQ, sid, FEED_QUOTE))
        except Exception:
            pass

    n_subscribed = len(instruments)
    print(f'[daily_market_ws] Resolved {n_subscribed} instruments. Registering with market data hub...', flush=True)

    # 4. Register with Market Data Hub
    hub_client.ensure_hub_running()
    hub_client.register_wanted('daily_market', instruments)

    # 5. Start WebSocket Push Server
    push_server = QuotePushServer(args.ws_port)
    ws_ready = push_server.start()
    if ws_ready:
        print(f'[daily_market_ws] WebSocket push server listening on ws://127.0.0.1:{args.ws_port}', flush=True)
    else:
        print(f'[daily_market_ws] Warning: WS server did not bind — running file snapshot mode', flush=True)

    write_status('RUNNING', ws_port=args.ws_port, subscribed=n_subscribed, started_at=started_at)

    last_hub_check = time.monotonic()
    last_broadcast_quotes: Dict[str, Any] = {}
    last_file_write = 0.0
    prev_close_cache: Dict[str, float] = {}
    cache_day = ''

    print('[daily_market_ws] Bridge active. Streaming quotes...', flush=True)

    try:
        while True:
            # Check stop trigger
            if os.path.exists(STOP_TRIGGER):
                try:
                    os.remove(STOP_TRIGGER)
                except OSError:
                    pass
                print('[daily_market_ws] Stop trigger received — shutting down.', flush=True)
                hub_client.unregister_wanted('daily_market')
                break

            now_monotonic = time.monotonic()
            if now_monotonic - last_hub_check >= 5.0:
                last_hub_check = now_monotonic
                hub_client.register_wanted('daily_market', instruments)
                hub_updated = hub_client.live_data_updated_at()
                if hub_updated is None or time.time() - hub_updated > 8.0:
                    hub_client.ensure_hub_running()

            live_ticks = hub_client.read_live_data()
            today_key = datetime.now(IST).strftime('%Y-%m-%d')
            if today_key != cache_day:
                prev_close_cache.clear()
                cache_day = today_key
            current_quotes: Dict[str, Dict[str, Any]] = {}

            for sid, sym in sid_to_sym.items():
                base = baseline.get(sym, {})
                prev_close = base.get('prev_close', 0.0)
                high_52w = base.get('high_52w', 0.0)
                low_52w = base.get('low_52w', 0.0)
                company = base.get('company', sym)
                industry = base.get('industry', 'General')

                tick = live_ticks.get(hub_client.tick_key(NSE_EQ, sid))
                # A tick with no LTP (e.g. an OI/prev-close-only packet) must not blank the row —
                # fall through to the baseline seed instead.
                if tick and float(tick.get('LTP') or tick.get('last_price') or 0.0) <= 0.0:
                    tick = None
                if tick:
                    ltp = float(tick.get('LTP') or tick.get('last_price') or 0.0)
                    open_ = float(tick.get('open') or 0.0)
                    high = float(tick.get('high') or 0.0)
                    low = float(tick.get('low') or 0.0)
                    volume = int(tick.get('volume') or 0)
                    vwap = float(tick.get('avg_price') or 0.0)

                    # Prefer Dhan's own previous close over the CSV (the CSV can lag a day).
                    # A raw close equal to LTP is Dhan's post-15:30 flip, not a real close —
                    # ignore it, and keep the first genuine value for the rest of the day.
                    cached = prev_close_cache.get(sym)
                    if cached is None:
                        raw_close = float(tick.get('prev_close') or tick.get('close') or 0.0)
                        if raw_close > 0.0 and raw_close != ltp:
                            prev_close_cache[sym] = cached = raw_close
                    if cached:
                        prev_close = cached

                    if prev_close > 0.0:
                        change = round(ltp - prev_close, 2)
                        change_pct = round((change / prev_close) * 100.0, 4)
                    else:
                        change = 0.0
                        change_pct = 0.0

                    if high == 0.0 and ltp > 0.0:
                        high = ltp
                    if low == 0.0 and ltp > 0.0:
                        low = ltp
                    if open_ == 0.0 and ltp > 0.0:
                        open_ = ltp
                    if vwap == 0.0 and ltp > 0.0:
                        vwap = ltp
                else:
                    # Seed fallback from database baseline
                    ltp = base.get('seed_close', 0.0) or prev_close
                    open_ = base.get('seed_open', 0.0) or ltp
                    high = base.get('seed_high', 0.0) or ltp
                    low = base.get('seed_low', 0.0) or ltp
                    volume = base.get('seed_volume', 0)
                    vwap = ltp
                    change = round(ltp - prev_close, 2) if prev_close > 0.0 else 0.0
                    change_pct = round((change / prev_close) * 100.0, 4) if prev_close > 0.0 else 0.0

                # Widen the CSV-based 52W range with today's live extremes.
                if high > 0.0:
                    high_52w = max(high_52w, high)
                if low > 0.0:
                    low_52w = min(low_52w, low) if low_52w > 0.0 else low

                turnover_cr = round((volume * (vwap or ltp)) / 10_000_000.0, 2) if volume > 0 else 0.0

                current_quotes[sym] = {
                    'symbol': sym,
                    'company': company,
                    'industry': industry,
                    'ltp': round(ltp, 2),
                    'change': round(change, 2),
                    'change_pct': round(change_pct, 2),
                    'prev_close': round(prev_close, 2),
                    'open': round(open_, 2),
                    'high': round(high, 2),
                    'low': round(low, 2),
                    'vwap': round(vwap, 2),
                    'volume': volume,
                    'turnover_cr': turnover_cr,
                    'high_52w': round(high_52w, 2),
                    'low_52w': round(low_52w, 2),
                }

            # Broadcast over WebSocket push server if changed
            now_ts = time.time()
            if current_quotes != last_broadcast_quotes:
                payload = {
                    'type': 'quotes',
                    'updated_at': datetime.now(IST).isoformat(),
                    'count': len(current_quotes),
                    'quotes': current_quotes,
                    'ws_clients': len(push_server.clients),
                }
                push_server.broadcast(json.dumps(payload))
                last_broadcast_quotes = current_quotes

            # Atomic write to debug file every 1 second
            if now_ts - last_file_write >= 1.0:
                payload_file = {
                    'updated_at': datetime.now(IST).isoformat(),
                    'count': len(current_quotes),
                    'quotes': current_quotes,
                }
                atomic_write(QUOTES_FILE, payload_file)
                write_status('RUNNING', ws_port=args.ws_port, subscribed=n_subscribed, started_at=started_at)
                last_file_write = now_ts

            time.sleep(0.25)

    except KeyboardInterrupt:
        print('[daily_market_ws] KeyboardInterrupt — shutting down.', flush=True)
        hub_client.unregister_wanted('daily_market')
    finally:
        push_server.stop()
        write_status('STOPPED', ws_port=args.ws_port, subscribed=0, started_at=started_at)
        print('[daily_market_ws] Bridge stopped.', flush=True)


if __name__ == '__main__':
    main()
