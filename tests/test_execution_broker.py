"""Broker-agnostic execution front: dhan pass-through must be behavior-
identical to calling DhanHelper directly; zerodha/kotak must route through
ChildBroker's resolve_symbol/place_child_order.

Run: venv\\Scripts\\python.exe -m pytest tests/test_execution_broker.py -v
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.execution_broker import ExecutionBroker, ExecutionBrokerError  # noqa: E402


class FakeSec(dict):
    """Mimics the pandas-Series-like row DhanHelper.find_option() returns."""


class FakeHelper:
    def __init__(self):
        self.buy_calls = []
        self.sell_calls = []
        self.net_qty = 0

    def find_option(self, underlying, expiry, strike, option_type):
        return FakeSec(SECURITY_ID=f"{underlying}-{expiry}-{strike}-{option_type}")

    def get_option_id(self, underlying, strike, option_type, expiry):
        return None  # not needed when find_option succeeds

    def buy(self, symbol, qty, price=None, product="INTRADAY"):
        self.buy_calls.append((symbol, qty, product))
        return "DHAN-ORDER-1"

    def sell(self, symbol, qty, price=None, product="INTRADAY"):
        self.sell_calls.append((symbol, qty, product))
        return "DHAN-ORDER-2"

    def get_net_quantity(self, symbol):
        return self.net_qty


class FakeChild:
    name = "kotak"

    def __init__(self):
        self.placed = []
        self._positions = []

    def init_instruments(self):
        pass

    def verify_session(self):
        return True, "ok"

    def resolve_symbol(self, strike, expiry, opt_type):
        return f"SYM-{strike}-{opt_type}"

    def map_product(self, *hints):
        return "MIS"

    def place_child_order(self, symbol, side, qty, product):
        order_id = f"CHILD-{side}-{symbol}"
        self.placed.append((symbol, side, qty, product))
        return qty, [order_id], None

    def positions_rows(self):
        return self._positions


def test_dhan_buy_resolves_via_find_option_and_calls_helper_buy():
    helper = FakeHelper()
    broker = ExecutionBroker(broker="dhan", helper=helper, underlying="NIFTY")
    order_id = broker.buy(25000, "2026-09-25", "CE", 75)
    assert order_id == "DHAN-ORDER-1"
    assert helper.buy_calls == [("NIFTY-2026-09-25-25000-CE", 75, "INTRADAY")]


def test_dhan_sell_calls_helper_sell():
    helper = FakeHelper()
    broker = ExecutionBroker(broker="dhan", helper=helper, underlying="NIFTY")
    order_id = broker.sell(25100, "2026-09-25", "PE", 75)
    assert order_id == "DHAN-ORDER-2"
    assert helper.sell_calls == [("NIFTY-2026-09-25-25100-PE", 75, "INTRADAY")]


def test_dhan_get_owned_net_qty_reads_helper_net_quantity():
    helper = FakeHelper()
    helper.net_qty = -75
    broker = ExecutionBroker(broker="dhan", helper=helper, underlying="NIFTY")
    assert broker.get_owned_net_qty(25000, "2026-09-25", "CE") == -75


def test_kotak_buy_resolves_symbol_and_places_child_order():
    helper = FakeHelper()
    child = FakeChild()
    broker = ExecutionBroker(broker="kotak", helper=helper, underlying="NIFTY", child=child)
    order_id = broker.buy(25000, "2026-09-25", "CE", 75)
    assert order_id == "CHILD-BUY-SYM-25000-CE"
    assert child.placed == [("SYM-25000-CE", "BUY", 75, "MIS")]
    assert helper.buy_calls == []  # never touches Dhan for order placement


def test_kotak_get_owned_net_qty_reads_positions_rows():
    helper = FakeHelper()
    child = FakeChild()
    child._positions = [{"symbol": "SYM-25000-CE", "qty": -150}]
    broker = ExecutionBroker(broker="kotak", helper=helper, underlying="NIFTY", child=child)
    assert broker.get_owned_net_qty(25000, "2026-09-25", "CE") == -150


def test_unresolvable_symbol_returns_none_not_an_exception():
    helper = FakeHelper()
    child = FakeChild()
    child.resolve_symbol = lambda strike, expiry, opt_type: None
    broker = ExecutionBroker(broker="kotak", helper=helper, underlying="NIFTY", child=child)
    assert broker.buy(25000, "2026-09-25", "CE", 75) is None
    assert child.placed == []


def test_create_unknown_broker_raises_value_error():
    with pytest.raises(ValueError):
        ExecutionBroker.create("upstox", FakeHelper(), "NIFTY")


def test_create_child_broker_failure_raises_execution_broker_error(monkeypatch):
    import scripts.tools.child_brokers as child_brokers

    def boom(name, log=print, **kwargs):
        raise RuntimeError("Kotak auth failed — run kotak_autologin.py")

    monkeypatch.setattr(child_brokers, "create_broker", boom)
    with pytest.raises(ExecutionBrokerError):
        ExecutionBroker.create("kotak", FakeHelper(), "NIFTY")


def test_create_dead_session_raises_execution_broker_error(monkeypatch):
    import scripts.tools.child_brokers as child_brokers

    dead_child = FakeChild()
    dead_child.verify_session = lambda: (False, "Kotak token rejected")
    monkeypatch.setattr(child_brokers, "create_broker", lambda name, log=print, **kw: dead_child)
    with pytest.raises(ExecutionBrokerError):
        ExecutionBroker.create("kotak", FakeHelper(), "NIFTY")


def test_create_dhan_never_touches_child_brokers():
    broker = ExecutionBroker.create("dhan", FakeHelper(), "NIFTY")
    assert broker.broker == "dhan"
    assert broker.child is None
