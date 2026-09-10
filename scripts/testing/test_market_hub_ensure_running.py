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
    """Replaces hub_client._spawn_hub for the duration of a test. By default
    simulates a hub that becomes healthy immediately (writes a fresh status file),
    since ensure_hub_running() now holds the spawn lock and polls is_hub_alive()
    until the hub reports itself alive — a mock that never does that would block
    the real HUB_STARTUP_TIMEOUT_SEC (30s) on every test. Pass become_alive=False
    to simulate a spawn that never reports healthy (tests the timeout path)."""
    def __init__(self, become_alive=True):
        self.calls = 0
        self.become_alive = become_alive

    def __call__(self):
        self.calls += 1
        if self.become_alive:
            hub_client._atomic_write(hub_client.hub_status_file(), {
                'status': 'RUNNING', 'pid': os.getpid(),
                'last_update': datetime.datetime.now().isoformat(),
            })


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


def test_spawn_lock_held_until_hub_healthy_prevents_double_spawn(tmp, recorder):
    """Direct regression test for the live-confirmed bug: ensure_hub_running() used
    to release the spawn lock immediately after Popen() returned, before the spawned
    hub ever reported itself alive. A slow-starting hub (master-list load alone took
    >10s live) left a window where a second concurrent caller saw "not alive yet"
    AND a free lock, and spawned a duplicate hub — two real Dhan connections."""
    import threading

    original_startup_timeout = hub_client.HUB_STARTUP_TIMEOUT_SEC
    hub_client.HUB_STARTUP_TIMEOUT_SEC = 5  # bound the test's own runtime

    # Simulate a SLOW hub: recorder.__call__ does NOT write a status file itself;
    # a background thread writes it after a delay, standing in for the real hub's
    # own slow startup (master-list load, login, WS connect).
    slow_recorder = SpawnRecorder(become_alive=False)
    hub_client._spawn_hub = slow_recorder

    def slow_hub_becomes_healthy_after_delay():
        time.sleep(0.5)
        hub_client._atomic_write(hub_client.hub_status_file(), {
            'status': 'RUNNING', 'pid': os.getpid(),
            'last_update': datetime.datetime.now().isoformat(),
        })

    results = {}

    def caller_a():
        results['a'] = None
        hub_client.ensure_hub_running()

    def caller_b():
        time.sleep(0.1)  # start just after A has acquired the lock and spawned
        hub_client.ensure_hub_running()

    try:
        healer = threading.Thread(target=slow_hub_becomes_healthy_after_delay)
        ta = threading.Thread(target=caller_a)
        tb = threading.Thread(target=caller_b)
        healer.start()
        ta.start()
        tb.start()
        healer.join()
        ta.join()
        tb.join()
    finally:
        hub_client.HUB_STARTUP_TIMEOUT_SEC = original_startup_timeout

    check('two concurrent ensure_hub_running() callers against a slow-starting hub '
          'result in exactly ONE spawn, not two', slow_recorder.calls == 1)
    check('the lock is released after the (simulated) hub becomes healthy',
          not os.path.exists(hub_client.hub_lock_file()))


def test_stale_but_alive_hub_is_killed_before_respawn(tmp, recorder):
    """Regression test for the live-confirmed accumulation bug: a hub whose heartbeat
    went stale (WS hiccup, stuck retry loop) but whose process never actually died
    used to be left running while a replacement spawned on top of it — repeated over
    a session this accumulated up to 7 concurrent hub processes, each holding its own
    real Dhan WebSocket connection. ensure_hub_running() must terminate the old pid
    before spawning a new one."""
    import psutil as psutil_module

    hub_client._atomic_write(hub_client.hub_status_file(), {
        'status': 'RUNNING', 'pid': os.getpid(),  # alive (it's this test process)
        'last_update': (datetime.datetime.now()
                         - datetime.timedelta(seconds=hub_client.HEARTBEAT_STALE_SEC + 5)
                         ).isoformat(),  # but stale
    })

    terminated = []
    original_process = psutil_module.Process

    class FakeProcess:
        def __init__(self, pid):
            self.pid = pid

        def name(self):
            return 'python.exe'

        def terminate(self):
            terminated.append(self.pid)

    psutil_module.Process = FakeProcess
    try:
        hub_client.ensure_hub_running()
    finally:
        psutil_module.Process = original_process

    check('a stale-but-alive hub pid is terminated before a replacement is spawned',
          terminated == [os.getpid()])
    check('a replacement hub is spawned after the stale one is killed',
          recorder.calls == 1)


def test_dead_pid_is_not_sent_a_terminate(tmp, recorder):
    """_kill_stale_hub must not call psutil.Process() for a pid that's already dead —
    is_pid_running() gates it first. (The default SpawnRecorder writes a healthy status
    naming THIS test process's own pid once the spawn happens, and ensure_hub_running's
    own post-spawn health poll legitimately calls psutil.Process on that — so this
    checks the dead pid specifically was never passed, not that Process was never
    called at all.)"""
    import psutil as psutil_module

    dead_pid = 999_999_999
    hub_client._atomic_write(hub_client.hub_status_file(), {
        'status': 'RUNNING', 'pid': dead_pid,
        'last_update': datetime.datetime.now().isoformat(),
    })

    called = []
    original_process = psutil_module.Process
    psutil_module.Process = lambda pid: called.append(pid) or original_process(pid)
    try:
        hub_client.ensure_hub_running()
    finally:
        psutil_module.Process = original_process

    check('a dead pid is never passed to psutil.Process/terminate', dead_pid not in called)
    check('a replacement hub is still spawned for a dead pid',
          recorder.calls == 1)


def test_spawn_lock_released_after_startup_timeout(tmp, recorder):
    """If the spawned hub never reports healthy at all, ensure_hub_running() must
    still release the lock eventually (bounded by HUB_STARTUP_TIMEOUT_SEC) rather
    than deadlocking every future call."""
    original_startup_timeout = hub_client.HUB_STARTUP_TIMEOUT_SEC
    hub_client.HUB_STARTUP_TIMEOUT_SEC = 0.3  # bound the test's own runtime

    never_alive = SpawnRecorder(become_alive=False)
    hub_client._spawn_hub = never_alive
    try:
        hub_client.ensure_hub_running()
    finally:
        hub_client.HUB_STARTUP_TIMEOUT_SEC = original_startup_timeout

    check('a spawn that never reports healthy still releases the lock after '
          'HUB_STARTUP_TIMEOUT_SEC (no permanent deadlock)',
          not os.path.exists(hub_client.hub_lock_file()))


def run():
    with_temp_hub_dir(test_spawns_when_nothing_running)
    with_temp_hub_dir(test_noop_when_hub_already_healthy)
    with_temp_hub_dir(test_spawns_when_hub_status_names_dead_pid)
    with_temp_hub_dir(test_lock_prevents_double_spawn_when_held_fresh)
    with_temp_hub_dir(test_stale_lock_is_stolen_and_spawns)
    with_temp_hub_dir(test_spawn_lock_held_until_hub_healthy_prevents_double_spawn)
    with_temp_hub_dir(test_stale_but_alive_hub_is_killed_before_respawn)
    with_temp_hub_dir(test_dead_pid_is_not_sent_a_terminate)
    with_temp_hub_dir(test_spawn_lock_released_after_startup_timeout)

    print(f'\n{len(PASS)} passed, {len(FAIL)} failed')
    return len(FAIL) == 0


if __name__ == '__main__':
    ok = run()
    sys.exit(0 if ok else 1)
