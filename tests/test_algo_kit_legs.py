"""lib/algo_kit/legs.py: all-or-nothing multi-leg entry with rollback, and a close that never lies.

Stub broker and helper with failure injection (an order that returns no id, raises, is accepted but never fills,
is rejected; a position lookup that fails). No network, no orders.

Run: venv/bin/python -m pytest tests/test_algo_kit_legs.py -q
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.algo_kit.legs import LegExecutor, leg_pnl  # noqa: E402

EXP = "2026-10-27"


class Clock:
    def __init__(self): self.t = 0.0
    def now(self): return self.t
    def sleep(self, s): self.t += s


class FakeBroker:
    """ExecutionBroker stand-in: net positions keyed by (strike, opt_type), failure injection per (side, strike)."""

    def __init__(self):
        self.net, self.orders = {}, []
        self.no_id, self.raises, self.ghost, self.rejected, self.read_error = set(), set(), set(), set(), False
        self.unfilled_oids, self.rejected_oids = set(), set()

    def _place(self, side, strike, expiry, opt, qty, product):
        if (side, strike) in self.no_id:
            return None
        if (side, strike) in self.raises:
            raise RuntimeError("broker down")
        oid = f"O{len(self.orders)}"
        self.orders.append({"side": side, "strike": strike, "opt": opt, "qty": qty, "product": product, "oid": oid})
        if (side, strike) in self.ghost:                 # accepted but never fills
            self.unfilled_oids.add(oid)
        elif (side, strike) in self.rejected:
            self.unfilled_oids.add(oid); self.rejected_oids.add(oid)
        else:
            self.net[(strike, opt)] = self.net.get((strike, opt), 0) + (qty if side == "BUY" else -qty)
        return oid

    def buy(self, strike, expiry, opt, qty, product="MARGIN"): return self._place("BUY", strike, expiry, opt, qty, product)
    def sell(self, strike, expiry, opt, qty, product="MARGIN"): return self._place("SELL", strike, expiry, opt, qty, product)

    def get_owned_net_qty(self, strike, expiry, opt):
        if self.read_error:
            raise RuntimeError("positions api 429")
        return self.net.get((strike, opt), 0)


class FakeHelper:
    def __init__(self, broker, fills=None):
        self.b, self.fills, self.waited, self.cancelled = broker, fills or {}, [], []

    def wait_for_fill(self, oid, timeout=5):
        self.waited.append(oid)
        return oid not in self.b.unfilled_oids

    def get_order_by_id(self, oid):
        o = next(x for x in self.b.orders if x["oid"] == oid)
        return {"averageTradedPrice": self.fills.get((o["side"], o["strike"]), 0.0)}

    def cancel_order(self, oid): self.cancelled.append(oid); return True
    def get_order_status(self, oid): return "REJECTED" if oid in self.b.rejected_oids else "OPEN"


def mk(broker_name="dhan", dry=False, ltp=None, fills=None):
    b = FakeBroker(); h = FakeHelper(b, fills); c = Clock()
    ex = LegExecutor(b, h, broker_name, "MARGIN", dry_run=dry, ltp_fn=(lambda leg: ltp.get(leg["strike"], 0.0)) if ltp else None,
                     confirm_timeout=5, sleep=c.sleep, clock=c.now)
    return ex, b, h


def spec(name, side, strike, price=100.0, qty=75, opt="PE"):
    return {"name": name, "side": side, "opt_type": opt, "strike": strike, "expiry": EXP, "qty": qty,
            "avg_price": price, "id": strike * 10}


CONDOR = [spec("long_up", "BUY", 26050, 30), spec("short_up", "SELL", 25850, 90),
          spec("short_lo", "SELL", 25650, 80), spec("long_lo", "BUY", 25500, 25)]


# ── entry: success ──────────────────────────────────────────────────────────────────────────────────────────

def test_paper_entry_places_no_orders_and_keeps_expected_prices():
    ex, b, h = mk(dry=True)
    r = ex.open_all([dict(s) for s in CONDOR])
    assert r.ok and set(r.opened) == {"long_up", "short_up", "short_lo", "long_lo"}
    assert b.orders == [] and h.waited == []
    assert r.opened["short_up"]["avg_price"] == 90.0


def test_live_dhan_entry_confirms_by_status_and_books_the_real_fill():
    ex, b, h = mk("dhan", fills={("SELL", 25850): 88.5, ("BUY", 26050): 31.25})
    r = ex.open_all([dict(s) for s in CONDOR])
    assert r.ok and [o["strike"] for o in b.orders] == [26050, 25850, 25650, 25500]   # order as given
    assert all(o["product"] == "MARGIN" for o in b.orders)
    assert r.opened["short_up"]["avg_price"] == 88.5 and r.opened["long_up"]["avg_price"] == 31.25
    assert r.opened["short_lo"]["avg_price"] == 80.0               # unreadable fill falls back to the quote


def test_live_non_dhan_entry_confirms_from_the_brokers_net_never_dhans_status():
    ex, b, h = mk("zerodha")
    r = ex.open_all([dict(s) for s in CONDOR])
    assert r.ok and h.waited == []                                  # Dhan was never asked about a Zerodha id
    assert b.net[(25850, "PE")] == -75 and b.net[(26050, "PE")] == 75
    assert r.opened["short_up"]["avg_price"] == 90.0                # non-Dhan: expected price, not a Dhan lookup


# ── entry: failure and rollback ─────────────────────────────────────────────────────────────────────────────

def test_a_failed_order_unwinds_the_legs_already_placed():
    ex, b, h = mk("dhan", ltp={})
    b.no_id.add(("SELL", 25650))                                    # third leg fails
    r = ex.open_all([dict(s) for s in CONDOR])
    assert r.failed == "short_lo" and not r.ok
    assert r.stuck == {} and r.flat                                  # everything it placed was closed
    assert {n for n, *_ in r.unwound} == {"long_up", "short_up"}
    assert all(v == 0 for v in b.net.values())                       # the broker really is flat


def test_rollback_closes_shorts_before_hedges():
    ex, b, h = mk("dhan")
    b.no_id.add(("SELL", 25650))
    ex.open_all([dict(s) for s in CONDOR])
    closes = [o for o in b.orders[2:]]
    assert [o["side"] for o in closes] == ["BUY", "SELL"]            # buy back the short, then sell the hedge
    assert closes[0]["strike"] == 25850 and closes[1]["strike"] == 26050


def test_a_raised_order_is_a_failure_not_a_crash():
    ex, b, h = mk("dhan")
    b.raises.add(("SELL", 25850))
    r = ex.open_all([dict(s) for s in CONDOR])
    assert r.failed == "short_up" and r.flat and {n for n, *_ in r.unwound} == {"long_up"}


def test_first_leg_failing_leaves_nothing_tracked():
    ex, b, h = mk("dhan")
    b.no_id.add(("BUY", 26050))
    r = ex.open_all([dict(s) for s in CONDOR])
    assert r.failed == "long_up" and r.flat and r.unwound == [] and b.orders == []


def test_an_accepted_but_unfilled_order_is_cancelled_and_not_left_dangling():
    ex, b, h = mk("dhan")
    b.ghost.add(("SELL", 25850))                                     # accepted, never fills
    r = ex.open_all([dict(s) for s in CONDOR])
    assert r.failed == "short_up" and h.cancelled                    # it tried to cancel the unconfirmed order
    assert r.flat                                                    # broker net never moved, so the uncertain leg reads flat
    assert all(v == 0 for v in b.net.values())


def test_a_rejected_order_is_known_unfilled_and_is_not_tracked():
    ex, b, h = mk("dhan")
    b.rejected.add(("SELL", 25850))
    seen = []
    r = ex.open_all([dict(s) for s in CONDOR], checkpoint=lambda legs: seen.append(sorted(legs)))
    assert r.failed == "short_up"
    assert "short_up" not in seen[-1]                                # dropped from tracking once known unfilled


def test_rollback_that_cannot_close_a_leg_never_reports_flat():
    ex, b, h = mk("dhan")
    b.no_id.add(("SELL", 25650))                                     # entry fails at leg 3
    b.no_id.add(("BUY", 25850))                                      # ...and the buy-back of leg 2 also fails
    r = ex.open_all([dict(s) for s in CONDOR])
    assert r.failed == "short_lo" and not r.flat
    assert "short_up" in r.stuck                                     # the short is still tracked for a retry
    assert "long_up" in r.stuck                                      # and its hedge is held while that short is open
    assert b.net[(25850, "PE")] == -75 and b.net[(26050, "PE")] == 75


def test_rollback_close_that_never_confirms_stays_tracked():
    ex, b, h = mk("dhan")
    b.no_id.add(("SELL", 25650))
    b.ghost.add(("BUY", 25850))                                      # the buy-back is accepted but never fills
    r = ex.open_all([dict(s) for s in CONDOR])
    assert "short_up" in r.stuck and not r.flat


def test_checkpoint_runs_before_each_order_with_the_leg_already_tracked():
    ex, b, h = mk("dhan")
    snaps = []
    ex.open_all([dict(s) for s in CONDOR], checkpoint=lambda legs: snaps.append((len(b.orders), sorted(legs))))
    # the first call for leg i happens with i orders already placed and leg i already in the book
    assert snaps[0] == (0, ["long_up"]) and snaps[1] == (1, ["long_up"])
    assert snaps[2] == (1, ["long_up", "short_up"]) and snaps[4] == (2, ["long_up", "short_lo", "short_up"])


def test_without_rollback_the_caller_gets_the_tracked_legs():
    ex, b, h = mk("dhan")
    b.no_id.add(("SELL", 25650))
    r = ex.open_all([dict(s) for s in CONDOR], rollback=False)
    assert r.failed == "short_lo" and set(r.stuck) == {"long_up", "short_up"} and len(b.orders) == 2


# ── exit ────────────────────────────────────────────────────────────────────────────────────────────────────

def held(side, strike, qty=75, price=90.0, opt="PE"):
    return {"side": side, "opt_type": opt, "strike": strike, "expiry": EXP, "qty": qty, "avg_price": price, "id": strike}


def test_close_clamps_to_what_the_broker_still_shows():
    """A sibling instance already closed part of this strike: exit only what is left, book only that."""
    ex, b, h = mk("dhan", ltp={25850: 40.0})
    b.net[(25850, "PE")] = -75                                       # broker shows 75 short, we track 150
    r = ex.close_leg(held("SELL", 25850, qty=150))
    assert r.confirmed and r.qty_closed == 75 and b.orders[0]["qty"] == 75


def test_close_of_an_already_flat_leg_is_confirmed_with_nothing_traded():
    ex, b, h = mk("dhan")
    r = ex.close_leg(held("SELL", 25850))
    assert r.confirmed and r.qty_closed == 0 and b.orders == []


def test_close_does_not_call_a_leg_flat_when_the_position_lookup_fails():
    ex, b, h = mk("dhan")
    b.read_error = True
    r = ex.close_leg(held("SELL", 25850))
    assert not r.confirmed and b.orders == []


def test_close_confirms_a_non_dhan_order_from_the_net_position():
    ex, b, h = mk("kotak", ltp={25850: 40.0})
    b.net[(25850, "PE")] = -75
    r = ex.close_leg(held("SELL", 25850))
    assert r.confirmed and r.qty_closed == 75 and h.waited == [] and b.net[(25850, "PE")] == 0


def test_paper_close_without_a_quote_closes_at_entry_not_at_zero():
    ex, b, h = mk(dry=True, ltp={25850: 40.0})
    assert ex.close_leg(held("SELL", 25850)) .exit_price == 40.0
    ex2, *_ = mk(dry=True, ltp={})
    leg = held("SELL", 25850)
    r = ex2.close_leg(leg)
    assert r.confirmed and r.exit_price == leg["avg_price"] > 0      # zero P&L, never "closed at 0", never hangs


def test_close_all_closes_shorts_then_hedges_and_calls_back_per_leg():
    ex, b, h = mk("dhan", ltp={})
    b.net.update({(26050, "PE"): 75, (25850, "PE"): -75, (25650, "PE"): -75, (25500, "PE"): 75})
    legs = {"long_up": held("BUY", 26050), "short_up": held("SELL", 25850),
            "short_lo": held("SELL", 25650), "long_lo": held("BUY", 25500)}
    seen = []
    r = ex.close_all(legs, on_closed=lambda n, l, px, q: seen.append(n))
    assert r.all_closed and r.remaining == {} and len(legs) == 4     # input is not mutated
    assert seen[:2] == ["short_up", "short_lo"] and set(seen[2:]) == {"long_up", "long_lo"}
    assert all(v == 0 for v in b.net.values())


def test_a_hedge_is_held_while_any_short_remains_open():
    ex, b, h = mk("dhan")
    b.net.update({(26050, "PE"): 75, (25850, "PE"): -75})
    b.no_id.add(("BUY", 25850))                                      # cannot buy the short back
    legs = {"long_up": held("BUY", 26050), "short_up": held("SELL", 25850)}
    r = ex.close_all(legs)
    assert not r.all_closed and set(r.remaining) == {"long_up", "short_up"}
    assert b.net[(26050, "PE")] == 75                                # the hedge was NOT sold: no naked short


def test_close_all_reports_partial_progress():
    ex, b, h = mk("dhan")
    b.net.update({(25850, "PE"): -75, (25650, "PE"): -75})
    b.no_id.add(("BUY", 25650))
    r = ex.close_all({"short_up": held("SELL", 25850), "short_lo": held("SELL", 25650)})
    assert not r.all_closed and [n for n, *_ in r.closed] == ["short_up"] and set(r.remaining) == {"short_lo"}


def test_leg_pnl_sign():
    assert leg_pnl("SELL", 100, 70, 75) == 2250 and leg_pnl("BUY", 100, 130, 75) == 2250
    assert leg_pnl("SELL", 100, 130, 75) == -2250


# ── reconcile ───────────────────────────────────────────────────────────────────────────────────────────────

def test_reconcile_matches_a_clean_book():
    ex, b, h = mk("dhan")
    b.net.update({(26050, "PE"): 75, (25850, "PE"): -75})
    legs = {"long_up": held("BUY", 26050), "short_up": held("SELL", 25850)}
    assert ex.reconcile(legs) == [] and ex.reconcile(legs, shortfall_only=False) == []


def test_reconcile_flags_a_shortfall_in_either_direction():
    ex, b, h = mk("dhan")
    b.net.update({(26050, "PE"): 0, (25850, "PE"): 0})               # broker holds neither leg
    legs = {"long_up": held("BUY", 26050), "short_up": held("SELL", 25850)}
    out = ex.reconcile(legs)
    assert len(out) == 2 and "long_up" in out[0] and "short_up" in out[1]


def test_reconcile_tolerates_a_sibling_on_the_same_strike_unless_exact():
    ex, b, h = mk("dhan")
    b.net[(25850, "PE")] = -150                                      # a sibling added 75 more short
    legs = {"short_up": held("SELL", 25850)}
    assert ex.reconcile(legs) == []                                  # we still hold ours: fine
    assert len(ex.reconcile(legs, shortfall_only=False)) == 1        # exact mode: a mismatch


def test_reconcile_skips_unreadable_legs_and_paper_books():
    ex, b, h = mk("dhan")
    b.read_error = True
    assert ex.reconcile({"short_up": held("SELL", 25850)}) == []
    exp, *_ = mk(dry=True)
    assert exp.reconcile({"short_up": held("SELL", 25850)}) == []


class _BaselineBroker:
    """Non-Dhan broker whose position read fails: an order must not be sent without a baseline."""
    def __init__(self):
        self.orders = []

    def get_owned_net_qty(self, *a, **k):
        raise RuntimeError("positions unavailable")

    def sell(self, *a, **k):
        self.orders.append(("SELL", a))
        return "X1"

    buy = sell


def _exec(broker, name="zerodha", dry=False, ltp=0.0):
    from lib.algo_kit import LegExecutor
    import logging
    return LegExecutor(broker, object(), name, "MARGIN", dry_run=dry, ltp_fn=lambda leg: ltp,
                       log=logging.getLogger("t"), sleep=lambda x: None, clock=lambda: 0.0)


def test_no_order_when_the_baseline_read_fails():
    b = _BaselineBroker()
    ok, oid = _exec(b).open_leg("SELL", {"side": "SELL", "opt_type": "PE", "strike": 25000, "expiry": "2026-10-27",
                                         "qty": 65, "avg_price": 100.0})
    assert (ok, oid) == (False, None)
    assert b.orders == []


def test_paper_close_without_a_quote_closes_at_entry_instead_of_hanging():
    leg = {"side": "SELL", "opt_type": "PE", "strike": 25000, "expiry": "2026-10-27", "qty": 65, "avg_price": 100.0}
    res = _exec(_BaselineBroker(), dry=True, ltp=0.0).close_leg(leg)
    assert res.confirmed and res.exit_price == 100.0 and res.qty_closed == 65


def test_a_pending_leg_is_never_closed_automatically_in_live():
    b = _BaselineBroker()
    leg = {"side": "BUY", "opt_type": "PE", "strike": 24800, "expiry": "2026-10-27", "qty": 65, "avg_price": 50.0,
           "pending": True}
    res = _exec(b, ltp=50.0).close_leg(leg)
    assert not res.confirmed
    assert b.orders == []
