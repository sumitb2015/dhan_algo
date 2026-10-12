"""The live smoke script's logic, against a stub helper: no broker, no orders."""
import importlib.util
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
spec = importlib.util.spec_from_file_location("super_order_smoke", os.path.join(ROOT, "scripts", "tools", "super_order_smoke.py"))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

IST = timezone(timedelta(hours=5, minutes=30))
OPEN = datetime(2026, 10, 12, 11, 0, tzinfo=IST)           # a Monday, mid-session


class StubHelper:
    def __init__(self, ltp=40.0, list_rows=None, modify_ok=True, cancel_ok=True):
        self.calls, self.ltp, self.modify_ok, self.cancel_ok = [], ltp, modify_ok, cancel_ok
        self.rows = list_rows
        self.placed = {}

    def get_ltp(self, *a, **k): return 24000.0
    def get_nearest_expiry(self, s): return "2026-10-13"
    def get_option_id(self, *a, **k): return {"security_id": "111"}
    def get_option_ltp(self, *a, **k): return self.ltp
    def get_lot_size(self, s): return 75

    def place_super_order(self, **kw):
        self.calls.append("place"); self.placed = kw
        return {"ok": True, "order_id": "5001", "status": "TRANSIT", "correlation_id": "so1", "error": None, "unknown": False}

    def get_super_orders(self):
        self.calls.append("list")
        if self.rows is not None:
            return self.rows
        return [{"orderId": "5001", "securityId": "111", "correlationId": "so1", "legDetails": [
            {"legName": "ENTRY_LEG", "orderStatus": "PENDING"}, {"legName": "TARGET_LEG", "orderStatus": "PENDING"},
            {"legName": "STOP_LOSS_LEG", "orderStatus": "PENDING"}]}] if self.calls.count("cancel") == 0 else [
            {"orderId": "5001", "legDetails": [{"legName": "ENTRY_LEG", "orderStatus": "CANCELLED"}]}]

    def modify_super_order(self, *a, **k): self.calls.append("modify"); return self.modify_ok
    def cancel_super_order(self, *a, **k): self.calls.append("cancel"); return self.cancel_ok


def run(h, apply=True, now=OPEN):
    import io, contextlib
    with contextlib.redirect_stdout(io.StringIO()):
        return smoke.run(h, apply, now, sleep=lambda s: None)


class SmokeTest(unittest.TestCase):
    def test_plan_only_places_nothing(self):
        h = StubHelper()
        rep = run(h, apply=False)
        self.assertTrue(rep["ok"])
        self.assertEqual(h.calls, [])

    def test_full_pass_places_a_resting_far_limit_and_cancels(self):
        h = StubHelper()
        rep = run(h)
        self.assertTrue(rep["ok"], rep["steps"])
        self.assertEqual(h.calls, ["place", "list", "modify", "cancel", "list"])
        p = h.placed
        self.assertEqual((p["order_type"], p["side"], p["quantity"]), ("LIMIT", "BUY", 75))
        self.assertEqual(p["price"], 20.0)                               # 50% of LTP: it cannot fill
        self.assertLess(p["stop_loss_price"], p["price"])
        self.assertGreater(p["target_price"], p["price"])

    def test_cancel_still_runs_when_a_check_or_modify_fails(self):
        h = StubHelper(modify_ok=False)
        rep = run(h)
        self.assertFalse(rep["ok"])
        self.assertIn("cancel", h.calls)

    def test_shape_mismatch_fails_the_run(self):
        rows = [{"orderId": "5001", "legDetails": [{"legName": "ENTRY_LEG", "orderStatus": "PENDING"}]}]   # no securityId / correlationId
        rep = run(StubHelper(list_rows=rows))
        self.assertFalse(rep["ok"])

    def test_a_leftover_live_leg_is_reported(self):
        live = [{"orderId": "5001", "securityId": "111", "correlationId": "so1", "legDetails": [
            {"legName": "ENTRY_LEG", "orderStatus": "PENDING"}, {"legName": "TARGET_LEG", "orderStatus": "PENDING"}]}]
        rep = run(StubHelper(list_rows=live))
        self.assertFalse(rep["ok"])
        self.assertTrue(any(s["step"] == "nothing left live" and not s["ok"] for s in rep["steps"]))

    def test_refuses_outside_hours_and_for_a_cheap_option(self):
        h = StubHelper()
        self.assertFalse(run(h, now=datetime(2026, 10, 12, 20, 0, tzinfo=IST))["ok"])
        self.assertFalse(run(h, now=datetime(2026, 10, 10, 11, 0, tzinfo=IST))["ok"])      # Saturday
        self.assertFalse(run(StubHelper(ltp=1.0))["ok"])
        self.assertEqual(h.calls, [])


if __name__ == "__main__":
    unittest.main()
