"""Pure tests for scripts/tools/iv_snapshot_collector.py startup (no API, no Dhan session).

A failed spot read at startup (Dhan's quote API is ~1 req/s per account and a dashboard restart makes a burst of quote
calls) must not drop an index for the whole day: the read is retried, and an index that still fails stays pending and is
initialised again on later cycles.
"""
import os
import sys
import unittest
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scripts.tools.iv_snapshot_collector import (  # noqa: E402
    TARGETS, PREP_LEAD_S, spot_with_retry, init_underlying, retry_pending, seconds_to_open, prepare_for_open,
    chain_signature, first_live_chain, recentre, BASELINE_MIN_LEAD_S,
)


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

    chain = None      # what get_option_chain answers ({'oc': {...}}); None = no chain
    chain_calls = 0

    def get_option_chain(self, *_a, **_k):
        self.chain_calls += 1
        return self.chain


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



class FakeClock:
    """A clock that only moves when the code under test sleeps; records every sleep and what ran when."""
    def __init__(self, start):
        self.t = start
        self.sleeps = []

    def now(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(s)
        self.t += timedelta(seconds=s)


class OpenArgs(Args):
    ignore_market_hours = False


class PrepareForOpenTests(unittest.TestCase):
    OPEN = datetime(2026, 11, 17, 9, 15, 0)

    def test_seconds_to_open_counts_seconds_across_the_boundary(self):
        self.assertEqual(seconds_to_open(datetime(2026, 11, 17, 9, 14, 30)), 30)
        self.assertEqual(seconds_to_open(self.OPEN), 0)
        self.assertEqual(seconds_to_open(datetime(2026, 11, 17, 9, 15, 0, 500000)), -0.5)
        self.assertEqual(seconds_to_open(datetime(2026, 11, 17, 8, 42, 0)), 33 * 60)

    def run_from(self, start, spots=(24000.0, 51000.0)):
        clock = FakeClock(start)
        helper = FakeHelper(list(spots))
        eod_at, init_at = [], []
        orig = helper.get_expiry_list
        helper.get_expiry_list = lambda **k: (init_at.append(clock.t), orig(**k))[1]
        states, pending = prepare_for_open(helper, ['NIFTY', 'BANKNIFTY'], OpenArgs(), date(2026, 11, 17),
                                           lambda: eod_at.append(clock.t), now=clock.now, sleep=clock.sleep)
        return clock, states, pending, eod_at, init_at

    def test_wakes_exactly_at_the_open_with_every_index_ready(self):
        clock, states, pending, eod_at, init_at = self.run_from(datetime(2026, 11, 17, 8, 42, 7))
        self.assertEqual(clock.t, self.OPEN)                       # not up to a minute late
        self.assertEqual(sorted(states), ['BANKNIFTY', 'NIFTY'])
        self.assertEqual(pending, [])
        self.assertTrue(all(s <= 60 for s in clock.sleeps))
        # Setup ran before the open, inside the lead; the EOD task never ran inside it.
        lead = self.OPEN - timedelta(seconds=PREP_LEAD_S)
        self.assertTrue(init_at and all(lead <= t < self.OPEN for t in init_at))
        self.assertTrue(eod_at and all(t < lead for t in eod_at))

    def test_started_inside_the_lead_skips_the_eod_task(self):
        clock, states, _pending, eod_at, _init = self.run_from(datetime(2026, 11, 17, 9, 14, 50))
        self.assertEqual(eod_at, [])
        self.assertEqual(clock.sleeps, [10])
        self.assertEqual(len(states), 2)

    def test_started_after_the_open_does_not_wait(self):
        clock, states, _pending, eod_at, _init = self.run_from(datetime(2026, 11, 17, 10, 0, 0))
        self.assertEqual((clock.sleeps, eod_at, len(states)), ([], [], 2))

    def test_an_index_with_no_spot_is_left_pending_not_dropped(self):
        _clock, states, pending, _eod, _init = self.run_from(datetime(2026, 11, 17, 9, 14, 50), spots=(24000.0,))
        self.assertEqual((sorted(states), pending), (['NIFTY'], ['BANKNIFTY']))

    def test_ignore_market_hours_prepares_at_once(self):
        clock = FakeClock(datetime(2026, 11, 17, 7, 0, 0))
        args = OpenArgs()
        args.ignore_market_hours = True
        states, _p = prepare_for_open(FakeHelper([24000.0]), ['NIFTY'], args, date(2026, 11, 17), lambda: None,
                                      now=clock.now, sleep=clock.sleep)
        self.assertEqual((clock.sleeps, len(states)), ([], 1))



def oc(vol, ltp=10.0):
    return {'25000.000000': {'ce': {'volume': vol, 'last_price': ltp}, 'pe': {'volume': vol, 'last_price': ltp}},
            '25050.000000': {'ce': {'volume': 0, 'last_price': 5.0}, 'pe': {}}}


class FirstSnapshotTests(unittest.TestCase):
    def test_signature_changes_with_any_trade(self):
        self.assertEqual(chain_signature(oc(100)), chain_signature(oc(100)))
        self.assertNotEqual(chain_signature(oc(100)), chain_signature(oc(101)))
        self.assertNotEqual(chain_signature(oc(100)), chain_signature(oc(100, 10.5)))
        self.assertEqual(chain_signature({}), {})

    def run_wait(self, baseline, first, later):
        t = [0.0]
        reads = list(later)
        sleeps = []

        def sleep(s):
            sleeps.append(s)
            t[0] += s

        got, live = first_live_chain(lambda: reads.pop(0) if reads else None, first, baseline,
                                     wait_s=11, retry_s=5.2, sleep=sleep, clock=lambda: t[0])
        return got, live, sleeps

    def test_a_chain_that_already_moved_is_written_at_once(self):
        got, live, sleeps = self.run_wait(chain_signature(oc(100)), oc(140), [])
        self.assertEqual((got, live, sleeps), (oc(140), True, []))

    def test_no_pre_open_reading_means_no_check(self):
        got, live, sleeps = self.run_wait(None, oc(100), [])
        self.assertEqual((live, sleeps), (True, []))

    def test_the_pre_open_picture_is_re_read_until_it_moves(self):
        got, live, sleeps = self.run_wait(chain_signature(oc(100)), oc(100), [oc(100), oc(180)])
        self.assertEqual((got, live, sleeps), (oc(180), True, [5.2, 5.2]))

    def test_gives_up_after_the_wait_and_says_so(self):
        got, live, sleeps = self.run_wait(chain_signature(oc(100)), oc(100), [oc(100), oc(100), oc(100)])
        self.assertEqual((got, live, sleeps), (oc(100), False, [5.2, 5.2]))      # a third re-read would pass 11 s

    def test_a_failed_re_read_keeps_the_last_chain(self):
        got, live, _s = self.run_wait(chain_signature(oc(100)), oc(100), [None, None])
        self.assertEqual((got, live), (oc(100), False))

    def test_recentre_moves_the_window_to_the_opening_price(self):
        st = {'cfg': TARGETS['NIFTY'], 'atm': 25000, 'strikes': [25000]}
        self.assertFalse(recentre(st, 25010.0))
        self.assertTrue(recentre(st, 25340.0))
        self.assertEqual(st['atm'], 25350)
        self.assertEqual((st['strikes'][0], st['strikes'][-1], len(st['strikes'])), (24350, 26350, 41))

    def test_pre_open_readings_are_taken_only_with_enough_lead(self):
        open_at = datetime(2026, 11, 17, 9, 15, 0)
        for start, expect in ((open_at - timedelta(seconds=40), 2), (open_at - timedelta(seconds=BASELINE_MIN_LEAD_S - 1), 0)):
            clock = FakeClock(start)
            helper = FakeHelper([24000.0, 51000.0])
            helper.chain = {'oc': oc(100)}
            states, _p = prepare_for_open(helper, ['NIFTY', 'BANKNIFTY'], OpenArgs(), date(2026, 11, 17), lambda: None,
                                          now=clock.now, sleep=clock.sleep)
            self.assertEqual(helper.chain_calls, expect)
            self.assertEqual(sum('pre_open_sig' in s for s in states.values()), expect)
            self.assertEqual(clock.t, open_at)


if __name__ == '__main__':
    unittest.main()
