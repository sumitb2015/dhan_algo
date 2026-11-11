"""Pure tests for scripts/tools/crudeoil_oi_collector.py extract_side's change in OI (no API, no Dhan session).

Change in OI = oi - previous_oi, and ONLY when both are numbers (same rule as iv_snapshot_collector.py): a missing
previous_oi must never turn the whole OI into "today's change", nor a missing oi into minus the previous OI.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scripts.tools.crudeoil_oi_collector import extract_side  # noqa: E402


class CrudeOiChangeTests(unittest.TestCase):
    def test_change_is_oi_minus_previous_oi(self):
        self.assertEqual(extract_side({'oi': 3775, 'previous_oi': 3492})['change_OI'], 283)
        self.assertEqual(extract_side({'oi': 5061, 'previous_oi': 5631})['change_OI'], -570)
        self.assertEqual(extract_side({'oi': 100, 'previous_oi': 100})['change_OI'], 0)

    def test_missing_previous_oi_is_blank_not_the_whole_oi(self):
        self.assertEqual(extract_side({'oi': 3775})['change_OI'], '')
        self.assertEqual(extract_side({'oi': 3775, 'previous_oi': None})['change_OI'], '')

    def test_missing_oi_is_blank_not_minus_previous(self):
        self.assertEqual(extract_side({'previous_oi': 3492})['change_OI'], '')
        self.assertEqual(extract_side({})['change_OI'], '')

    def test_oi_column_unchanged(self):
        self.assertEqual(extract_side({'oi': 3775, 'previous_oi': 3492})['OI'], 3775)
        self.assertEqual(extract_side({})['OI'], '')


if __name__ == '__main__':
    unittest.main()
