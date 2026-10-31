"""scripts/tools/price_pnf_candles.py: equity resolution and contract-leg parsing (no Dhan session, no network)."""
import importlib.util
import os
import sys
import unittest

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "tools", "price_pnf_candles.py")


def _load():
    sys.path.insert(0, os.path.join(ROOT, "scripts", "tools"))
    spec = importlib.util.spec_from_file_location("price_pnf_candles", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class ResolveEquity(unittest.TestCase):
    def test_prefers_eq_over_be_and_ignores_other_exchanges_and_series(self):
        m = _load()
        master = pd.DataFrame({
            "EXCH_ID": ["NSE", "NSE", "BSE", "NSE"],
            "INSTRUMENT": ["EQUITY"] * 4,
            "UNDERLYING_SYMBOL": ["ABC"] * 4,
            "SERIES": ["BE", "EQ", "EQ", "SM"],
            "SECURITY_ID": [11, 22, 33, 44],
            "SYMBOL_NAME": ["ABC BE", "ABC LIMITED", "ABC BSE", "ABC SM"],
        })
        self.assertEqual(m.resolve_equity(master, "ABC"), ("22", "ABC LIMITED"))
        self.assertIsNone(m.resolve_equity(master, "XYZ"))


class ParseLegs(unittest.TestCase):
    def test_one_or_two_fno_legs(self):
        m = _load()
        self.assertEqual(m.parse_legs("NSE_FNO:53872:OPTIDX"), [("NSE_FNO", "53872", "OPTIDX")])
        self.assertEqual(m.parse_legs("MCX_COMM:1:OPTFUT, MCX_COMM:2:OPTFUT"), [("MCX_COMM", "1", "OPTFUT"), ("MCX_COMM", "2", "OPTFUT")])

    def test_rejects_other_segments_instruments_ids_and_counts(self):
        m = _load()
        for bad in ["", "NSE_EQ:1:EQUITY", "NSE_FNO:abc:OPTIDX", "NSE_FNO:1:INDEX", "NSE_FNO:1", "a:1:OPTIDX,b:2:OPTIDX",
                    "NSE_FNO:1:OPTIDX,NSE_FNO:2:OPTIDX,NSE_FNO:3:OPTIDX"]:
            with self.assertRaises(ValueError, msg=bad):
                m.parse_legs(bad)


class StoredHistory(unittest.TestCase):
    def test_stored_bars_are_ist_epoch_and_api_wins_on_overlap(self):
        import tempfile
        m = _load()
        idx = pd.DatetimeIndex(["2026-06-08 09:15:00", "2026-06-08 09:16:00"], name="Datetime")
        raw = pd.DataFrame({"Open": 1.0, "High": 1.0, "Low": 1.0, "Close": [10.0, 11.0], "Volume": [5.0, 6.0]}, index=idx)
        with tempfile.TemporaryDirectory() as d:
            raw.to_parquet(os.path.join(d, "ABC.parquet"))
            stored = m.load_stored_1min("ABC", d)
            self.assertTrue(m.load_stored_1min("NOPE", d).empty)
        t0 = int(pd.Timestamp("2026-06-08 09:15:00", tz="Asia/Kolkata").timestamp())
        self.assertEqual(list(stored["start_Time"]), [t0, t0 + 60])
        fresh = pd.DataFrame({"start_Time": [t0 + 60, t0 + 120], "close": [99.0, 12.0], "volume": [1, 2]})
        from straddle_pnf_candles import _leg
        out = _leg(m.stitch_history(stored, fresh)).sort_values("t")
        self.assertEqual(list(out["close"]), [10.0, 99.0, 12.0])


class DailyPrefix(unittest.TestCase):
    def test_only_days_before_the_first_minute_bar_at_1529_ist(self):
        import tempfile
        m = _load()
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "ABC_Daily_2Y.csv"), "w") as f:
                f.write("Datetime,Open,High,Low,Close,Volume\n2026-06-04,1,1,1,10,100\n2026-06-05,1,1,1,0,0\n2026-06-08,1,1,1,12,200\n")
            first = int(pd.Timestamp("2026-06-08 09:15:00", tz="Asia/Kolkata").timestamp())
            out = m.load_daily_before("ABC", first, d)
            self.assertTrue(m.load_daily_before("NOPE", first, d).empty)
        self.assertEqual(list(out["close"]), [10.0])
        self.assertEqual(int(out["start_Time"][0]), int(pd.Timestamp("2026-06-04 15:29:00", tz="Asia/Kolkata").timestamp()))


if __name__ == "__main__":
    unittest.main()
