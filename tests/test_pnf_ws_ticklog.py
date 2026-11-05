"""scripts/tools/pnf_ws.py's tick log (Renko Tick mode): append-on-change, one folder per IST day, pruning.

Pure file I/O in a temp directory: no Dhan, no hub. Run:  venv/bin/python -m unittest tests.test_pnf_ws_ticklog   (project root)
"""
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The bridge imports the hub client at module level; a stub keeps this test off the real hub.
sys.modules.setdefault('lib.market_hub_client', types.ModuleType('lib.market_hub_client'))
spec = importlib.util.spec_from_file_location('pnf_ws', os.path.join(ROOT, 'scripts', 'tools', 'pnf_ws.py'))
pnf_ws = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pnf_ws)

# 2025-11-05 10:00:00 IST
MS = 1_762_317_000_000


class TickLogTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.log = pnf_ws.TickLog(self.tmp)

    def tearDown(self):
        self.log.close()
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def rows(self, day, key):
        with open(os.path.join(self.tmp, day, key.replace(':', '_') + '.jsonl')) as f:
            return [json.loads(line) for line in f]

    def test_appends_changes_only(self):
        day = pnf_ws.ist_date(MS)
        self.assertEqual(day, '2025-11-05')
        self.assertTrue(self.log.append('NSE_FNO:1', MS, 100.5, 10))
        self.assertFalse(self.log.append('NSE_FNO:1', MS + 500, 100.5, 10))   # same price and volume
        self.assertTrue(self.log.append('NSE_FNO:1', MS + 1000, 100.5, 12))  # volume moved
        self.assertTrue(self.log.append('NSE_FNO:1', MS + 1500, 101.0, 12))
        self.assertFalse(self.log.append('NSE_FNO:1', MS + 2000, 0, 12))      # no price
        self.log.flush()
        self.assertEqual(self.rows(day, 'NSE_FNO:1'), [[MS, 100.5, 10], [MS + 1000, 100.5, 12], [MS + 1500, 101.0, 12]])

    def test_new_day_new_folder(self):
        self.log.append('IDX_I:13', MS, 24000.0, 0)
        nxt = MS + 86_400_000
        self.log.append('IDX_I:13', nxt, 24000.0, 0)   # same price, but a new day starts its own file
        self.log.flush()
        self.assertEqual(len(self.rows(pnf_ws.ist_date(MS), 'IDX_I:13')), 1)
        self.assertEqual(len(self.rows(pnf_ws.ist_date(nxt), 'IDX_I:13')), 1)

    def test_prune(self):
        for d in ('2025-10-20', '2025-10-31', '2025-11-04', 'notes'):
            os.makedirs(os.path.join(self.tmp, d))
        pnf_ws.prune_tick_days(self.tmp, '2025-11-05', keep=5)
        self.assertEqual(sorted(os.listdir(self.tmp)), ['2025-10-31', '2025-11-04', 'notes'])


if __name__ == '__main__':
    unittest.main()
