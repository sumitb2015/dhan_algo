"""scripts/tools/yahoo_pre2019.py: the pre-2019 Yahoo cache filler (no Dhan session, no network: fetch is faked)."""
import importlib.util
import os
import sys
import tempfile
import unittest

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "tools", "yahoo_pre2019.py")


def _load():
    sys.path.insert(0, os.path.join(ROOT, "scripts", "tools"))
    spec = importlib.util.spec_from_file_location("yahoo_pre2019", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _csv(d, sym="ABC"):
    with open(os.path.join(d, f"{sym}_Daily_2Y.csv"), "w") as f:
        f.write("Datetime,Open,High,Low,Close,Volume\n2019-01-01,100,102,98,100,10\n2019-01-02,100,102,98,101,10\n")


def _frame():
    idx = pd.DatetimeIndex(pd.bdate_range("2008-01-01", periods=3), name="Datetime")
    return pd.DataFrame({"Open": 1.0, "High": 2.0, "Low": 0.5, "Close": 1.5, "Volume": 5}, index=idx)


class FillOne(unittest.TestCase):
    def test_fetches_2008_to_90_days_past_the_csv_start_and_caches(self):
        m = _load()
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as y:
            _csv(d)
            calls = []
            r = m.fill_one("ABC", d, y, lambda s, a, b: (calls.append((s, a, b)), _frame())[1])
            self.assertEqual(calls, [("ABC", "2008-01-01", "2019-04-01")])
            self.assertEqual(r, {"symbol": "ABC", "ok": True, "cached": False, "rows": 3})
            self.assertTrue(os.path.isfile(os.path.join(y, "ABC.csv")))
            # a second call is a no-op: the cache is never refetched or overwritten
            r2 = m.fill_one("ABC", d, y, lambda *a: self.fail("refetched"))
            self.assertTrue(r2["cached"])

    def test_writes_nothing_when_yahoo_returns_nothing(self):
        m = _load()
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as y:
            _csv(d)
            r = m.fill_one("ABC", d, y, lambda *a: pd.DataFrame())
            self.assertFalse(r["ok"])
            self.assertEqual(os.listdir(y), [])

    def test_no_daily_csv_is_an_error_without_a_fetch(self):
        m = _load()
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as y:
            r = m.fill_one("NOPE", d, y, lambda *a: self.fail("fetched"))
            self.assertEqual(r["error"], "no daily CSV")


if __name__ == "__main__":
    unittest.main()
