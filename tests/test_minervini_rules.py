"""Pure-rule tests for lib/minervini.py (no broker, no network). Run: venv/bin/python tests/test_minervini_rules.py"""
import os, sys
from datetime import date
from types import SimpleNamespace

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from lib import minervini as m  # noqa: E402

D = date(2026, 11, 20)


def tables(**over):
    """A stock that satisfies every rule; override single values to break one rule."""
    row = SimpleNamespace(close=110.0, volume=2000.0)
    vals = dict(sma50=105.0, sma150=95.0, sma200=85.0, sma200_prev=80.0,
                high250=120.0, low250=60.0, high20=108.0, high10=109.0)
    vals.update({k: v for k, v in over.items() if k != "row"})
    t = {k: {D: v} for k, v in vals.items()}
    t["px"] = {D: over.get("row", row)}
    t["vol20"] = {D: 1000.0}
    return {"AAA": t}


def check(tbl, pct=95.0, bo=20):
    return m.entry_check("AAA", tbl, D, bo, {"AAA": pct})


def test_qualifies():
    assert check(tables()) == (True, "QUALIFIED")


def test_each_rule_rejects():
    cases = {
        "trend not stacked": tables(sma50=115.0),
        "200 SMA not rising": tables(sma200_prev=90.0),
        "<25% above 52w low": tables(low250=100.0),
        ">20% below 52w high": tables(high250=200.0),
        "below 20d pivot": tables(high20=111.0),
        "extended": tables(high20=100.0),                       # 110 is 10% above the pivot
        "volume <": tables(row=SimpleNamespace(close=110.0, volume=500.0)),
    }
    for name, tbl in cases.items():
        ok, why = check(tbl)
        assert not ok and name.split(" 20d")[0] in why, (name, why)
    ok, why = check(tables(), pct=40.0)
    assert not ok and "RS rank <70" in why


def test_all_failures_listed():
    ok, why = check(tables(sma200_prev=90.0, high20=111.0), pct=10.0)
    assert not ok and why.count(" · ") == 2, why


def test_pivot_window_10_vs_20():
    tbl = tables(high20=111.0, high10=108.0)
    assert not check(tbl, bo=20)[0]       # 20-day pivot not yet cleared
    assert check(tbl, bo=10)[0]           # tight-VCP 10-day pivot is
    assert m.pivot_lookback(55) == 20     # any other setting falls back to 20


def test_missing_history_rejected():
    ok, why = check(tables(sma200_prev=float("nan")))
    assert not ok and "insufficient history" in why


def test_rs_percentiles():
    r = m.rs_percentiles([("A", 3), ("B", 2), ("C", 1)])
    assert r == {"A": 100.0, "B": 50.0, "C": 0.0}


def _pos(entry=100.0, stop=88.0):
    return SimpleNamespace(symbol="AAA", entry_price=entry, stop_price=stop, peak_close=entry,
                           last_close=entry, stage=0)


def test_exit_initial_stop_and_trail():
    TRAIL = 2
    t = {"AAA": {"sma50": {D: 112.0}}}
    p = _pos()
    assert m.exit_check(p, 95.0, t, D, TRAIL) is None and p.stop_price == 88.0      # above the 12% stop
    assert m.exit_check(p, 87.0, t, D, TRAIL) == "stop"
    p = _pos()
    assert m.exit_check(p, 120.0, t, D, TRAIL) is None                               # +20% arms the trail
    assert p.stage == TRAIL and p.stop_price == 112.0                                # stop moved to the 50 SMA
    assert m.exit_check(p, 150.0, {"AAA": {"sma50": {D: 100.0}}}, D, TRAIL) is None  # a lower SMA never loosens it
    assert p.stop_price == 112.0
    assert m.exit_check(p, 111.0, t, D, TRAIL) == "stop"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
