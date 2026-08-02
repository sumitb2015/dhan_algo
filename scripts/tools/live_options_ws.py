"""
Live options WebSocket bridge for the RS dashboard options page.

Subscribes to NSE FNO option contracts via Dhan WebSocket and writes
debug/live_options_quotes_dhan.json + debug/live_options_history_dhan.json
for the Next.js dashboard to poll. Runs concurrently and independently of the
Zerodha bridge (live_options_ws_zerodha.py) — broker-namespaced file paths so
neither bridge ever needs to stop the other.

Usage:
    venv\\Scripts\\python.exe scripts/tools/live_options_ws.py --underlying NIFTY --expiry 2026-06-27

Stop gracefully by writing debug/live_options_stop_dhan.trigger (done
automatically by the dashboard's /api/options/live POST {action:"stop"} endpoint).
"""
import sys
import os
import json
import time
import queue
import asyncio
import argparse
import threading
import urllib.request
from datetime import datetime, date, timezone

from websockets.asyncio.server import serve as ws_serve, broadcast as ws_broadcast

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from dhanhq.marketfeed import MarketFeed

DEBUG_DIR    = os.path.join(ROOT, 'debug')
QUOTES_FILE  = os.path.join(DEBUG_DIR, 'live_options_quotes_dhan.json')
HISTORY_FILE = os.path.join(DEBUG_DIR, 'live_options_history_dhan.json')
STATUS_FILE  = os.path.join(DEBUG_DIR, 'live_options_status_dhan.json')
STOP_TRIGGER = os.path.join(DEBUG_DIR, 'live_options_stop_dhan.trigger')

MAX_HISTORY  = 300   # ~10 min at 2s ticks

# MarketFeed constants
NSE_FNO     = 2   # NSE F&O segment
BSE_FNO     = 8   # BSE F&O segment
IDX         = 0   # Index segment (shared across exchanges, differentiated by security ID)
FULL        = 21  # Full packet — includes OI
FEED_QUOTE  = 17  # Quote packet — LTP + OHLC + volume (includes prev_close)

# Security IDs
NIFTY_IDX_SID = '13'   # NIFTY 50 index (spot canary)
VIX_SID       = '21'   # India VIX index

UNDERLYING_SIDS = {
    'NIFTY':     '13',
    'BANKNIFTY': '25',
    'FINNIFTY':  '27',
    'SENSEX':    '51',
}

# Cash-market exchange each underlying's options trade on — everything here
# is NSE except SENSEX, which is a BSE index.
UNDERLYING_EXCHANGE = {
    'NIFTY':     'NSE',
    'BANKNIFTY': 'NSE',
    'FINNIFTY':  'NSE',
    'SENSEX':    'BSE',
}

# WS market-feed option-segment code per underlying's exchange
OPTION_FEED_SEGMENT = {
    'NSE': NSE_FNO,
    'BSE': BSE_FNO,
}

OHLC_URL = 'https://api.dhan.co/v2/marketfeed/ohlc'


def _fetch_prev_closes(dhan, underlying_sid: str, underlying_exchange: str = 'NSE') -> dict:
    """Fetch previous-session closes for both VIX (always NSE) and the underlying
    index — the underlying may be on NSE_IDX or BSE_IDX depending on exchange."""
    closes = {underlying_sid: 0.0, VIX_SID: 0.0}
    underlying_seg = 'NSE_IDX' if underlying_exchange == 'NSE' else 'BSE_IDX'
    try:
        token     = dhan.dhan_http.access_token
        client_id = dhan.dhan_http.client_id
        body_map = {'NSE_IDX': [int(VIX_SID)]}
        body_map.setdefault(underlying_seg, []).append(int(underlying_sid))
        body = json.dumps(body_map).encode()
        req  = urllib.request.Request(
            OHLC_URL, data=body, method='POST',
            headers={
                'access-token':  token,
                'client-id':     client_id,
                'Content-Type':  'application/json',
                'Accept':        'application/json',
            },
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            res = json.loads(resp.read())
        if res.get('status') == 'success':
            data = res.get('data', {}) or {}
            for sid, seg in ((underlying_sid, underlying_seg), (VIX_SID, 'NSE_IDX')):
                entry = (data.get(seg, {}) or {}).get(sid, {}) or {}
                ohlc  = entry.get('ohlc') or {}
                val   = float(ohlc.get('close') or 0)
                if val > 0:
                    closes[sid] = round(val, 2)
    except Exception as e:
        print(f'[live_options_ws] WARN: prev_closes fetch failed: {e}', flush=True)
    return closes

def _fetch_prev_meta(helper, underlying: str, expiry: str, exchange_segment: str = 'IDX_I', attempts: int = 5, delay: float = 5.0) -> dict:
    """Fetch previous-day OI and previous-day Close per strike/side from option chain (at startup).

    Retries on transient failures (429s, empty chain) since a single missed
    fetch would otherwise disable buildup labels for the whole session.
    Returns {strike_int: {'ce_oi': int, 'pe_oi': int, 'ce_close': float, 'pe_close': float}}.

    Only genuine previous-day fields are accepted. Falling back to the CURRENT
    'oi'/'close'/'last_price' would fabricate a baseline: OI change would read ~0%
    all session and change% would be measured from startup rather than yesterday's
    close, both indistinguishable from real values on screen. Dhan additionally
    flips 'close' to the LTP after the 15:30 bell, so it is not a safe stand-in.
    A missing baseline is left at 0 and the dependent label is suppressed.
    """
    for attempt in range(attempts):
        prev_meta: dict = {}
        try:
            chain = helper.get_option_chain(underlying, expiry, exchange_segment=exchange_segment)
            for strike_str, data in ((chain or {}).get('oc') or {}).items():
                strike = int(float(strike_str))
                ce_data = data.get('ce') or {}
                pe_data = data.get('pe') or {}
                prev_meta[strike] = {
                    'ce_oi':    int(_f(ce_data.get('previous_oi'))),
                    'pe_oi':    int(_f(pe_data.get('previous_oi'))),
                    'ce_close': _f(ce_data.get('previous_close')),
                    'pe_close': _f(pe_data.get('previous_close')),
                }
        except Exception as e:
            print(f'[live_options_ws] WARN: prev_meta fetch failed (attempt {attempt + 1}/{attempts}): {e}', flush=True)
            prev_meta = {}

        if prev_meta:
            return prev_meta
        if attempt < attempts - 1:
            print(f'[live_options_ws] WARN: prev_meta fetch returned no strikes (attempt {attempt + 1}/{attempts}), retrying in {delay:.0f}s…', flush=True)
            time.sleep(delay)
    return {}


# Buildup dead-bands. The price band is deliberately near-zero so any directional
# move classifies; OI carries the dead-band instead. This bridge is the SINGLE source
# of buildup labels — do not re-derive them in the dashboard, or the two thresholds
# drift and the same strike gets different labels in different panels.
BUILDUP_MIN_PRICE_PCT = 0.01
BUILDUP_MIN_OI_PCT    = 0.5


def _classify_buildup(change_pct: float, oi_chg_pct: float) -> str:
    """4-way OI buildup label: LB/SB (OI up), SC/LU (OI down); '' inside dead-band."""
    if abs(change_pct) < BUILDUP_MIN_PRICE_PCT or abs(oi_chg_pct) < BUILDUP_MIN_OI_PCT:
        return ''
    if oi_chg_pct > 0:
        return 'LB' if change_pct > 0 else 'SB'
    return 'SC' if change_pct > 0 else 'LU'


# Strike step per underlying
STRIKE_STEP = {'NIFTY': 50, 'BANKNIFTY': 100, 'FINNIFTY': 50, 'SENSEX': 100}


def _f(val, default: float = 0.0) -> float:
    if val is None:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def atomic_write_text(path: str, text: str) -> bool:
    """Atomic write of pre-serialized JSON text (see atomic_write for semantics)."""
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w') as f:
            f.write(text)
        os.replace(tmp, path)
        return True
    except PermissionError:
        return False
    except Exception as e:
        print(f"[live_options_ws] Warning: failed to write {path} ({e})", flush=True)
        return False


def atomic_write(path: str, data: dict) -> bool:
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w') as f:
            json.dump(data, f)
        os.replace(tmp, path)
        return True
    except PermissionError:
        # File is locked by a concurrent reader (e.g. the Next.js API route) — skip
        # this cycle. Caller must NOT advance its "last written" bookkeeping on
        # failure, or the dropped write is never retried and the file goes stale.
        return False
    except Exception as e:
        print(f"[live_options_ws] Warning: failed to write {path} ({e})", flush=True)
        return False


def write_status(status: str, underlying: str = '', expiry: str = '',
                 subscribed: int = 0, started_at: str = '', ws_port=None):
    try:
        atomic_write(STATUS_FILE, {
            'status': status,
            'broker': 'dhan',
            'pid': os.getpid(),
            'underlying': underlying,
            'expiry': expiry,
            'subscribed': subscribed,
            'ws_port': ws_port,
            'started_at': started_at or datetime.now().isoformat(),
            'last_update': datetime.now().isoformat(),
        })
    except Exception as e:
        print(f"[live_options_ws] Warning: failed to write status ({e})", flush=True)


class QuotePushServer:
    """Localhost WebSocket push server. Runs in its own thread with its own
    asyncio loop; the bridge main loop hands it pre-serialized JSON payloads
    via broadcast(), which is thread-safe. Bound to 127.0.0.1 only."""

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
            # Greet new connections with the latest snapshot so a fresh tab
            # paints immediately instead of waiting for the next market tick.
            if self._latest_payload:
                await ws.send(self._latest_payload)
            async for _ in ws:   # drain and ignore anything the client sends
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
            print(f'[live_options_ws] WARN: WS push server failed to bind port {self.port}: {e} '
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
        self.thread = threading.Thread(target=self._run, daemon=True, name='quote-push-ws')
        self.thread.start()
        self._started.wait(timeout=5)
        return self.bound

    def _do_broadcast(self, payload: str):
        self._latest_payload = payload
        if self.clients:
            ws_broadcast(self.clients, payload)

    def broadcast(self, payload: str):
        """Thread-safe: called from the bridge main loop."""
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
    parser = argparse.ArgumentParser(description='Live options WebSocket bridge')
    parser.add_argument('--underlying', default='NIFTY',
                        choices=['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX'])
    parser.add_argument('--expiry', required=True,
                        help='Expiry date YYYY-MM-DD')
    parser.add_argument('--num-strikes', type=int, default=10,
                        help='Number of strikes each side of ATM (default 10)')
    parser.add_argument('--ws-port', type=int, default=8765,
                        help='Localhost WebSocket push server port (default 8765)')
    args = parser.parse_args()

    os.makedirs(DEBUG_DIR, exist_ok=True)
    started_at = datetime.now().isoformat()

    push_server = QuotePushServer(args.ws_port)
    ws_port = args.ws_port if push_server.start() else None
    if ws_port:
        print(f'[live_options_ws] WS push server listening on ws://127.0.0.1:{ws_port}', flush=True)

    write_status('STARTING', underlying=args.underlying, expiry=args.expiry,
                 started_at=started_at, ws_port=ws_port)

    print(f'[live_options_ws] Starting — underlying={args.underlying} expiry={args.expiry}',
          flush=True)

    dhan = get_dhan_client()
    if not dhan:
        print('[live_options_ws] ERROR: authentication failed', flush=True)
        write_status('ERROR', underlying=args.underlying, expiry=args.expiry,
                     started_at=started_at)
        sys.exit(1)

    helper = DhanHelper(dhan)
    step = STRIKE_STEP.get(args.underlying, 50)
    underlying_sid = UNDERLYING_SIDS.get(args.underlying.upper(), '13')
    underlying_exchange = UNDERLYING_EXCHANGE.get(args.underlying.upper(), 'NSE')
    underlying_seg = 'IDX_I' if underlying_exchange == 'NSE' else 'BSE_IDX'

    # Fetch prev_closes once at startup — used for % change throughout the session
    closes = _fetch_prev_closes(dhan, underlying_sid, underlying_exchange)
    underlying_prev_close = closes.get(underlying_sid, 0.0)
    vix_prev_close = closes.get(VIX_SID, 0.0)
    print(f'[live_options_ws] prev_closes: underlying={underlying_prev_close}, VIX={vix_prev_close}', flush=True)

    # Fetch prev-day OI & Close per strike once at startup — baseline for buildup labels
    prev_meta_map = _fetch_prev_meta(helper, args.underlying, args.expiry, exchange_segment=underlying_seg)
    print(f'[live_options_ws] prev_meta baseline: {len(prev_meta_map)} strikes', flush=True)

    # Get spot to determine ATM — retry on transient REST failures (429s):
    # spot=0 here means zero strikes resolved and a crippled session.
    print('[live_options_ws] Fetching spot price…', flush=True)
    spot = 0.0
    for attempt in range(5):
        spot = helper.get_ltp(args.underlying, exchange=underlying_exchange, instrument='INDEX') or 0.0
        if spot > 0:
            break
        print(f'[live_options_ws] WARN: spot fetch failed (attempt {attempt + 1}/5), retrying in 5s…', flush=True)
        time.sleep(5)
    atm  = round(spot / step) * step if spot > 0 else 0
    print(f'[live_options_ws] Spot={spot:.2f} ATM={atm} step={step}', flush=True)

    num = args.num_strikes
    strikes = [atm + i * step for i in range(-num, num + 1)] if atm > 0 else []

    # Resolve security IDs from master list
    instruments = []
    sid_map: dict[str, dict] = {}  # sid -> {strike, type}

    option_feed_segment = OPTION_FEED_SEGMENT.get(underlying_exchange, NSE_FNO)
    print(f'[live_options_ws] Resolving {len(strikes) * 2} option contracts…', flush=True)
    for strike in strikes:
        for opt_type in ('CE', 'PE'):
            opt = helper.find_option(args.underlying, args.expiry, float(strike), opt_type, exchange=underlying_exchange)
            if opt is None:
                continue
            sid = str(int(opt['SECURITY_ID']))
            sid_map[sid] = {'strike': int(strike), 'type': opt_type}
            instruments.append((option_feed_segment, sid, FULL))

    # Subscribe to underlying index (spot canary) and India VIX
    instruments.append((IDX, underlying_sid, FEED_QUOTE))
    instruments.append((IDX, VIX_SID, FEED_QUOTE))

    n = len(sid_map)  # actual option contracts (excludes index canary + VIX)
    print(f'[live_options_ws] Subscribing to {n} option contracts + index canary…', flush=True)

    if n == 0:
        print('[live_options_ws] ERROR: no contracts resolved — aborting', flush=True)
        write_status('ERROR', underlying=args.underlying, expiry=args.expiry,
                     started_at=started_at, ws_port=ws_port)
        sys.exit(1)

    # Dirty flag set by the feed thread on every incoming packet. DhanHelper
    # merges the packet into live_data BEFORE invoking this callback, so the
    # data is already readable when the main loop wakes.
    dirty = threading.Event()
    helper.start_websocket(instruments, on_message=lambda inst, msg: dirty.set())
    time.sleep(3)  # wait for connection + first tick batch

    # Diagnostic: check if index canary received a tick
    idx_initial = helper.live_data.get(underlying_sid)
    if idx_initial:
        initial_ltp = _f(idx_initial.get('LTP') or idx_initial.get('last_price'))
        print(f'[live_options_ws] Index tick received — LTP={initial_ltp:.2f}', flush=True)
    else:
        print('[live_options_ws] WARNING: No index tick received after 3s; will use REST spot as fallback', flush=True)

    write_status('RUNNING', underlying=args.underlying, expiry=args.expiry,
                 subscribed=n, started_at=started_at, ws_port=ws_port)
    print('[live_options_ws] WebSocket connected. Pushing on tick; file every 0.5s…', flush=True)

    last_print = 0.0
    last_quotes = None
    last_pushed = None
    last_file_write = 0.0
    last_history_write = 0.0
    # Each history tick is serialized to JSON ONCE when it's captured (~20KB,
    # ~1ms). The writer thread only joins the pre-serialized strings and writes
    # the ~6MB file. Never re-json.dumps the whole 300-snapshot history:
    # that's 300-800ms of GIL-held CPU that stalls the feed thread AND the
    # push loop — it was the source of the multi-hundred-ms push latency.
    hist_json_parts: list = []

    hist_q: queue.Queue = queue.Queue(maxsize=1)

    def _history_writer():
        while True:
            parts = hist_q.get()
            if parts is None:
                return
            atomic_write_text(HISTORY_FILE, '{"history":[' + ','.join(parts) + ']}')

    hist_thread = threading.Thread(target=_history_writer, daemon=True, name='history-writer')
    hist_thread.start()

    try:
        while True:
            # Event-driven pacing: wake instantly on a market tick (dirty flag
            # set by the feed thread), or every 250ms as a heartbeat for the
            # stop-trigger check. After a wake, sleep 20ms so the multi-packet
            # burst per tick (Full + OI + PrevClose) coalesces into ONE
            # snapshot build + push (~40 pushes/sec max).
            if dirty.wait(timeout=0.25):
                dirty.clear()
                time.sleep(0.02)

            if os.path.exists(STOP_TRIGGER):
                try:
                    os.remove(STOP_TRIGGER)
                except OSError:
                    pass
                print('[live_options_ws] Stop trigger detected — exiting.', flush=True)
                break

            # Update spot from index canary
            idx_tick = helper.live_data.get(underlying_sid)
            if idx_tick:
                live_spot = _f(idx_tick.get('LTP') or idx_tick.get('last_price'))
                if live_spot > 0:
                    spot = live_spot
                    atm  = round(spot / step) * step

            # Read India VIX from WebSocket; prev_close is the value fetched at startup
            vix_data: dict | None = None
            vix_tick = helper.live_data.get(VIX_SID)
            if vix_tick:
                vix_ltp = _f(vix_tick.get('LTP') or vix_tick.get('last_price'))
                if vix_ltp > 0:
                    vix_chg     = round(vix_ltp - vix_prev_close, 2) if vix_prev_close else 0.0
                    vix_chg_pct = round(vix_chg / vix_prev_close * 100, 4) if vix_prev_close else 0.0
                    vix_data = {
                        'ltp':        round(vix_ltp, 2),
                        'prev_close': round(vix_prev_close, 2),
                        'change':     vix_chg,
                        'change_pct': vix_chg_pct,
                    }

            # Build per-strike quotes
            strikes_data: dict[str, dict] = {}
            for sid, meta in sid_map.items():
                sk_key = str(meta['strike'])
                if sk_key not in strikes_data:
                    strikes_data[sk_key] = {
                        'strike': meta['strike'],
                        'ce': {'ltp': 0, 'oi': 0, 'volume': 0, 'prev_close': 0.0, 'change': 0.0, 'change_pct': 0.0, 'oi_chg_pct': 0.0, 'buildup': ''},
                        'pe': {'ltp': 0, 'oi': 0, 'volume': 0, 'prev_close': 0.0, 'change': 0.0, 'change_pct': 0.0, 'oi_chg_pct': 0.0, 'buildup': ''},
                    }

                tick = helper.live_data.get(sid)
                if tick:
                    ltp = _f(tick.get('LTP') or tick.get('last_price'))
                    oi  = int(tick.get('OI', 0) or tick.get('oi', 0) or 0)
                    vol = int(tick.get('volume', 0) or 0)
                    
                    side_key = meta['type'].lower()
                    strike_meta = prev_meta_map.get(meta['strike']) or {}
                    side_prev_oi = _f(strike_meta.get(f'{side_key}_oi'))
                    fallback_prev_close = _f(strike_meta.get(f'{side_key}_close'))

                    prev_close = _f(tick.get('prev_close') or tick.get('close'))
                    if prev_close == 0.0:
                        ohlc = tick.get('ohlc') or {}
                        prev_close = _f(ohlc.get('close'))
                    if prev_close == 0.0:
                        prev_close = fallback_prev_close
                    
                    change = ltp - prev_close if prev_close > 0 else 0.0
                    change_pct = (change / prev_close * 100) if prev_close > 0 else 0.0
                    oi_chg_pct = ((oi - side_prev_oi) / side_prev_oi * 100) if side_prev_oi > 0 and oi > 0 else 0.0

                    strikes_data[sk_key][meta['type'].lower()] = {
                        'ltp':    round(ltp, 2),
                        'oi':     oi,
                        'volume': vol,
                        'open':   round(_f(tick.get('open')), 2),
                        'high':   round(_f(tick.get('high')), 2),
                        'low':    round(_f(tick.get('low')), 2),
                        'prev_close': round(prev_close, 2),
                        'change':     round(change, 2),
                        'change_pct': round(change_pct, 4),
                        'oi_chg_pct': round(oi_chg_pct, 2),
                        'buildup':    _classify_buildup(change_pct, oi_chg_pct),
                    }

            # ATM straddle premium
            atm_key = str(atm)
            straddle = 0.0
            if atm_key in strikes_data:
                ce_ltp = strikes_data[atm_key].get('ce', {}).get('ltp', 0)
                pe_ltp = strikes_data[atm_key].get('pe', {}).get('ltp', 0)
                straddle = round(ce_ltp + pe_ltp, 2)

            now_iso = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

            spot_chg = 0.0
            spot_chg_pct = 0.0
            if spot > 0 and underlying_prev_close > 0:
                spot_chg = round(spot - underlying_prev_close, 2)
                spot_chg_pct = round(spot_chg / underlying_prev_close * 100, 4)

            current_quotes = {
                'underlying':        args.underlying,
                'expiry':            args.expiry,
                'spot':              round(spot, 2),
                'spot_change':       spot_chg,
                'spot_change_pct':   spot_chg_pct,
                'atm':               atm,
                'straddle_premium':  straddle,
                'strikes':           strikes_data,
                'vix':               vix_data,
            }

            now_ts = time.time()

            # WS push (hot path): push immediately whenever the snapshot changed.
            # Compare the core payload BEFORE stamping volatile fields
            # (updated_at/pushed_at) so identical market data never re-pushes.
            if current_quotes != last_pushed:
                payload = dict(current_quotes)
                payload['type']       = 'quotes'
                payload['updated_at'] = now_iso
                payload['pushed_at']  = now_ts
                push_server.broadcast(json.dumps(payload))
                last_pushed = current_quotes

            # Quotes file (fallback + other consumers): relaxed 500ms cadence —
            # the scalper hot path no longer reads this file.
            if current_quotes != last_quotes and now_ts - last_file_write >= 0.5:
                file_payload = dict(current_quotes)
                file_payload['updated_at'] = now_iso
                if atomic_write(QUOTES_FILE, file_payload):
                    last_quotes = current_quotes
                    last_file_write = now_ts
                # else: write was dropped (e.g. lock contention) — leave last_quotes
                # unchanged so this same state is retried on the next loop tick
                # instead of going stale until the next real market data change.

            # Queue history snapshot every 2 seconds. Only THIS tick is
            # serialized here (~20KB); the writer thread joins the parts.
            if now_ts - last_history_write >= 2.0:
                tick = {
                    'timestamp': now_iso,
                    'spot':              round(spot, 2),
                    'atm':               atm,
                    'straddle_premium':  straddle,
                    'strikes':           strikes_data,
                }
                hist_json_parts.append(json.dumps(tick))
                if len(hist_json_parts) > MAX_HISTORY:
                    hist_json_parts = hist_json_parts[-MAX_HISTORY:]
                try:
                    hist_q.put_nowait(list(hist_json_parts))
                except queue.Full:
                    pass  # writer busy — next 2s tick retries
                last_history_write = now_ts

            # Print status update to terminal every 10 seconds
            if now_ts - last_print > 10:
                print(f'[live_options_ws] Spot={spot:.2f} | ATM={atm} | Straddle={straddle:.2f} | Subscribed={n} | WS clients={len(push_server.clients)}', flush=True)
                last_print = now_ts

    except KeyboardInterrupt:
        print('[live_options_ws] KeyboardInterrupt — shutting down.', flush=True)
    finally:
        try:
            hist_q.put_nowait(None)   # stop the history writer
        except queue.Full:
            pass
        push_server.stop()
        write_status('STOPPED', underlying=args.underlying, expiry=args.expiry,
                     subscribed=0, started_at=started_at, ws_port=None)
        print('[live_options_ws] Stopped.', flush=True)


if __name__ == '__main__':
    main()
