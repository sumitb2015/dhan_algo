#!/usr/bin/env python
"""Unit tests for lib/rolling_straddle_rules.py (pure functions, no broker, safe to run any time).

    venv/bin/python tests/test_rolling_straddle_rules.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib.rolling_straddle_rules import (trail_lock_pct, is_balanced, straddle_sl_hit, leg_sl_hit,
                                        spot_move_pct, roll_reason)

K = dict(spot=25000, ref_spot=25000, trigger="spot_pct", spot_pct=0.4, max_delta=None,
         delta_limit=0.6, imbalance_ratio=2.0)


def test_trail():
    got = [trail_lock_pct(x) for x in (0.0, 0.19, 0.2, 0.29, 0.3, 0.4, 0.5, 0.6)]
    exp = [None, None, 0.0, 0.0, 0.1, 0.2, 0.28, 0.36]
    assert all((g is None and e is None) or abs(g - e) < 1e-9 for g, e in zip(got, exp)), got


def test_balance_and_sl():
    assert is_balanced(100, 60, 2.0) and not is_balanced(100, 50, 2.0) and not is_balanced(0, 50, 2.0)
    assert straddle_sl_hit(70, 70, 112, 1.25) and not straddle_sl_hit(70, 69, 112, 1.25)
    assert leg_sl_hit(75, 50, 1.5) and not leg_sl_hit(74.9, 50, 1.5)
    assert abs(spot_move_pct(25100, 25000) - 0.4) < 1e-9


def test_roll_reason():
    # skewed at entry: not armed -> imbalance silent; arms once balanced, then fires on drift
    r, armed = roll_reason(ce=100, pe=40, armed=False, **K)
    assert r is None and not armed
    r, armed = roll_reason(ce=100, pe=80, armed=False, **K)
    assert r is None and armed
    r, armed = roll_reason(ce=100, pe=40, armed=True, **K)
    assert r and "imbalance" in r and armed
    # spot trigger, 0.4% of 25000 = 100pts
    r, _ = roll_reason(ce=100, pe=90, armed=True, **{**K, "spot": 25100})
    assert r and "spot moved" in r
    r, _ = roll_reason(ce=100, pe=90, armed=True, **{**K, "spot": 25099})
    assert r is None
    # delta trigger only when selected; None/stale delta never fires
    r, _ = roll_reason(ce=100, pe=90, armed=True, **{**K, "trigger": "delta", "max_delta": 0.61})
    assert r and "delta" in r
    r, _ = roll_reason(ce=100, pe=90, armed=True, **{**K, "trigger": "delta", "max_delta": None})
    assert r is None
    r, _ = roll_reason(ce=100, pe=90, armed=True, **{**K, "trigger": "spot_pct", "max_delta": 0.9})
    assert r is None


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f(); print("ok", n)
