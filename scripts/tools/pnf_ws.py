"""
Point & Figure WebSocket bridge — the P&F page's live price from the shared Market Data Hub.

  dashboard  ->  debug/pnf_ws_wanted_<pid>.json   {"instruments": [["NSE_EQ", "1333"], ...]}
                 (one file per dashboard server process; files older than WANTED_STALE_SEC are ignored)
  this bridge -> market_hub_client.register_wanted('pnf', ...)   (ONE shared Dhan connection, no new one)
  this bridge -> debug/pnf_ws_quotes.json
                 {"updated_ms", "hub_alive", "quotes": {"NSE_EQ:1333": {"ltp", "ltt", "volume", "prev_close",
                                                                  "changed_ms", "since_ms"}}}

`changed_ms` is when the tick's content last CHANGED while this bridge was asking for it (null until it does). The hub
keeps an instrument's last tick and Dhan replays it on (re)subscribe, so a price merely being present says nothing about
its age: the reader decides freshness from `changed_ms`, never from the file's write time.

  this bridge -> debug/pnf_ticks/<IST date>/<SEG>_<sid>.jsonl   one [ms, ltp, volume] line per CHANGED price (Renko "Tick" mode)

The tick log holds only changes seen while the instrument was asked for (never the replayed last tick on subscribe), stamped
with this bridge's clock like `changed_ms`; day folders older than TICK_KEEP_DAYS are deleted at start.

Started by the dashboard on demand (O_EXCL start lock); exits on debug/pnf_ws_stop.trigger or after IDLE_EXIT_SEC with
nothing wanted. Read-only: no orders.
"""
import glob
import json
import os
import signal
import sys
import shutil
import time
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from lib import market_hub_client as hub_client

DEBUG_DIR = os.path.join(ROOT, 'debug')
WANTED_GLOB = os.path.join(DEBUG_DIR, 'pnf_ws_wanted_*.json')
QUOTES_FILE = os.path.join(DEBUG_DIR, 'pnf_ws_quotes.json')
STATUS_FILE = os.path.join(DEBUG_DIR, 'pnf_ws_status.json')
STOP_TRIGGER = os.path.join(DEBUG_DIR, 'pnf_ws_stop.trigger')
TICKS_DIR = os.path.join(DEBUG_DIR, 'pnf_ticks')
TICK_KEEP_DAYS = 5
IST = timezone(timedelta(hours=5, minutes=30))

CONSUMER = 'pnf'
# Dhan marketfeed segment codes (price_ladder_ws.py / live_options_ws.py use the same): index, NSE cash, NSE F&O, MCX.
SEGMENTS = {'IDX_I': 0, 'NSE_EQ': 1, 'NSE_FNO': 2, 'MCX_COMM': 5}
FEED_QUOTE = 17          # Quote packets: an MCX contract sends nothing in Full mode while shut
LOOP_SEC = 0.25
WRITE_SEC = 0.5
REGISTER_SEC = 5         # well under market_hub_client.WANTED_STALE_SEC (60 s)
WANTED_STALE_SEC = 60    # a dashboard process that stopped refreshing its file is gone
HEARTBEAT_STALE_SEC = 10
IDLE_EXIT_SEC = 600


def atomic_write(path: str, data: dict) -> None:
    tmp = f'{path}.{os.getpid()}.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f)
    os.replace(tmp, path)


def now_ms() -> int:
    return int(time.time() * 1000)


def read_wanted() -> set:
    """Union of every live dashboard process's request: {(segment_name, security_id)}."""
    out = set()
    for path in glob.glob(WANTED_GLOB):
        try:
            if time.time() - os.path.getmtime(path) > WANTED_STALE_SEC:
                continue
            with open(path) as f:
                data = json.load(f)
            for seg, sid in (data.get('instruments') or []):
                if seg in SEGMENTS and str(sid).isdigit():
                    out.add((seg, str(sid)))
        except (OSError, ValueError, TypeError):
            continue    # mid-write or malformed: the next pass reads it
    return out


def another_bridge_alive() -> bool:
    try:
        with open(STATUS_FILE) as f:
            st = json.load(f)
    except (OSError, ValueError):
        return False
    pid = st.get('pid')
    fresh = time.time() * 1000 - float(st.get('heartbeat_ms') or 0) < HEARTBEAT_STALE_SEC * 1000
    return bool(pid) and int(pid) != os.getpid() and fresh and hub_client.is_pid_running(pid)


def fingerprint(tick: dict) -> tuple:
    return (tick.get('LTP'), tick.get('LTT'), tick.get('volume'))


def num(tick: dict, key: str) -> float:
    try:
        return float(tick.get(key) or 0)
    except (TypeError, ValueError):
        return 0.0


def ist_date(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, IST).strftime('%Y-%m-%d')


def prune_tick_days(root: str, today: str, keep: int = TICK_KEEP_DAYS) -> None:
    """Deletes day folders (YYYY-MM-DD) more than `keep` days before `today`; anything else in `root` is left alone."""
    try:
        cutoff = (datetime.strptime(today, '%Y-%m-%d') - timedelta(days=keep)).strftime('%Y-%m-%d')
        names = os.listdir(root)
    except (OSError, ValueError):
        return
    for name in names:
        try:
            datetime.strptime(name, '%Y-%m-%d')
        except ValueError:
            continue
        if name < cutoff:
            shutil.rmtree(os.path.join(root, name), ignore_errors=True)


class TickLog:
    """Appends one JSON line [ms, ltp, volume] per changed price to <root>/<IST date>/<SEG>_<sid>.jsonl. Read by the dashboard's
    /api/straddle-pnf/ticks route (Renko Tick mode). Files are opened in append mode per day and flushed each pass."""

    def __init__(self, root: str):
        self.root = root
        self.day = None
        self.files: dict = {}
        self.last: dict = {}    # key -> (ltp, volume) last written

    def _close(self) -> None:
        for f in self.files.values():
            try:
                f.close()
            except OSError:
                pass
        self.files = {}

    def append(self, key: str, ms: int, ltp: float, volume: float) -> bool:
        """Writes the tick unless it repeats the last one written for `key`. Returns whether a line was written."""
        if not (ltp > 0):
            return False
        day = ist_date(ms)
        if day != self.day:
            self._close()
            self.day = day
            self.last = {}
        vol = int(volume) if volume > 0 else 0
        if self.last.get(key) == (ltp, vol):
            return False
        f = self.files.get(key)
        if f is None:
            folder = os.path.join(self.root, day)
            os.makedirs(folder, exist_ok=True)
            f = self.files[key] = open(os.path.join(folder, key.replace(':', '_') + '.jsonl'), 'a')
        f.write(json.dumps([ms, ltp, vol]) + '\n')
        self.last[key] = (ltp, vol)
        return True

    def flush(self) -> None:
        for f in self.files.values():
            try:
                f.flush()
            except OSError:
                pass

    def close(self) -> None:
        self._close()


def main() -> None:
    # A plain kill (SIGTERM) must still unregister from the hub and mark the status STOPPED (the finally below).
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    os.makedirs(DEBUG_DIR, exist_ok=True)
    if another_bridge_alive():
        print('[pnf_ws] another bridge is already running — exiting', flush=True)
        return
    started = datetime.now().isoformat()
    print(f'[pnf_ws] started pid={os.getpid()}', flush=True)

    since: dict = {}          # key -> ms we started asking for it
    last_fp: dict = {}        # key -> tick fingerprint last seen while asked for
    changed: dict = {}        # key -> ms its content last changed while asked for
    registered: list = []
    last_register = 0.0
    last_write = 0.0
    idle_since = time.time()
    os.makedirs(TICKS_DIR, exist_ok=True)
    prune_tick_days(TICKS_DIR, ist_date(now_ms()))
    tick_log = TickLog(TICKS_DIR)

    try:
        while True:
            if os.path.exists(STOP_TRIGGER):
                try:
                    os.remove(STOP_TRIGGER)
                except OSError:
                    pass
                print('[pnf_ws] stop trigger — exiting', flush=True)
                break

            wanted = read_wanted()
            t = time.time()
            ms = now_ms()
            keys = {f'{SEGMENTS[seg]}:{sid}': (seg, sid) for seg, sid in wanted}
            for k in list(since):
                if k not in keys:
                    since.pop(k, None); last_fp.pop(k, None); changed.pop(k, None)
            for k in keys:
                since.setdefault(k, ms)

            instruments = sorted([SEGMENTS[seg], sid, FEED_QUOTE] for seg, sid in wanted)
            if instruments != registered or t - last_register >= REGISTER_SEC:
                if instruments:
                    hub_client.register_wanted(CONSUMER, [tuple(i) for i in instruments])
                    # A no-op while the hub's own heartbeat is fresh; respawns a dead hub.
                    hub_client.ensure_hub_running()
                else:
                    hub_client.unregister_wanted(CONSUMER)
                registered = instruments
                last_register = t

            if wanted:
                idle_since = t
            elif t - idle_since > IDLE_EXIT_SEC:
                print('[pnf_ws] nothing wanted for 10 min — exiting', flush=True)
                break

            if t - last_write >= WRITE_SEC:
                ticks = hub_client.read_live_data()
                # The tick log is stamped at the write itself (not the pass start, which a slow hub register can delay): the
                # dashboard serves rows only once they are SETTLE_MS old, so a row must be on disk within that of its stamp.
                write_ms = now_ms()
                quotes = {}
                for k, (seg, sid) in keys.items():
                    tick = ticks.get(k)
                    if not tick:
                        continue
                    fp = fingerprint(tick)
                    moved = k in last_fp and last_fp[k] != fp
                    if moved:
                        changed[k] = ms
                    last_fp[k] = fp
                    ltp = num(tick, 'LTP')
                    if moved and ltp > 0:
                        try:
                            tick_log.append(f'{seg}:{sid}', write_ms, ltp, num(tick, 'volume'))
                        except OSError as e:
                            print(f'[pnf_ws] tick log write failed: {e}', flush=True)
                    if ltp > 0:
                        q = {'ltp': ltp, 'ltt': tick.get('LTT'), 'changed_ms': changed.get(k), 'since_ms': since[k]}
                        # A Quote packet's `close` is the PREVIOUS session's close while the session runs.
                        if num(tick, 'close') > 0:
                            q['prev_close'] = num(tick, 'close')
                        if num(tick, 'volume') > 0:
                            q['volume'] = num(tick, 'volume')
                        quotes[f'{seg}:{sid}'] = q
                tick_log.flush()
                atomic_write(QUOTES_FILE, {'updated_ms': ms, 'hub_alive': hub_client.is_hub_alive(), 'quotes': quotes})
                atomic_write(STATUS_FILE, {'status': 'RUNNING', 'pid': os.getpid(), 'started_at': started,
                                           'heartbeat_ms': ms, 'subscribed': len(instruments)})
                last_write = t
            time.sleep(LOOP_SEC)
    finally:
        tick_log.close()
        hub_client.unregister_wanted(CONSUMER)
        try:
            atomic_write(STATUS_FILE, {'status': 'STOPPED', 'pid': os.getpid(), 'heartbeat_ms': now_ms()})
        except OSError:
            pass


if __name__ == '__main__':
    main()
