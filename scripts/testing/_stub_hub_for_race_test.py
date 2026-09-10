"""Stand-in for market_data_hub.py used only by test_market_hub_multiprocess_race.py,
to reproduce the real hub's slow-startup race window without needing a live Dhan
login on every iteration. Not a real bridge component — never spawned in production."""
import sys
import os
import time
import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from lib import market_hub_client as hub_client

STARTUP_DELAY_SEC = float(os.environ.get('STUB_HUB_STARTUP_DELAY', '1.5'))

# Match the real hub's actual shape: write STARTING immediately (like
# market_data_hub.py's write_status('STARTING', ...) as its very first statement),
# then go silent for the slow part of startup (master-list load takes 10-15s live,
# with no heartbeat refresh in between) before finally writing RUNNING. A stub that
# skips the STARTING write and just sleeps-then-writes-RUNNING does NOT reproduce
# the bug: with no status file at all during the delay, every caller correctly sees
# "not alive" throughout. The real bug only appears once a STARTING heartbeat goes
# stale (HEARTBEAT_STALE_SEC) before RUNNING is ever written.
hub_client._atomic_write(hub_client.hub_status_file(), {
    'status': 'STARTING',
    'pid': os.getpid(),
    'last_update': datetime.datetime.now().isoformat(),
})

time.sleep(STARTUP_DELAY_SEC)  # simulate the real hub's master-list-load + login latency

hub_client._atomic_write(hub_client.hub_status_file(), {
    'status': 'RUNNING',
    'pid': os.getpid(),
    'last_update': datetime.datetime.now().isoformat(),
})

counter_path = os.path.join(hub_client.HUB_DIR, 'spawn_counter.txt')
with open(counter_path, 'a') as f:
    f.write(f'{os.getpid()}\n')

time.sleep(3)  # stay "alive" briefly so is_hub_alive() reads True during the test window
