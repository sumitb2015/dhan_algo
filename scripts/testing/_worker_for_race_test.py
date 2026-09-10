"""Worker process for test_market_hub_multiprocess_race.py — calls ensure_hub_running()
against the real HUB_DIR, pointed at the stub hub instead of the real one."""
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from lib import market_hub_client as hub_client

hub_client.HUB_SCRIPT = os.path.join(ROOT, 'scripts', 'testing', '_stub_hub_for_race_test.py')
hub_client.ensure_hub_running()
