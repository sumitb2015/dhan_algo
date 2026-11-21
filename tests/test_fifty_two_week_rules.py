"""Pure-rule tests for lib/fifty_two_week.py (no broker, no network). Run: venv/bin/python tests/test_fifty_two_week_rules.py"""
import os, sys
from datetime import date
from types import SimpleNamespace

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from lib import fifty_two_week as ftw  # noqa: E402

D = date(2026, 11, 20)


def tables(**over):
    """A stock that satisfies every rule; override single values to test rejection."""
    row = SimpleNamespace(close=102.0, volume=2000.0)
    vals = dict(sma50=95.0, sma200=85.0, high250=100.0)
    vals.update({k: v for k, v in over.items() if k != "row"})
    t = {k: {D: v} for k, v in vals.items()}
    t["px"] = {D: over.get("row", row)}
    t["vol20"] = {D: 1000.0}
    return {"AAA": t}


def test_qualifies():
    ok, why = ftw.entry_check("AAA", tables(), D, strict_breakout=True)
    assert ok and why == "QUALIFIED", (ok, why)


def test_each_rule_rejects():
    # 1. Close not > 50 SMA > 200 SMA
    tbl1 = tables(sma50=80.0, sma200=90.0)
    ok, why = ftw.entry_check("AAA", tbl1, D)
    assert not ok and "Close not > 50 SMA > 200 SMA" in why

    # 2. Below 52-week high
    tbl2 = tables(row=SimpleNamespace(close=98.0, volume=2000.0), high250=100.0)
    ok, why = ftw.entry_check("AAA", tbl2, D, strict_breakout=True)
    assert not ok and "below 52w high" in why

    # 3. Extended > 5% above 52W high
    tbl3 = tables(row=SimpleNamespace(close=108.0, volume=2000.0), high250=100.0)
    ok, why = ftw.entry_check("AAA", tbl3, D, strict_breakout=True)
    assert not ok and "extended" in why

    # 4. Volume < 20d average
    tbl4 = tables(row=SimpleNamespace(close=102.0, volume=500.0))
    ok, why = ftw.entry_check("AAA", tbl4, D)
    assert not ok and "volume < 20d average" in why


def test_proximity_mode():
    # Proximity mode with 5% threshold: 96 / 100 = 0.96 (within 5%, i.e. >= 0.95)
    tbl = tables(row=SimpleNamespace(close=96.0, volume=2000.0), high250=100.0)
    ok, why = ftw.entry_check("AAA", tbl, D, strict_breakout=False, max_proximity_pct=5.0)
    assert ok and why == "QUALIFIED"

    # Proximity mode with 5% threshold: 92 / 100 = 0.92 (< 0.95 -> rejects)
    tbl2 = tables(row=SimpleNamespace(close=92.0, volume=2000.0), high250=100.0)
    ok2, why2 = ftw.entry_check("AAA", tbl2, D, strict_breakout=False, max_proximity_pct=5.0)
    assert not ok2 and "proximity <95%" in why2


def test_exit_trailing_stop():
    pos = SimpleNamespace(symbol="AAA", entry_price=100.0, stop_price=88.0, peak_close=100.0, last_close=100.0)
    # Stop does not trigger at 95.0
    res = ftw.exit_check(pos, 95.0, stop_pct=12.0)
    assert res is None
    assert pos.stop_price == 88.0

    # Stock rallies to 120.0 -> peak_close = 120.0, stop moves up to 120 * 0.88 = 105.6
    res = ftw.exit_check(pos, 120.0, stop_pct=12.0)
    assert res is None
    assert round(pos.stop_price, 2) == 105.6

    # Stock pulls back to 110.0 -> stop stays 105.6
    res = ftw.exit_check(pos, 110.0, stop_pct=12.0)
    assert res is None
    assert round(pos.stop_price, 2) == 105.6

    # Stock drops to 104.0 -> breaches 105.6 stop
    res = ftw.exit_check(pos, 104.0, stop_pct=12.0)
    assert res == "stop"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
