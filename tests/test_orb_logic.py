"""
Unit tests for the pure decision logic in strategies/crudeoil/crudeoilm_orb.py.

Offline — no broker session, no network. Importing the strategy module only configures
logging; get_dhan_client() is called in __init__, not at import time.

    venv\\Scripts\\python.exe -m unittest tests.test_orb_logic -v
"""

import os
import sys
import unittest
from datetime import time as dtime

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from strategies.crudeoil.crudeoilm_orb import (
    breakout_signal,
    compute_opening_range,
    parse_hhmm,
    ratchet_stop,
    stop_hit,
    window_end,
)


def make_df(rows, start="2026-08-07 09:00", freq="5min"):
    """rows = list of (high, low). Index is tz-naive IST, like get_latest_candles()."""
    idx = pd.date_range(start, periods=len(rows), freq=freq)
    highs = [r[0] for r in rows]
    lows = [r[1] for r in rows]
    return pd.DataFrame(
        {
            "Open": highs,
            "High": highs,
            "Low": lows,
            "Close": [(h + l) / 2 for h, l in rows],
            "Volume": [100] * len(rows),
        },
        index=idx,
    )


class TestWindowHelpers(unittest.TestCase):
    def test_parse_hhmm(self):
        self.assertEqual(parse_hhmm("09:00"), dtime(9, 0))
        self.assertEqual(parse_hhmm("23:30"), dtime(23, 30))
        with self.assertRaises(ValueError):
            parse_hhmm("nine")

    def test_window_end(self):
        self.assertEqual(window_end(dtime(9, 0), 15), dtime(9, 15))
        self.assertEqual(window_end(dtime(9, 20), 30), dtime(9, 50))
        # Clamped inside the same day rather than wrapping to 00:xx.
        self.assertEqual(window_end(dtime(23, 50), 30), dtime(23, 59))


class TestComputeOpeningRange(unittest.TestCase):
    def test_basic_range(self):
        # 09:00, 09:05, 09:10 are inside a 15-min window; 09:15 onward is not.
        df = make_df([(100, 90), (105, 95), (103, 88), (120, 80), (130, 70)])
        orh, orl, bars = compute_opening_range(df, dtime(9, 0), 15)
        self.assertEqual(bars, 3)
        self.assertEqual(orh, 105.0)
        self.assertEqual(orl, 88.0)

    def test_later_candles_excluded(self):
        # The 09:15 bar has a far wider range and must not leak into ORH/ORL.
        df = make_df([(100, 90), (105, 95), (103, 88), (999, 1)])
        orh, orl, _ = compute_opening_range(df, dtime(9, 0), 15)
        self.assertEqual(orh, 105.0)
        self.assertEqual(orl, 88.0)

    def test_partial_window_counts_bars(self):
        df = make_df([(100, 90), (105, 95)])
        orh, orl, bars = compute_opening_range(df, dtime(9, 0), 15)
        self.assertEqual(bars, 2)
        self.assertEqual((orh, orl), (105.0, 90.0))

    def test_other_session_excluded(self):
        """Yesterday's 09:00 bars must not contaminate today's range."""
        prev = make_df([(999, 1), (999, 1), (999, 1)], start="2026-08-06 09:00")
        today = make_df([(100, 90), (105, 95), (103, 88)], start="2026-08-07 09:00")
        df = pd.concat([prev, today])
        orh, orl, bars = compute_opening_range(df, dtime(9, 0), 15)
        self.assertEqual(bars, 3)
        self.assertEqual((orh, orl), (105.0, 88.0))

        # Explicit ref_date reaches back to the earlier session.
        orh_prev, _, _ = compute_opening_range(
            df, dtime(9, 0), 15, ref_date=pd.Timestamp("2026-08-06").date())
        self.assertEqual(orh_prev, 999.0)

    def test_custom_window_width(self):
        df = make_df([(100, 90), (105, 95), (103, 88), (110, 85), (99, 80)])
        _, _, bars15 = compute_opening_range(df, dtime(9, 0), 15)
        orh30, orl30, bars30 = compute_opening_range(df, dtime(9, 0), 30)
        self.assertEqual(bars15, 3)
        self.assertEqual(bars30, 5)
        self.assertEqual((orh30, orl30), (110.0, 80.0))

    def test_no_data_returns_zero(self):
        self.assertEqual(compute_opening_range(pd.DataFrame(), dtime(9, 0), 15), (0.0, 0.0, 0))
        self.assertEqual(compute_opening_range(None, dtime(9, 0), 15), (0.0, 0.0, 0))
        # Session hasn't started — no candle falls in the window.
        df = make_df([(100, 90)], start="2026-08-07 14:00")
        self.assertEqual(compute_opening_range(df, dtime(9, 0), 15), (0.0, 0.0, 0))

    def test_missing_columns(self):
        df = make_df([(100, 90), (105, 95), (103, 88)]).drop(columns=["High"])
        self.assertEqual(compute_opening_range(df, dtime(9, 0), 15), (0.0, 0.0, 0))


class TestBreakoutSignal(unittest.TestCase):
    ORH, ORL = 105.0, 88.0

    def test_long_on_close_above(self):
        sig, _ = breakout_signal(106.0, self.ORH, self.ORL)
        self.assertEqual(sig, "LONG")

    def test_short_on_close_below(self):
        sig, _ = breakout_signal(87.0, self.ORH, self.ORL)
        self.assertEqual(sig, "SHORT")

    def test_inside_range_is_neutral(self):
        sig, reason = breakout_signal(100.0, self.ORH, self.ORL)
        self.assertEqual(sig, "NEUTRAL")
        self.assertIn("inside range", reason)

    def test_exact_touch_is_not_a_breakout(self):
        # Strictly greater / less — a close exactly at the level is not a break.
        self.assertEqual(breakout_signal(self.ORH, self.ORH, self.ORL)[0], "NEUTRAL")
        self.assertEqual(breakout_signal(self.ORL, self.ORH, self.ORL)[0], "NEUTRAL")

    def test_unready_range_is_neutral(self):
        sig, reason = breakout_signal(106.0, 0.0, 0.0)
        self.assertEqual(sig, "NEUTRAL")
        self.assertIn("not ready", reason)

    def test_filter_blocks_break_that_misses_pivot(self):
        # Clears ORH (105) but not the last pivot high (110) — weak poke, rejected.
        sig, reason = breakout_signal(106.0, self.ORH, self.ORL, last_pivot_high=110.0)
        self.assertEqual(sig, "NEUTRAL")
        self.assertIn("not pivot high", reason)

    def test_filter_allows_break_that_clears_pivot(self):
        sig, _ = breakout_signal(112.0, self.ORH, self.ORL, last_pivot_high=110.0)
        self.assertEqual(sig, "LONG")

    def test_filter_skipped_when_no_pivot_yet(self):
        """The early-session case: no pivot has confirmed, so the filter must not block."""
        sig, reason = breakout_signal(106.0, self.ORH, self.ORL, last_pivot_high=None)
        self.assertEqual(sig, "LONG")
        self.assertIn("no pivot yet", reason)

    def test_filter_can_be_disabled(self):
        sig, _ = breakout_signal(106.0, self.ORH, self.ORL, last_pivot_high=110.0, use_filter=False)
        self.assertEqual(sig, "LONG")

    def test_short_filter_symmetry(self):
        # Breaks ORL (88) but not the pivot low (80).
        self.assertEqual(
            breakout_signal(87.0, self.ORH, self.ORL, last_pivot_low=80.0)[0], "NEUTRAL")
        self.assertEqual(
            breakout_signal(79.0, self.ORH, self.ORL, last_pivot_low=80.0)[0], "SHORT")
        self.assertEqual(
            breakout_signal(87.0, self.ORH, self.ORL, last_pivot_low=None)[0], "SHORT")


class TestRatchetStop(unittest.TestCase):
    def test_long_stop_tightens_upward(self):
        self.assertEqual(ratchet_stop("LONG", 88.0, 95.0), 95.0)

    def test_long_stop_never_loosens(self):
        """A pullback pivot below the current stop must not hand back locked-in profit."""
        self.assertEqual(ratchet_stop("LONG", 95.0, 90.0), 95.0)

    def test_short_stop_tightens_downward(self):
        self.assertEqual(ratchet_stop("SHORT", 105.0, 99.0), 99.0)

    def test_short_stop_never_loosens(self):
        self.assertEqual(ratchet_stop("SHORT", 99.0, 105.0), 99.0)

    def test_no_pivot_leaves_stop_untouched(self):
        self.assertEqual(ratchet_stop("LONG", 88.0, None), 88.0)
        self.assertEqual(ratchet_stop("LONG", 88.0, 0.0), 88.0)

    def test_unset_stop_adopts_pivot(self):
        self.assertEqual(ratchet_stop("LONG", 0.0, 95.0), 95.0)
        self.assertEqual(ratchet_stop("SHORT", 0.0, 99.0), 99.0)

    def test_flat_direction_is_noop(self):
        self.assertEqual(ratchet_stop("NONE", 88.0, 95.0), 88.0)

    def test_two_stage_handoff(self):
        """Stage 1 is the opening-range edge; stage 2 takes over on the first pivot."""
        orl = 88.0
        stop = orl                                   # stage 1: no pivot exists yet
        self.assertEqual(ratchet_stop("LONG", stop, None), orl)

        stop = ratchet_stop("LONG", stop, 92.0)      # stage 2: first pivot low confirms
        self.assertEqual(stop, 92.0)
        stop = ratchet_stop("LONG", stop, 97.0)      # trend continues
        self.assertEqual(stop, 97.0)
        stop = ratchet_stop("LONG", stop, 94.0)      # pullback pivot — ignored
        self.assertEqual(stop, 97.0)


class TestStopHit(unittest.TestCase):
    def test_long_hit_below_stop(self):
        self.assertTrue(stop_hit("LONG", 94.9, 95.0))
        self.assertFalse(stop_hit("LONG", 95.1, 95.0))

    def test_short_hit_above_stop(self):
        self.assertTrue(stop_hit("SHORT", 99.1, 99.0))
        self.assertFalse(stop_hit("SHORT", 98.9, 99.0))

    def test_unset_stop_or_price_never_hits(self):
        self.assertFalse(stop_hit("LONG", 94.0, 0.0))
        self.assertFalse(stop_hit("LONG", 0.0, 95.0))
        self.assertFalse(stop_hit("NONE", 94.0, 95.0))


class TestEndToEndDecisionFlow(unittest.TestCase):
    """Walk a session through the pure functions in the order the strategy calls them."""

    def test_long_day(self):
        df = make_df([(100, 90), (105, 95), (103, 88), (107, 101)])
        orh, orl, bars = compute_opening_range(df, dtime(9, 0), 15)
        self.assertEqual((orh, orl, bars), (105.0, 88.0, 3))

        # 09:15 candle closes above the range; no pivot yet, so the filter is skipped.
        sig, _ = breakout_signal(106.5, orh, orl, None, None)
        self.assertEqual(sig, "LONG")

        stop = orl                                    # stage 1
        self.assertFalse(stop_hit("LONG", 106.5, stop))

        stop = ratchet_stop("LONG", stop, 101.0)      # first pivot low
        self.assertEqual(stop, 101.0)
        self.assertFalse(stop_hit("LONG", 108.0, stop))

        stop = ratchet_stop("LONG", stop, 105.5)      # trend extends
        self.assertTrue(stop_hit("LONG", 105.0, stop))  # structure breaks → exit
