"""
Unit tests for Nifty Delta-Controlled, Low-Gamma Diagonal Covered-Call Strategy.
Tests pure calculation functions: Black-Scholes Greeks, short call scoring,
portfolio Greek aggregation, dynamic position sizing, and roll trigger rules.
"""

import math
import os
import sys
import unittest

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from strategies.diagonal_call.nifty_diagonal_call import (
    compute_bs_greeks,
    score_short_call,
    calculate_portfolio_greeks,
    calculate_required_short_lots,
    check_short_roll_triggers,
    check_long_roll_triggers,
)


class TestDiagonalCallCalculations(unittest.TestCase):
    def test_compute_bs_greeks(self):
        spot = 22400.0
        # ITM call (e.g. 22000 CE, 90 DTE)
        g_long = compute_bs_greeks(spot, 22000.0, 90, iv=0.14, r=0.07, opt_type="CE")
        self.assertGreater(g_long["delta"], 0.55)
        self.assertLess(g_long["delta"], 0.85)
        self.assertGreater(g_long["gamma"], 0.0)
        self.assertLess(g_long["theta_day"], 0.0)  # negative price decay for long
        self.assertGreater(g_long["vega"], 0.0)

        # OTM call (e.g. 23000 CE, 30 DTE)
        g_short = compute_bs_greeks(spot, 23000.0, 30, iv=0.13, r=0.07, opt_type="CE")
        self.assertGreater(g_short["delta"], 0.10)
        self.assertLess(g_short["delta"], 0.30)
        self.assertGreater(g_short["gamma"], 0.0)
        self.assertLess(g_short["theta_day"], 0.0)

    def test_score_short_call(self):
        # theta_day is negative, score = (-theta_day) / gamma
        score = score_short_call(theta_day=-5.50, gamma=0.00045)
        self.assertAlmostEqual(score, 5.50 / 0.00045, places=2)

        # Non-positive decay or zero gamma yields 0
        self.assertEqual(score_short_call(theta_day=1.0, gamma=0.00045), 0.0)
        self.assertEqual(score_short_call(theta_day=-5.0, gamma=0.0), 0.0)

    def test_calculate_required_short_lots(self):
        # Example from user prompt:
        # 3 long calls x 0.60 delta = 1.80 lots
        # Lot size = 65 -> Long delta shares = 3 x 65 x 0.60 = 117 shares
        # Target portfolio delta = +0.15 lots = 0.15 x 65 = +9.75 shares
        # Required short delta shares = 117 - 9.75 = 107.25 shares
        # Short call delta = 0.20
        # Required short lots = 107.25 / (0.20 x 65) = 107.25 / 13 = 8.25 -> 8 lots!
        long_delta_shares = 3 * 65 * 0.60
        target_net_delta_shares = 0.15 * 65
        lots = calculate_required_short_lots(
            long_delta_shares=long_delta_shares,
            target_net_delta_shares=target_net_delta_shares,
            short_call_delta=0.20,
            lot_size=65,
            max_short_ratio=1.25,
        )
        self.assertEqual(lots, 8)

    def test_calculate_required_short_lots_clamped(self):
        # Max exposure rule: short delta cannot exceed 1.25 x long delta
        long_delta_shares = 100.0
        # Requesting a negative target net delta that would imply massive shorts
        lots = calculate_required_short_lots(
            long_delta_shares=long_delta_shares,
            target_net_delta_shares=-200.0,
            short_call_delta=0.10,
            lot_size=65,
            max_short_ratio=1.25,
        )
        max_allowed_delta = 100.0 * 1.25  # 125
        max_allowed_lots = int(125 / (0.10 * 65))  # 19 lots
        self.assertEqual(lots, max_allowed_lots)

    def test_calculate_portfolio_greeks(self):
        long_leg = {"lots": 3, "strike": 22000, "dte": 90, "iv": 0.14}
        short_leg = {"lots": 8, "strike": 23000, "dte": 30, "iv": 0.13}
        spot = 22400.0
        lot_size = 65

        greeks = calculate_portfolio_greeks(long_leg, short_leg, spot, lot_size)
        self.assertIn("net_delta_shares", greeks)
        self.assertIn("portfolio_gamma", greeks)
        self.assertIn("portfolio_theta_day", greeks)
        self.assertIn("delta_zone", greeks)
        self.assertIn("gamma_status", greeks)

        # Portfolio should collect net daily theta from 8 short options
        self.assertGreater(greeks["portfolio_theta_day"], 0.0)

    def test_check_short_roll_triggers(self):
        short_leg = {"lots": 8, "strike": 23000, "dte": 30, "entry_price": 100.0}

        # 1. Normal hold
        roll, reason = check_short_roll_triggers(
            short_leg, current_short_ltp=80.0, current_short_delta=0.20,
            net_delta_shares=10.0, portfolio_gamma=-0.12, short_roll_dte=14, short_roll_delta=0.35,
        )
        self.assertFalse(roll)

        # 2. Profit-taking: captured 65% decay (LTP dropped to 30)
        roll, reason = check_short_roll_triggers(
            short_leg, current_short_ltp=30.0, current_short_delta=0.08,
            net_delta_shares=10.0, portfolio_gamma=-0.05, short_profit_pct=65.0,
        )
        self.assertTrue(roll)
        self.assertIn("PROFIT_TARGET_CAPTURED", reason)

        # 3. DTE threshold: DTE dropped to 12 days
        short_leg_near = {"lots": 8, "strike": 23000, "dte": 12, "entry_price": 100.0}
        roll, reason = check_short_roll_triggers(
            short_leg_near, current_short_ltp=50.0, current_short_delta=0.20,
            net_delta_shares=10.0, portfolio_gamma=-0.10, short_roll_dte=14,
        )
        self.assertTrue(roll)
        self.assertIn("DTE_THRESHOLD", reason)

        # 4. Short delta expansion: short delta surged to 0.38 (rally)
        roll, reason = check_short_roll_triggers(
            short_leg, current_short_ltp=150.0, current_short_delta=0.38,
            net_delta_shares=5.0, portfolio_gamma=-0.14, short_roll_delta=0.35,
        )
        self.assertTrue(roll)
        self.assertIn("SHORT_DELTA_EXPANSION", reason)

        # 5. Portfolio defensive delta: net delta drops below -40
        roll, reason = check_short_roll_triggers(
            short_leg, current_short_ltp=110.0, current_short_delta=0.30,
            net_delta_shares=-45.0, portfolio_gamma=-0.14,
        )
        self.assertTrue(roll)
        self.assertIn("PORTFOLIO_DELTA_DEFENSIVE", reason)

        # 6. Gamma breach: portfolio gamma < -0.20
        roll, reason = check_short_roll_triggers(
            short_leg, current_short_ltp=110.0, current_short_delta=0.30,
            net_delta_shares=-10.0, portfolio_gamma=-0.22, min_gamma_limit=-0.20,
        )
        self.assertTrue(roll)
        self.assertIn("GAMMA_LIMIT_BREACH", reason)

    def test_check_long_roll_triggers(self):
        long_leg = {"lots": 3, "strike": 22000, "dte": 30}
        roll, reason = check_long_roll_triggers(long_leg, long_roll_dte=35)
        self.assertTrue(roll)
        self.assertIn("LONG_DTE_THRESHOLD", reason)

        long_leg_fresh = {"lots": 3, "strike": 22000, "dte": 85}
        roll, reason = check_long_roll_triggers(long_leg_fresh, long_roll_dte=35)
        self.assertFalse(roll)

    def test_dynamic_iv_clamping(self):
        # Test extreme VIX values are clamped between 0.08 and 0.40
        from unittest.mock import MagicMock
        from strategies.diagonal_call.nifty_diagonal_call import NiftyDiagonalCallStrategy

        mock_helper = MagicMock()
        mock_helper.get_lot_size.return_value = 65
        strat = NiftyDiagonalCallStrategy(helper=mock_helper, live=False)
        # Mock VIX LTP = 13.5 -> 0.135
        strat.helper.get_ltp.return_value = 13.5
        self.assertEqual(strat._get_current_iv(), 0.135)

        # Mock VIX LTP = 5.0 -> clamped to 0.08
        strat.helper.get_ltp.return_value = 5.0
        self.assertEqual(strat._get_current_iv(), 0.08)

        # Mock VIX LTP = 55.0 -> clamped to 0.40
        strat.helper.get_ltp.return_value = 55.0
        self.assertEqual(strat._get_current_iv(), 0.40)

        # Mock VIX failure -> fallback to 0.14
        strat.helper.get_ltp.side_effect = Exception("API error")
        self.assertEqual(strat._get_current_iv(), 0.14)

    def test_multi_broker_wait_for_fill(self):
        from unittest.mock import MagicMock
        from strategies.diagonal_call.nifty_diagonal_call import NiftyDiagonalCallStrategy

        mock_helper = MagicMock()
        mock_helper.get_lot_size.return_value = 65

        # Dhan broker: calls helper.wait_for_fill
        strat_dhan = NiftyDiagonalCallStrategy(helper=mock_helper, broker="dhan", live=True)
        strat_dhan.helper.wait_for_fill.return_value = True
        filled = strat_dhan._wait_for_fill("12345", 24000, "2026-10-27", "CE", +65, 0)
        self.assertTrue(filled)
        strat_dhan.helper.wait_for_fill.assert_called_once_with("12345", timeout=15)

        # Zerodha broker: checks broker.get_owned_net_qty against net_before + signed_qty
        strat_zero = NiftyDiagonalCallStrategy(helper=mock_helper, broker="zerodha", live=True)
        strat_zero.broker = MagicMock()
        strat_zero.broker.get_owned_net_qty.return_value = 130  # expected = 65 + 65
        filled = strat_zero._wait_for_fill("2410040001", 24000, "2026-10-27", "CE", +65, 65, timeout=2)
        self.assertTrue(filled)

    def test_long_cost_recovery_and_free_long_call(self):
        from unittest.mock import MagicMock
        from strategies.diagonal_call.nifty_diagonal_call import NiftyDiagonalCallStrategy

        mock_helper = MagicMock()
        mock_helper.get_lot_size.return_value = 65
        strat = NiftyDiagonalCallStrategy(helper=mock_helper, live=False)

        # Example from user prompt:
        # Long: 3 x 65 = 195 units @ Rs 804.16 -> Initial Debit = Rs 1,56,811.20
        strat.long_leg = {"strike": 23000, "lots": 3, "entry_price": 804.16}
        strat.initial_long_debit = 804.16 * 195  # 156,811.20

        # Stage 1: Collected Rs 42,000 from short calls
        strat.cumulative_short_premium = 42000.0
        lcr_pct, total_short, is_free = strat.compute_lcr()
        # 42000 / 156811.20 = 26.78% -> 26.8%
        self.assertAlmostEqual(lcr_pct, 26.8, places=1)
        self.assertFalse(is_free)

        # Stage 2: Short calls accumulate Rs 1,60,000 -> LCR > 100% -> Free Long Call!
        strat.cumulative_short_premium = 160000.0
        lcr_pct, total_short, is_free = strat.compute_lcr()
        self.assertGreaterEqual(lcr_pct, 100.0)
        self.assertTrue(is_free)
        self.assertTrue(strat.is_free_long_call)


if __name__ == "__main__":
    unittest.main()


