"""resolve_exit_qty_broker must exit only what THIS strategy opened, clamped
by the execution broker's own position truth — the ExecutionBroker-based
sibling of resolve_exit_qty(), used by strategies wired for broker-selectable
execution (Task 1 onward).

Run: venv\\Scripts\\python.exe -m pytest tests/test_strategy_risk.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.strategy_risk import resolve_exit_qty_broker  # noqa: E402


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
