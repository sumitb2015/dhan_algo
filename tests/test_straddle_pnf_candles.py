"""scripts/tools/straddle_pnf_candles.py: merge_legs joins CE/PE bars into straddle bars for the last N IST sessions.

Pure-function test: no Dhan session, no network (the script imports the broker SDK only inside main()).
"""
import importlib.util
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "tools", "straddle_pnf_candles.py")

_IST = timezone(timedelta(hours=5, minutes=30))


def _load():
    spec = importlib.util.spec_from_file_location("straddle_pnf_candles", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _epoch(day, hh, mm):
    return int(datetime(2026, 10, day, hh, mm, tzinfo=_IST).timestamp())


def _frame(rows):
    return pd.DataFrame(rows, columns=["start_Time", "close", "volume"])


class MergeLegs(unittest.TestCase):
    def setUp(self):
        self.m = _load()
        days = [20, 21, 22, 23]
        self.ce = _frame([(_epoch(d, 9, 15 + k), 100.0 + d + k, 10 + k) for d in days for k in (0, 1)])
        self.pe = _frame([(_epoch(d, 9, 15 + k), 50.0 + k, 5) for d in days for k in (0, 1)])

    def test_keeps_only_the_last_n_ist_sessions(self):
        rows = self.m.merge_legs(self.ce, self.pe, 3)
        days = sorted({datetime.fromtimestamp(r["t"], _IST).day for r in rows})
        self.assertEqual(days, [21, 22, 23])

    def test_straddle_and_volume_are_leg_sums(self):
        rows = self.m.merge_legs(self.ce, self.pe, 3)
        first = rows[0]
        self.assertEqual(first["ce"], 121.0)
        self.assertEqual(first["pe"], 50.0)
        self.assertEqual(first["straddle"], 171.0)
        self.assertEqual(first["vol"], 15)

    def test_rows_are_ascending_by_time(self):
        rows = self.m.merge_legs(self.ce, self.pe, 3)
        ts = [r["t"] for r in rows]
        self.assertEqual(ts, sorted(ts))

    def test_rows_with_a_zero_leg_are_dropped(self):
        pe = self.pe.copy()
        pe.loc[pe.index[-1], "close"] = 0.0
        rows = self.m.merge_legs(self.ce, pe, 3)
        self.assertEqual(rows[-1]["t"], _epoch(23, 9, 15))

    def test_only_timestamps_present_in_both_legs_survive(self):
        pe = self.pe.iloc[:-1]
        rows = self.m.merge_legs(self.ce, pe, 3)
        self.assertNotIn(_epoch(23, 9, 16), [r["t"] for r in rows])

    def test_empty_frames_give_no_rows(self):
        self.assertEqual(self.m.merge_legs(pd.DataFrame(), pd.DataFrame(), 3), [])


if __name__ == "__main__":
    unittest.main()
