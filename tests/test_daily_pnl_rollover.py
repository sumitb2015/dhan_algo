"""Run-cumulative `realized_pnl` must reset when the calendar date rolls.

These strategies compare `realized_pnl` (+ open P&L) to a daily target / stop-loss and wait for
the next session after hitting one. Without a per-day reset, day 1's total made the first tick
of day 2 exit again, and a normal day's P&L leaked into the next day's limits.
Each test drives the real `run()` outer loop up to the first step after the market-open wait.
"""
import importlib
import os
import sys
import unittest
from datetime import date, datetime, timedelta
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.strategy_state_helper import reset_pnl_on_new_day

PKG = "strategies.value_imbalance."
# (module, class, ctor kwargs, method run() calls right after the rollover -> we stop there)
STRATEGIES = [
    ("nifty_delta_neutral", "NiftyDeltaNeutral", {}, "reset_session"),
    ("nifty_value_imbalance_straddle", "ValueImbalanceStrategy", {}, "reset_session"),
    ("nifty_value_imbalance_strangle", "ValueImbalanceStrangle", {"strike_selection": "distance"}, "reset_session"),
    ("nifty_winner_roll_straddle", "WinnerRollStraddleStrategy", {}, "reset_session"),
    ("nifty_vix_straddle", "NiftyVixStraddle", {}, "_nifty_spot"),
    ("nifty_vwap_1min_straddle", "NiftyVWAP1MinStraddle", {}, "_nifty_spot"),
]


class _Stop(Exception):
    pass


class ResetHelper(unittest.TestCase):
    def test_first_call_only_records_date(self):
        s = MagicMock(spec=[]); s.realized_pnl = 4000.0
        self.assertFalse(reset_pnl_on_new_day(s))
        self.assertEqual(s.realized_pnl, 4000.0)
        self.assertEqual(s.pnl_date, datetime.now().date())

    def test_same_day_keeps_pnl(self):
        s = MagicMock(spec=[]); s.realized_pnl = -1500.0; s.pnl_date = datetime.now().date()
        self.assertFalse(reset_pnl_on_new_day(s))
        self.assertEqual(s.realized_pnl, -1500.0)

    def test_new_day_resets_pnl(self):
        s = MagicMock(spec=[]); s.realized_pnl = 4000.0; s.pnl_date = datetime.now().date() - timedelta(days=1)
        self.assertTrue(reset_pnl_on_new_day(s))
        self.assertEqual(s.realized_pnl, 0.0)
        self.assertEqual(s.pnl_date, datetime.now().date())


class RunLoopRollover(unittest.TestCase):
    def build(self, module, cls, kwargs):
        mod = importlib.import_module(PKG + module)
        helper = MagicMock()
        helper.get_prev_day_levels.return_value = {"high": 24100.0, "low": 23900.0, "close": 24000.0}
        helper.get_lot_size.return_value = 75
        for name, value in (("get_dhan_client", MagicMock()), ("DhanHelper", MagicMock(return_value=helper)),
                            ("check_shutdown_trigger", MagicMock(return_value=False)),
                            ("exit_if_market_closed", MagicMock()), ("save_strategy_state", MagicMock()),
                            ("notify", MagicMock())):
            if hasattr(mod, name):
                p = patch.object(mod, name, value); p.start(); self.addCleanup(p.stop)
        p = patch("time.sleep"); p.start(); self.addCleanup(p.stop)
        return getattr(mod, cls)(**kwargs)

    def drive(self, module, cls, kwargs, stop_at, prev_date):
        s = self.build(module, cls, kwargs)
        s.realized_pnl = 5000.0
        s.pnl_date = prev_date
        s.helper.wait_for_market_open = MagicMock()
        setattr(s, stop_at, MagicMock(side_effect=_Stop))
        with self.assertRaises(_Stop):
            s.run()
        return s

    def test_each_strategy_resets_on_new_day(self):
        for module, cls, kwargs, stop_at in STRATEGIES:
            with self.subTest(strategy=module):
                s = self.drive(module, cls, kwargs, stop_at, datetime.now().date() - timedelta(days=1))
                self.assertEqual(s.realized_pnl, 0.0)
                self.assertEqual(s.pnl_date, datetime.now().date())

    def test_each_strategy_keeps_pnl_within_a_day(self):
        for module, cls, kwargs, stop_at in STRATEGIES:
            with self.subTest(strategy=module):
                s = self.drive(module, cls, kwargs, stop_at, datetime.now().date())
                self.assertEqual(s.realized_pnl, 5000.0)


if __name__ == "__main__":
    unittest.main()
