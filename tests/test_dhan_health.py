"""Stubbed tests for lib/dhan_health.py (no broker session, no network)."""
import os
import sys
import unittest
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.dhan_health import IST, evaluate_preflight, kill_switch_active, parse_dhan_datetime, unwrap

NOW = datetime(2026, 10, 12, 9, 30, tzinfo=IST)
GOOD_PROFILE = {"tokenValidity": "13/10/2026 05:30"}
OFF = {"killSwitchStatus": "DEACTIVATE"}
IP = {"primaryIP": "1.2.3.4", "secondaryIP": ""}


class DhanHealthTest(unittest.TestCase):
    def test_datetime_is_ist(self):
        self.assertEqual(parse_dhan_datetime("13/10/2026 05:30").isoformat(), "2026-10-13T05:30:00+05:30")
        self.assertIsNone(parse_dhan_datetime("nope"))

    def test_deactivated_is_not_activated(self):
        self.assertIs(kill_switch_active({"killSwitchStatus": "Kill Switch is Deactivated"}), False)
        self.assertIs(kill_switch_active({"killSwitchStatus": "ACTIVATE"}), True)
        self.assertIsNone(kill_switch_active({"killSwitchStatus": "???"}))

    def test_healthy(self):
        self.assertEqual(evaluate_preflight(GOOD_PROFILE, OFF, IP, "1.2.3.4", NOW), ([], []))

    def test_blockers(self):
        b, _ = evaluate_preflight({"tokenValidity": "12/10/2026 08:00"}, OFF, IP, "1.2.3.4", NOW)
        self.assertTrue(any("expired" in x for x in b))
        b, _ = evaluate_preflight(GOOD_PROFILE, {"killSwitchStatus": "ACTIVATE"}, IP, "1.2.3.4", NOW)
        self.assertTrue(any("kill switch" in x for x in b))
        b, _ = evaluate_preflight(GOOD_PROFILE, OFF, IP, "9.9.9.9", NOW)
        self.assertTrue(any("DH-905" in x for x in b))
        b, _ = evaluate_preflight(GOOD_PROFILE, OFF, {"primaryIP": "", "secondaryIP": ""}, "1.2.3.4", NOW)
        self.assertTrue(any("No static IP" in x for x in b))

    def test_unknowns_only_warn(self):
        b, w = evaluate_preflight(None, None, None, None, NOW)
        self.assertEqual(b, [])
        self.assertEqual(len(w), 2)
        b, w = evaluate_preflight(GOOD_PROFILE, OFF, IP, None, NOW)
        self.assertEqual(b, [])
        self.assertTrue(w)

    def test_unwrap_accepts_wrapped_and_raw(self):
        self.assertEqual(unwrap({"status": "success", "data": {"a": 1}}), {"a": 1})
        self.assertEqual(unwrap({"tokenValidity": "x"}), {"tokenValidity": "x"})
        self.assertIsNone(unwrap({"status": "failure", "remarks": "bad"}))


if __name__ == "__main__":
    unittest.main()
