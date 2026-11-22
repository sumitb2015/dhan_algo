"""Pure-rule tests for lib/ema_supertrend.py (no broker, no network). Run: venv/bin/python -m pytest tests/test_ema_supertrend_rules.py"""
import os, sys
from datetime import date
from types import SimpleNamespace

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from lib import ema_supertrend as est

D = date(2026, 11, 20)


def tables(**over):
    """A stock that satisfies every rule; override single values to test rejection."""
    row = SimpleNamespace(close=120.0, volume=2000.0)
    vals = dict(
        ema20=115.0,
        ema50=105.0,
        ema200=90.0,
        st_dir=1,
        st_line=110.0,
    )
    vals.update({k: v for k, v in over.items() if k != "row"})
    t = {k: {D: v} for k, v in vals.items()}
    t["px"] = {D: over.get("row", row)}
    t["vol20"] = {D: 1000.0}
    return {"AAA": t}


def check(tbl, pct=85.0):
    return est.entry_check("AAA", tbl, D, {"AAA": pct})


def test_qualifies():
    ok, reason = check(tables())
    assert ok is True
    assert reason == "pass"


def test_each_rule_rejects():
    cases = {
        "EMAs not stacked": tables(ema20=125.0), # Close (120) < EMA20 (125)
        "Supertrend is Red": tables(st_dir=-1),
        "Volume < 80%": tables(row=SimpleNamespace(close=120.0, volume=500.0)),
    }
    for name, tbl in cases.items():
        ok, why = check(tbl)
        assert not ok, f"Expected {name} to fail"
        assert name in why, f"Expected '{name}' in '{why}'"

    ok, why = check(tables(), pct=40.0)
    assert not ok and "RS percentile" in why


def test_exit_check():
    # Test un-armed trailing stop (peak up only 5% < 15%)
    pos = SimpleNamespace(symbol="AAA", entry_price=100.0, peak_price=105.0)
    tbl = tables()

    # Default is stop-only: a red Supertrend or a close under EMA 50 does NOT sell on its own.
    tbl_red = tables(st_dir=-1, ema50=90.0, st_line=115.0)
    assert est.exit_check(pos, 102.0, tbl_red, D) is None
    tbl_ema = tables(ema50=105.0, st_line=90.0, st_dir=1)
    assert est.exit_check(pos, 102.0, tbl_ema, D) is None

    # Hard stop hit (close < 88.0)
    assert est.exit_check(pos, 85.0, tbl, D) == "stop"


def test_optional_discretionary_exits():
    pos = SimpleNamespace(symbol="AAA", entry_price=100.0, peak_price=105.0)
    try:
        est.EXIT_ON_SUPERTREND = True
        assert est.exit_check(pos, 102.0, tables(st_dir=-1, ema50=90.0, st_line=115.0), D) == "Supertrend Bearish (Red)"
        est.EXIT_ON_SUPERTREND = False
        est.EXIT_ON_EMA50 = True
        assert est.exit_check(pos, 102.0, tables(ema50=105.0, st_line=90.0, st_dir=1), D) == "Close < EMA 50 (Trend Broken)"
    finally:
        est.EXIT_ON_SUPERTREND = False
        est.EXIT_ON_EMA50 = False


def test_trailing_stop_arms_after_15pct():
    pos = SimpleNamespace(symbol="AAA", entry_price=100.0, peak_close=130.0, stop_price=88.0)
    # peak +30% -> trailing stop 130*0.88 = 114.4; a close of 112 is under it, above the 88 hard stop
    assert est.exit_check(pos, 112.0, tables(), D) == "stop"
    assert est.exit_check(pos, 116.0, tables(), D) is None


if __name__ == "__main__":
    test_qualifies()
    test_each_rule_rejects()
    test_exit_check()
    test_optional_discretionary_exits()
    test_trailing_stop_arms_after_15pct()
    print("All EMA + Supertrend unit tests passed!")
