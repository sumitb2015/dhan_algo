"""Tests for lib/dhan_order_lane.py: the sliding-window math and, for real, several PROCESSES sharing one lane."""
import os
import random
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from lib import dhan_order_lane as lane


def max_in_window(times, window=lane.WINDOW_MS):
    return max(sum(1 for x in times if b - window < x <= b) for b in times)


class BookTest(unittest.TestCase):
    def test_burst_is_spread_into_windows_of_at_most_limit(self):
        b = []
        times = [lane.book(b, 0.0) for _ in range(30)]
        self.assertLessEqual(max_in_window(times), lane.LIMIT)
        self.assertEqual(times[:lane.LIMIT], [0.0] * lane.LIMIT)          # a free window books immediately
        self.assertEqual(times, sorted(times))

    def test_random_arrivals_never_exceed_the_limit(self):
        rng = random.Random(7)
        b, times, now = [], [], 0.0
        for _ in range(400):
            now += rng.choice([0, 0, 0, 5, 40, 120, 400])
            times.append(lane.book(b, now))
            self.assertGreaterEqual(times[-1], now)
        self.assertLessEqual(max_in_window(times), lane.LIMIT)

    def test_expired_bookings_do_not_delay_a_later_order(self):
        b = []
        for _ in range(lane.LIMIT):
            lane.book(b, 0.0)
        self.assertEqual(lane.book(b, 5000.0), 5000.0)


class FailOpenTest(unittest.TestCase):
    def test_unwritable_lane_means_no_wait_not_an_error(self):
        old = (lane.DIR, lane.LANE_FILE, lane.LOCK_FILE)
        try:
            blocker = tempfile.NamedTemporaryFile(delete=False)       # a FILE where the directory should be
            lane.DIR = os.path.join(blocker.name, 'sub')
            lane.LANE_FILE, lane.LOCK_FILE = os.path.join(lane.DIR, 'l.json'), os.path.join(lane.DIR, 'l.lock')
            self.assertEqual(lane.reserve(), 0.0)
            self.assertEqual(lane.wait_for_slot(), 0.0)
        finally:
            lane.DIR, lane.LANE_FILE, lane.LOCK_FILE = old

    def test_wait_is_capped(self):
        with tempfile.TemporaryDirectory() as d:
            old = (lane.DIR, lane.LANE_FILE, lane.LOCK_FILE, lane.MAX_WAIT_SEC)
            try:
                lane.DIR, lane.LANE_FILE, lane.LOCK_FILE = d, os.path.join(d, 'l.json'), os.path.join(d, 'l.lock')
                lane.MAX_WAIT_SEC = 0.05
                for _ in range(lane.LIMIT * 3):
                    lane.reserve()                                      # queue far beyond the cap
                t0 = time.monotonic()
                lane.wait_for_slot()
                self.assertLess(time.monotonic() - t0, 0.5)
            finally:
                lane.DIR, lane.LANE_FILE, lane.LOCK_FILE, lane.MAX_WAIT_SEC = old


class MultiProcessTest(unittest.TestCase):
    def test_many_processes_share_one_window(self):
        code = (
            "import sys; sys.path.insert(0, sys.argv[1]); from lib import dhan_order_lane as l;"
            "print(l.reserve_at_ms())"
        )
        with tempfile.TemporaryDirectory() as d:
            env = {**os.environ, 'DHAN_ORDER_LANE_DIR': d}
            procs = [subprocess.Popen([sys.executable, '-c', code, ROOT], env=env, stdout=subprocess.PIPE, text=True) for _ in range(24)]
            times = [float(p.communicate(timeout=30)[0].strip()) for p in procs]
        self.assertEqual(len(times), 24)
        self.assertLessEqual(max_in_window(times), lane.LIMIT)
        self.assertGreater(max(times) - min(times), 1500)               # 24 orders at 8/s cannot fit in 1.5 s


if __name__ == '__main__':
    unittest.main()
