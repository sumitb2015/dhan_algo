"""
Unit tests for lib/pivots.py.

Pure offline tests -- no broker session, no network, no mocks needed.

    venv\\Scripts\\python.exe -m unittest tests.test_pivots -v
"""

import json
import logging
import os
import sys
import unittest

import numpy as np
import pandas as pd

# Add parent directory to path to import lib
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.pivots import (
    PIVOT_HIGH,
    PIVOT_LOW,
    Pivot,
    PivotTracker,
    find_pivot_highs,
    find_pivot_lows,
    find_pivots,
    get_pivots,
)


def make_df(highs, lows=None, start="2026-08-07 09:15", freq="5min"):
    """Build an OHLCV frame shaped like DhanHelper.get_latest_candles() output:
    tz-naive IST DatetimeIndex, Title-Case columns."""
    idx = pd.date_range(start, periods=len(highs), freq=freq)
    lows = list(lows) if lows is not None else [h - 1 for h in highs]
    return pd.DataFrame(
        {
            "Open": list(highs),
            "High": list(highs),
            "Low": lows,
            "Close": list(highs),
            "Volume": [100] * len(highs),
        },
        index=idx,
    )


class TestFindPivots(unittest.TestCase):
    # 1
    def test_single_pivot_high_n1(self):
        df = make_df([1, 2, 3, 2, 1])
        pivots = find_pivots(df, n=1, kind="high")
        self.assertEqual(len(pivots), 1)
        p = pivots[0]
        self.assertEqual(p.type, PIVOT_HIGH)
        self.assertTrue(p.is_high)
        self.assertFalse(p.is_low)
        self.assertEqual(p.index, 2)
        self.assertEqual(p.price, 3.0)
        self.assertEqual(p.timestamp, df.index[2])

    # 2
    def test_single_pivot_low_n1(self):
        # Lows dip at index 2; highs held flat so they contribute nothing.
        df = make_df([9, 9, 9, 9, 9], lows=[5, 4, 1, 4, 5])
        pivots = find_pivots(df, n=1, kind="low")
        self.assertEqual(len(pivots), 1)
        p = pivots[0]
        self.assertEqual(p.type, PIVOT_LOW)
        self.assertTrue(p.is_low)
        self.assertEqual(p.index, 2)
        self.assertEqual(p.price, 1.0)
        self.assertEqual(p.timestamp, df.index[2])

    # 3
    def test_n3_requires_wider_window(self):
        df = make_df([1, 2, 3, 4, 5, 4, 3, 2, 1])
        pivots = find_pivots(df, n=3, kind="high")
        self.assertEqual(len(pivots), 1)
        self.assertEqual(pivots[0].index, 4)
        self.assertEqual(pivots[0].price, 5.0)

        # A local blip that qualifies at n=1 but not at n=3: the 3 at index 2 is a
        # 1-bar peak, but the 4 at index 4 sits inside its right window.
        df2 = make_df([1, 2, 3, 2, 4, 2, 1, 0, 1])
        n1 = [p.index for p in find_pivots(df2, n=1, kind="high")]
        n3 = [p.index for p in find_pivots(df2, n=3, kind="high")]
        self.assertIn(2, n1)
        self.assertNotIn(2, n3)

    # 4
    def test_multiple_pivots_chronological(self):
        highs = [1, 2, 5, 2, 1, 2, 6, 2, 1, 2, 7, 2, 1]
        lows = [h - 4 for h in highs]
        df = make_df(highs, lows)
        pivots = find_pivots(df, n=2)
        self.assertEqual([p.index for p in pivots], sorted(p.index for p in pivots))
        highs_found = [p for p in pivots if p.is_high]
        lows_found = [p for p in pivots if p.is_low]
        self.assertEqual([p.index for p in highs_found], [2, 6, 10])
        self.assertEqual([p.price for p in highs_found], [5.0, 6.0, 7.0])
        # Troughs sit between the peaks
        self.assertEqual([p.index for p in lows_found], [4, 8])
        # Interleaved by time overall
        ts = [p.timestamp for p in pivots]
        self.assertEqual(ts, sorted(ts))

    # 5
    def test_strict_ties_rejected(self):
        df = make_df([1, 3, 3, 1])
        self.assertEqual(find_pivots(df, n=1, kind="high"), [])

    # 6
    def test_non_strict_ties_accepted(self):
        df = make_df([1, 3, 3, 1])
        pivots = find_pivots(df, n=1, kind="high", strict=False)
        self.assertEqual([p.index for p in pivots], [1, 2])

    # 7
    def test_last_n_bars_never_confirmed(self):
        df = make_df([1, 2, 3, 4, 5])  # peak at the final bar, no right window
        self.assertEqual(find_pivots(df, n=1, kind="high"), [])

        df2 = make_df([1, 2, 3, 4, 5, 4, 3])  # same peak, now with right-side bars
        pivots = find_pivots(df2, n=1, kind="high")
        self.assertEqual(len(pivots), 1)
        self.assertEqual(pivots[0].price, 5.0)
        self.assertEqual(pivots[0].timestamp, df2.index[4])

    # 8
    def test_first_n_bars_never_confirmed(self):
        # Peak at index 1 has only one bar of left history, so n=2 cannot confirm it.
        df = make_df([1, 9, 1, 1, 1, 1, 1])
        self.assertEqual(find_pivots(df, n=2, kind="high"), [])

    # 9
    def test_insufficient_data(self):
        n = 3
        df = make_df(list(range(2 * n)))  # exactly 2n rows, one short of 2n+1
        self.assertEqual(find_pivots(df, n=n), [])

    # 10
    def test_empty_and_none_input(self):
        self.assertEqual(find_pivots(pd.DataFrame(), n=3), [])
        self.assertEqual(find_pivots(None, n=3), [])
        self.assertEqual(find_pivots(make_df([1, 2, 3, 2, 1]), n=0), [])

    # 11
    def test_kind_filter(self):
        highs = [1, 2, 5, 2, 1, 2, 6, 2, 1]
        lows = [h - 4 for h in highs]
        df = make_df(highs, lows)
        only_high = find_pivots(df, n=2, kind="high")
        only_low = find_pivots(df, n=2, kind="low")
        self.assertTrue(all(p.is_high for p in only_high))
        self.assertTrue(all(p.is_low for p in only_low))
        self.assertTrue(only_high and only_low)
        self.assertEqual(
            [p.index for p in find_pivot_highs(df, n=2)], [p.index for p in only_high]
        )
        self.assertEqual(
            [p.index for p in find_pivot_lows(df, n=2)], [p.index for p in only_low]
        )

    # 12
    def test_nan_window_skipped(self):
        df = make_df([1, 2, 3, 2, 1, 2, 1])
        df.loc[df.index[3], "High"] = np.nan  # NaN in the right window of index 2
        pivots = find_pivots(df, n=1, kind="high")
        self.assertNotIn(2, [p.index for p in pivots])

    # 13
    def test_custom_columns(self):
        df = make_df([1, 2, 3, 2, 1])
        df["high"] = df["High"]
        df["low"] = df["Low"]
        df = df.drop(columns=["High", "Low"])
        pivots = find_pivots(df, n=1, high_col="high", low_col="low")
        self.assertEqual([p.index for p in pivots if p.is_high], [2])
        # Missing columns must degrade to [], not raise.
        self.assertEqual(find_pivots(df, n=1), [])

    def test_equality_ignores_index(self):
        # The same swing seen in a full frame and in a slid window must compare equal,
        # or a set-based dedup would re-fire on an already-traded pivot.
        # Peak sits at index 3 so it still has 2 left-side bars after the slice.
        df = make_df([1, 2, 3, 9, 3, 2, 1])
        full = find_pivots(df, n=2, kind="high")[0]
        shifted = find_pivots(df.iloc[1:], n=2, kind="high")[0]
        self.assertNotEqual(full.index, shifted.index)
        self.assertEqual(full, shifted)
        self.assertEqual(len({full, shifted}), 1)

    def test_invalid_kind_raises(self):
        df = make_df([1, 2, 3, 2, 1])
        with self.assertRaises(ValueError):
            find_pivots(df, n=1, kind="highs")
        # The exported constants are case-insensitively accepted, not silently empty.
        self.assertEqual(
            [p.index for p in find_pivots(df, n=1, kind=PIVOT_HIGH)],
            [p.index for p in find_pivots(df, n=1, kind="high")],
        )
        self.assertTrue(find_pivots(df, n=1, kind=PIVOT_HIGH))
        self.assertEqual(find_pivots(df, n=1, kind=PIVOT_LOW), [])

    # 14
    def test_to_dict_json_roundtrip(self):
        df = make_df([1, 2, 3, 2, 1])
        pivots = find_pivots(df, n=1, kind="high")
        payload = json.dumps([p.to_dict() for p in pivots])
        restored = [Pivot.from_dict(d) for d in json.loads(payload)]
        self.assertEqual(restored, pivots)
        self.assertEqual(
            pivots[0].to_dict()["timestamp"], df.index[2].strftime("%Y-%m-%d %H:%M:%S")
        )


class TestPivotTracker(unittest.TestCase):
    def zigzag(self, cycles=6, n_gap=3):
        """Repeating peak/trough pattern with distinct prices so pivots are unambiguous."""
        highs, lows = [], []
        for c in range(cycles):
            base = 100 + c
            highs += [base, base + 2, base + 5, base + 2, base]
            lows += [base - 2, base - 4, base - 7, base - 4, base - 2]
        return make_df(highs, lows)

    # 15
    def test_emits_each_pivot_exactly_once(self):
        df = self.zigzag()
        tracker = PivotTracker(n=2, maxlen=50)
        fresh = []
        for k in range(1, len(df) + 1):
            fresh.extend(tracker.update(df.iloc[:k]))
        keys = [(p.timestamp, p.type) for p in fresh]
        self.assertEqual(len(keys), len(set(keys)), "a pivot was emitted twice")
        expected = [(p.timestamp, p.type) for p in find_pivots(df.iloc[:-1], 2)]
        self.assertEqual(sorted(keys), sorted(expected))

    # 16
    def test_repeated_identical_update_returns_empty(self):
        df = self.zigzag()
        tracker = PivotTracker(n=2)
        first = tracker.update(df)
        self.assertTrue(first)
        self.assertEqual(tracker.update(df), [])

    # 17
    def test_ring_buffer_evicts_oldest(self):
        df = self.zigzag(cycles=8)
        tracker = PivotTracker(n=2, maxlen=5)
        for k in range(1, len(df) + 1):
            tracker.update(df.iloc[:k])
        all_highs = [p for p in find_pivots(df.iloc[:-1], 2) if p.is_high]
        self.assertGreater(len(all_highs), 5)
        self.assertEqual(len(tracker.highs), 5)
        self.assertEqual(
            [p.timestamp for p in tracker.highs], [p.timestamp for p in all_highs[-5:]]
        )
        self.assertNotIn(all_highs[0].timestamp, [p.timestamp for p in tracker.highs])
        self.assertEqual(tracker.high_prices(), [p.price for p in all_highs[-5:]])
        self.assertEqual(tracker.latest_high().timestamp, all_highs[-1].timestamp)

    # 18
    def test_maxlen_configurable(self):
        df = self.zigzag(cycles=8)
        tracker = PivotTracker(n=2, maxlen=3)
        tracker.update(df)
        self.assertEqual(len(tracker.highs), 3)
        self.assertEqual(len(tracker.lows), 3)

    # 19
    def test_drop_forming_delays_by_one_bar(self):
        # The bar at index 4 is exactly the last candle needed to confirm the peak
        # at index 2 with n=2. Dropping it as "forming" defers confirmation.
        df = make_df([1, 2, 5, 2, 1])
        self.assertEqual(PivotTracker(n=2, drop_forming=True).update(df), [])
        fresh = PivotTracker(n=2, drop_forming=False).update(df)
        self.assertEqual(len(fresh), 1)
        self.assertEqual(fresh[0].index, 2)
        self.assertEqual(fresh[0].price, 5.0)

        # Once one more (forming) bar arrives, drop_forming=True confirms it too.
        df2 = make_df([1, 2, 5, 2, 1, 1])
        fresh2 = PivotTracker(n=2, drop_forming=True).update(df2)
        self.assertEqual([p.price for p in fresh2], [5.0])

    # 20
    def test_index_shifts_but_timestamp_stable(self):
        df = self.zigzag()
        tracker = PivotTracker(n=2, maxlen=50)
        tracker.update(df)
        before = [(p.timestamp, p.index) for p in tracker.highs]
        self.assertTrue(before)

        # Same data, window slid forward 10 rows: identical bars, different offsets.
        again = tracker.update(df.iloc[10:])
        self.assertEqual(again, [], "sliding the window re-emitted known pivots")
        after = [(p.timestamp, p.index) for p in tracker.highs]
        self.assertEqual(after, before)

        shifted = find_pivots(df.iloc[10:-1], 2)
        common_ts = {p.timestamp for p in shifted} & {ts for ts, _ in before}
        self.assertTrue(common_ts)
        ts = sorted(common_ts)[0]
        idx_full = dict(before)[ts]
        idx_shifted = next(p.index for p in shifted if p.timestamp == ts)
        self.assertNotEqual(idx_full, idx_shifted)

    # 21
    def test_state_roundtrip(self):
        df = self.zigzag()
        tracker = PivotTracker(n=2, maxlen=5)
        tracker.update(df)
        state = json.loads(json.dumps(tracker.to_dict()))
        restored = PivotTracker.from_dict(state)

        self.assertEqual(restored.n, tracker.n)
        self.assertEqual(restored.maxlen, tracker.maxlen)
        self.assertEqual(restored.drop_forming, tracker.drop_forming)
        self.assertEqual(restored.strict, tracker.strict)
        self.assertEqual(list(restored.highs), list(tracker.highs))
        self.assertEqual(list(restored.lows), list(tracker.lows))
        self.assertEqual(restored._last_high_ts, tracker._last_high_ts)
        self.assertEqual(restored._last_low_ts, tracker._last_low_ts)
        self.assertEqual(restored.update(df), [], "restored tracker re-emitted pivots")

    # 22
    def test_latest_high_low_empty(self):
        tracker = PivotTracker(n=3)
        self.assertIsNone(tracker.latest_high())
        self.assertIsNone(tracker.latest_low())
        self.assertEqual(tracker.high_prices(), [])
        self.assertEqual(tracker.low_prices(), [])

    # 23
    def test_empty_df_update_noop(self):
        df = self.zigzag()
        tracker = PivotTracker(n=2)
        tracker.update(df)
        snapshot = list(tracker.highs)
        self.assertTrue(snapshot)
        self.assertEqual(tracker.update(pd.DataFrame()), [])
        self.assertEqual(tracker.update(None), [])
        self.assertEqual(list(tracker.highs), snapshot)

    def test_reset_clears_state(self):
        df = self.zigzag()
        tracker = PivotTracker(n=2)
        tracker.update(df)
        tracker.reset()
        self.assertEqual(len(tracker.highs), 0)
        self.assertEqual(len(tracker.lows), 0)
        self.assertTrue(tracker.update(df), "reset should allow re-emission")

    def test_prime_absorbs_history_without_emitting(self):
        df = self.zigzag()
        tracker = PivotTracker(n=2, maxlen=5)
        absorbed = tracker.prime(df)
        self.assertGreater(absorbed, 0)
        # Levels are available immediately...
        self.assertIsNotNone(tracker.latest_high())
        self.assertIsNotNone(tracker.latest_low())
        # ...but nothing was reported as a fresh, tradeable signal.
        self.assertEqual(tracker.update(df), [])

        # A pivot formed after priming still fires normally.
        extra = make_df(
            [130, 132, 140, 132, 130, 130, 130],
            lows=[128, 126, 120, 126, 128, 128, 128],
            start="2026-08-07 12:00",
        )
        combined = pd.concat([df, extra])
        fresh = tracker.update(combined)
        self.assertTrue(fresh)
        self.assertIn(140.0, [p.price for p in fresh if p.is_high])

    def test_invalid_constructor_args_raise(self):
        with self.assertRaises(ValueError):
            PivotTracker(n=0)
        with self.assertRaises(ValueError):
            PivotTracker(n=3, maxlen=0)

    def test_concurrent_update_and_read(self):
        import threading

        df = self.zigzag(cycles=12)
        tracker = PivotTracker(n=2, maxlen=5)
        errors = []

        def writer():
            try:
                for k in range(1, len(df) + 1):
                    tracker.update(df.iloc[:k])
            except Exception as exc:  # pragma: no cover - only on a real race
                errors.append(exc)

        def reader():
            try:
                for _ in range(2000):
                    tracker.latest_high()
                    tracker.low_prices()
                    tracker.to_dict()
            except Exception as exc:  # pragma: no cover
                errors.append(exc)

        threads = [threading.Thread(target=writer), threading.Thread(target=reader)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertEqual(
            [p.timestamp for p in tracker.highs],
            [p.timestamp for p in find_pivots(df.iloc[:-1], 2) if p.is_high][-5:],
        )

    def test_duplicate_timestamps_tolerated(self):
        df = self.zigzag()
        dupe = pd.concat([df, df.iloc[[-1]]])  # repeated final timestamp
        tracker = PivotTracker(n=2, maxlen=50)
        self.assertEqual(
            [p.timestamp for p in tracker.update(dupe)],
            [p.timestamp for p in find_pivots(df.iloc[:-1], 2)],
        )


class TestGetPivots(unittest.TestCase):
    class _FakeHelper:
        def __init__(self, df, last_api_error=None):
            self.df = df
            self.last_api_error = last_api_error
            self.calls = []

        def get_latest_candles(self, symbol, interval="5", days=5):
            self.calls.append((symbol, interval, days))
            return self.df

    def test_fetches_and_drops_forming_candle(self):
        df = make_df([1, 2, 5, 2, 1])
        helper = self._FakeHelper(df)
        # Last row dropped => not enough right-side bars to confirm the peak.
        self.assertEqual(get_pivots(helper, "NIFTY", interval="5", n=2, days=5), [])
        self.assertEqual(helper.calls, [("NIFTY", "5", 5)])

        df2 = make_df([1, 2, 5, 2, 1, 1])
        pivots = get_pivots(self._FakeHelper(df2), "NIFTY", n=2)
        self.assertEqual([p.price for p in pivots], [5.0])

    def test_empty_response(self):
        self.assertEqual(get_pivots(self._FakeHelper(pd.DataFrame()), "NIFTY"), [])
        self.assertEqual(get_pivots(self._FakeHelper(None), "NIFTY"), [])

    def test_api_error_is_surfaced_not_swallowed(self):
        helper = self._FakeHelper(pd.DataFrame(), last_api_error="DH-902: no subscription")
        with self.assertLogs("lib.pivots", level="WARNING") as cm:
            self.assertEqual(get_pivots(helper, "NIFTY"), [])
        self.assertIn("DH-902", "".join(cm.output))

    def test_no_warning_when_genuinely_no_data(self):
        helper = self._FakeHelper(pd.DataFrame())
        logger = logging.getLogger("lib.pivots")
        with self.assertLogs(logger, level="WARNING") as cm:
            logger.warning("sentinel")  # assertLogs requires >=1 record
            get_pivots(helper, "NIFTY")
        self.assertEqual(len(cm.output), 1)


if __name__ == "__main__":
    unittest.main()
