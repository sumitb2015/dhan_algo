#!/usr/bin/env python
"""Unit tests for lib/managed_straddle_rules.py (pure functions, no broker, safe to run anytime).

    venv/bin/python tests/test_managed_straddle_rules.py
"""
import os
import sys
import unittest
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.managed_straddle_rules import (
    atm_strike,
    atm_imbalance_pct,
    is_atm_balanced,
    combined_sl_hit,
    leg_sl_hit,
    leg_target_hit,
    is_inverted,
    find_match_strike,
)


class TestManagedStraddleRules(unittest.TestCase):
    def test_atm_strike(self):
        self.assertEqual(atm_strike(25023, 50), 25000)
        self.assertEqual(atm_strike(25026, 50), 25050)
        self.assertEqual(atm_strike(25049, 50), 25050)
        self.assertEqual(atm_strike(25075, 50), 25100)
        self.assertEqual(atm_strike(0, 50), 0)

    def test_atm_imbalance_and_balance(self):
        # CE=100, PE=95 -> diff is 5% < 10% -> balanced
        self.assertAlmostEqual(atm_imbalance_pct(100.0, 95.0), 5.0)
        self.assertTrue(is_atm_balanced(100.0, 95.0, threshold_pct=10.0))

        # CE=100, PE=88 -> diff is 12% >= 10% -> not balanced
        self.assertAlmostEqual(atm_imbalance_pct(100.0, 88.0), 12.0)
        self.assertFalse(is_atm_balanced(100.0, 88.0, threshold_pct=10.0))

        # Boundary test: exactly 10% difference
        self.assertAlmostEqual(atm_imbalance_pct(100.0, 90.0), 10.0)
        self.assertFalse(is_atm_balanced(100.0, 90.0, threshold_pct=10.0))

        # Missing or zero prices
        self.assertFalse(is_atm_balanced(0.0, 100.0, threshold_pct=10.0))
        self.assertFalse(is_atm_balanced(100.0, 0.0, threshold_pct=10.0))

    def test_combined_sl(self):
        # Entry combined: CE 100 + PE 100 = 200
        # 20% SL threshold = 200 * 1.20 = 240
        p0 = 200.0
        self.assertFalse(combined_sl_hit(110.0, 110.0, p0, sl_pct=20.0))  # 220 < 240
        self.assertFalse(combined_sl_hit(120.0, 119.0, p0, sl_pct=20.0))  # 239 < 240
        self.assertTrue(combined_sl_hit(120.0, 120.0, p0, sl_pct=20.0))   # 240 == 240 -> Hit
        self.assertTrue(combined_sl_hit(150.0, 100.0, p0, sl_pct=20.0))   # 250 > 240 -> Hit

    def test_leg_sl(self):
        # Entry price 100.0. 20% SL level = 120.0
        entry = 100.0
        self.assertFalse(leg_sl_hit(119.9, entry, sl_pct=20.0))
        self.assertTrue(leg_sl_hit(120.0, entry, sl_pct=20.0))
        self.assertTrue(leg_sl_hit(125.0, entry, sl_pct=20.0))

    def test_leg_target(self):
        # Entry price 100.0. 30% target decay level = 100 * (1 - 0.30) = 70.0
        entry = 100.0
        self.assertFalse(leg_target_hit(70.1, entry, target_pct=30.0))
        self.assertTrue(leg_target_hit(70.0, entry, target_pct=30.0))
        self.assertTrue(leg_target_hit(65.0, entry, target_pct=30.0))

    def test_inversion(self):
        self.assertFalse(is_inverted(25100, 25000))
        self.assertTrue(is_inverted(25000, 25000))
        self.assertTrue(is_inverted(24900, 25000))

    def test_find_match_strike_df(self):
        # Create sample option chain DataFrame
        data = {
            "ce_last_price": [150.0, 120.0, 95.0, 72.0, 50.0],
            "pe_last_price": [45.0, 68.0, 92.0, 125.0, 160.0],
            "ce_security_id": ["101", "102", "103", "104", "105"],
            "pe_security_id": ["201", "202", "203", "204", "205"],
        }
        df = pd.DataFrame(data, index=[24900, 24950, 25000, 25050, 25100])

        # Match CE to target premium 70.0
        # Candidate CEs: 24900:150, 24950:120, 25000:95, 25050:72 (diff 2), 25100:50 (diff 20)
        # Closest is 25050 @ 72.0
        strike, px, sec_id = find_match_strike(df, "CE", target_premium=70.0)
        self.assertEqual(strike, 25050)
        self.assertEqual(px, 72.0)
        self.assertEqual(sec_id, "104")

        # Match PE to target premium 90.0
        # Candidate PEs: 24900:45, 24950:68, 25000:92 (diff 2), 25050:125, 25100:160
        # Closest is 25000 @ 92.0
        strike, px, sec_id = find_match_strike(df, "PE", target_premium=90.0)
        self.assertEqual(strike, 25000)
        self.assertEqual(px, 92.0)
        self.assertEqual(sec_id, "203")

        # Non-inversion filter test
        # If PE is at 25000, CE must be > 25000
        strike, px, sec_id = find_match_strike(df, "CE", target_premium=100.0, non_inverted_with=("PE", 25000))
        # 25000 is excluded, closest > 25000 is 25050 (72.0)
        self.assertEqual(strike, 25050)

    def test_find_match_strike_list(self):
        records = [
            {"strike": 24900, "option_type": "CE", "price": 140.0, "security_id": "1"},
            {"strike": 25000, "option_type": "CE", "price": 98.0, "security_id": "2"},
            {"strike": 25100, "option_type": "CE", "price": 60.0, "security_id": "3"},
        ]
        strike, px, sec_id = find_match_strike(records, "CE", target_premium=95.0)
        self.assertEqual(strike, 25000)
        self.assertEqual(px, 98.0)
        self.assertEqual(sec_id, "2")


if __name__ == "__main__":
    unittest.main()
