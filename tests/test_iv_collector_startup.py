"""Pure tests for scripts/tools/iv_snapshot_collector.py startup (no API, no Dhan session).

A failed spot read at startup (Dhan's quote API is ~1 req/s per account and a dashboard restart makes a burst of quote
calls) must not drop an index for the whole day: the read is retried, and an index that still fails stays pending and is
initialised again on later cycles.
"""
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scripts.tools.iv_snapshot_collector import TARGETS, spot_with_retry, init_underlying, retry_pending  # noqa: E402


class FakeHelper:
    """get_ltp answers from a list (None / 0 / an exception = failure); expiries always known."""
    def __init__(self, spots):
        self.spots = list(spots)
        self.ltp_calls = 0

    def get_ltp(self, *_a, **_k):
        self.ltp_calls += 1
        v = self.spots.pop(0) if self.spots else None
        if isinstance(v, Exception):
            raise v
        return v

    def get_expiry_list(self, **_k):
        return ['2026-11-17']


class Args:
    expiry = ''


NO_SLEEP = lambda _s: None  # noqa: E731


class SpotRetryTests(unittest.TestCase):
    def test_retries_until_a_price_arrives(self):
        h = FakeHelper([None, RuntimeError('rate limited'), 25350.6])
        slept = []
        self.assertEqual(spot_with_retry(lambda: h.get_ltp(), tries=4, wait_s=1.5, sleep=slept.append), 25350.6)
        self.assertEqual(h.ltp_calls, 3)
        self.assertEqual(slept, [1.5, 1.5])

    def test_gives_up_after_the_tries(self):
        h = FakeHelper([None, 0, None, None, 25000])
        self.assertEqual(spot_with_retry(lambda: h.get_ltp(), tries=4, wait_s=1.5, sleep=NO_SLEEP), 0.0)
        self.assertEqual(h.ltp_calls, 4)


class InitTests(unittest.TestCase):
    def test_init_builds_the_strike_window(self):
        st = init_underlying(FakeHelper([25350.6]), 'NIFTY', TARGETS['NIFTY'], Args(), 1, date(2026, 11, 11), sleep=NO_SLEEP)
        self.assertEqual(st['expiry'], '2026-11-17')
        self.assertEqual(st['atm'], 25350)
        self.assertIn(25350, st['strikes'])

    def test_init_returns_none_when_no_spot(self):
        self.assertIsNone(init_underlying(FakeHelper([]), 'NIFTY', TARGETS['NIFTY'], Args(), 1, date(2026, 11, 11), sleep=NO_SLEEP))

    def test_a_pending_index_joins_on_a_later_cycle(self):
        states, pending = {}, ['NIFTY']
        retry_pending(FakeHelper([]), pending, states, Args(), date(2026, 11, 11), sleep=NO_SLEEP)
        self.assertEqual(pending, ['NIFTY'])
        self.assertEqual(states, {})
        retry_pending(FakeHelper([25350.6]), pending, states, Args(), date(2026, 11, 11), sleep=NO_SLEEP)
        self.assertEqual(pending, [])
        self.assertEqual(states['NIFTY']['atm'], 25350)


if __name__ == '__main__':
    unittest.main()
