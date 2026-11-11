"""Pure tests for lib/prev_close_sidecar.py (no API, no Dhan session)."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib.prev_close_sidecar import sidecar_path, prev_closes_from_chain, merge, write_prev_closes  # noqa: E402

OC = {
    '25000.000000': {'ce': {'previous_close_price': 112.3, 'previous_close': None}, 'pe': {'previous_close_price': 98.1}},
    '25050.000000': {'ce': {'previous_close_price': 0}, 'pe': {}},
    'bad': {'ce': {'previous_close_price': 5}},
}


class SidecarTests(unittest.TestCase):
    def test_path(self):
        self.assertEqual(sidecar_path('/d/iv_snapshots_NIFTY_2026-11-11.csv'), '/d/iv_snapshots_NIFTY_2026-11-11_prev_close.json')

    def test_reads_previous_close_price_only(self):
        self.assertEqual(prev_closes_from_chain(OC), {'ce': {'25000': 112.3}, 'pe': {'25000': 98.1}})

    def test_merge_keeps_drifted_strikes_and_resets_on_new_expiry(self):
        a = merge(None, '2026-11-17', {'ce': {'25000': 1.0}, 'pe': {}})
        b = merge(a, '2026-11-17', {'ce': {'25100': 2.0}, 'pe': {'25000': 3.0}})
        self.assertEqual(b['ce'], {'25000': 1.0, '25100': 2.0})
        c = merge(b, '2026-11-24', {'ce': {'25200': 4.0}, 'pe': {}})
        self.assertEqual(c['ce'], {'25200': 4.0})

    def test_write_is_atomic_json(self):
        with tempfile.TemporaryDirectory() as d:
            csv = os.path.join(d, 'iv_snapshots_NIFTY_2026-11-11.csv')
            write_prev_closes(csv, '2026-11-17', OC)
            with open(sidecar_path(csv)) as f:
                data = json.load(f)
            self.assertEqual(data['expiry'], '2026-11-17')
            self.assertEqual(data['ce'], {'25000': 112.3})
            self.assertEqual([n for n in os.listdir(d) if n.endswith('.tmp')], [])


if __name__ == '__main__':
    unittest.main()
