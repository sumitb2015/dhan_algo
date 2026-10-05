"""
Unit tests for Nifty Bi-Weekly Adaptive Strangle Strategy pure functions:
  - greeks_from_days (library delta/vega as this strategy calls them)
  - choose_strangle_strikes
  - evaluate_threat_and_hedging
  - evaluate_directional_conversion
"""

import math
import os
import sys
import unittest

# Ensure project root is in sys.path
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from lib.options_pricing import greeks_from_days  # noqa: E402
from strategies.adaptive_strangle.nifty_adaptive_strangle import (
    choose_strangle_strikes,
    evaluate_threat_and_hedging,
    evaluate_directional_conversion,
)


class TestAdaptiveStrangleMath(unittest.TestCase):

    def test_bs_delta_atm_and_otm(self):
        spot = 25000.0
        dte = 10.0

        # ATM Call should be near ~0.50
        atm_ce_d = greeks_from_days("CE", spot, 25000, dte, 0.15, min_days=0.5).delta
        self.assertAlmostEqual(atm_ce_d, 0.50, delta=0.10)

        # ATM Put should be near ~ -0.50
        atm_pe_d = greeks_from_days("PE", spot, 25000, dte, 0.15, min_days=0.5).delta
        self.assertAlmostEqual(atm_pe_d, -0.50, delta=0.10)

        # Far OTM Call (25500) should have low positive delta ~ 0.08 - 0.15
        otm_ce_d = greeks_from_days("CE", spot, 25500, dte, 0.15, min_days=0.5).delta
        self.assertGreater(otm_ce_d, 0.0)
        self.assertLess(otm_ce_d, 0.25)

        # Far OTM Put (24500) should have low negative delta ~ -0.08 - -0.15
        otm_pe_d = greeks_from_days("PE", spot, 24500, dte, 0.15, min_days=0.5).delta
        self.assertLess(otm_pe_d, 0.0)
        self.assertGreater(otm_pe_d, -0.25)

        # Put-Call Parity Delta Check: Delta_CE - Delta_PE should equal 1.0 (approx for small t)
        self.assertAlmostEqual(atm_ce_d - atm_pe_d, 1.0, delta=0.01)

    def test_bs_vega_behavior(self):
        spot = 25000.0
        dte = 10.0

        # Vega must be positive
        atm_vega = greeks_from_days("CE", spot, 25000, dte, 0.15, min_days=0.5).vega
        self.assertGreater(atm_vega, 0.0)

        # Vega peaks near ATM and decays far OTM
        far_otm_vega = greeks_from_days("CE", spot, 26000, dte, 0.15, min_days=0.5).vega
        self.assertGreater(atm_vega, far_otm_vega)

        # Invalid spot or strike returns 0.0
        self.assertEqual(greeks_from_days("CE", 0, 25000, dte, 0.15, min_days=0.5).vega, 0.0)
        self.assertEqual(greeks_from_days("CE", 25000, 0, dte, 0.15, min_days=0.5).vega, 0.0)

    def test_choose_strangle_strikes(self):
        spot = 25000.0
        dte = 10.0

        strikes = choose_strangle_strikes(None, spot, dte, entry_delta=0.10)
        ce = strikes["ce_short"]
        pe = strikes["pe_short"]

        # Inversion guard: CE strike must strictly exceed PE strike
        self.assertGreater(ce["strike"], pe["strike"])
        self.assertGreater(ce["strike"], spot)
        self.assertLess(pe["strike"], spot)

        # Deltas should be in the target zone (~0.10)
        self.assertAlmostEqual(ce["delta"], 0.10, delta=0.05)
        self.assertAlmostEqual(abs(pe["delta"]), 0.10, delta=0.05)

    def test_evaluate_threat_and_hedging(self):
        # 1. Normal state: Both deltas low, no IV surge
        res_normal = evaluate_threat_and_hedging(
            ce_delta=0.12, pe_delta=-0.11, iv_change_pct=0.0,
            hedge_delta_trigger=0.22, vega_surge_pct=20.0
        )
        self.assertFalse(res_normal["need_ce_hedge"])
        self.assertFalse(res_normal["need_pe_hedge"])

        # 2. Bullish threat: CE delta reaches 0.24 (>= 0.22)
        res_ce_threat = evaluate_threat_and_hedging(
            ce_delta=0.24, pe_delta=-0.04, iv_change_pct=5.0,
            hedge_delta_trigger=0.22, vega_surge_pct=20.0
        )
        self.assertTrue(res_ce_threat["need_ce_hedge"])
        self.assertFalse(res_ce_threat["need_pe_hedge"])

        # 3. Bearish threat: PE delta reaches -0.25 (magnitude >= 0.22)
        res_pe_threat = evaluate_threat_and_hedging(
            ce_delta=0.03, pe_delta=-0.25, iv_change_pct=5.0,
            hedge_delta_trigger=0.22, vega_surge_pct=20.0
        )
        self.assertFalse(res_pe_threat["need_ce_hedge"])
        self.assertTrue(res_pe_threat["need_pe_hedge"])

        # 4. Volatility surge: IV expands by 25% (>= 20%) -> triggers BOTH hedges
        res_vega_surge = evaluate_threat_and_hedging(
            ce_delta=0.14, pe_delta=-0.13, iv_change_pct=25.0,
            hedge_delta_trigger=0.22, vega_surge_pct=20.0
        )
        self.assertTrue(res_vega_surge["need_ce_hedge"])
        self.assertTrue(res_vega_surge["need_pe_hedge"])

        # 5. Already hedged legs do NOT re-trigger
        res_already_hedged = evaluate_threat_and_hedging(
            ce_delta=0.25, pe_delta=-0.25, iv_change_pct=30.0,
            has_ce_hedge=True, has_pe_hedge=True
        )
        self.assertFalse(res_already_hedged["need_ce_hedge"])
        self.assertFalse(res_already_hedged["need_pe_hedge"])

    def test_evaluate_directional_conversion(self):
        spot = 25200.0
        trend_ema = 25050.0

        # Bullish conversion: CE delta >= 0.30 and spot > EMA
        dir_bull = evaluate_directional_conversion(
            ce_delta=0.32, pe_delta=-0.03, spot=spot, trend_ema=trend_ema, conversion_delta_trigger=0.30
        )
        self.assertEqual(dir_bull, "BULLISH")

        # Bearish conversion: PE delta >= 0.30 and spot < EMA
        spot_bear = 24800.0
        trend_ema_bear = 24950.0
        dir_bear = evaluate_directional_conversion(
            ce_delta=0.03, pe_delta=-0.33, spot=spot_bear, trend_ema=trend_ema_bear, conversion_delta_trigger=0.30
        )
        self.assertEqual(dir_bear, "BEARISH")

        # Neutral: Deltas < 0.30
        dir_none = evaluate_directional_conversion(
            ce_delta=0.18, pe_delta=-0.12, spot=spot, trend_ema=trend_ema, conversion_delta_trigger=0.30
        )
        self.assertIsNone(dir_none)


if __name__ == "__main__":
    unittest.main()
