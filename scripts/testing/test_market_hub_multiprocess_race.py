"""
Real multi-PROCESS (not thread) stress test for ensure_hub_running()'s spawn lock,
using a fast stub hub (see _stub_hub_for_race_test.py) instead of the real
market_data_hub.py so this needs no Dhan login and runs in a few seconds.

This is the test that actually caught the double-spawn bug live testing found —
threading-based tests in test_market_hub_ensure_running.py exercise the same code
path within one process/one GIL, which did not reproduce the real cross-process
Windows file-locking behavior. Run any time:

    venv\\Scripts\\python.exe scripts/testing/test_market_hub_multiprocess_race.py
"""
import os
import sys
import time
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from lib import market_hub_client as hub_client

WORKER_SCRIPT = os.path.join(ROOT, 'scripts', 'testing', '_worker_for_race_test.py')
N_WORKERS = 8

# The real hub writes STARTING immediately, then goes silent (no heartbeat refresh)
# for its slow master-list-load phase before finally writing RUNNING — observed
# live at 10-15s. Set the stub's delay comfortably past HEARTBEAT_STALE_SEC (10s
# in lib/market_hub_client.py) so a late-arriving caller's is_hub_alive() check can
# see a genuinely stale STARTING heartbeat, exactly like a bridge that spends 20s+
# on its own REST calls (retries, rate limits) before ever calling
# ensure_hub_running() for the first time.
STUB_STARTUP_DELAY_SEC = 13

PASS = []
FAIL = []


def check(name, condition):
    if condition:
        PASS.append(name)
        print(f'[OK] {name}')
    else:
        FAIL.append(name)
        print(f'[FAIL] {name}')


def run():
    # Use the real debug/market_hub dir (not a temp dir) so this exercises the
    # exact filesystem/locking behavior production bridges hit — clean it first.
    import shutil
    if os.path.isdir(hub_client.HUB_DIR):
        shutil.rmtree(hub_client.HUB_DIR)
    os.makedirs(hub_client.HUB_DIR, exist_ok=True)

    env = dict(os.environ, STUB_HUB_STARTUP_DELAY=str(STUB_STARTUP_DELAY_SEC))

    print(f'Launching {N_WORKERS} real worker processes — 5 immediately, 3 staggered '
          f'past the heartbeat-stale window — against a hub with a {STUB_STARTUP_DELAY_SEC}s '
          f'startup delay…')
    procs = [subprocess.Popen([sys.executable, WORKER_SCRIPT], env=env) for _ in range(5)]
    # Stagger the remaining callers so at least one lands after the STARTING
    # heartbeat has gone stale (HEARTBEAT_STALE_SEC=10s) but before RUNNING is
    # written — the exact window that caused the live double-spawn. Popen is
    # non-blocking, so sleeping here doesn't pause the already-launched processes.
    elapsed = 0.0
    for target in (11, 12, 13.5):
        time.sleep(max(0.0, target - elapsed))
        elapsed = target
        procs.append(subprocess.Popen([sys.executable, WORKER_SCRIPT], env=env))
    for p in procs:
        p.wait(timeout=30)

    # Give the (possibly multiple) stub hub(s) time to finish their startup delay
    # and write to the counter file.
    time.sleep(STUB_STARTUP_DELAY_SEC + 2)

    counter_path = os.path.join(hub_client.HUB_DIR, 'spawn_counter.txt')
    spawned_pids = []
    if os.path.exists(counter_path):
        with open(counter_path) as f:
            spawned_pids = [line.strip() for line in f if line.strip()]

    check(f'{N_WORKERS} concurrent ensure_hub_running() callers against a slow-starting '
          f'hub result in exactly ONE spawn (got {len(spawned_pids)}: {spawned_pids})',
          len(spawned_pids) == 1)
    check('no dangling spawn lock file left after the race resolves',
          not os.path.exists(hub_client.hub_lock_file()))

    shutil.rmtree(hub_client.HUB_DIR, ignore_errors=True)

    print(f'\n{len(PASS)} passed, {len(FAIL)} failed')
    return len(FAIL) == 0


if __name__ == '__main__':
    ok = run()
    sys.exit(0 if ok else 1)
