"""
Ablation of the Vivek Bajaj RS + Supertrend model (lib/rs_supertrend.py) inside the momentum replay engine
(simulate_momentum_replay.run_replay_simulation: regime filter on, next-open fills, costs, sector cap 2, 10 slots).
Variants flip the module constants; results are written to a TEMP replay dir so the dashboard's cache is untouched.
Context rows (EMA+Supertrend, Weinstein) use the same engine and windows.

    venv/bin/python scripts/analysis/backtest_rs_supertrend_ablation.py
"""
from __future__ import annotations

import os
import sys
import tempfile
from datetime import date

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts", "analysis"))

import simulate_momentum_replay as sim  # noqa: E402
from lib import rs_supertrend as rst  # noqa: E402
from lib.momentum import MomentumConfig  # noqa: E402

END = date(2026, 11, 20)
WINDOWS = {"FULL 2020-26": (date(2020, 1, 1), END), "OOS 2024-26": (date(2024, 1, 1), END)}
VARIANTS = [
    ("RS+ST faithful (N=123, exit ST flip)", "rs_supertrend", dict(RS_LOOKBACK=123, EXIT_ON_SUPERTREND=True, REQUIRE_RS=True)),
    ("No RS filter (ST+SMA50 only, ranked by RS)", "rs_supertrend", dict(RS_LOOKBACK=123, EXIT_ON_SUPERTREND=True, REQUIRE_RS=False)),
    ("RS+ST N=252", "rs_supertrend", dict(RS_LOOKBACK=252, EXIT_ON_SUPERTREND=True, REQUIRE_RS=True)),
    ("RS+ST N=123, stop-only exit", "rs_supertrend", dict(RS_LOOKBACK=123, EXIT_ON_SUPERTREND=False, REQUIRE_RS=True)),
    ("RS+ST N=252, stop-only exit", "rs_supertrend", dict(RS_LOOKBACK=252, EXIT_ON_SUPERTREND=False, REQUIRE_RS=True)),
]


def metrics(res, start, end):
    snaps = res["snapshots"]
    eq = pd.Series({pd.Timestamp(s["date"]): s["equity"] for s in snaps})
    trades = snaps[-1].get("closed_trades", []) if snaps else []
    yrs = max((eq.index[-1] - eq.index[0]).days / 365.25, 1e-9)
    cagr = ((eq.iloc[-1] / eq.iloc[0]) ** (1 / yrs) - 1) * 100
    dd = ((eq / eq.cummax()) - 1).min() * 100
    w = sum(t["pnl"] for t in trades if t["pnl"] > 0); l = -sum(t["pnl"] for t in trades if t["pnl"] < 0)
    return dict(CAGR=cagr, MaxDD=dd, PF=(w / l if l > 0 else np.nan), Trades=len(trades),
                Win=(100 * sum(t["pnl"] > 0 for t in trades) / len(trades) if trades else np.nan),
                Return=(eq.iloc[-1] / eq.iloc[0] - 1) * 100)


def main():
    sim.REPLAYS_DIR = tempfile.mkdtemp(prefix="rs_st_ablation_")
    defaults = {k: getattr(rst, k) for k in ("RS_LOOKBACK", "EXIT_ON_SUPERTREND", "REQUIRE_RS")}
    rows = {w: {} for w in WINDOWS}
    try:
        for name, strat, over in VARIANTS:
            for k, v in {**defaults, **over}.items():
                setattr(rst, k, v)
            for w, (a, b) in WINDOWS.items():
                cfg = MomentumConfig(universe="nifty500", capital=500_000.0, slots=10, regime_enabled=True,
                                     stop_pct=12.0, breakout_days=55)
                res = sim.run_replay_simulation(cfg, a, b, strategy=strat, force=True)
                rows[w][name] = metrics(res, a, b)
    finally:
        for k, v in defaults.items():
            setattr(rst, k, v)
    for w in WINDOWS:
        print(f"\n=== {w} (Rs 5 lakh, 10 slots, Nifty-50 weekly regime ON) ===")
        print(pd.DataFrame(rows[w]).T.round(2).to_string())


if __name__ == "__main__":
    main()
