"""scripts/tools/futures_pnf_candles.py: futures candles -> straddle-shaped bars, and the upcoming-contract pick.

Pure-function test: no Dhan session, no network (the script imports the broker SDK only inside main()).
"""
import importlib.util
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "tools", "futures_pnf_candles.py")
_IST = timezone(timedelta(hours=5, minutes=30))


def _load():
    sys.path.insert(0, os.path.join(ROOT, "scripts", "tools"))
    spec = importlib.util.spec_from_file_location("futures_pnf_candles", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _epoch(day, hh, mm):
    return int(datetime(2026, 10, day, hh, mm, tzinfo=_IST).timestamp())


class ToBars(unittest.TestCase):
    def setUp(self):
        self.m = _load()

    def test_close_becomes_the_price_and_pe_is_zero(self):
        df = pd.DataFrame([(_epoch(23, 9, 0), 9500.5, 7), (_epoch(23, 9, 1), 9501.0, 3)], columns=["start_Time", "close", "volume"])
        bars = self.m.to_bars(df, 3)
        self.assertEqual([b["straddle"] for b in bars], [9500.5, 9501.0])
        self.assertTrue(all(b["pe"] == 0 and b["ce"] == b["straddle"] for b in bars))
        self.assertEqual([b["vol"] for b in bars], [7, 3])

    def test_keeps_only_the_last_sessions_and_drops_zero_closes(self):
        rows = [(_epoch(d, 9, 0), 9000.0 + d, 1) for d in (20, 21, 22, 23)] + [(_epoch(23, 9, 1), 0.0, 1)]
        bars = self.m.to_bars(pd.DataFrame(rows, columns=["start_Time", "close", "volume"]), 2)
        self.assertEqual([b["straddle"] for b in bars], [9022.0, 9023.0])

    def test_with_today_the_sessions_are_completed_days_and_today_comes_on_top(self):
        rows = [(_epoch(d, 9, 0), 9000.0 + d, 1) for d in (20, 21, 22, 23)]
        df = pd.DataFrame(rows, columns=["start_Time", "close", "volume"])
        today = datetime(2026, 10, 23, tzinfo=_IST).date()
        self.assertEqual([b["straddle"] for b in self.m.to_bars(df, 2, today=today)], [9021.0, 9022.0, 9023.0])
        before_open = datetime(2026, 10, 24, tzinfo=_IST).date()   # no bars for "today" yet: just the last two sessions
        self.assertEqual([b["straddle"] for b in self.m.to_bars(df, 2, today=before_open)], [9022.0, 9023.0])

    def test_empty_frame(self):
        self.assertEqual(self.m.to_bars(pd.DataFrame(), 3), [])


class UpcomingContracts(unittest.TestCase):
    def test_skips_expired_and_other_underlyings_soonest_first(self):
        m = _load()
        master = pd.DataFrame({
            "EXCH_ID": ["MCX", "MCX", "MCX", "MCX", "NSE"],
            "INSTRUMENT": ["FUTCOM"] * 4 + ["FUTIDX"],
            "UNDERLYING_SYMBOL": ["CRUDEOILM", "CRUDEOILM", "CRUDEOILM", "CRUDEOIL", "CRUDEOILM"],
            "SM_EXPIRY_DATE": ["2026-10-19 23:30:00", "2026-12-21", "2026-11-19", "2026-11-19", "2026-11-19"],
            "SECURITY_ID": [1, 3, 2, 9, 8],
        })
        self.assertEqual(m.upcoming_contracts(master, "CRUDEOILM", "2026-10-29", 3), [("2026-11-19", "2"), ("2026-12-21", "3")])


if __name__ == "__main__":
    unittest.main()
