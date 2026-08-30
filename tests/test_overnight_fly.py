"""Nifty Overnight Fly: order-failure paths that dry-run can never exercise
(dry-run never calls broker.buy/sell, so these branches only run live).
Real money holds overnight here, so these are worth a real regression net.

resolve_exit_qty_broker's own qty-clamping is tested separately — these tests
monkeypatch it to always report "the full requested quantity is available",
so what's under test is purely how roll_leg/_drag_hedge/exit_all_positions
react when the broker.buy()/sell() call itself fails.

Run: venv\\Scripts\\python.exe -m pytest tests/test_overnight_fly.py -v
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import strategies.overnight_fly.nifty_overnight_fly as ofly  # noqa: E402
from strategies.overnight_fly.nifty_overnight_fly import NiftyOvernightFly, PRODUCT  # noqa: E402


@pytest.fixture(autouse=True)
def full_qty_available(monkeypatch):
    """Every resolve_exit_qty_broker() call in the module under test reports
    the requested quantity as fully available — isolates these tests from
    that helper's own (separately tested) qty-clamping logic."""
    monkeypatch.setattr(
        ofly, "resolve_exit_qty_broker",
        lambda broker, strike, expiry, opt_type, own_qty, side, log=None: (own_qty, 0),
    )


class FakeBroker:
    """Fails buy()/sell() for (strike, opt_type) pairs listed in
    *_should_fail; otherwise mints an incrementing order id."""

    def __init__(self):
        self.buy_calls = []
        self.sell_calls = []
        self.buy_should_fail = set()
        self.sell_should_fail = set()
        self._n = 0

    def buy(self, strike, expiry, opt_type, qty, product="INTRADAY"):
        self.buy_calls.append((strike, opt_type, qty, product))
        if (strike, opt_type) in self.buy_should_fail:
            return None
        self._n += 1
        return f"BUY-{self._n}"

    def sell(self, strike, expiry, opt_type, qty, product="INTRADAY"):
        self.sell_calls.append((strike, opt_type, qty, product))
        if (strike, opt_type) in self.sell_should_fail:
            return None
        self._n += 1
        return f"SELL-{self._n}"


class FakeHelper:
    def __init__(self):
        self.quotes = {}   # (strike, opt_type) -> (security_id: int, price)
        self.ltps = {}      # str(id) -> ltp

    def option(self, underlying, strike, opt_type, expiry_index=0, exchange="NSE"):
        key = (strike, opt_type)
        if key not in self.quotes:
            return None
        sid, price = self.quotes[key]
        return {'CONTRACT_INFO': {'SECURITY_ID': sid}, 'last_price': price}

    def get_ltp(self, symbol, exchange=None, instrument=None):
        return self.ltps.get(str(symbol), 0.0)

    def wait_for_fill(self, order_id, timeout=5):
        return True

    def get_order_by_id(self, order_id):
        return {}  # no fill price -> get_execution_price falls back to the quote price

    def subscribe_instruments(self, instruments):
        pass

    def unsubscribe_instruments(self, instruments):
        pass


def make_strategy(broker, helper, **overrides):
    """Build a NiftyOvernightFly without running __init__ (which needs a real
    Dhan session) — same pattern as test_execution_broker.py's fakes, applied
    to a heavier constructor."""
    strat = object.__new__(NiftyOvernightFly)
    strat.state_key = "test_overnight_fly"
    strat.broker_name = "dhan"
    strat.dry_run = False
    strat.lots = 1
    strat.hedge_multiplier = 2.0
    strat.leg_sl_pct = 0.40
    strat.max_rolls_per_leg = 2
    strat.trail_start_rs = 3000.0
    strat.trail_gap_rs = 1500.0
    strat.entry_time = "09:15"
    strat.entry_window_min = 15
    strat.eod_exit_time = "15:17"
    strat.entry_dte = 1
    strat.broker = broker
    strat.helper = helper
    strat.nifty_lot_size = 75
    strat.expiry = "2026-09-25"
    strat._reset_position_state()
    for k, v in overrides.items():
        setattr(strat, k, v)
    # save_position()/save_state() touch disk — no-op them for pure logic tests.
    strat.save_position = lambda: None
    strat.save_state = lambda *a, **kw: None
    return strat


def leg(strike, price, sid, qty=75, sl=None, roll_count=0):
    d = {'id': sid, 'strike': strike, 'avg_price': price, 'qty': qty}
    if sl is not None:
        d['sl'] = sl
        d['roll_count'] = roll_count
    return d


# ── roll_leg: buy-back order failure must not open a new leg ───────────────

def test_roll_leg_buyback_failure_leaves_leg_tracked_and_does_not_resell():
    broker = FakeBroker()
    broker.buy_should_fail = {(25000, "CE")}
    helper = FakeHelper()
    strat = make_strategy(broker, helper)
    strat.ce_short = leg(25000, 100.0, 1001, sl=140.0, roll_count=0)
    strat.pe_short = leg(25000, 100.0, 1002, sl=140.0, roll_count=0)
    strat.ce_hedge = leg(25400, 20.0, 1003)
    strat.pe_hedge = leg(24600, 20.0, 1004)

    strat.roll_leg("CE", 145.0)

    # The failed leg is still exactly the original short — never overwritten,
    # never doubled with a second sell.
    assert strat.ce_short == leg(25000, 100.0, 1001, sl=140.0, roll_count=0)
    assert strat.realized_pnl == 0.0
    assert broker.sell_calls == []  # no fresh short was ever placed


def test_roll_leg_buyback_failure_lets_next_tick_retry():
    """The SL check in run() re-evaluates ltp >= leg['sl'] every tick; since
    roll_leg leaves the leg's 'sl' untouched on a buy failure, a second call
    with the broker now healthy must succeed cleanly."""
    broker = FakeBroker()
    broker.buy_should_fail = {(25000, "CE")}
    helper = FakeHelper()
    strat = make_strategy(broker, helper)
    strat.ce_short = leg(25000, 100.0, 1001, sl=140.0, roll_count=0)
    strat.pe_short = leg(25000, 100.0, 1002, sl=140.0, roll_count=0)
    strat.ce_hedge = leg(25400, 20.0, 1003)
    strat.pe_hedge = leg(24600, 20.0, 1004)
    strat.roll_leg("CE", 145.0)
    assert strat.ce_short['strike'] == 25000  # still stuck

    broker.buy_should_fail.clear()
    helper.ltps["NIFTY"] = 25050  # spot for the new-ATM resolution on this retry
    helper.quotes[(25050, "CE")] = (2001, 90.0)
    helper.quotes[(25350, "CE")] = (2002, 15.0)  # hedge drag target, so the drag succeeds too
    strat.roll_leg("CE", 145.0)
    assert strat.ce_short['strike'] == 25050
    assert strat.ce_short['roll_count'] == 1


# ── roll_leg: missing hedge must refuse to re-sell, never crash ────────────

def test_roll_leg_with_no_hedge_refuses_to_resell_instead_of_crashing():
    broker = FakeBroker()
    helper = FakeHelper()
    strat = make_strategy(broker, helper)
    strat.ce_short = leg(25000, 100.0, 1001, sl=140.0, roll_count=0)
    strat.pe_short = leg(25000, 100.0, 1002, sl=140.0, roll_count=0)
    strat.ce_hedge = None  # an earlier drag failure left this side unhedged
    strat.pe_hedge = leg(24600, 20.0, 1004)

    strat.roll_leg("CE", 145.0)  # must not raise

    assert strat.ce_short is None
    assert broker.sell_calls == []


# ── _drag_hedge: close failure must leave the old hedge untouched ──────────

def test_drag_hedge_close_failure_keeps_old_hedge_tracked():
    broker = FakeBroker()
    broker.sell_should_fail = {(25400, "CE")}  # closing the old CE hedge fails
    helper = FakeHelper()
    strat = make_strategy(broker, helper)
    old_hedge = leg(25400, 20.0, 1003)
    strat.ce_hedge = old_hedge

    strat._drag_hedge("CE", old_hedge, 25350, 75)

    assert strat.ce_hedge == old_hedge  # untouched, not None, not new
    assert strat.realized_pnl == 0.0
    assert broker.buy_calls == []  # never even tried the new leg


def test_drag_hedge_rebuy_failure_marks_unhedged_only_after_old_leg_confirmed_closed():
    broker = FakeBroker()
    broker.buy_should_fail = {(25350, "CE")}  # the replacement hedge buy fails
    helper = FakeHelper()
    helper.quotes[(25400, "CE")] = (1003, 22.0)  # exit-price quote for the old leg
    helper.quotes[(25350, "CE")] = (2002, 15.0)
    strat = make_strategy(broker, helper)
    old_hedge = leg(25400, 20.0, 1003)
    strat.ce_hedge = old_hedge

    strat._drag_hedge("CE", old_hedge, 25350, 75)

    assert strat.ce_hedge is None  # correctly flagged unhedged
    assert broker.sell_calls == [(25400, "CE", 75, PRODUCT)]  # old leg WAS closed
    assert broker.buy_calls == [(25350, "CE", 75, PRODUCT)]


# ── exit_all_positions: a failed leg stays tracked, others still close ─────

def test_exit_all_positions_partial_failure_keeps_failed_leg_and_returns_false():
    broker = FakeBroker()
    broker.buy_should_fail = {(25000, "CE")}  # CE short close fails; PE short closes fine
    helper = FakeHelper()
    strat = make_strategy(broker, helper)
    strat.position_open = True
    strat.ce_short = leg(25000, 100.0, 1001)
    strat.pe_short = leg(25000, 100.0, 1002)
    strat.ce_hedge = leg(25400, 20.0, 1003)
    strat.pe_hedge = leg(24600, 20.0, 1004)

    result = strat.exit_all_positions("test exit")

    assert result is False
    assert strat.ce_short is not None  # the failed leg is still tracked
    assert strat.pe_short is None      # everything else closed normally
    assert strat.ce_hedge is None
    assert strat.pe_hedge is None


def test_exit_all_positions_full_success_resets_to_flat():
    broker = FakeBroker()
    helper = FakeHelper()
    strat = make_strategy(broker, helper)
    strat.position_open = True
    strat.ce_short = leg(25000, 100.0, 1001)
    strat.pe_short = leg(25000, 100.0, 1002)
    strat.ce_hedge = leg(25400, 20.0, 1003)
    strat.pe_hedge = leg(24600, 20.0, 1004)

    result = strat.exit_all_positions("test exit")

    assert result is True
    assert strat.position_open is False
    assert strat.ce_short is None and strat.pe_short is None
    assert strat.ce_hedge is None and strat.pe_hedge is None


# ── inversion guard ──────────────────────────────────────────────────────

def test_roll_leg_triggers_emergency_unwind_on_strike_inversion():
    broker = FakeBroker()
    helper = FakeHelper()
    helper.quotes[(24900, "CE")] = (2003, 90.0)   # rolled CE strike, below PE's
    helper.quotes[(25350, "CE")] = (2004, 15.0)   # dragged hedge quote, so the drag itself succeeds
    helper.quotes[(25400, "CE")] = (1003, 22.0)   # old-hedge exit-price quote
    strat = make_strategy(broker, helper)
    strat.position_open = True
    strat.ce_short = leg(25000, 100.0, 1001, sl=140.0, roll_count=0)
    strat.pe_short = leg(25000, 100.0, 1002)  # PE stays at 25000
    strat.ce_hedge = leg(25400, 20.0, 1003)
    strat.pe_hedge = leg(24600, 20.0, 1004)
    helper.ltps["NIFTY"] = 24900  # spot implies a new CE ATM strike at/below PE's

    strat.roll_leg("CE", 145.0)

    # CE ended up <= PE strike -> emergency unwind must have fired and flattened.
    assert strat.position_open is False
    assert strat.ce_short is None and strat.pe_short is None
