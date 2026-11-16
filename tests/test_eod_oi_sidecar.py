"""Pure tests for lib/eod_oi_sidecar.py and the collector's eod_oi_step / EodOiTask (no API, no Dhan session)."""
import json
import os
import sys
import tempfile
import unittest
from datetime import date
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib.eod_oi_sidecar import (  # noqa: E402
    eod_oi_path, eod_oi_from_chain, has_rolled, last_expiry_of_csv, previous_trading_day, session_prev_oi_from_csv,
    write_eod_oi,
)

OC = {
    '25000.000000': {'ce': {'oi': 2695420, 'previous_oi': 2640755}, 'pe': {'oi': 1, 'previous_oi': 7703020}},
    '25050.000000': {'ce': {'previous_oi': 0}, 'pe': {}},
    '25075.5': {'ce': {'previous_oi': '12'}, 'pe': {'previous_oi': None}},
    'bad': {'ce': {'previous_oi': 5}},
}
HEAD = 'timestamp,spot,expiry,strike,CE_OI,CE_change_OI,PE_OI,PE_change_OI\n'
STRIKES = [24900, 24950, 25000, 25050, 25100, 25150]


def session_csv(path, expiry='2026-11-17', ts='2026-11-13 15:39:40'):
    """A session whose previous close (OI - change) is 1000 + strike offset; the last snapshot is the one compared."""
    with open(path, 'w') as f:
        f.write(HEAD)
        for t in ('2026-11-13 15:39:10', ts):
            for k in STRIKES:
                prev = 1000 + (k - 24900)
                f.write(f'{t},25144,{expiry},{k},{prev + 50},50,{prev + 70},70\n')
    return {k: 1000 + (k - 24900) for k in STRIKES}


def chain(values):
    return {'oc': {f'{k}.000000': {'ce': {'previous_oi': v}, 'pe': {'previous_oi': v}} for k, v in values.items()}}


class EodOiTests(unittest.TestCase):
    def test_path(self):
        self.assertEqual(eod_oi_path('/d/iv_snapshots_NIFTY_2026-11-13.csv'), '/d/iv_snapshots_NIFTY_2026-11-13_eod_oi.json')

    def test_reads_previous_oi_only_and_never_zero(self):
        self.assertEqual(eod_oi_from_chain(OC), {'ce': {'25000': 2640755, '25075.5': 12}, 'pe': {'25000': 7703020}})

    def test_previous_trading_day_skips_weekend(self):
        self.assertEqual(previous_trading_day(date(2026, 11, 16)), date(2026, 11, 13))   # Monday -> Friday
        self.assertEqual(previous_trading_day(date(2026, 11, 13)), date(2026, 11, 12))

    def test_last_expiry_skips_a_cut_row(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 'x.csv')
            with open(p, 'w') as f:
                f.write(HEAD + '2026-11-13 15:39:40,25144,2026-11-17,25000,1,0,1,0\n2026-11-13 15:39:40,25144,2026-11-24')
            self.assertEqual(last_expiry_of_csv(p), '2026-11-17')
            self.assertIsNone(last_expiry_of_csv(os.path.join(d, 'missing.csv')))

    def test_session_prev_oi_is_oi_minus_change_of_the_last_snapshot(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 's.csv')
            prev = session_csv(p)
            got = session_prev_oi_from_csv(p, '2026-11-17')
            self.assertEqual(got['ce'], {str(k): v for k, v in prev.items()})
            self.assertEqual(got['pe'], {str(k): v for k, v in prev.items()})
            self.assertEqual(session_prev_oi_from_csv(p, '2026-11-24'), {'ce': {}, 'pe': {}})

    def test_has_rolled(self):
        prev = {'ce': {str(k): 1000 + i for i, k in enumerate(STRIKES)}, 'pe': {}}
        same = {'ce': dict(prev['ce']), 'pe': {}}
        moved = {'ce': {k: v + 7 for k, v in prev['ce'].items()}, 'pe': {}}
        self.assertFalse(has_rolled(same, prev))                 # still the session's own previous close
        self.assertTrue(has_rolled(moved, prev))                 # a new close
        one_same = dict(moved['ce']); one_same['24900'] = prev['ce']['24900']
        self.assertTrue(has_rolled({'ce': one_same, 'pe': {}}, prev))   # an untouched far strike is normal
        self.assertIsNone(has_rolled({'ce': {'24900': 1}, 'pe': {}}, prev))   # too few to compare

    def test_write_is_atomic_and_skips_empty(self):
        with tempfile.TemporaryDirectory() as d:
            csv = os.path.join(d, 'iv_snapshots_NIFTY_2026-11-13.csv')
            self.assertFalse(write_eod_oi(csv, '2026-11-13', '2026-11-17', {'ce': {}, 'pe': {}}, 'now'))
            self.assertFalse(os.path.exists(eod_oi_path(csv)))
            self.assertTrue(write_eod_oi(csv, '2026-11-13', '2026-11-17', eod_oi_from_chain(OC), '2026-11-16 08:25:00'))
            with open(eod_oi_path(csv)) as f:
                data = json.load(f)
            self.assertEqual((data['date'], data['expiry'], data['ce']['25000']), ('2026-11-13', '2026-11-17', 2640755))
            self.assertEqual([n for n in os.listdir(d) if n.endswith('.tmp')], [])


class CollectorStepTests(unittest.TestCase):
    def _step(self, d, today, expiry='2026-11-17', chain_reply=None):
        import scripts.tools.iv_snapshot_collector as col
        csv = os.path.join(d, 'iv_snapshots_NIFTY_2026-11-13.csv')
        if not os.path.exists(csv):
            session_csv(csv, expiry=expiry)
        helper = mock.Mock()
        helper.get_option_chain.return_value = chain_reply
        with mock.patch.object(col, 'get_csv_paths', lambda day, u: [csv] if day == date(2026, 11, 13) else []):
            out = col.eod_oi_step(helper, 'NIFTY', today)
        return out, csv, helper

    def test_writes_once_dhan_has_rolled(self):
        with tempfile.TemporaryDirectory() as d:
            rolled = chain({k: 5000 + k for k in STRIKES})
            out, csv, helper = self._step(d, date(2026, 11, 16), chain_reply=rolled)
            self.assertEqual(out, 'done')
            self.assertEqual(helper.get_option_chain.call_args[0][1], '2026-11-17')
            self.assertTrue(os.path.exists(eod_oi_path(csv)))
            out, _, again = self._step(d, date(2026, 11, 16), chain_reply=rolled)
            self.assertEqual(out, 'done')
            again.get_option_chain.assert_not_called()

    def test_not_rolled_yet_is_retried_and_writes_nothing(self):
        # Early morning / non-trading day: previous_oi is still the session's own previous close.
        with tempfile.TemporaryDirectory() as d:
            stale = chain({k: 1000 + (k - 24900) for k in STRIKES})
            out, csv, _ = self._step(d, date(2026, 11, 16), chain_reply=stale)
            self.assertEqual(out, 'retry')
            self.assertFalse(os.path.exists(eod_oi_path(csv)))

    def test_failed_or_empty_fetch_is_retried(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(self._step(d, date(2026, 11, 16), chain_reply=None)[0], 'retry')
            self.assertEqual(self._step(d, date(2026, 11, 16), chain_reply={'oc': {}})[0], 'retry')

    def test_expired_contract_and_wrong_day_are_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            out, _, helper = self._step(d, date(2026, 11, 16), expiry='2026-11-13')
            self.assertEqual(out, 'skip')
            helper.get_option_chain.assert_not_called()
        with tempfile.TemporaryDirectory() as d:
            out, _, helper = self._step(d, date(2026, 11, 17))   # Tuesday: the CSV is not Monday's
            self.assertEqual(out, 'skip')
            helper.get_option_chain.assert_not_called()

    def test_task_makes_one_call_per_slot_and_spaces_retries(self):
        import scripts.tools.iv_snapshot_collector as col
        now = [0.0]
        calls = []

        def step(helper, u, today):
            calls.append(u)
            return 'retry' if u == 'NIFTY' and len(calls) == 1 else 'done'
        with mock.patch.object(col, 'eod_oi_step', step):
            task = col.EodOiTask(['NIFTY', 'SENSEX'], date(2026, 11, 16), clock=lambda: now[0])
            task.tick(None)                          # NIFTY: not rolled -> back of the queue, next slot in 120 s
            task.tick(None)
            self.assertEqual(calls, ['NIFTY'])
            now[0] = col.EOD_RETRY_SEC
            task.tick(None)                          # SENSEX
            now[0] += 3
            task.tick(None)                          # NIFTY again
            self.assertEqual(calls, ['NIFTY', 'SENSEX', 'NIFTY'])
            self.assertEqual(task.pending, [])


if __name__ == '__main__':
    unittest.main()
