"""Rule tests for lib/weinstein.py on synthetic weekly-shaped data (no broker, no network).
Run: venv/bin/python tests/test_weinstein_rules.py"""
import os, sys
from types import SimpleNamespace
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import numpy as np, pandas as pd
from lib import weinstein as W


def build(weekly_close, weekly_vol):
    """Daily frame, 5 sessions a week, every day of a week at that week's value."""
    days = pd.bdate_range("2020-01-06", periods=5 * len(weekly_close))
    close = np.repeat(weekly_close, 5).astype(float)
    return pd.DataFrame({"date": [d.date() for d in days], "open": close, "high": close, "low": close,
                         "close": close, "volume": np.repeat(weekly_vol, 5).astype(float)})


def scenario(breakout_vol=3.0, breakout_px=120.0):
    down = list(np.linspace(200, 100, 60))                          # 60w downtrend: MA falling
    base = [100 + 2 * ((-1) ** i) + 0.03 * i for i in range(36)]     # 36w sideways base, MA turning flat/up
    wk = down + base + [breakout_px] + [breakout_px - 5 * i for i in range(1, 16)]
    vol = [1000.0] * (60 + 36) + [1000.0 * breakout_vol] + [1000.0] * 15
    return build(wk, vol), 60 + 36                                  # index of the breakout week


def tables_for(df):
    bench = df[["date"]].assign(close=1000.0)
    t = {"AAA": {"px": {r.date: r for r in df.itertuples(index=False)}}}
    W.add_tables({"AAA": df}, t, bench)
    return t


def week_end(df, i):
    return df["date"].iloc[5 * i + 4]


def test_breakout_week_qualifies():
    df, i = scenario()
    t = tables_for(df)
    ok, why = W.entry_check("AAA", t, week_end(df, i))
    assert ok and why == "QUALIFIED", why


def test_only_on_weekly_close():
    df, i = scenario()
    t = tables_for(df)
    mid_week = df["date"].iloc[5 * i + 2]
    ok, why = W.entry_check("AAA", t, mid_week)
    assert not ok and why == "weekly close only"


def test_volume_rule():
    df, i = scenario(breakout_vol=1.5)
    ok, why = W.entry_check("AAA", tables_for(df), week_end(df, i))
    assert not ok and "volume" in why, why


def test_no_breakout_no_entry():
    df, i = scenario(breakout_px=101.0)                             # does not clear the 26w high
    ok, why = W.entry_check("AAA", tables_for(df), week_end(df, i))
    assert not ok and "26w high" in why, why


def test_weekly_exit_and_hard_stop():
    df, i = scenario()
    t = tables_for(df)
    # exits also fire legitimately during the earlier downtrend, so only look at those after the breakout
    exits = [d for d, v in t["AAA"]["wk_exit"].items() if v and d > week_end(df, i)]
    assert exits, "exit must fire after the breakout once price sinks below a flat MA"
    pos = SimpleNamespace(symbol="AAA", entry_price=120.0, peak_close=120.0, last_close=120.0, stop_price=0.0)
    try:
        W.HARD_STOP = True
        assert W.exit_check(pos, 100.0, t, week_end(df, i), stop_pct=12.0) == "stop"      # 100 < 120 * 0.88
        W.HARD_STOP = False
        assert W.exit_check(pos, 100.0, t, week_end(df, i), stop_pct=12.0) is None        # MA exit only at weekly close
        assert "Weekly close" in (W.exit_check(pos, 100.0, t, min(exits), stop_pct=12.0) or "")
    finally:
        W.HARD_STOP = True


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn(); print("ok", name)
