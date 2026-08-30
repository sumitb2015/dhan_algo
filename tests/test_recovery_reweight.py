"""Recovery Reweight: strike selection + order placement for the "flip a
stopped-out short leg to a directional long option" logic.

Run: venv\\Scripts\\python.exe -m pytest tests/test_recovery_reweight.py -v
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.recovery_reweight import (  # noqa: E402
    enter_recovery_leg,
    next_otm_strike,
    recovery_stop_price,
)


class FakeBroker:
    def __init__(self, order_id="ORD-1"):
        self.buy_calls = []
        self._order_id = order_id

    def buy(self, strike, expiry, opt_type, qty, product="INTRADAY"):
        self.buy_calls.append((strike, expiry, opt_type, qty, product))
        return self._order_id


def test_next_otm_strike_ce_moves_up():
    assert next_otm_strike(25000, "CE", 50) == 25050


def test_next_otm_strike_pe_moves_down():
    assert next_otm_strike(25000, "PE", 50) == 24950


def test_next_otm_strike_unknown_opt_type_raises():
    with pytest.raises(ValueError):
        next_otm_strike(25000, "XX", 50)


def test_recovery_stop_price_default_30pct_below_entry():
    assert recovery_stop_price(100) == 70.0


def test_recovery_stop_price_custom_pct():
    assert recovery_stop_price(100, sl_pct=0.20) == 80.0


def test_enter_recovery_leg_buys_next_otm_strike_and_returns_details():
    broker = FakeBroker(order_id="ORD-42")
    result = enter_recovery_leg(
        broker, "NIFTY", "2026-09-25", stopped_strike=25000, opt_type="CE",
        qty=75, strike_step=50,
    )
    assert result == {
        'strike': 25050, 'expiry': '2026-09-25', 'opt_type': 'CE',
        'qty': 75, 'order_id': 'ORD-42',
    }
    assert broker.buy_calls == [(25050, "2026-09-25", "CE", 75, "INTRADAY")]


def test_enter_recovery_leg_pe_side_moves_strike_down():
    broker = FakeBroker()
    result = enter_recovery_leg(
        broker, "NIFTY", "2026-09-25", stopped_strike=25000, opt_type="PE",
        qty=75, strike_step=50,
    )
    assert result['strike'] == 24950
    assert broker.buy_calls == [(24950, "2026-09-25", "PE", 75, "INTRADAY")]


def test_enter_recovery_leg_forwards_product():
    broker = FakeBroker()
    enter_recovery_leg(
        broker, "NIFTY", "2026-09-25", stopped_strike=25000, opt_type="CE",
        qty=75, strike_step=50, product="MARGIN",
    )
    assert broker.buy_calls == [(25050, "2026-09-25", "CE", 75, "MARGIN")]


def test_enter_recovery_leg_order_failure_returns_none():
    broker = FakeBroker(order_id=None)
    result = enter_recovery_leg(
        broker, "NIFTY", "2026-09-25", stopped_strike=25000, opt_type="CE",
        qty=75, strike_step=50,
    )
    assert result is None


def test_enter_recovery_leg_bad_opt_type_returns_none_not_raises():
    broker = FakeBroker()
    result = enter_recovery_leg(
        broker, "NIFTY", "2026-09-25", stopped_strike=25000, opt_type="XX",
        qty=75, strike_step=50,
    )
    assert result is None
    assert broker.buy_calls == []
