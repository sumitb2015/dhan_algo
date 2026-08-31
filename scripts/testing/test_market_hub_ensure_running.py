"""
Pure-mock tests for lib/market_hub_client.py's ensure_hub_running() spawn/lock/steal
logic. subprocess.Popen is monkeypatched out — nothing here ever actually spawns a
process. No login, no network, no live market required — run any time:

    venv\\Scripts\\python.exe scripts/testing/test_market_hub_ensure_running.py
"""
import os
import sys
import time
import datetime
import tempfile
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from lib import market_hub_client as hub_client

PASS = []
FAIL = []


def check(name, condition):
    if condition:
        PASS.append(name)
        print(f'[OK] {name}')
    else:
        FAIL.append(name)
        print(f'[FAIL] {name}')


class SpawnRecorder:
    """Replaces hub_client._spawn_hub for the duration of a test."""
    def __init__(self):
        self.calls = 0

    def __call__(self):
        self.calls += 1


def with_temp_hub_dir(fn):
    tmp = tempfile.mkdtemp(prefix='market_hub_ensure_test_')
    original_dir = hub_client.HUB_DIR
    original_spawn = hub_client._spawn_hub
    hub_client.HUB_DIR = tmp
    recorder = SpawnRecorder()
    hub_client._spawn_hub = recorder
    try:
        fn(tmp, recorder)
    finally:
        hub_client.HUB_DIR = original_dir
        hub_client._spawn_hub = original_spawn
        shutil.rmtree(tmp, ignore_errors=True)


def test_spawns_when_nothing_running(tmp, recorder):
    hub_client.ensure_hub_running()
    check('ensure_hub_running spawns when no status file exists at all',
          recorder.calls == 1)


def test_noop_when_hub_already_healthy(tmp, recorder):
    hub_client._atomic_write(hub_client.hub_status_file(), {
        'status': 'RUNNING', 'pid': os.getpid(),
        'last_update': datetime.datetime.now().isoformat(),
    })
    hub_client.ensure_hub_running()
    check('ensure_hub_running does NOT spawn when the hub is alive and heartbeating',
          recorder.calls == 0)


def test_spawns_when_hub_status_names_dead_pid(tmp, recorder):
    hub_client._atomic_write(hub_client.hub_status_file(), {
        'status': 'RUNNING', 'pid': 999_999_999,
        'last_update': datetime.datetime.now().isoformat(),
    })
    hub_client.ensure_hub_running()
    check('ensure_hub_running spawns a replacement when the status file names a dead pid',
          recorder.calls == 1)


def test_lock_prevents_double_spawn_when_held_fresh(tmp, recorder):
    # Simulate another bridge mid-spawn: it holds a fresh lock, and by the time our
    # caller's wait-loop gives up, the other bridge "finished" (hub_status now healthy).
    hub_client._acquire_spawn_lock()
    # Instead of sleeping the real SPAWN_WAIT_TIMEOUT_SEC, patch it down so this test
    # runs fast, then write a healthy status partway through the wait window.
    original_timeout = hub_client.SPAWN_WAIT_TIMEOUT_SEC
    hub_client.SPAWN_WAIT_TIMEOUT_SEC = 1
    try:
        import threading
        def finish_the_other_spawn():
            time.sleep(0.3)
            hub_client._atomic_write(hub_client.hub_status_file(), {
                'status': 'RUNNING', 'pid': os.getpid(),
                'last_update': datetime.datetime.now().isoformat(),
            })
        t = threading.Thread(target=finish_the_other_spawn)
        t.start()
        hub_client.ensure_hub_running()
        t.join()
    finally:
        hub_client.SPAWN_WAIT_TIMEOUT_SEC = original_timeout
        hub_client._release_spawn_lock()

    check('a caller that loses the lock race waits, and does not spawn once the '
          'lock-holder\'s hub becomes healthy', recorder.calls == 0)


def test_stale_lock_is_stolen_and_spawns(tmp, recorder):
    hub_client._acquire_spawn_lock()
    old = time.time() - (hub_client.LOCK_STALE_MS / 1000 + 5)
    os.utime(hub_client.hub_lock_file(), (old, old))

    hub_client.ensure_hub_running()
    check('a stale lock (older than LOCK_STALE_MS) is stolen and the hub is spawned',
          recorder.calls == 1)
    check('stealing the lock releases it afterward (no dangling lock file)',
          not os.path.exists(hub_client.hub_lock_file()))


def run():
    with_temp_hub_dir(test_spawns_when_nothing_running)
    with_temp_hub_dir(test_noop_when_hub_already_healthy)
    with_temp_hub_dir(test_spawns_when_hub_status_names_dead_pid)
    with_temp_hub_dir(test_lock_prevents_double_spawn_when_held_fresh)
    with_temp_hub_dir(test_stale_lock_is_stolen_and_spawns)

    print(f'\n{len(PASS)} passed, {len(FAIL)} failed')
    return len(FAIL) == 0


if __name__ == '__main__':
    ok = run()
    sys.exit(0 if ok else 1)
