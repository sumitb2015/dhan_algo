"""Pure-rule tests for lib/clenow.py (no broker, no network). Run: venv/bin/python tests/test_clenow_rules.py"""
import os, sys
from datetime import date
from types import SimpleNamespace

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from lib import clenow as cl  # noqa: E402

D = date(2026, 11, 20)


def tables(**over):
    """A stock that satisfies every rule; override single values to test rejection."""
    row = SimpleNamespace(close=150.0, volume=5000.0)
    vals = dict(sma100=140.0, sma200=130.0, max_gap_90=0.08, clenow=45.2)
    vals.update({k: v for k, v in over.items() if k != "row"})
    t = {k: {D: v} for k, v in vals.items()}
    t["px"] = {D: over.get("row", row)}
    return {"AAA": t}


def test_qualifies():
    ok, why = cl.entry_check("AAA", tables(), D)
    assert ok and why == "QUALIFIED", (ok, why)


def test_each_rule_rejects():
    # 1. Close < 100 SMA
    tbl1 = tables(sma100=155.0)
    ok, why = cl.entry_check("AAA", tbl1, D)
    assert not ok and "Close not > 100 SMA" in why

    # 2. Close < 200 SMA
    tbl2 = tables(sma200=160.0)
    ok, why = cl.entry_check("AAA", tbl2, D)
    assert not ok and "Close not > 100 SMA and > 200 SMA" in why

    # 3. Gap filter breached (>15% in 90 days)
    tbl3 = tables(max_gap_90=0.18)
    ok, why = cl.entry_check("AAA", tbl3, D)
    assert not ok and "gap filter breached" in why

    # 4. Non-positive momentum score
    tbl4 = tables(clenow=-2.5)
    ok, why = cl.entry_check("AAA", tbl4, D)
    assert not ok and "non-positive momentum score" in why


def test_exit_sma100_and_stop():
    pos = SimpleNamespace(symbol="AAA", entry_price=100.0, stop_price=85.0, peak_close=100.0, last_close=100.0)
    t = {"AAA": {"sma100": {D: 95.0}}}

    # Normal holding (Close 98.0 > SMA100 95.0, > Stop 85.0)
    assert cl.exit_check(pos, 98.0, t, D, stop_pct=15.0) is None

    # Trend Exit: Close 94.0 < SMA100 95.0
    assert cl.exit_check(pos, 94.0, t, D, stop_pct=15.0) == "sma100_exit"

    # Disaster Stop: Close 84.0 < Stop 85.0 (even if SMA100 was 80.0)
    t_low = {"AAA": {"sma100": {D: 80.0}}}
    assert cl.exit_check(pos, 84.0, t_low, D, stop_pct=15.0) == "stop"


def test_rank_rotation_exits():
    portfolio = {"AAA": {}, "BBB": {}, "CCC": {}}
    # Ranking of universe (strongest first)
    # AAA is 1st (100th percentile), BBB is middle, CCC is bottom
    ranking = [("AAA", 50.0), ("DDD", 40.0), ("EEE", 30.0), ("BBB", 20.0), ("CCC", 5.0)]
    # Min percentile 80% (top 20%) -> BBB and CCC should rotate out
    exits = cl.rank_rotation_exits(portfolio, ranking, min_percentile=70.0)
    exited_symbols = {s for s, _ in exits}
    assert "AAA" not in exited_symbols
    assert "BBB" in exited_symbols or "CCC" in exited_symbols


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
