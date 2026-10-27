"""scripts/tools/price_ladder_ws.py: the best bid / ask read from a Full packet and the wanted-file reader. Pure: no Dhan, no feed.
Run:  venv/bin/python -m unittest tests.test_price_ladder_depth   (from the project root)
"""
import importlib.util
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
spec = importlib.util.spec_from_file_location('price_ladder_ws_under_test', os.path.join(ROOT, 'scripts', 'tools', 'price_ladder_ws.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


def level(bid, ask, bq=100, aq=120):
    # The shape dhanhq's process_full() produces: prices are "%.2f" strings.
    return {'bid_quantity': bq, 'ask_quantity': aq, 'bid_orders': 3, 'ask_orders': 4, 'bid_price': f'{bid:.2f}', 'ask_price': f'{ask:.2f}'}


class BestBidAsk(unittest.TestCase):
    def test_top_level_of_a_full_packet(self):
        t = {'LTP': '185.00', 'depth': [level(184.5, 185.5, 650, 910), level(184.0, 186.0)]}
        self.assertEqual(bridge.best_bid_ask(t), (184.5, 185.5, 650, 910))

    def test_no_depth_means_none(self):
        self.assertIsNone(bridge.best_bid_ask({'LTP': '185.00'}))                      # a Quote packet
        self.assertIsNone(bridge.best_bid_ask({'depth': []}))
        self.assertIsNone(bridge.best_bid_ask({'depth': 'junk'}))

    def test_one_sided_zero_or_crossed_book_is_not_a_price(self):
        self.assertIsNone(bridge.best_bid_ask({'depth': [level(0, 185.5)]}))           # no bid
        self.assertIsNone(bridge.best_bid_ask({'depth': [level(184.5, 0)]}))           # no offer
        self.assertIsNone(bridge.best_bid_ask({'depth': [level(186.0, 185.0)]}))       # crossed: a mid-update read
        self.assertIsNone(bridge.best_bid_ask({'depth': [{'bid_price': 'x', 'ask_price': 'y'}]}))

    def test_a_change_of_book_changes_the_fingerprint(self):
        a = {'LTP': '185.00', 'depth': [level(184.5, 185.5)]}
        b = {'LTP': '185.00', 'depth': [level(184.0, 185.5)]}
        self.assertNotEqual(bridge.fingerprint(a), bridge.fingerprint(b))


class WantedFile(unittest.TestCase):
    def test_depth_is_only_for_nse_bse_options_that_are_also_wanted(self):
        with tempfile.TemporaryDirectory() as d:
            bridge.WANTED_GLOB = os.path.join(d, 'price_ladder_ws_wanted_*.json')
            with open(os.path.join(d, 'price_ladder_ws_wanted_1.json'), 'w') as f:
                json.dump({'instruments': [['NSE_FNO', '111'], ['NSE_FNO', '222'], ['MCX_COMM', '333']],
                           'depth': ['NSE_FNO:111', 'MCX_COMM:333', 'NSE_FNO:999', 'BSE_FNO:abc']}, f)
            wanted, depth = bridge.read_wanted()
        self.assertEqual(wanted, {('NSE_FNO', '111'), ('NSE_FNO', '222'), ('MCX_COMM', '333')})
        self.assertEqual(depth, {('NSE_FNO', '111')})       # MCX never; an unwanted id never; a non-numeric id never

    def test_an_old_file_without_a_depth_key_still_reads(self):
        with tempfile.TemporaryDirectory() as d:
            bridge.WANTED_GLOB = os.path.join(d, 'price_ladder_ws_wanted_*.json')
            with open(os.path.join(d, 'price_ladder_ws_wanted_1.json'), 'w') as f:
                json.dump({'instruments': [['NSE_FNO', '111']]}, f)
            wanted, depth = bridge.read_wanted()
        self.assertEqual((wanted, depth), ({('NSE_FNO', '111')}, set()))


if __name__ == '__main__':
    unittest.main()
