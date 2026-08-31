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
SPAWN_WAIT_TIMEOUT_SEC = 10     # how long a caller waits for a racing spawn to finish


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
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f)
    os.replace(tmp, path)


def _atomic_read(path: str):
    """Returns the parsed JSON dict, or None if missing/corrupt/mid-write.

    A reader can observe a momentarily-absent file (hub cold-start, or a writer
    between unlink and the atomic os.replace on some filesystems) — never raise,
    every caller in this module treats None as "nothing there yet".
    """
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
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
    """True iff hub_status.json names a live pid with a recent heartbeat.

    The status file is data, not a lock — this only ever gates whether to spawn a
    new hub, never used to prevent a race (see ensure_hub_running's atomic lock).
    """
    status = _atomic_read(hub_status_file())
    if not status or status.get('status') not in ('STARTING', 'RUNNING'):
        return False
    if not is_pid_running(status.get('pid')):
        return False
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
    (or the caller's own staleness check on read_live_data()) tries again."""
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

def read_live_data() -> dict:
    """Returns {security_id: tick_dict}. Empty dict if the hub hasn't written yet or
    the file is momentarily unreadable — callers already treat a missing tick per
    instrument as "no data this cycle" (pre-existing behavior), so this never raises."""
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
