"""Pure-rule tests for lib/rs_supertrend.py (no broker, no network). Run: venv/bin/python -m pytest tests/test_rs_supertrend_rules.py"""
import os, sys
from datetime import date
from types import SimpleNamespace

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from lib import rs_supertrend as rst

D = date(2026, 11, 20)


def tables(**over):
    vals = dict(rs=0.20, rs_up=True, sma50=100.0, st_dir=1, st_line=105.0)
    vals.update(over)
    t = {k: {D: v} for k, v in vals.items()}
    t["px"] = {D: SimpleNamespace(close=120.0, volume=1000.0)}
    t["turnover20"] = {D: 5e7}
    return {"AAA": t}


def test_qualifies():
    assert rst.entry_check("AAA", tables(), D) == (True, "pass")


def test_each_rule_rejects():
    for over, text in [({"rs": -0.05}, "RS"), ({"rs_up": False}, "not rising"), ({"st_dir": -1}, "Supertrend"),
                       ({"sma50": 130.0}, "SMA 50")]:
        ok, reason = rst.entry_check("AAA", tables(**over), D)
        assert not ok and text in reason, (over, reason)
    low = tables(); low["AAA"]["turnover20"] = {D: 1e6}
    assert not rst.entry_check("AAA", low, D)[0]


def test_missing_history_rejects():
    ok, reason = rst.entry_check("AAA", tables(rs=float("nan")), D)
    assert not ok and "history" in reason


def test_rs_formula_and_rising():
    c = pd.Series(np.linspace(100, 200, 300)); b = pd.Series(np.linspace(100, 150, 300))
    rs = rst.rs_series(c, b, 123)
    assert rs.iloc[:123].isna().all()
    exp = (c.iloc[-1] / c.iloc[-124]) / (b.iloc[-1] / b.iloc[-124]) - 1
    assert abs(rs.iloc[-1] - exp) < 1e-12
    assert rst.rs_rising(rs).iloc[-1] in (True, False)
    assert not rst.rs_rising(pd.Series(np.linspace(1, 0, 300))).iloc[-1]


def pos(entry=100.0, peak=100.0):
    return SimpleNamespace(symbol="AAA", entry_price=entry, peak_close=peak, stop_price=entry * 0.88)


def test_exit_stop_and_supertrend():
    tb = tables()
    assert rst.exit_check(pos(), 87.0, tb, D) == "stop"
    assert rst.exit_check(pos(), 110.0, tb, D) is None
    red = tables(st_dir=-1)
    assert rst.exit_check(pos(), 110.0, red, D) == "Supertrend Bearish (Red)"


def test_trail_arms_after_15pct():
    tb = tables()
    assert rst.exit_check(pos(peak=130.0), 112.0, tb, D) == "stop"   # peak*0.88 = 114.4
