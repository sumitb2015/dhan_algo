"""Pure tests for lib/eod_oi_sidecar.py and the collector's record_prev_session_eod_oi (no API, no Dhan session)."""
import json
import os
import sys
import tempfile
import unittest
from datetime import date
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib.eod_oi_sidecar import (  # noqa: E402
    eod_oi_path, eod_oi_from_chain, last_expiry_of_csv, previous_trading_day, write_eod_oi,
)

OC = {
    '25000.000000': {'ce': {'oi': 2695420, 'previous_oi': 2640755}, 'pe': {'oi': 1, 'previous_oi': 7703020}},
    '25050.000000': {'ce': {'previous_oi': 0}, 'pe': {}},
    '25075.5': {'ce': {'previous_oi': '12'}, 'pe': {'previous_oi': None}},
    'bad': {'ce': {'previous_oi': 5}},
}
HEAD = 'timestamp,spot,expiry,strike,CE_OI\n'


class EodOiTests(unittest.TestCase):
    def test_path(self):
        self.assertEqual(eod_oi_path('/d/iv_snapshots_NIFTY_2026-11-13.csv'), '/d/iv_snapshots_NIFTY_2026-11-13_eod_oi.json')

    def test_reads_previous_oi_only_and_never_zero(self):
        self.assertEqual(eod_oi_from_chain(OC), {'ce': {'25000': 2640755, '25075.5': 12}, 'pe': {'25000': 7703020}})

    def test_previous_trading_day_skips_weekend_and_holidays(self):
        self.assertEqual(previous_trading_day(date(2026, 11, 16)), date(2026, 11, 13))   # Monday -> Friday
        self.assertEqual(previous_trading_day(date(2026, 11, 13)), date(2026, 11, 12))

    def test_last_expiry_skips_a_cut_row(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'x.csv')
            with open(p, 'w') as f:
                f.write(HEAD + '2026-11-13 15:39:40,25144,2026-11-17,25000,1\n2026-11-13 15:39:40,25144,2026-11-24')
            self.assertEqual(last_expiry_of_csv(p), '2026-11-17')
            self.assertIsNone(last_expiry_of_csv(os.path.join(d, 'missing.csv')))

    def test_write_is_atomic_and_skips_an_empty_chain(self):
        with tempfile.TemporaryDirectory() as d:
            csv = os.path.join(d, 'iv_snapshots_NIFTY_2026-11-13.csv')
            self.assertFalse(write_eod_oi(csv, '2026-11-13', '2026-11-17', {}, 'now'))
            self.assertFalse(os.path.exists(eod_oi_path(csv)))
            self.assertTrue(write_eod_oi(csv, '2026-11-13', '2026-11-17', OC, '2026-11-16 08:25:00'))
            with open(eod_oi_path(csv)) as f:
                data = json.load(f)
            self.assertEqual((data['date'], data['expiry'], data['ce']['25000']), ('2026-11-13', '2026-11-17', 2640755))
            self.assertEqual([n for n in os.listdir(d) if n.endswith('.tmp')], [])


class CollectorHookTests(unittest.TestCase):
    def _run(self, d, expiry, today):
        import scripts.tools.iv_snapshot_collector as col
        csv = os.path.join(d, 'iv_snapshots_NIFTY_2026-11-13.csv')
        with open(csv, 'w') as f:
            f.write(HEAD + f'2026-11-13 15:39:40,25144,{expiry},25000,1\n')
        helper = mock.Mock()
        helper.get_option_chain.return_value = {'oc': OC}
        with mock.patch.object(col, 'get_csv_paths', lambda day, u: [csv] if day == date(2026, 11, 13) else []):
            col.record_prev_session_eod_oi(helper, ['NIFTY'], today, sleep=lambda s: None)
        return csv, helper

    def test_writes_for_the_previous_session_once(self):
        with tempfile.TemporaryDirectory() as d:
            csv, helper = self._run(d, '2026-11-17', date(2026, 11, 16))
            self.assertEqual(helper.get_option_chain.call_args[0][1], '2026-11-17')
            self.assertTrue(os.path.exists(eod_oi_path(csv)))
            _, again = self._run(d, '2026-11-17', date(2026, 11, 16))
            again.get_option_chain.assert_not_called()

    def test_expired_contract_and_wrong_day_are_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            csv, helper = self._run(d, '2026-11-13', date(2026, 11, 16))   # expired on the session day
            helper.get_option_chain.assert_not_called()
            self.assertFalse(os.path.exists(eod_oi_path(csv)))
        with tempfile.TemporaryDirectory() as d:
            _, helper = self._run(d, '2026-11-24', date(2026, 11, 17))     # Tuesday: the CSV is not Monday's
            helper.get_option_chain.assert_not_called()


if __name__ == '__main__':
    unittest.main()
