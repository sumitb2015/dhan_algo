"""Stubbed tests for lib/super_order.py (no broker session, no network)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.super_order import build_place_payload, validate_modify, validate_super_order

BUY = dict(security_id="12345", exchange_segment="NSE_FNO", side="BUY", product_type="INTRADAY",
           quantity=75, price=100.0, target_price=120.0, stop_loss_price=90.0)


class SuperOrderTest(unittest.TestCase):
    def test_valid_brackets(self):
        self.assertIsNone(validate_super_order(**BUY))
        self.assertIsNone(validate_super_order(**{**BUY, "side": "SELL", "target_price": 80.0, "stop_loss_price": 110.0}))

    def test_wrong_side_of_entry(self):
        self.assertIn("BUY needs", validate_super_order(**{**BUY, "stop_loss_price": 105.0}))
        self.assertIn("SELL needs", validate_super_order(**{**BUY, "side": "SELL"}))

    def test_market_needs_ref_price_and_never_sends_it(self):
        mkt = {**BUY, "order_type": "MARKET", "price": None}
        self.assertIn("ref_price", validate_super_order(**mkt))
        self.assertIsNone(validate_super_order(**mkt, ref_price=100.0))
        payload = build_place_payload("1", "c1", **mkt, ref_price=100.0)
        self.assertEqual(payload["price"], 100.0)   # never 0: Dhan's SDK refuses it
        self.assertNotIn("refPrice", payload)

    def test_hard_limits(self):
        for bad in ({"quantity": 0}, {"quantity": 7.5}, {"quantity": 99999}, {"quantity": True},
                    {"product_type": "CO"}, {"exchange_segment": "IDX_I"}, {"exchange_segment": "NSE_EQ"}, {"security_id": "NIFTY"}):
            self.assertIsNotNone(validate_super_order(**{**BUY, **bad}), bad)

    def test_trailing_jump(self):
        self.assertIsNone(validate_super_order(**BUY, trailing_jump=5))
        self.assertIn("trailing_jump", validate_super_order(**BUY, trailing_jump=10))
        self.assertIn("trailing_jump", validate_super_order(**BUY, trailing_jump=-1))

    def test_modify_legs(self):
        self.assertIsNone(validate_modify("TARGET_LEG", targetPrice=125.0))
        self.assertIn("order_type", validate_modify("ENTRY_LEG", price=101.0))
        self.assertIsNone(validate_modify("ENTRY_LEG", order_type="LIMIT", price=101.0))
        self.assertIn("cannot change", validate_modify("TARGET_LEG", stopLossPrice=95.0))
        self.assertIsNone(validate_modify("STOP_LOSS_LEG", stopLossPrice=95.0, trailingJump=0))
        self.assertEqual(validate_modify("STOP_LOSS_LEG"), "Nothing to modify")
        self.assertIn("Invalid leg_name", validate_modify("NOPE", targetPrice=1.0))



class ListShapeTest(unittest.TestCase):
    GOOD = [{"orderId": "5001", "securityId": "111", "correlationId": "so1", "orderStatus": "PENDING",
             "legDetails": [{"legName": "ENTRY_LEG", "orderStatus": "PENDING"}, {"legName": "TARGET_LEG", "orderStatus": "PENDING"},
                            {"legName": "STOP_LOSS_LEG", "orderStatus": "PENDING"}]}]

    def run_check(self, rows):
        from lib.super_order import check_list_shape
        return check_list_shape(rows, "5001", "so1", "111")

    def test_matching_payload_passes_every_assumption(self):
        self.assertTrue(all(ok for ok, _ in self.run_check(self.GOOD)))

    def test_each_assumption_is_reported_when_it_fails(self):
        import copy
        for field, bad in (("securityId", None), ("correlationId", None), ("legDetails", None)):
            rows = copy.deepcopy(self.GOOD)
            if bad is None:
                del rows[0][field]
            res = self.run_check(rows)
            self.assertFalse(all(ok for ok, _ in res), field)
        rows = copy.deepcopy(self.GOOD)
        rows[0]["legDetails"][1]["legName"] = "PROFIT_LEG"
        self.assertFalse(all(ok for ok, _ in self.run_check(rows)))
        self.assertFalse(self.run_check({"data": []})[0][0])        # not a list at all
        self.assertFalse(self.run_check([])[0][0])                   # order missing



if __name__ == "__main__":
    unittest.main()
