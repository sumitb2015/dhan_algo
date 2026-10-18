#!/usr/bin/env python
"""Unit tests for lib/straddle_manager.py (pure dataclasses and logic, safe to run anytime).

    venv/bin/python tests/test_straddle_manager.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.straddle_manager import (
    StraddleLeg,
    StraddlePosition,
    StraddleRiskConfig,
    StraddleSignal,
)


class TestStraddleManager(unittest.TestCase):
    def test_straddle_leg_pnl(self):
        leg = StraddleLeg(
            opt_type="CE",
            strike=25000,
            id="101",
            entry_price=100.0,
            qty=50,
            sl=120.0,
            target=70.0,
        )
        # Price drops to 80 (profit): (100 - 80) * 50 = +1000
        self.assertAlmostEqual(leg.compute_unrealized_pnl(80.0), 1000.0)
        # Price rises to 110 (loss): (100 - 110) * 50 = -500
        self.assertAlmostEqual(leg.compute_unrealized_pnl(110.0), -500.0)

        # SL and target triggers
        self.assertTrue(leg.is_sl_hit(120.0, 20.0))
        self.assertFalse(leg.is_sl_hit(119.0, 20.0))
        self.assertTrue(leg.is_target_hit(70.0, 30.0))
        self.assertFalse(leg.is_target_hit(71.0, 30.0))

    def test_straddle_position_pnl_and_serialization(self):
        ce = StraddleLeg("CE", 25000, "101", 100.0, 50, 120.0, 70.0)
        pe = StraddleLeg("PE", 25000, "201", 100.0, 50, 120.0, 70.0)
        pos = StraddlePosition(
            atm_strike=25000,
            combined_p0=200.0,
            ce_leg=ce,
            pe_leg=pe,
            realized_pnl=500.0,
        )
        self.assertTrue(pos.is_open)

        # CE=80 (+1000), PE=90 (+500), realized=500 -> total = 2000
        self.assertAlmostEqual(pos.total_pnl(80.0, 90.0), 2000.0)

        # Serialization round-trip
        data = pos.to_dict()
        restored = StraddlePosition.from_dict(data)
        self.assertEqual(restored.atm_strike, 25000)
        self.assertEqual(restored.combined_p0, 200.0)
        self.assertEqual(restored.ce_leg.strike, 25000)
        self.assertEqual(restored.pe_leg.strike, 25000)
        self.assertEqual(restored.realized_pnl, 500.0)

    def test_straddle_risk_evaluation(self):
        cfg = StraddleRiskConfig(
            combined_sl_pct=20.0,
            leg_sl_pct=20.0,
            leg_target_pct=30.0,
            entry_diff_pct=10.0,
        )
        ce = StraddleLeg("CE", 25000, "101", 100.0, 50, 120.0, 70.0)
        pe = StraddleLeg("PE", 25000, "201", 100.0, 50, 120.0, 70.0)
        pos = StraddlePosition(
            atm_strike=25000,
            combined_p0=200.0,
            ce_leg=ce,
            pe_leg=pe,
        )

        # Normal condition
        self.assertEqual(pos.evaluate_risk(95.0, 95.0, cfg), StraddleSignal.NONE)

        # Combined SL: 200 * 1.20 = 240. If CE=120, PE=121 -> 241 >= 240
        self.assertEqual(pos.evaluate_risk(120.0, 121.0, cfg), StraddleSignal.COMBINED_SL_HIT)

        # Leg SL (combined SL not hit, e.g. CE=122, PE=80 -> combined 202 < 240)
        self.assertEqual(pos.evaluate_risk(122.0, 80.0, cfg), StraddleSignal.CE_SL_HIT)
        self.assertEqual(pos.evaluate_risk(80.0, 122.0, cfg), StraddleSignal.PE_SL_HIT)

        # Leg Target (e.g. CE=68, PE=95 -> CE target hit)
        self.assertEqual(pos.evaluate_risk(68.0, 95.0, cfg), StraddleSignal.CE_TARGET_HIT)
        self.assertEqual(pos.evaluate_risk(95.0, 68.0, cfg), StraddleSignal.PE_TARGET_HIT)


if __name__ == "__main__":
    unittest.main()

