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
            nofetch = lambda *a: pd.DataFrame()
            out = m.load_daily_before("ABC", first, d, d, nofetch)
            self.assertTrue(m.load_daily_before("NOPE", first, d, d, nofetch).empty)
        self.assertEqual(list(out["close"]), [10.0])
        self.assertEqual(int(out["start_Time"][0]), int(pd.Timestamp("2026-06-04 15:29:00", tz="Asia/Kolkata").timestamp()))


class YahooPre2019(unittest.TestCase):
    def _csv(self, d, rows):
        with open(os.path.join(d, "ABC_Daily_2Y.csv"), "w") as f:
            f.write("Datetime,Open,High,Low,Close,Volume\n" + "".join(f"{r}\n" for r in rows))

    def test_older_yahoo_rows_join_the_csv_scaled_to_its_basis_and_are_cached(self):
        import tempfile
        m = _load()
        dates = pd.bdate_range("2019-01-01", periods=70)
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as y:
            self._csv(d, [f"{t.date()},100,102,98,100,10" for t in dates])
            calls = []

            def fetch(sym, start, end):
                calls.append((sym, start, end))
                idx = pd.bdate_range("2018-12-24", periods=70)   # 5 days before the CSV, then the overlap
                return pd.DataFrame({"Open": 98.4, "High": 100.4, "Low": 96.4, "Close": 98.4, "Volume": 7.0}, index=pd.DatetimeIndex(idx, name="Datetime"))
            first = int(pd.Timestamp("2019-06-01", tz="Asia/Kolkata").timestamp())
            out = m.load_daily_before("ABC", first, d, y, fetch)
            self.assertEqual(calls[0][1], "2008-01-01")
            self.assertEqual(len(out), 70 + 6)                       # 6 Yahoo days (24-31 Dec) before the CSV starts, then the CSV
            self.assertAlmostEqual(out["close"].iloc[0], 100.0, places=1)   # 98.4 x (100 / 98.4)
            m.load_daily_before("ABC", first, d, y, fetch)
            self.assertEqual(len(calls), 1)                          # second call reads the cache

    def test_an_unsteady_ratio_refuses_to_join_two_price_bases(self):
        import tempfile
        m = _load()
        dates = pd.bdate_range("2019-01-01", periods=70)
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as y:
            self._csv(d, [f"{t.date()},100,102,98,100,10" for t in dates])
            wobble = lambda sym, s, e: pd.DataFrame({"Open": 1.0, "High": 1.0, "Low": 1.0, "Close": [50 + 5 * (i % 7) for i in range(70)], "Volume": 1.0},
                                                    index=pd.DatetimeIndex(pd.bdate_range("2018-12-24", periods=70), name="Datetime"))
            first = int(pd.Timestamp("2019-06-01", tz="Asia/Kolkata").timestamp())
            out = m.load_daily_before("ABC", first, d, y, wobble)
            self.assertEqual(len(out), 70)                           # CSV only


class SnapCloses(unittest.TestCase):
    def test_last_minute_of_a_session_takes_the_official_close_unless_the_basis_differs_or_the_day_is_missing(self):
        m = _load()
        t = lambda d, hm: int(pd.Timestamp(f"{d} {hm}", tz="Asia/Kolkata").timestamp())
        bars = pd.DataFrame({
            "start_Time": [t("2026-10-22", "15:13"), t("2026-10-22", "15:14"), t("2026-10-23", "15:14"), t("2026-10-26", "15:14"), t("2026-10-27", "15:14")],
            "close": [1250.0, 1247.0, 1200.4, 500.0, 1300.0], "volume": [1, 1, 1, 1, 1]})
        daily = pd.DataFrame({"Close": [1250.5, 1185.1, 1250.0]}, index=pd.DatetimeIndex(["2026-10-22", "2026-10-23", "2026-10-26"]))
        out = m.snap_session_closes(bars, daily)
        self.assertEqual(list(out["close"]), [1250.0, 1250.5, 1185.1, 500.0, 1300.0])   # only the LAST bar of a day; 10-26 differs 60%: kept; 10-27 has no CSV row: kept


class IndexDaily(unittest.TestCase):
    def test_daily_index_rows_before_the_first_minute_bar_become_1529_ist_closes(self):
        import tempfile
        m = _load()
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "NIFTY.csv")
            with open(path, "w") as f:
                f.write("Datetime,Open,High,Low,Close,Volume\n2024-09-18,1,1,1,25400.5,10\n2024-09-19,1,1,1,25415.8,0\n2024-09-20,1,1,1,25500,0\n")
            first = int(pd.Timestamp("2024-09-20 09:15", tz="Asia/Kolkata").timestamp())
            out = m.load_index_daily_before("NIFTY", first, path)
            self.assertTrue(m.load_index_daily_before("NIFTY", first, os.path.join(d, "missing.csv")).empty)
        self.assertEqual(list(out["close"]), [25400.5, 25415.8])
        self.assertEqual(int(out["start_Time"].iloc[-1]), int(pd.Timestamp("2024-09-19 15:29", tz="Asia/Kolkata").timestamp()))


if __name__ == "__main__":
    unittest.main()
