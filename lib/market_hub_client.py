"""
Shared client for the Market Data Hub (scripts/tools/market_data_hub.py).

Four dashboard bridges (live_equity_ws.py, live_indices_ws.py, live_options_ws.py,
focus_tool_ws.py) used to each open their own independent Dhan WebSocket connection.
Dhan caps concurrent connections per account, and opening several live dashboard pages
at once was hitting that cap. The hub owns exactly ONE DhanHelper/WebSocket connection;
each bridge becomes a thin consumer that tells the hub what it wants (via a registry
file) and reads merged ticks back (via a shared live-data file), using the same
file-based IPC idiom already used everywhere else in this repo (debug/*.json,
temp-write + os.replace, stop-trigger files) rather than introducing a new dependency.

This module intentionally does not import lib/dhan_helper.py — it has no opinion on
market data itself, only on hub discovery/liveness/registry bookkeeping, so it stays
testable with zero login/network dependency (see scripts/testing/test_market_hub_*.py).
"""
import os
import sys
import time
import json
import subprocess
from datetime import datetime

import psutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HUB_SCRIPT = os.path.join(ROOT, 'scripts', 'tools', 'market_data_hub.py')

# HUB_DIR is the one mutable knob: tests monkeypatch this module attribute to a
# tempfile.mkdtemp() before calling anything else, and every path below is derived
# from it at call time (not baked in at import time) so the redirect actually takes.
HUB_DIR = os.path.join(ROOT, 'debug', 'market_hub')

LOCK_STALE_MS = 30_000          # mirrors app/api/options/live/route.ts's LOCK_STALE_MS
HEARTBEAT_STALE_SEC = 10        # hub writes a heartbeat ~every 3s; 10s = 3 missed cycles
WANTED_STALE_SEC = 60           # hard backstop GC even if the pid check is ever wrong

# The hub's own startup (master-list load + login + WS connect) was observed taking
# up to ~13-15s live — both of these must comfortably exceed that, or a second
# caller can win the lock (or give up waiting) before the first caller's freshly
# spawned hub ever reports itself alive, causing a genuine double-spawn. This was
# caught by live testing (two "Market data hub starting" lines ~15s apart, then two
# interleaved sets of subscribe/unsubscribe logs — two real Dhan connections).
HUB_STARTUP_TIMEOUT_SEC = 30    # how long the spawning caller holds the lock, polling
SPAWN_WAIT_TIMEOUT_SEC = 30     # how long a losing caller waits before giving up


def hub_status_file() -> str:
    return os.path.join(HUB_DIR, 'hub_status.json')


def hub_lock_file() -> str:
    return os.path.join(HUB_DIR, 'hub_spawn.lock')


def hub_live_data_file() -> str:
    return os.path.join(HUB_DIR, 'live_data.json')


def hub_log_file() -> str:
    return os.path.join(HUB_DIR, 'hub.log')


def _wanted_file(consumer_name: str) -> str:
    return os.path.join(HUB_DIR, f'wanted_{consumer_name}.json')


def _atomic_write(path: str, data: dict):
    """Never raises — a dropped write (e.g. transient Windows file-lock contention,
    the same race _atomic_read tolerates) just means this cycle's write is skipped;
    every writer in this module runs on a loop and retries on its next cycle."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w') as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except (PermissionError, OSError):
        pass


def _atomic_read(path: str):
    """Returns the parsed JSON dict, or None if missing/corrupt/mid-write.

    A reader can observe a momentarily-absent file (hub cold-start, or a writer
    between unlink and the atomic os.replace on some filesystems). On Windows,
    a reader can also observe a transient PermissionError if it opens the file in
    the narrow window where another process still holds a handle open during its
    own os.replace() — os.replace is atomic with respect to the FILE CONTENTS a
    reader sees, but Windows file-locking semantics can still deny a concurrent
    open() for a few milliseconds around the rename (confirmed live: crashed
    live_options_ws.py with an uncaught PermissionError reading hub_status.json).
    Every caller in this module treats None as "nothing there yet" — this must
    never raise.
    """
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, PermissionError):
        return None


def is_pid_running(pid) -> bool:
    if not pid:
        return False
    try:
        return psutil.pid_exists(int(pid))
    except (TypeError, ValueError):
        return False


# --- Hub liveness / spawn -------------------------------------------------

def is_hub_alive() -> bool:
    """True iff hub_status.json names a live pid that's either RUNNING with a
    recent heartbeat, or still STARTING at all.

    STARTING gets no heartbeat-freshness requirement, only a PID-liveness check.
    The real hub writes STARTING once as its very first statement, then does
    master-list load + login + WS connect (observed live: 10-15s+) before its next
    write, when it flips to RUNNING. HEARTBEAT_STALE_SEC (10s) is shorter than that
    gap — requiring a fresh heartbeat during STARTING meant a caller whose own
    pre-hub REST work (e.g. focus_tool_ws.py's prev-day-chain fetch with 429
    retries) took long enough to reach ensure_hub_running() after the original
    STARTING write had gone stale, but before RUNNING was ever written, saw
    "not alive" with a free lock and spawned a SECOND hub — confirmed live (two
    real Dhan connections) and reproduced by
    scripts/testing/test_market_hub_multiprocess_race.py. A hub that is merely
    slow to finish starting is not the same as a hub that crashed; PID-liveness
    alone is the right signal for "still legitimately starting."

    RUNNING still requires heartbeat freshness — by then the hub is in its normal
    ~3s registry-scan/heartbeat cadence, so a stale heartbeat there really does
    mean something's wrong (hung, deadlocked) even though the PID is still alive.

    The status file is data, not a lock — this only ever gates whether to spawn a
    new hub, never used to prevent a race (see ensure_hub_running's atomic lock).
    """
    status = _atomic_read(hub_status_file())
    if not status or status.get('status') not in ('STARTING', 'RUNNING'):
        return False
    if not is_pid_running(status.get('pid')):
        return False
    if status['status'] == 'STARTING':
        return True
    try:
        last_update = datetime.fromisoformat(status['last_update'])
    except (KeyError, ValueError):
        return False
    age = (datetime.now() - last_update).total_seconds()
    return age < HEARTBEAT_STALE_SEC


def _lock_is_stale() -> bool:
    try:
        age_ms = (time.time() - os.path.getmtime(hub_lock_file())) * 1000
        return age_ms > LOCK_STALE_MS
    except OSError:
        return True  # lock file vanished between the exists-check and stat — treat as gone


def _acquire_spawn_lock() -> bool:
    """Atomic create-exclusive lock, with a stale-lock steal — same flag:'wx' + steal
    pattern already used in app/api/options/live/route.ts, ported to Python."""
    os.makedirs(HUB_DIR, exist_ok=True)
    try:
        fd = os.open(hub_lock_file(), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except FileExistsError:
        if _lock_is_stale():
            try:
                os.remove(hub_lock_file())
            except OSError:
                return False
            return _acquire_spawn_lock()
        return False


def _release_spawn_lock():
    try:
        os.remove(hub_lock_file())
    except OSError:
        pass


def _spawn_hub():
    os.makedirs(HUB_DIR, exist_ok=True)
    log_fd = open(hub_log_file(), 'a')
    kwargs = dict(stdin=subprocess.DEVNULL, stdout=log_fd, stderr=log_fd, close_fds=True)
    if os.name == 'nt':
        # DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP: survives the spawning bridge
        # exiting or the dashboard's dev server restarting, same convention as the
        # existing detached: true spawns in rs_dashboard's API routes.
        kwargs['creationflags'] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs['start_new_session'] = True
    subprocess.Popen([sys.executable, HUB_SCRIPT], **kwargs)


def ensure_hub_running():
    """Idempotent — safe to call from any bridge's startup AND periodically from its
    main loop, so a hub that dies mid-session gets respawned without restarting the
    bridge. Never raises; a transient failure here just means the next periodic call
    (or the caller's own staleness check on read_live_data()) tries again.

    Holds the spawn lock for the ENTIRE duration of the hub's startup (until it
    reports itself alive, or HUB_STARTUP_TIMEOUT_SEC elapses) rather than releasing
    it right after Popen() returns. Releasing early leaves a window — the hub's own
    master-list load alone can take over 10s — where a second caller sees "not
    alive yet" and a free lock, and spawns a second hub. Confirmed live: two hub
    processes running concurrently, each with its own real Dhan WebSocket
    connection, defeating the entire point of this module.
    """
    if is_hub_alive():
        return
    if not _acquire_spawn_lock():
        # Another bridge is presumably mid-spawn — wait for it rather than racing.
        deadline = time.monotonic() + SPAWN_WAIT_TIMEOUT_SEC
        while time.monotonic() < deadline:
            if is_hub_alive():
                return
            time.sleep(0.5)
        return
    try:
        if is_hub_alive():  # double-check: the lock holder may have finished already
            return
        _spawn_hub()
        deadline = time.monotonic() + HUB_STARTUP_TIMEOUT_SEC
        while time.monotonic() < deadline:
            if is_hub_alive():
                return
            time.sleep(0.5)
        # Timed out still holding the lock — release below regardless (never block
        # forever) so a subsequent call can retry rather than deadlock permanently.
    finally:
        _release_spawn_lock()


# --- Registry (instrument discovery) --------------------------------------

def register_wanted(consumer_name: str, instruments):
    """instruments: list of (exchange_segment, security_id, feed_type) tuples, the
    exact same shape a bridge used to pass to helper.start_websocket() directly."""
    _atomic_write(_wanted_file(consumer_name), {
        'consumer': consumer_name,
        'pid': os.getpid(),
        'updated_at': datetime.now().isoformat(),
        'instruments': [list(i) for i in instruments],
    })


def unregister_wanted(consumer_name: str):
    """Best-effort delete on graceful bridge shutdown — speeds up hub convergence
    versus waiting for the hub's own PID-staleness GC to notice."""
    try:
        os.remove(_wanted_file(consumer_name))
    except OSError:
        pass


def list_live_registry_entries():
    """Used by the hub only: every wanted_*.json whose pid is alive and whose file
    isn't older than the WANTED_STALE_SEC backstop. Returns a list of parsed dicts."""
    if not os.path.isdir(HUB_DIR):
        return []
    live = []
    for name in os.listdir(HUB_DIR):
        if not (name.startswith('wanted_') and name.endswith('.json')):
            continue
        path = os.path.join(HUB_DIR, name)
        entry = _atomic_read(path)
        if not entry:
            continue
        if not is_pid_running(entry.get('pid')):
            continue
        try:
            age = time.time() - os.path.getmtime(path)
        except OSError:
            continue
        if age >= WANTED_STALE_SEC:
            continue
        live.append(entry)
    return live


# --- Shared ticks (read side) ----------------------------------------------

def tick_key(exchange_segment, security_id) -> str:
    """Composite key for the shared tick dict — segment AND security_id, never
    security_id alone.

    DhanHelper.live_data (lib/dhan_helper.py) keys purely by raw security_id, with
    no segment. That was safe when every bridge had its own isolated DhanHelper
    instance subscribed to only one kind of instrument space (equity-only, index-
    only, or options+index+VIX) — no single bridge's own instrument set ever mixed
    segments enough to collide. The shared hub subscribes across ALL 4 bridges'
    segments at once, and Dhan's security IDs are only unique WITHIN a segment:
    confirmed live, ADANIENT (NSE_EQ, id 25) and BANKNIFTY (IDX, id 25) share the
    same raw id — under bare-sid keying, whichever ticked most recently silently
    overwrote the other's entry, so BANKNIFTY's spot briefly showed ADANIENT's LTP
    on the Focus Tool page. market_data_hub.py maintains its own merged-tick dict
    keyed by tick_key(), independent of (and not reading from) helper.live_data,
    specifically to avoid this. Every reader must look up by tick_key(seg, sid),
    never by bare sid."""
    return f'{exchange_segment}:{security_id}'


def read_live_data() -> dict:
    """Returns {tick_key(segment, security_id): tick_dict}. Empty dict if the hub
    hasn't written yet or the file is momentarily unreadable — callers already
    treat a missing tick per instrument as "no data this cycle" (pre-existing
    behavior), so this never raises."""
    data = _atomic_read(hub_live_data_file())
    if not data:
        return {}
    return data.get('ticks', {})


def live_data_updated_at():
    """Returns the hub's last live_data.json write time as a float epoch, or None."""
    try:
        return os.path.getmtime(hub_live_data_file())
    except OSError:
        return None
