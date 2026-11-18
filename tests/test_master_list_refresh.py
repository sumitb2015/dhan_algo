"""
Stubbed tests for lib/master_list_refresh.py: no network, no Dhan session, no real master_list.csv (a temp dir).
    venv\\Scripts\\python.exe tests/test_master_list_refresh.py
"""
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime

import pandas as pd

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from lib import master_list_refresh as mlr  # noqa: E402

DAY = 86_400
NOW = datetime(2026, 11, 18, 21, 0, tzinfo=mlr.IST).timestamp()


def frame(mcx=True, nifty_expiry='2026-11-24'):
    rows = [{'EXCH_ID': 'NSE', 'INSTRUMENT': 'EQUITY', 'UNDERLYING_SYMBOL': 'RELIANCE', 'SM_EXPIRY_DATE': 'nan'},
            {'EXCH_ID': 'NSE', 'INSTRUMENT': 'FUTIDX', 'UNDERLYING_SYMBOL': 'NIFTY', 'SM_EXPIRY_DATE': nifty_expiry}]
    if mcx:
        rows.append({'EXCH_ID': 'MCX', 'INSTRUMENT': 'FUTCOM', 'UNDERLYING_SYMBOL': 'CRUDEOILM', 'SM_EXPIRY_DATE': '2026-12-18'})
    return pd.DataFrame(rows)


class FakeHelper:
    def __init__(self, path, df, fetch_ok=True):
        self._master_list_path = path
        self._master_list = df
        self.fetch_ok = fetch_ok
        self.fetch_calls = []

    def _load_master_list(self, reload=False):
        return self._master_list

    def fetch_security_list(self, segments, require_all=False, min_rows=0):
        self.fetch_calls.append((list(segments), require_all, min_rows))
        if self.fetch_ok:
            self._master_list = frame()
            os.utime(self._master_list_path, (NOW, NOW))
        return self.fetch_ok


class MasterListRefreshTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, 'master_list.csv')
        with open(self.path, 'w') as f:
            f.write('x\n')
        os.environ.pop(mlr.ENV_SWITCH, None)

    def tearDown(self):
        self.dir.cleanup()

    def touch(self, ts):
        os.utime(self.path, (ts, ts))

    def test_content_problems(self):
        self.assertIsNone(mlr.content_problem(frame(), '2026-11-18'))
        self.assertIn('MCX', mlr.content_problem(frame(mcx=False), '2026-11-18'))
        self.assertIn('NIFTY', mlr.content_problem(frame(nifty_expiry='2026-08-25'), '2026-11-18'))
        self.assertIsNone(mlr.content_problem(frame(nifty_expiry='2026-11-18 14:30:00'), '2026-11-18'))  # expiry day counts
        self.assertIn('empty', mlr.content_problem(pd.DataFrame(), '2026-11-18'))

    def test_age_problem_uses_ist_days(self):
        self.touch(NOW - 60)
        self.assertIsNone(mlr.age_problem(self.path, NOW))
        self.touch(NOW - DAY)
        self.assertIn('2026-11-17', mlr.age_problem(self.path, NOW))
        self.assertIn('missing', mlr.age_problem(os.path.join(self.dir.name, 'nope.csv'), NOW))

    def test_fresh_file_is_left_alone(self):
        self.touch(NOW - 60)
        h = FakeHelper(self.path, frame())
        self.assertEqual(mlr.refresh_if_stale(h, now=NOW)['status'], 'fresh')
        self.assertEqual(h.fetch_calls, [])

    def test_old_file_is_refreshed_strictly(self):
        self.touch(NOW - 150 * DAY)
        h = FakeHelper(self.path, frame(nifty_expiry='2026-08-25'))
        r = mlr.refresh_if_stale(h, now=NOW)
        self.assertEqual(r['status'], 'refreshed')
        segs, require_all, min_rows = h.fetch_calls[0]
        self.assertIn('MCX_COMM', segs)
        self.assertTrue(require_all)                      # a partial download must never replace the file
        self.assertEqual(min_rows, 1)                     # half of the 2 rows on disk
        self.assertFalse(os.path.exists(mlr._lock_path(self.path)))

    def test_todays_file_without_mcx_is_refreshed(self):
        self.touch(NOW - 60)                              # e.g. test_11's NSE-only rewrite this morning
        h = FakeHelper(self.path, frame(mcx=False))
        self.assertEqual(mlr.refresh_if_stale(h, now=NOW)['status'], 'refreshed')

    def test_failed_download_reports_and_releases_lock(self):
        self.touch(NOW - DAY)
        h = FakeHelper(self.path, frame(), fetch_ok=False)
        self.assertEqual(mlr.refresh_if_stale(h, now=NOW)['status'], 'failed')
        self.assertFalse(os.path.exists(mlr._lock_path(self.path)))

    def test_lock_held_by_another_process(self):
        self.touch(NOW - DAY)
        lock = mlr._lock_path(self.path)
        os.makedirs(os.path.dirname(lock), exist_ok=True)
        with open(lock, 'w') as f:
            f.write('1')
        os.utime(lock, (NOW - 30, NOW - 30))
        h = FakeHelper(self.path, frame())
        self.assertEqual(mlr.refresh_if_stale(h, now=NOW)['status'], 'busy')
        self.assertEqual(h.fetch_calls, [])
        os.utime(lock, (NOW - mlr.LOCK_STALE_S - 1,) * 2)   # a crashed holder's lock is taken over
        self.assertEqual(mlr.refresh_if_stale(h, now=NOW)['status'], 'refreshed')

    def test_env_switch_and_never_raises(self):
        self.touch(NOW - DAY)
        os.environ[mlr.ENV_SWITCH] = '0'
        try:
            self.assertEqual(mlr.refresh_if_stale(FakeHelper(self.path, frame()), now=NOW)['status'], 'disabled')
        finally:
            os.environ.pop(mlr.ENV_SWITCH, None)

        class Boom(FakeHelper):
            def fetch_security_list(self, *a, **k):
                raise RuntimeError('network down')
        self.assertEqual(mlr.refresh_if_stale(Boom(self.path, frame()), now=NOW)['status'], 'failed')


if __name__ == '__main__':
    unittest.main(verbosity=2)
