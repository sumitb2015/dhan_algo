"""
Parameter search for lib/rs_supertrend.py, tuned on IN-SAMPLE 2020-01..2023-12 only; the top picks are then run ONCE on
OOS 2024-01..2026-11 and FULL. Nothing is chosen on OOS. Every config tried is counted and printed.
Results go to a temp replay dir (dashboard cache untouched).

    venv/bin/python scripts/analysis/optimise_rs_supertrend.py
"""
from __future__ import annotations

import itertools
import os
import sys
import tempfile
from datetime import date
from multiprocessing import Pool

import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts", "analysis"))

END = date(2026, 11, 20)
IS = (date(2020, 1, 1), date(2023, 12, 31))
OOS = (date(2024, 1, 1), END)
FULL = (date(2020, 1, 1), END)

GRID = dict(
    exit_st=[True, False],
    stop=[10.0, 12.0, 15.0, 20.0],
    st_mult=[2.0, 3.0],
    slots=[10, 15],
)


def run(job):
    cfgd, window = job
    import simulate_momentum_replay as sim
    from backtest_rs_supertrend_ablation import metrics
    from lib import rs_supertrend as rst
    from lib.momentum import MomentumConfig
    tmp = tempfile.TemporaryDirectory(prefix="rs_opt_")   # each replay JSON is large; delete it as soon as the run ends
    sim.REPLAYS_DIR = tmp.name
    rst.EXIT_ON_SUPERTREND = cfgd["exit_st"]
    rst.ST_MULT = cfgd["st_mult"]
    cfg = MomentumConfig(universe="nifty500", capital=500_000.0, slots=cfgd["slots"], regime_enabled=True,
                         stop_pct=cfgd["stop"], breakout_days=55)
    res = sim.run_replay_simulation(cfg, window[0], window[1], strategy="rs_supertrend", force=True)
    out = metrics(res, *window)
    tmp.cleanup()
    return cfgd, out


def score(m):
    # return per unit of drawdown, ignoring configs with too few trades to mean anything
    return m["CAGR"] / abs(m["MaxDD"]) if m["Trades"] >= 100 else -9


def main():
    keys = list(GRID)
    cfgs = [dict(zip(keys, v)) for v in itertools.product(*GRID.values())]
    print(f"configs tried on in-sample: {len(cfgs)}", flush=True)
    with Pool(6) as p:
        ins = p.map(run, [(c, IS) for c in cfgs])
    df = pd.DataFrame([{**c, **m, "score": score(m)} for c, m in ins]).sort_values("score", ascending=False)
    print("\n=== IN-SAMPLE 2020-23, ranked by CAGR/|MaxDD| ===")
    print(df.round(2).to_string(index=False), flush=True)
    top = [dict(zip(keys, r[keys])) for _, r in df.head(3).iterrows()]
    base = dict(exit_st=True, stop=12.0, st_mult=2.0, slots=10)
    picks = [base] + [t for t in top if t != base]
    jobs = [(c, w) for c in picks for w in (OOS, FULL)]
    with Pool(6) as p:
        outs = p.map(run, jobs)
    rows = []
    for (c, m), (_, w) in zip(outs, jobs):
        rows.append({**c, "window": "OOS" if w == OOS else "FULL", **m})
    print("\n=== top in-sample picks + baseline (first row), run on OOS and FULL ===")
    print(pd.DataFrame(rows).round(2).to_string(index=False))


if __name__ == "__main__":
    main()
