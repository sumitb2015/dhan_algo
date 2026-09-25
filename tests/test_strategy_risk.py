"""resolve_exit_qty_broker must exit only what THIS strategy opened, clamped
by the execution broker's own position truth — the ExecutionBroker-based
sibling of resolve_exit_qty(), used by strategies wired for broker-selectable
execution (Task 1 onward).

Run: venv\\Scripts\\python.exe -m pytest tests/test_strategy_risk.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.strategy_risk import resolve_exit_qty_broker, detect_phantom_leg, detect_phantom_leg_broker  # noqa: E402


class FakeHelper:
    def __init__(self, net_qty):
        self.net_qty = net_qty

    def get_net_quantity(self, security_id):
        return self.net_qty


class FakeBroker:
    def __init__(self, net_qty):
        self.net_qty = net_qty

    def get_owned_net_qty(self, strike, expiry, opt_type):
        return self.net_qty


def test_exits_own_qty_when_broker_confirms_enough_short():
    broker = FakeBroker(net_qty=-150)  # short 150 (2 lots)
    qty, net = resolve_exit_qty_broker(broker, 25000, "2026-09-25", "CE", own_qty=75, side="BUY")
    assert qty == 75
    assert net == -150


def test_clamps_to_broker_truth_when_sibling_already_closed_part():
    broker = FakeBroker(net_qty=-75)  # only 1 lot left, but this instance thinks it owns 2
    qty, net = resolve_exit_qty_broker(broker, 25000, "2026-09-25", "CE", own_qty=150, side="BUY")
    assert qty == 75


def test_returns_zero_when_already_flat():
    broker = FakeBroker(net_qty=0)
    qty, net = resolve_exit_qty_broker(broker, 25000, "2026-09-25", "CE", own_qty=75, side="BUY")
    assert qty == 0


def test_returns_zero_when_own_qty_is_zero():
    broker = FakeBroker(net_qty=-150)
    qty, net = resolve_exit_qty_broker(broker, 25000, "2026-09-25", "CE", own_qty=0, side="BUY")
    assert qty == 0


def test_sell_side_closes_a_long_leg():
    broker = FakeBroker(net_qty=75)  # long 75
    qty, net = resolve_exit_qty_broker(broker, 25000, "2026-09-25", "PE", own_qty=75, side="SELL")
    assert qty == 75


def test_lookup_failure_returns_zero_not_an_exception():
    class BoomBroker:
        def get_owned_net_qty(self, strike, expiry, opt_type):
            raise RuntimeError("Kotak order book unreadable")

    qty, net = resolve_exit_qty_broker(BoomBroker(), 25000, "2026-09-25", "CE", own_qty=75, side="BUY")
    assert qty == 0
    assert net == 0


# --- detect_phantom_leg / detect_phantom_leg_broker ------------------------
# The victim-side check: a strategy still tracking a leg as open should notice
# when the broker no longer shows anything to close (2026-07-30 incident's
# open weakness #1/#2 — the exiting side was fixed by resolve_exit_qty(_broker)
# above; this is the side that got its leg flattened by someone else).

def test_phantom_detected_when_broker_shows_leg_already_flat():
    helper = FakeHelper(net_qty=0)  # sibling/manual square-off already closed it
    assert detect_phantom_leg(helper, "12345", own_qty=130, side="BUY") is True


def test_phantom_detected_when_broker_reversed():
    helper = FakeHelper(net_qty=130)  # was short, broker now shows long — not ours to close as BUY
    assert detect_phantom_leg(helper, "12345", own_qty=130, side="BUY") is True


def test_not_phantom_when_broker_still_shows_leg_open():
    helper = FakeHelper(net_qty=-130)  # still short exactly what we think we own
    assert detect_phantom_leg(helper, "12345", own_qty=130, side="BUY") is False


def test_not_phantom_when_broker_shows_more_than_our_qty():
    helper = FakeHelper(net_qty=-260)  # sibling's leg is still there too — ours is fine
    assert detect_phantom_leg(helper, "12345", own_qty=130, side="BUY") is False


def test_phantom_check_is_a_noop_when_own_qty_already_zero():
    """Nothing to detect if the strategy doesn't think it holds anything —
    must not even make the broker call."""
    class ExplodingHelper:
        def get_net_quantity(self, security_id):
            raise AssertionError("should not be called when own_qty <= 0")

    assert detect_phantom_leg(ExplodingHelper(), "12345", own_qty=0, side="BUY") is False


def test_phantom_lookup_failure_reads_as_not_phantom_not_an_exception():
    """Fails closed, same as resolve_exit_qty: an API error must never be
    mistaken for 'the leg is gone' and force-clear real tracked state."""
    class BoomHelper:
        def get_net_quantity(self, security_id):
            raise RuntimeError("Dhan API unreachable")

    assert detect_phantom_leg(BoomHelper(), "12345", own_qty=130, side="BUY") is False


def test_phantom_detected_via_broker_variant():
    broker = FakeBroker(net_qty=0)
    assert detect_phantom_leg_broker(broker, 25000, "2026-09-25", "CE", own_qty=75, side="BUY") is True


def test_not_phantom_via_broker_variant_when_still_open():
    broker = FakeBroker(net_qty=-75)
    assert detect_phantom_leg_broker(broker, 25000, "2026-09-25", "CE", own_qty=75, side="BUY") is False
