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

    # Normal: Close 110, Supertrend Green (st_line 100), EMA50 105 -> No exit
    tbl_ok = tables(ema50=105.0, st_line=100.0)
    assert est.exit_check(pos, 110.0, tbl_ok, D) is None

    # Supertrend flips Red
    tbl_red = tables(st_dir=-1, ema50=90.0, st_line=115.0)
    assert est.exit_check(pos, 102.0, tbl_red, D) == "Supertrend Bearish (Red)"

    # Close drops below EMA 50 (with st_line lower at 90.0 and st_dir=1)
    tbl_ema = tables(ema50=105.0, st_line=90.0, st_dir=1)
    assert est.exit_check(pos, 102.0, tbl_ema, D) == "Close < EMA 50 (Trend Broken)"

    # Hard stop hit (close < 88.0)
    assert est.exit_check(pos, 85.0, tbl, D) == "stop"


if __name__ == "__main__":
    test_qualifies()
    test_each_rule_rejects()
    test_exit_check()
    print("All EMA + Supertrend unit tests passed!")
