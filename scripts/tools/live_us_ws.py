"""
Live US stocks bridge: Dhan Global Stocks Live Feed -> debug/live_us_quotes.json.

READ-ONLY. It subscribes to Trade (15) and OHLC (17) packets for the security ids listed in
debug/live_us_watchlist.json and writes a compact snapshot for the dashboard's /us-markets page. It never
places or modifies a US order.

  debug/live_us_watchlist.json   in : {"ids": ["10000025", ...]}   re-read every second; diffs are (un)subscribed live
  debug/live_us_quotes.json      out: {"updated_at", "connected", "market_status", "quotes": {id: {ltp, ...}}}  every 1 s
  debug/live_us_status.json      out: {"status", "pid", "heartbeat", "subscribed", "connected", "error", ...}
  debug/live_us_stop.trigger     in : write it (the dashboard's Stop does) to exit gracefully

Usage:
    venv/bin/python scripts/tools/live_us_ws.py

Why not the dhanhq SDK: the venv's SDK predates GlobalStocksFeed (added in 2.3.0, packet-parsing fixed 2026-10-08), and
upgrading it would touch every strategy. The wire format is parsed by lib/us_feed.py instead.

Safety, learned from the spec: the server allows 5 connections per client and drops the OLDEST on the 6th (error 805), and
more than ~10 invalid connection attempts can block the source IP. So this bridge (a) refuses to start when another live
instance exists, (b) treats auth/payment/limit errors (805-809), an HTTP 401/403 on the upgrade and a missing token file as fatal and
does NOT retry, and (c) backs off between ordinary reconnects while keeping its heartbeat fresh.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from lib import us_feed  # noqa: E402
from lib.market_hub_client import is_pid_running  # noqa: E402  (psutil + image-name check; NOT os.kill(pid, 0), which TerminateProcess-es on Windows)

DEBUG_DIR = os.path.join(ROOT, 'debug')
WATCHLIST_FILE = os.path.join(DEBUG_DIR, 'live_us_watchlist.json')
UNIVERSE_FILE = os.path.join(DEBUG_DIR, 'live_us_universe.json')   # the dashboard's curated market universe (written by the route)
QUOTES_FILE = os.path.join(DEBUG_DIR, 'live_us_quotes.json')
STATUS_FILE = os.path.join(DEBUG_DIR, 'live_us_status.json')
STOP_TRIGGER = os.path.join(DEBUG_DIR, 'live_us_stop.trigger')
TOKEN_FILE = os.path.join(ROOT, 'access_token.json')
ENV_FILE = os.path.join(ROOT, '.env')

FEED_HOST = 'wss://global-stocks-api-feed.dhan.co/'
SEG_INX_EQ = 'INX_EQ'
REQ_DISCONNECT, REQ_SUB_TRADE, REQ_UNSUB_TRADE, REQ_SUB_OHLC, REQ_UNSUB_OHLC = 12, 15, 16, 17, 18
MAX_PER_REQUEST = 100          # spec: max instruments in one subscribe/unsubscribe message
MAX_WATCHLIST = 400            # watchlist + universe; 2 subscriptions per symbol -> 800 of the 5000 a connection allows
WRITE_EVERY_SEC = 1.0
HEARTBEAT_SEC = 5.0
LIVE_PID_FRESH_SEC = 15.0      # a status heartbeat younger than this + a live pid = another bridge is running
BACKOFF_START, BACKOFF_MAX = 2.0, 30.0

_ID_RE = re.compile(r'^\d{1,9}$')


def now_ms() -> int:
    return int(time.time() * 1000)


def atomic_write(path: str, obj: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.{os.getpid()}.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, separators=(',', ':'))
    os.replace(tmp, path)


def read_json(path: str):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def another_bridge_running() -> int | None:
    st = read_json(STATUS_FILE)
    if not st or st.get('status') not in ('RUNNING', 'IDLE', 'CONNECTING', 'RECONNECTING'):
        return None
    pid = st.get('pid')
    hb = st.get('heartbeat')
    if isinstance(pid, int) and pid != os.getpid() and is_pid_running(pid) and isinstance(hb, (int, float)) and time.time() - hb / 1000 < LIVE_PID_FRESH_SEC:
        return pid
    return None


def load_credentials() -> tuple[str, str]:
    """Fresh read each connect - the access token is re-issued daily and the file is rewritten by login.py."""
    with open(TOKEN_FILE, encoding='utf-8') as f:
        tok = json.load(f)
    token = tok.get('accessToken') or ''
    client_id = ''
    try:
        with open(ENV_FILE, encoding='utf-8') as f:
            m = re.search(r'^client_id\s*=\s*["\']?([^"\'\r\n]+)', f.read(), re.M)
            if m:
                client_id = m.group(1).strip()
    except OSError:
        pass
    client_id = client_id or tok.get('dhanClientId') or tok.get('clientId') or ''
    if not token or not client_id:
        raise us_feed.CredentialsError('no Dhan access token / client id - run login.py')
    return client_id, token


def _ids_from(path: str, need_enabled: bool) -> list[str]:
    data = read_json(path) or {}
    if not isinstance(data, dict) or (need_enabled and data.get('enabled') is not True):
        return []
    ids = data.get('ids')
    return [str(v).strip() for v in ids] if isinstance(ids, list) else []


def read_watchlist() -> list[str]:
    """The ids to subscribe: the user's watchlist first, then the dashboard universe (only while it is enabled), de-duplicated
    in that order and capped at MAX_WATCHLIST - so a cap can only ever trim universe names, never a symbol the user added."""
    out: list[str] = []
    seen: set[str] = set()
    for s in _ids_from(WATCHLIST_FILE, False) + _ids_from(UNIVERSE_FILE, True):
        if _ID_RE.match(s) and s not in seen:
            seen.add(s)
            out.append(s)
    return out[:MAX_WATCHLIST]


def sub_message(code: int, ids: list[str]) -> str:
    return json.dumps({
        'requestCode': code,
        'instrumentCount': len(ids),
        'instrumentList': [{'exchangeSegment': SEG_INX_EQ, 'securityId': i} for i in ids],
    })


class Bridge:
    def __init__(self) -> None:
        self.state: dict[int, dict] = {}
        self.market_status: dict | None = None
        self.subscribed: set[str] = set()
        self.connected = False
        self.dirty = True
        self.last_error: str | None = None
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.status = 'CONNECTING'
        self.stopping = False
        self.fatal: str | None = None
        self.packets = 0

    # ── output ────────────────────────────────────────────────────────────────────────────────────
    def write_status(self) -> None:
        atomic_write(STATUS_FILE, {
            'status': self.status, 'pid': os.getpid(), 'heartbeat': now_ms(), 'started_at': self.started_at,
            'subscribed': len(self.subscribed), 'connected': self.connected, 'error': self.last_error, 'packets': self.packets,
        })

    def write_quotes(self) -> None:
        # Always written (even when nothing changed) so the page can use `updated_at` as a liveness clock.
        # Filter by the watchlist file, not by self.subscribed: that set is empty for the first second after a reconnect and
        # would blank every row on the page for no reason.
        wanted = set(read_watchlist())
        atomic_write(QUOTES_FILE, {
            'updated_at': now_ms(), 'connected': self.connected, 'market_status': self.market_status,
            'quotes': {str(k): v for k, v in self.state.items() if str(k) in wanted},
        })
        self.dirty = False

    # ── socket ────────────────────────────────────────────────────────────────────────────────────
    async def session(self) -> None:
        """One connection: connect, subscribe, pump until it closes. Raises on abnormal close."""
        from websockets.asyncio.client import connect

        client_id, token = load_credentials()
        url = f'{FEED_HOST}?clientId={client_id}&token={token}&authType=2&version=2'
        self.status, self.connected = 'CONNECTING', False
        self.write_status()
        async with connect(url, max_size=2**22, open_timeout=15) as ws:
            self.connected = True
            self.status = 'RUNNING'
            self.last_error = None
            self.subscribed = set()          # a fresh connection has no subscriptions server-side
            print(f'[live_us_ws] connected, subscribing {len(read_watchlist())} instrument(s)', flush=True)
            sync = asyncio.create_task(self.sync_loop(ws))
            outw = asyncio.create_task(self.writer_loop())
            try:
                async for msg in ws:
                    if isinstance(msg, str):
                        continue                      # the feed sends binary only; ignore any text frame
                    self.handle(bytes(msg))
                    if self.fatal or self.stopping:
                        break
            finally:
                sync.cancel()
                outw.cancel()
                await asyncio.gather(sync, outw, return_exceptions=True)
                self.connected = False
                try:
                    await ws.send(json.dumps({'requestCode': REQ_DISCONNECT}))
                except Exception:
                    pass

    def handle(self, buf: bytes) -> None:
        packets, leftover = us_feed.parse_packets(buf)
        if leftover:
            # Spec: one WebSocket message holds whole packets; a fragment means a framing surprise, so say so once.
            print(f'[live_us_ws] {len(leftover)} undecodable trailing byte(s) dropped', flush=True)
        for p in packets:
            self.packets += 1
            reason = us_feed.fatal_error(p)
            if reason:
                self.fatal = reason
                return
            if p.kind == 'error':
                # Not on the fatal list: log it and let the connection run or the normal reconnect path take over.
                print(f'[live_us_ws] feed error packet {us_feed.error_text(p)}', flush=True)
                self.last_error = us_feed.error_text(p)
                continue
            if p.kind == 'market_status':
                self.market_status = {**p.data, 'at': now_ms()}
                self.dirty = True
            elif us_feed.apply_packet(self.state, p):
                self.dirty = True

    async def sync_loop(self, ws) -> None:
        """Keep the server-side subscriptions equal to the watchlist file."""
        while True:
            want = set(read_watchlist())
            add = sorted(want - self.subscribed)
            drop = sorted(self.subscribed - want)
            for i in range(0, len(add), MAX_PER_REQUEST):
                chunk = add[i:i + MAX_PER_REQUEST]
                await ws.send(sub_message(REQ_SUB_TRADE, chunk))
                await ws.send(sub_message(REQ_SUB_OHLC, chunk))
            for i in range(0, len(drop), MAX_PER_REQUEST):
                chunk = drop[i:i + MAX_PER_REQUEST]
                await ws.send(sub_message(REQ_UNSUB_TRADE, chunk))
                await ws.send(sub_message(REQ_UNSUB_OHLC, chunk))
                for i2 in chunk:
                    self.state.pop(int(i2), None)
            if add or drop:
                self.subscribed = want
                self.dirty = True
                print(f'[live_us_ws] +{len(add)} -{len(drop)} -> {len(want)} subscribed', flush=True)
            if os.path.exists(STOP_TRIGGER):
                self.stopping = True
                await ws.close()
                return
            await asyncio.sleep(1.0)

    async def writer_loop(self) -> None:
        last_hb = 0.0
        while True:
            self.write_quotes()
            if time.monotonic() - last_hb >= HEARTBEAT_SEC:
                self.write_status()
                last_hb = time.monotonic()
            await asyncio.sleep(WRITE_EVERY_SEC)

    # ── lifecycle ─────────────────────────────────────────────────────────────────────────────────
    async def idle_until_watchlist(self) -> None:
        """No symbols = no connection (saves one of the 5 slots). Heartbeat so the dashboard sees us alive."""
        self.status, self.connected = 'IDLE', False
        while not self.stopping and not read_watchlist():
            if os.path.exists(STOP_TRIGGER):
                self.stopping = True
                return
            self.write_quotes()
            self.write_status()
            await asyncio.sleep(1.0)

    async def sleep_with_heartbeat(self, seconds: float) -> None:
        """Back-off sleep that keeps the status heartbeat fresh (the duplicate-instance guard and the dashboard both
        read it) and still honours the stop trigger within a second."""
        end = time.monotonic() + seconds
        while time.monotonic() < end and not self.stopping:
            if os.path.exists(STOP_TRIGGER):
                self.stopping = True
                return
            self.write_status()
            await asyncio.sleep(min(1.0, max(0.0, end - time.monotonic())))

    async def run(self) -> int:
        backoff = BACKOFF_START
        while not self.stopping:
            if not read_watchlist():
                await self.idle_until_watchlist()
                continue
            started = time.monotonic()
            try:
                await self.session()
            except asyncio.CancelledError:
                raise
            except Exception as e:                              # network drop, handshake rejection, bad token file...
                self.last_error = f'{type(e).__name__}: {e}'[:300]
                print(f'[live_us_ws] {self.last_error}', flush=True)
                # Credentials / plan problems cannot be fixed by retrying, and repeated invalid connects can get the IP blocked.
                self.fatal = us_feed.classify_connect_error(e)
            if self.fatal:
                self.last_error = self.fatal
                self.status = 'ERROR'
                self.connected = False
                self.write_status()
                print(f'[live_us_ws] FATAL {self.fatal} - not retrying', flush=True)
                return 2
            if self.stopping or os.path.exists(STOP_TRIGGER):
                break
            # A session that lived a while earns a fresh, short backoff; rapid failures escalate it. The delay used is the
            # current value, and it doubles only after being used, so the first retry really waits BACKOFF_START.
            if time.monotonic() - started > 60:
                backoff = BACKOFF_START
            self.status = 'RECONNECTING'
            self.write_status()
            print(f'[live_us_ws] reconnecting in {backoff:.0f}s', flush=True)
            await self.sleep_with_heartbeat(backoff)
            backoff = min(BACKOFF_MAX, backoff * 2)
        return 0


def main() -> int:
    os.makedirs(DEBUG_DIR, exist_ok=True)
    other = another_bridge_running()
    if other:
        print(f'[live_us_ws] another bridge is already running (pid {other}) - exiting', flush=True)
        return 3
    try:
        os.remove(STOP_TRIGGER)
    except OSError:
        pass
    bridge = Bridge()
    code = 1
    try:
        code = asyncio.run(bridge.run())
    except KeyboardInterrupt:
        code = 0
    finally:
        if bridge.status != 'ERROR':
            bridge.status = 'STOPPED'
        bridge.connected = False
        bridge.subscribed = set()
        bridge.write_status()
        try:
            os.remove(STOP_TRIGGER)
        except OSError:
            pass
        print('[live_us_ws] stopped', flush=True)
    return code


if __name__ == '__main__':
    sys.exit(main())
