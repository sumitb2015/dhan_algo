"""Engine tests for lib/momentum.py and the replay (scripts/analysis/simulate_momentum_replay.py).

Pure / synthetic data only: no broker, no network, no repo CSVs. Run: venv/bin/python tests/test_momentum_engine.py

Covers the 2026-11-23 audit fixes: weekly rank rotation (rotation_due), compounding sizing, gap-aware history
(_segment_counts / RSMatrix.history_ok / rank_universe), and the replay's data-gap exit, slot cap and Turtle
rank <= buy_rank_limit entry gate.
"""
import importlib.util
import os
import sys
import tempfile
from datetime import date, timedelta

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
from lib import momentum as mo  # noqa: E402
from lib import clenow  # noqa: E402


def _load_replay():
    spec = importlib.util.spec_from_file_location(
        "sim_replay", os.path.join(ROOT, "scripts", "analysis", "simulate_momentum_replay.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _bdays(start: date, n: int):
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def _frame(dates, closes, volume=1e6):
    closes = np.asarray(closes, dtype=float)
    vols = np.linspace(volume, volume * 3, len(closes))          # rising volume: today > 20d average
    return pd.DataFrame({"date": dates, "open": closes, "high": closes * 1.01, "low": closes * 0.99,
                         "close": closes, "volume": vols})


# ── rules ──────────────────────────────────────────────────────────────────────

def test_rotation_due_once_per_iso_week():
    mon, tue, next_mon = date(2026, 11, 23), date(2026, 11, 24), date(2026, 11, 30)
    assert mo.rotation_due(None, mon)
    assert not mo.rotation_due(mon, tue)                  # same week: already rotated
    assert mo.rotation_due(mon, next_mon)
    assert mo.rotation_due(date(2026, 11, 20), tue)       # Monday missed: Tuesday still rotates


def test_compounding_sizing():
    cfg = mo.MomentumConfig(capital=500_000, slots=10)
    w_top, w_rest = cfg.tier_weights()
    assert abs(cfg.allocation_for_rank(1) - 500_000 * w_top) < 1e-6           # no equity: starting capital
    assert abs(cfg.allocation_for_rank(1, 1_000_000) - 1_000_000 * w_top) < 1e-6
    assert abs(cfg.allocation_for_rank(8, 1_000_000) - 1_000_000 * w_rest) < 1e-6
    fixed = mo.MomentumConfig(capital=500_000, slots=10, compound=False)
    assert abs(fixed.allocation_for_rank(1, 1_000_000) - 500_000 * w_top) < 1e-6
    assert mo.size_position(100.0, 1, cfg, cash_available=50_000, equity=1_000_000) == 500   # cash caps it


def test_segment_counts_reset_after_long_gap():
    present = np.array([1] * 5 + [0] * 3 + [1] * 2 + [0] * 25 + [1] * 3, dtype=bool)
    seg = mo._segment_counts(present, 20)
    assert seg[4] == 5 and seg[9] == 7           # a 3-day hole does not reset
    assert seg[-1] == 3                          # the 25-day gap does


def test_rank_universe_skips_relisted_symbol():
    dates = _bdays(date(2022, 1, 3), 700)
    bench = _frame(dates, np.linspace(100, 150, 700))
    steady = _frame(dates, np.linspace(100, 180, 700))
    # RELIST trades 300 bars, vanishes for 200, then comes back at 3x: forward-filling across the gap would hand it
    # a huge RS. It must stay unranked until it has min_history_bars fresh bars.
    keep = list(range(300)) + list(range(500, 700))
    relist = _frame([dates[i] for i in keep], [100.0] * 300 + [300.0] * 200)
    cfg = mo.MomentumConfig(min_history_bars=150)
    m = mo.build_rs_matrix({"STEADY": steady, "RELIST": relist}, bench, cfg.gap_reset_days)
    at = dates[-1]                                 # 200 bars after relisting: above 150? yes -> ranked
    assert m.history_ok("RELIST", at, 150) and not m.history_ok("RELIST", dates[600], 150)
    ranked_600 = dict(mo.rank_universe({}, bench, dates[600], cfg, matrix=m))
    assert "RELIST" not in ranked_600 and "STEADY" in ranked_600


def test_clenow_rotation_skips_symbols_without_a_bar():
    ranking = [("A", 50.0), ("B", 40.0), ("C", 30.0), ("D", 20.0), ("E", 10.0)]
    held = {"E": object(), "GAP": object()}
    exits = dict(clenow.rank_rotation_exits(held, ranking, min_percentile=80.0, unscored={"GAP"}))
    assert "E" in exits and "GAP" not in exits


# ── replay ─────────────────────────────────────────────────────────────────────

def _run_replay(price_map, bench, universe, cfg, start, end):
    sim = _load_replay()
    sim.REPLAYS_DIR = tempfile.mkdtemp(prefix="momentum_replay_test_")
    sim.load_universe = lambda _u: universe
    sim.load_benchmark = lambda _b=None: bench
    sim.load_price_map = lambda syms, min_bars=0: {s: price_map[s] for s in syms if s in price_map}
    return sim.run_replay_simulation(cfg, start, end, strategy="turtle_rs", force=True)


def test_replay_gap_exit_slot_cap_and_weekly_rotation():
    n = 700
    dates = _bdays(date(2022, 1, 3), n)
    bench = _frame(dates, np.linspace(100, 160, n))
    universe, price_map = [], {}
    for k in range(4):                                   # four strong, steadily breaking-out names
        sym = f"S{k}"
        universe.append({"symbol": sym, "company": sym, "industry": f"I{k}", "isin": ""})
        price_map[sym] = _frame(dates, np.linspace(100, 400 + 50 * k, n), volume=2e6)
    # GHOST: strongest name, then no bars for 150 sessions, then back at 5x.
    keep = list(range(420)) + list(range(570, n))
    ghost_px = np.concatenate([np.linspace(100, 900, 420), np.full(n - 570, 4500.0)])
    price_map["GHOST"] = _frame([dates[i] for i in keep], ghost_px, volume=2e6)
    universe.append({"symbol": "GHOST", "company": "GHOST", "industry": "IG", "isin": ""})

    cfg = mo.MomentumConfig(capital=500_000, slots=3, sector_cap=2, min_history_bars=250)
    res = _run_replay(price_map, bench, universe, cfg, dates[300], dates[-1])
    snaps, trades = res["snapshots"], res["closed_trades"]

    assert max(s["active_slots"] for s in snaps) <= cfg.slots, "book exceeded its slot count"
    ghost = [t for t in trades if t["symbol"] == "GHOST"]
    assert ghost, "GHOST should have been bought before its gap"
    gap_exits = [t for t in ghost if t["exit_reason"] == "data_gap"]
    assert gap_exits, f"GHOST should leave on the data gap, got {[t['exit_reason'] for t in ghost]}"
    assert all(t["exit_price"] < 1000 for t in gap_exits), "gap exit must use the last close, not the relisting price"
    relisted_buys = [t for t in ghost if t["entry_date"] >= dates[570].isoformat()]
    assert not relisted_buys, "GHOST must not be bought until it has min_history_bars fresh bars"
    held_after = [s for s in snaps if s["date"] >= dates[570].isoformat() and any(h["symbol"] == "GHOST" for h in s["holdings"])]
    assert not held_after, "GHOST must not be held through or after its gap"

    # Rotation sells only ever happen on one day per ISO week.
    weeks = {}
    for t in trades:
        if t["exit_reason"] == "rebalance":
            d = date.fromisoformat(t["exit_date"])
            weeks.setdefault(tuple(d.isocalendar()[:2]), set()).add(d)
    assert all(len(v) == 1 for v in weeks.values()), weeks
    assert res["config"]["compound"] is True and res["config"]["engine"] >= 2


def test_replay_turtle_respects_buy_rank_limit():
    n = 600
    dates = _bdays(date(2022, 1, 3), n)
    bench = _frame(dates, np.linspace(100, 130, n))
    universe, price_map = [], {}
    for k in range(6):                                   # S0 strongest ... S5 weakest; all pass the entry filters
        sym = f"S{k}"
        universe.append({"symbol": sym, "company": sym, "industry": f"I{k}", "isin": ""})
        price_map[sym] = _frame(dates, np.linspace(100, 600 - 60 * k, n), volume=2e6)
    cfg = mo.MomentumConfig(capital=500_000, slots=6, buy_rank_limit=2, min_history_bars=250)
    res = _run_replay(price_map, bench, universe, cfg, dates[300], dates[-1])
    ranks = {t["rank_at_entry"] for t in res["closed_trades"]}
    for s in res["snapshots"]:
        ranks |= {h["rank_at_entry"] for h in s["holdings"]}
    assert ranks and max(ranks) <= 2, f"entries above buy_rank_limit: {sorted(ranks)}"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"PASS {t.__name__}")
    print(f"\n{len(tests)} passed")
