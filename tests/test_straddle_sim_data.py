"""scripts/tools/straddle_sim_data.py: expiry list and straddle bars for the Straddle Simulator.

Runs against a tiny temporary SQLite DB with the real option_prices schema; the 8 GB production DB is never opened.
"""
import importlib.util
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "tools", "straddle_sim_data.py")
_IST = timezone(timedelta(hours=5, minutes=30))

SCHEMA = """CREATE TABLE option_prices (expiry TEXT, datetime TEXT, option_type TEXT, strike REAL, strike_relative TEXT,
    open REAL, high REAL, low REAL, close REAL, spot REAL, volume REAL, oi REAL, iv REAL,
    PRIMARY KEY (expiry, datetime, option_type, strike))"""
EXPIRY = "2026-09-22"
DAYS = ["2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22"]
MINUTES = ["09:15:00", "09:16:00", "09:17:00"]
ATM0 = 23000.0  # ATM on every minute of the fixture, so strikes 22800 / 23000 / 23200 exist throughout


def _load():
    spec = importlib.util.spec_from_file_location("straddle_sim_data", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _epoch(day, hhmm):
    return int(datetime.fromisoformat(f"{day} {hhmm}").replace(tzinfo=_IST).timestamp())


def _make_db(skip=None, zero_pe=None):
    f = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    f.close()
    conn = sqlite3.connect(f.name)
    conn.execute(SCHEMA)
    rows = []
    for d in DAYS:
        for m in MINUTES:
            dt = f"{d} {m}"
            for k in range(-10, 11):
                strike = ATM0 + 50 * k
                rel = "ATM" if k == 0 else (f"ATM+{k}" if k > 0 else f"ATM{k}")
                for typ in ("CE", "PE"):
                    if skip and (dt, strike) == skip:
                        continue
                    close = 100.0 + k if typ == "CE" else 90.0 - k
                    if zero_pe and (dt, strike, typ) == zero_pe:
                        close = 0.0
                    rows.append((EXPIRY, dt, typ, strike, rel, close, close, close, close, 23010.0, 1000.0 + k, 5000.0, 0.2))
    conn.executemany("INSERT INTO option_prices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    conn.commit()
    return conn, f.name


class StraddleSimData(unittest.TestCase):
    def setUp(self):
        self.m = _load()
        self.conn, self.path = _make_db()

    def tearDown(self):
        self.conn.close()
        os.unlink(self.path)

    def test_expiries_are_newest_first_with_their_session_range(self):
        out = self.m.list_expiries(self.conn, limit=5)
        self.assertEqual([e["expiry"] for e in out], [EXPIRY])
        self.assertEqual((out[0]["first"], out[0]["last"]), ("2026-09-17", "2026-09-22"))

    def test_payload_has_three_strikes_a_preload_day_and_straddle_sums(self):
        p = self.m.build_payload(self.conn, EXPIRY, "2026-09-21", "2026-09-22", "auto")
        self.assertEqual(p["atm"], 23000)
        self.assertEqual(p["strikes"], [22800, 23000, 23200])
        self.assertEqual(p["preloadSession"], "2026-09-18")
        self.assertEqual(p["sessions"], ["2026-09-21", "2026-09-22"])
        bars = p["bars"]["23000"]
        self.assertEqual(len(bars), 9)  # preload day + 2 replay days, 3 minutes each
        self.assertEqual(bars[0]["t"], _epoch("2026-09-18", "09:15:00"))
        self.assertEqual(bars[0]["ce"], 100.0)
        self.assertEqual(bars[0]["pe"], 90.0)
        self.assertEqual(bars[0]["straddle"], 190.0)
        self.assertEqual(bars[0]["vol"], 2000.0)  # CE + PE per-minute volume
        self.assertEqual([b["t"] for b in bars], sorted(b["t"] for b in bars))

    def test_spot_series_follows_the_bars(self):
        p = self.m.build_payload(self.conn, EXPIRY, "2026-09-21", "2026-09-22", "auto")
        self.assertEqual(len(p["spotT"]), len(p["spotV"]))
        self.assertEqual(p["spotV"][0], 23010.0)
        self.assertEqual(p["spotT"][0], p["bars"]["23000"][0]["t"])

    def test_a_typed_atm_is_used_as_given(self):
        p = self.m.build_payload(self.conn, EXPIRY, "2026-09-21", "2026-09-21", 23050)
        self.assertEqual(p["strikes"], [22850, 23050, 23250])

    def test_no_preload_when_from_is_the_first_session(self):
        p = self.m.build_payload(self.conn, EXPIRY, "2026-09-17", "2026-09-17", "auto")
        self.assertIsNone(p["preloadSession"])
        self.assertEqual(len(p["bars"]["23000"]), 3)

    def test_a_missing_strike_minute_shortens_that_strike_and_is_reported(self):
        conn, path = _make_db(skip=("2026-09-21 09:16:00", 22800.0))
        try:
            p = self.m.build_payload(conn, EXPIRY, "2026-09-21", "2026-09-21", "auto")
            self.assertEqual(p["coverage"]["22800"], 3 + 2)  # preload day + replay day minus the missing minute
            self.assertEqual(p["coverage"]["23000"], 6)
            self.assertEqual(len(p["bars"]["22800"]), 5)
        finally:
            conn.close()
            os.unlink(path)

    def test_a_zero_leg_row_is_dropped(self):
        conn, path = _make_db(zero_pe=("2026-09-21 09:15:00", 23000.0, "PE"))
        try:
            p = self.m.build_payload(conn, EXPIRY, "2026-09-21", "2026-09-21", "auto")
            self.assertEqual(len(p["bars"]["23000"]), 5)
        finally:
            conn.close()
            os.unlink(path)

    def test_a_range_with_no_sessions_is_an_error(self):
        with self.assertRaises(ValueError):
            self.m.build_payload(self.conn, EXPIRY, "2026-10-01", "2026-10-02", "auto")

    def test_unknown_expiry_is_an_error(self):
        with self.assertRaises(ValueError):
            self.m.build_payload(self.conn, "2030-01-01", "2026-09-21", "2026-09-21", "auto")


if __name__ == "__main__":
    unittest.main()
