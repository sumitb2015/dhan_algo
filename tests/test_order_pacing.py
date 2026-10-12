"""DhanHelper takes a slot in the shared order lane before every order call - and never fails because of it.

The real DhanHelper class with the SDK stubbed out: no network, no broker, no orders.
"""
import os
import sys
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# --- stub the third-party SDK / websockets so lib.dhan_helper imports without them ---
for name in ("dhanhq", "dhanhq.marketfeed", "dhanhq.orderupdate", "websockets"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["dhanhq"].dhanhq = type("dhanhq", (), {})
sys.modules["dhanhq.marketfeed"].MarketFeed = type("MarketFeed", (), {})
sys.modules["dhanhq.orderupdate"].OrderUpdate = type("OrderUpdate", (), {})

from lib import dhan_order_lane  # noqa: E402
from lib.dhan_helper import DhanHelper  # noqa: E402

OK = {"status": "success", "data": {"orderId": "42"}}


class FakeHttp:
    client_id = "1000000001"

    def __init__(self, log): self.log = log
    def post(self, path, payload=None): self.log.append(("post", path)); return OK
    def put(self, path, payload=None): self.log.append(("put", path)); return OK
    def delete(self, path): self.log.append(("delete", path)); return OK
    def get(self, path): self.log.append(("get", path)); return OK


class FakeDhan:
    def __init__(self, log):
        self.log = log
        self.dhan_http = FakeHttp(log)

    def place_order(self, **kw): self.log.append(("place_order",)); return OK
    def modify_order(self, **kw): self.log.append(("modify_order",)); return OK
    def cancel_order(self, order_id): self.log.append(("cancel_order",)); return OK
    def place_slice_order(self, **kw): self.log.append(("place_slice_order",)); return OK
    def get_order_list(self): return {"status": "success", "data": [{"orderId": "1", "orderStatus": "PENDING"}, {"orderId": "2", "orderStatus": "PENDING"}]}


class OrderPacingTest(unittest.TestCase):
    def setUp(self):
        self.log = []
        self.paced = 0
        self.h = DhanHelper.__new__(DhanHelper)
        self.h.dhan = FakeDhan(self.log)
        for k, v in dict(NSE_FNO='NSE_FNO', BUY='BUY', SELL='SELL', MARKET='MARKET', LIMIT='LIMIT', INTRA='INTRADAY', MARGIN='MARGIN', CNC='CNC').items():
            setattr(self.h, k, v)               # normally set from the SDK in __init__
        self._orig = dhan_order_lane.wait_for_slot
        dhan_order_lane.wait_for_slot = self._count

    def tearDown(self):
        dhan_order_lane.wait_for_slot = self._orig

    def _count(self):
        # Pacing must happen BEFORE the request leaves: nothing may be logged yet for this call.
        self.paced += 1
        self.before = len(self.log)
        return 0.0

    def test_every_order_call_takes_a_slot_first(self):
        h = self.h
        h.place_order("111", "NSE_FNO", "BUY", 75)
        h.modify_order("42", 75, "LIMIT", price=10)
        h.cancel_order("42")
        h.place_slice_order("111", "NSE_FNO", "BUY", 7500)
        h.place_super_order(security_id="111", exchange_segment="NSE_FNO", side="BUY", product_type="MARGIN",
                            quantity=75, target_price=110.0, stop_loss_price=90.0, price=100.0, order_type="LIMIT")
        h.modify_super_order("42", "TARGET_LEG", targetPrice=120.0)
        h.cancel_super_order("42", "TARGET_LEG")
        self.assertEqual(self.paced, 7)

    def test_cancel_all_orders_paces_each_cancel(self):
        self.assertEqual(self.h.cancel_all_orders(), 2)
        self.assertEqual(self.paced, 2)

    def test_slot_is_taken_before_the_request_is_sent(self):
        self.h.cancel_order("42")
        self.assertEqual(self.before, 0)        # the lane was consulted while the log was still empty

    def test_a_broken_lane_never_blocks_an_order(self):
        def boom():
            raise RuntimeError("lane exploded")
        dhan_order_lane.wait_for_slot = boom
        self.assertEqual(self.h.place_order("111", "NSE_FNO", "BUY", 75), "42")
        self.assertTrue(self.h.cancel_order("42"))


if __name__ == "__main__":
    unittest.main()
