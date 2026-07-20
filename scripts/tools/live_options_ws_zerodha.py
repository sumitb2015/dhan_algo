"""
Live options WebSocket bridge for the RS dashboard options page (Zerodha Mode).

Subscribes to NSE FNO option contracts via Zerodha KiteTicker WebSocket and writes
debug/live_options_quotes_zerodha.json + debug/live_options_history_zerodha.json
for the Next.js dashboard to poll. Runs concurrently and independently of the
Dhan bridge (live_options_ws.py) — broker-namespaced file paths so neither
bridge ever needs to stop the other.

Usage:
    venv\\Scripts\\python.exe scripts/tools/live_options_ws_zerodha.py --underlying NIFTY --expiry 2026-06-27

Stop gracefully by writing debug/live_options_stop_zerodha.trigger.
"""
import sys
import os
import json
import time
import queue
import asyncio
import argparse
import threading
from datetime import datetime, timezone

from websockets.asyncio.server import serve as ws_serve, broadcast as ws_broadcast
from kiteconnect import KiteConnect, KiteTicker

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from scripts.tools.zerodha_instruments_cache import restore_session_from_json

DEBUG_DIR    = os.path.join(ROOT, 'debug')
QUOTES_FILE  = os.path.join(DEBUG_DIR, 'live_options_quotes_zerodha.json')
HISTORY_FILE = os.path.join(DEBUG_DIR, 'live_options_history_zerodha.json')
STATUS_FILE  = os.path.join(DEBUG_DIR, 'live_options_status_zerodha.json')
STOP_TRIGGER = os.path.join(DEBUG_DIR, 'live_options_stop_zerodha.trigger')
INSTRUMENTS_CACHE_MAX_AGE_SEC = 24 * 60 * 60

# Resolved index instrument_tokens for underlyings not in the static
# UNDERLYING_TOKENS map (e.g. SENSEX) — instrument_tokens are effectively
# permanent, so a long TTL avoids re-fetching the full exchange instrument
# dump (kite.instruments()) on every single bridge start.
INDEX_TOKEN_CACHE_FILE = os.path.join(DEBUG_DIR, 'zerodha_index_tokens.json')
INDEX_TOKEN_CACHE_MAX_AGE_SEC = 7 * 24 * 60 * 60

MAX_HISTORY  = 300   # ~10 min at 2s ticks

# Zerodha Instrument Tokens
NIFTY_TOKEN  = 256265   # NSE:NIFTY 50
VIX_TOKEN    = 264969   # NSE:INDIA VIX

UNDERLYING_TRADING_SYMBOLS = {
    'NIFTY':     'NSE:NIFTY 50',
    'BANKNIFTY': 'NSE:NIFTY BANK',
    'FINNIFTY':  'NSE:NIFTY FIN SERVICE',
    'SENSEX':    'BSE:SENSEX',
}

UNDERLYING_TOKENS = {
    'NIFTY':     NIFTY_TOKEN,
    'BANKNIFTY': 260105,
    'FINNIFTY':  257801,
}

# Strike step per underlying
STRIKE_STEP = {'NIFTY': 50, 'BANKNIFTY': 100, 'FINNIFTY': 50, 'SENSEX': 100}


def _load_index_token_cache() -> dict:
    try:
        if os.path.exists(INDEX_TOKEN_CACHE_FILE):
            with open(INDEX_TOKEN_CACHE_FILE) as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def _resolve_index_token(kite, underlying: str):
    """Return the instrument_token for an underlying's index, using the
    static UNDERLYING_TOKENS map when available, then a file cache
    (INDEX_TOKEN_CACHE_FILE), then falling back to a live kite.instruments()
    lookup for anything not hardcoded there (e.g. SENSEX, whose token isn't a
    well-known constant like NIFTY's). Returns None on failure — callers MUST
    NOT fall back to another underlying's token (e.g. NIFTY's), since that
    would silently subscribe to and display a different instrument's live
    price mislabeled as this underlying's spot."""
    token = UNDERLYING_TOKENS.get(underlying)
    if token:
        return token

    cache = _load_index_token_cache()
    entry = cache.get(underlying)
    if entry and time.time() - entry.get('ts', 0) < INDEX_TOKEN_CACHE_MAX_AGE_SEC:
        return entry['token']

    exchange = 'BSE' if underlying == 'SENSEX' else 'NSE'
    try:
        for inst in kite.instruments(exchange):
            if inst.get('tradingsymbol') == underlying:
                resolved = int(inst['instrument_token'])
                cache[underlying] = {'token': resolved, 'ts': time.time()}
                atomic_write(INDEX_TOKEN_CACHE_FILE, cache)
                return resolved
    except Exception as e:
        print(f'[live_options_ws_zerodha] WARN: failed to resolve index token for {underlying}: {e}', flush=True)
    print(f'[live_options_ws_zerodha] WARN: could not resolve index token for {underlying} — '
          f'live spot updates will be disabled for this session (falling back to the one-time REST spot).', flush=True)
    return None

def _f(val, default: float = 0.0) -> float:
    if val is None:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        return default

def atomic_write_text(path: str, text: str) -> bool:
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w') as f:
            f.write(text)
        os.replace(tmp, path)
        return True
    except PermissionError:
        return False
    except Exception as e:
        print(f"[live_options_ws_zerodha] Warning: failed to write {path} ({e})", flush=True)
        return False

def atomic_write(path: str, data: dict) -> bool:
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w') as f:
            json.dump(data, f)
        os.replace(tmp, path)
        return True
    except PermissionError:
        return False
    except Exception as e:
        print(f"[live_options_ws_zerodha] Warning: failed to write {path} ({e})", flush=True)
        return False

def write_status(status: str, underlying: str = '', expiry: str = '',
                 subscribed: int = 0, started_at: str = '', ws_port=None):
    try:
        atomic_write(STATUS_FILE, {
            'status': status,
            'broker': 'zerodha',
            'pid': os.getpid(),
            'underlying': underlying,
            'expiry': expiry,
            'subscribed': subscribed,
            'ws_port': ws_port,
            'started_at': started_at or datetime.now().isoformat(),
            'last_update': datetime.now().isoformat(),
        })
    except Exception as e:
        print(f"[live_options_ws_zerodha] Warning: failed to write status ({e})", flush=True)

class QuotePushServer:
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
            print(f'[live_options_ws_zerodha] WARN: WS push server failed to bind port {self.port}: {e} — continuing file-only', flush=True)
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
        self.thread = threading.Thread(target=self._run, daemon=True, name='quote-push-ws-zerodha')
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

def load_zerodha_instruments_cache(underlying: str = 'NIFTY'):
    cache_file = os.path.join(ROOT, 'debug', f'zerodha_{underlying.lower()}_instruments.json')
    is_stale = (
        os.path.exists(cache_file)
        and time.time() - os.path.getmtime(cache_file) > INSTRUMENTS_CACHE_MAX_AGE_SEC
    )
    if not os.path.exists(cache_file) or is_stale:
        reason = 'stale (>24h old)' if is_stale else 'missing'
        print(f"[live_options_ws_zerodha] Instrument cache {reason}, generating...", flush=True)
        import subprocess
        subprocess.run(
            [sys.executable, os.path.join(ROOT, 'scripts', 'tools', 'zerodha_instruments_cache.py'),
             '--underlying', underlying],
            check=True,
        )
    with open(cache_file) as f:
        return json.load(f)

def main():
    parser = argparse.ArgumentParser(description='Live options WebSocket bridge (Zerodha Mode)')
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
        print(f'[live_options_ws_zerodha] WS push server listening on ws://127.0.0.1:{ws_port}', flush=True)

    write_status('STARTING', underlying=args.underlying, expiry=args.expiry,
                 started_at=started_at, ws_port=ws_port)

    print(f'[live_options_ws_zerodha] Starting — underlying={args.underlying} expiry={args.expiry}', flush=True)

    kite = restore_session_from_json()
    if not kite:
        print('[live_options_ws_zerodha] ERROR: authentication failed', flush=True)
        write_status('ERROR', underlying=args.underlying, expiry=args.expiry,
                     started_at=started_at)
        sys.exit(1)

    # Fetch spot to determine ATM
    spot_symbol = UNDERLYING_TRADING_SYMBOLS.get(args.underlying.upper(), 'NSE:NIFTY 50')
    print(f'[live_options_ws_zerodha] Fetching spot price for {spot_symbol}…', flush=True)
    spot = 0.0
    backoff = 1.0
    for attempt in range(3):
        try:
            q = kite.quote([spot_symbol])
            spot = q.get(spot_symbol, {}).get('last_price', 0.0)
            if spot > 0:
                break
        except Exception as e:
            print(f'[live_options_ws_zerodha] WARN: spot fetch failed (attempt {attempt + 1}/3): {e}', flush=True)
        time.sleep(backoff)
        backoff *= 2

    step = STRIKE_STEP.get(args.underlying.upper(), 50)
    atm  = round(spot / step) * step if spot > 0 else 0
    print(f'[live_options_ws_zerodha] Spot={spot:.2f} ATM={atm} step={step}', flush=True)

    num = args.num_strikes
    strikes = [atm + i * step for i in range(-num, num + 1)] if atm > 0 else []

    # Load instruments cache to map strike -> tokens
    insts_cache = load_zerodha_instruments_cache(args.underlying.upper())
    
    # Resolve instrument tokens
    sid_map = {} # token_id_int -> {strike, type, tradingsymbol}
    option_tokens = []
    
    for inst in insts_cache:
        if inst['expiry'] == args.expiry and float(inst['strike']) in strikes:
            token = int(inst['instrument_token'])
            sid_map[token] = {
                'strike': int(inst['strike']),
                'type': inst['instrument_type'],
                'tradingsymbol': inst['tradingsymbol']
            }
            option_tokens.append(token)

    # Spot and VIX tokens. underlying_token may be None (resolution failed) —
    # in that case we deliberately skip subscribing to any index canary
    # rather than silently falling back to a different underlying's token,
    # which would display that instrument's live price mislabeled as this
    # underlying's spot (see _resolve_index_token).
    underlying_token = _resolve_index_token(kite, args.underlying.upper())
    all_tokens = ([underlying_token] if underlying_token else []) + [VIX_TOKEN] + option_tokens

    print(f'[live_options_ws_zerodha] Subscribing to {len(option_tokens)} option contracts + indices…', flush=True)

    if len(option_tokens) == 0:
        print('[live_options_ws_zerodha] ERROR: no contracts resolved — aborting', flush=True)
        write_status('ERROR', underlying=args.underlying, expiry=args.expiry,
                     started_at=started_at, ws_port=ws_port)
        sys.exit(1)

    # Fetch prev closes
    print('[live_options_ws_zerodha] Fetching baseline prev_closes…', flush=True)
    underlying_prev_close = 0.0
    vix_prev_close = 0.0
    try:
        ohlc_data = kite.ohlc([spot_symbol, "NSE:INDIA VIX"])
        underlying_prev_close = ohlc_data.get(spot_symbol, {}).get('ohlc', {}).get('close', 0.0)
        vix_prev_close = ohlc_data.get("NSE:INDIA VIX", {}).get('ohlc', {}).get('close', 0.0)
    except Exception as e:
        print(f'[live_options_ws_zerodha] WARN: baseline ohlc fetch failed: {e}', flush=True)

    print(f'[live_options_ws_zerodha] prev_closes: underlying={underlying_prev_close}, VIX={vix_prev_close}', flush=True)

    live_data = {}
    dirty = threading.Event()

    def on_ticks(ws, ticks):
        for tick in ticks:
            tok = tick.get('instrument_token')
            if tok:
                live_data[tok] = tick
        dirty.set()

    def on_connect(ws, response):
        ws.subscribe(all_tokens)
        ws.set_mode(ws.MODE_FULL, all_tokens)
        print("[live_options_ws_zerodha] WebSocket connected & subscribed successfully.", flush=True)

    # Initialize KiteTicker
    kws = KiteTicker(api_key=kite.api_key, access_token=kite.access_token)
    kws.on_ticks = on_ticks
    kws.on_connect = on_connect
    kws.connect(threaded=True)

    # Poll until the socket is actually up instead of always waiting a flat
    # 3s — proceeds the instant the connection is live, capped at 5s.
    connect_deadline = time.time() + 5.0
    while not kws.is_connected() and time.time() < connect_deadline:
        time.sleep(0.2)

    write_status('RUNNING', underlying=args.underlying, expiry=args.expiry,
                 subscribed=len(option_tokens), started_at=started_at, ws_port=ws_port)

    last_print = 0.0
    last_quotes = None
    last_pushed = None
    last_pushed_time = 0.0
    last_file_write = 0.0
    last_history_write = 0.0
    hist_json_parts = []
    hist_q = queue.Queue(maxsize=1)

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
            if dirty.wait(timeout=0.25):
                dirty.clear()
                time.sleep(0.02)

            if os.path.exists(STOP_TRIGGER):
                try:
                    os.remove(STOP_TRIGGER)
                except OSError:
                    pass
                print('[live_options_ws_zerodha] Stop trigger detected — exiting.', flush=True)
                break

            # Update spot
            idx_tick = live_data.get(underlying_token)
            if idx_tick:
                live_spot = _f(idx_tick.get('last_price'))
                if live_spot > 0:
                    spot = live_spot
                    atm  = round(spot / step) * step

            # VIX data
            vix_data = None
            vix_tick = live_data.get(VIX_TOKEN)
            if vix_tick:
                vix_ltp = _f(vix_tick.get('last_price'))
                if vix_ltp > 0:
                    vix_chg = round(vix_ltp - vix_prev_close, 2) if vix_prev_close else 0.0
                    vix_chg_pct = round(vix_chg / vix_prev_close * 100, 4) if vix_prev_close else 0.0
                    vix_data = {
                        'ltp':        round(vix_ltp, 2),
                        'prev_close': round(vix_prev_close, 2),
                        'change':     vix_chg,
                        'change_pct': vix_chg_pct,
                    }

            # Build strikes quotes
            strikes_data = {}
            for token, meta in sid_map.items():
                sk_key = str(meta['strike'])
                if sk_key not in strikes_data:
                    strikes_data[sk_key] = {
                        'strike': meta['strike'],
                        'ce': {'ltp': 0, 'oi': 0, 'volume': 0, 'prev_close': 0.0, 'change': 0.0, 'change_pct': 0.0, 'oi_chg_pct': 0.0, 'buildup': ''},
                        'pe': {'ltp': 0, 'oi': 0, 'volume': 0, 'prev_close': 0.0, 'change': 0.0, 'change_pct': 0.0, 'oi_chg_pct': 0.0, 'buildup': ''},
                    }

                tick = live_data.get(token)
                if tick:
                    ltp = _f(tick.get('last_price'))
                    oi  = int(tick.get('oi', 0) or 0)
                    vol = int(tick.get('volume', 0) or tick.get('volume_traded', 0) or 0)
                    
                    ohlc = tick.get('ohlc') or {}
                    prev_close = _f(ohlc.get('close'))
                    
                    change = ltp - prev_close if prev_close > 0 else 0.0
                    change_pct = (change / prev_close * 100) if prev_close > 0 else 0.0

                    # Standard fallback for baseline OI since we don't have direct previous_oi from ticks
                    oi_chg_pct = 0.0
                    buildup = ''

                    strikes_data[sk_key][meta['type'].lower()] = {
                        'ltp':        round(ltp, 2),
                        'oi':         oi,
                        'volume':     vol,
                        'open':       round(_f(ohlc.get('open')), 2),
                        'high':       round(_f(ohlc.get('high')), 2),
                        'low':        round(_f(ohlc.get('low')), 2),
                        'prev_close':  round(prev_close, 2),
                        'change':      round(change, 2),
                        'change_pct':  round(change_pct, 4),
                        'oi_chg_pct':  round(oi_chg_pct, 2),
                        'buildup':     buildup,
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

            force_push = (now_ts - last_pushed_time >= 5.0)

            if current_quotes != last_pushed or force_push:
                payload = dict(current_quotes)
                payload['type']       = 'quotes'
                payload['updated_at'] = now_iso
                payload['pushed_at']  = now_ts
                push_server.broadcast(json.dumps(payload))
                last_pushed = current_quotes
                last_pushed_time = now_ts

            if (current_quotes != last_quotes or force_push) and now_ts - last_file_write >= 0.5:
                file_payload = dict(current_quotes)
                file_payload['updated_at'] = now_iso
                if atomic_write(QUOTES_FILE, file_payload):
                    last_quotes = current_quotes
                    last_file_write = now_ts

            if now_ts - last_history_write >= 2.0:
                tick_snap = {
                    'timestamp': now_iso,
                    'spot':              round(spot, 2),
                    'atm':               atm,
                    'straddle_premium':  straddle,
                    'strikes':           strikes_data,
                }
                hist_json_parts.append(json.dumps(tick_snap))
                if len(hist_json_parts) > MAX_HISTORY:
                    hist_json_parts = hist_json_parts[-MAX_HISTORY:]
                try:
                    hist_q.put_nowait(list(hist_json_parts))
                except queue.Full:
                    pass
                last_history_write = now_ts

            if now_ts - last_print > 10:
                print(f'[live_options_ws_zerodha] Spot={spot:.2f} | ATM={atm} | Straddle={straddle:.2f} | Subscribed={len(option_tokens)} | WS clients={len(push_server.clients)}', flush=True)
                last_print = now_ts

    except KeyboardInterrupt:
        print('[live_options_ws_zerodha] KeyboardInterrupt — shutting down.', flush=True)
    finally:
        try:
            hist_q.put_nowait(None)
        except queue.Full:
            pass
        
        # Stop KiteTicker
        try:
            kws.close()
        except Exception:
            pass
            
        push_server.stop()
        write_status('STOPPED', underlying=args.underlying, expiry=args.expiry,
                     subscribed=0, started_at=started_at, ws_port=None)
        print('[live_options_ws_zerodha] Stopped.', flush=True)

if __name__ == '__main__':
    main()
