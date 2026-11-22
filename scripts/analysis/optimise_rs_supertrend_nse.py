"""
Can ideas from NSE's Momentum 50 methodology improve the RS + Supertrend (Vivek Bajaj) model?

Runs the real replay engine (simulate_momentum_replay, strategy rs_supertrend: regime on, next-open fills, costs,
sector cap 2, fixed slots as live) with ONE change at a time from the current default (stop-only exit, 12% stop,
10 slots). Protocol matches optimise_rs_supertrend.py: tune on IN-SAMPLE 2020-01..2023-12, then look at
OUT-OF-SAMPLE 2024-01..2026-11. Nothing is chosen on OOS; phase 2 runs the combination of the knobs that helped
in-sample, on OOS and FULL.

Knobs (all from the NSE Nifty500 Momentum 50 rule, adapted):
    order   how qualifiers are picked when more qualify than there are free slots:
            rs (composite RS rank, default) | rsvol (RS / 1y volatility) | nse (NSE normalised momentum score)
    gate    extra entry requirement: NSE score >= 1.0 (z >= 0, i.e. above-average vol-adjusted 6/12m momentum)
    turn    minimum 20-day traded value (rupees); NSE drops the least-liquid decile
    slots   10 / 15 / 20 names
    rankexit  exit when the stock's composite-RS rank falls beyond R (NSE's rank-buffer idea; default off)
    n       RS lookback (123 default, 252 tested in an earlier study)

NSE score here uses trading-day offsets 21/147/273 for the skip-month 6m/12m returns, divided by 1y annualised
volatility, z-scored across the day's ranked universe, then 1+Z (Z>=0) or 1/(1-Z). Price-only: no pledge, circuit
or free-float data exists in the repo. Survivor-biased universe.

Throttled: 2 workers, nice 19, one BLAS thread each.
    venv/bin/python scripts/analysis/optimise_rs_supertrend_nse.py
"""
from __future__ import annotations

import os
import sys
import tempfile
from datetime import date
from multiprocessing import Pool

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts", "analysis"))

END = date(2026, 11, 20)
IS = (date(2020, 1, 1), date(2023, 12, 31))
OOS = (date(2024, 1, 1), END)
FULL = (date(2020, 1, 1), END)

BASE = dict(order="rs", gate=False, turn=2e7, slots=10, rankexit=None, n=123)
VARIANTS = [
    ("baseline", {}),
    ("order: RS / volatility", dict(order="rsvol")),
    ("order: NSE score", dict(order="nse")),
    ("gate: NSE score >= 1", dict(gate=True)),
    ("liquidity Rs 5 cr", dict(turn=5e7)),
    ("liquidity Rs 10 cr", dict(turn=1e8)),
    ("slots 15", dict(slots=15)),
    ("slots 20", dict(slots=20)),
    ("rank-exit beyond 50", dict(rankexit=50)),
    ("rank-exit beyond 100", dict(rankexit=100)),
    ("RS lookback 252", dict(n=252)),
]


def _vol(arr: np.ndarray, i: int) -> float:
    w = arr[max(0, i - 251): i + 1]
    w = w[~np.isnan(w)]
    if len(w) < 120:
        return np.nan
    return float(np.std(np.diff(np.log(w)), ddof=1) * np.sqrt(252))


def nse_scores(matrix, d, syms):
    """{symbol: normalised momentum score} for the symbols with enough history."""
    i = matrix.index_of.get(d)
    if i is None or i < 273:
        return {}
    rows = []
    for s in syms:
        arr = matrix.closes[s]
        v = _vol(arr, i)
        if not v or np.isnan(v) or v <= 0:
            continue
        p1, p7, p13 = arr[i - 21], arr[i - 147], arr[i - 273]
        if not (p1 > 0 and p7 > 0 and p13 > 0):
            continue
        rows.append((s, (p1 / p13 - 1) / v, (p1 / p7 - 1) / v))
    if len(rows) < 30:
        return {}
    a12 = np.array([r[1] for r in rows]); a6 = np.array([r[2] for r in rows])
    z = 0.5 * (a12 - a12.mean()) / a12.std() + 0.5 * (a6 - a6.mean()) / a6.std()
    return {r[0]: (1 + zz if zz >= 0 else 1 / (1 - zz)) for r, zz in zip(rows, z)}


def _init():
    os.nice(19)


def run(job):
    cfgd, window = job
    import simulate_momentum_replay as sim
    from backtest_rs_supertrend_ablation import metrics
    from lib import rs_supertrend as rst
    from lib.momentum import MomentumConfig

    tmp = tempfile.TemporaryDirectory(prefix="rs_nse_")
    sim.REPLAYS_DIR = tmp.name
    rst.MIN_TURNOVER20 = cfgd["turn"]
    rst.RS_LOOKBACK = cfgd["n"]
    rst.EXIT_ON_SUPERTREND = False

    state = {"nse": {}, "last_rank": {}}
    orig_rank = sim.rank_universe

    def ranked(price_map, bench, d, cfg, matrix=None):
        base = orig_rank(price_map, bench, d, cfg, matrix=matrix)
        if not base:
            return base
        syms = [s for s, _ in base]
        sc = nse_scores(matrix, d, syms) if matrix is not None else {}
        state["nse"][d] = sc
        out = base
        if cfgd["order"] == "rsvol":
            i = matrix.index_of.get(d)
            tmp_l = []
            for s, rs in base:
                v = _vol(matrix.closes[s], i)
                tmp_l.append((s, rs / v if v and not np.isnan(v) and v > 0 else -9.0))
            out = sorted(tmp_l, key=lambda x: x[1], reverse=True)
        elif cfgd["order"] == "nse":
            out = sorted(((s, sc.get(s, -9.0)) for s, _ in base), key=lambda x: x[1], reverse=True)
        state["last_rank"] = {s: r + 1 for r, (s, _) in enumerate(base)}   # exit rank is always composite RS
        return out

    sim.rank_universe = ranked

    orig_entry = rst.entry_check

    def entry(sym, tables, d, rs_pct=None):
        ok, why = orig_entry(sym, tables, d, rs_pct)
        if ok and cfgd["gate"]:
            if state["nse"].get(d, {}).get(sym, 0.0) < 1.0:
                return False, "NSE score < 1"
        return ok, why

    rst.entry_check = entry

    orig_exit = rst.exit_check

    def exit_(pos, close, tables, d, stop_pct=rst.DEFAULT_STOP_PCT):
        r = orig_exit(pos, close, tables, d, stop_pct=stop_pct)
        if r is None and cfgd["rankexit"]:
            rk = state["last_rank"].get(pos.symbol)
            if rk is not None and rk > cfgd["rankexit"]:
                return "rank decay"
        return r

    rst.exit_check = exit_

    cfg = MomentumConfig(universe="nifty500", capital=500_000.0, slots=cfgd["slots"], regime_enabled=True,
                         stop_pct=12.0, breakout_days=55)
    try:
        res = sim.run_replay_simulation(cfg, window[0], window[1], strategy="rs_supertrend", force=True)
        out = metrics(res, *window)
        from collections import Counter
        out["exits"] = dict(Counter(t["exit_reason"] for t in res["snapshots"][-1].get("closed_trades", [])))
    finally:
        tmp.cleanup()
    return cfgd, out


def fmt(rows):
    df = pd.DataFrame(rows)
    return df.round(2).to_string(index=False)


def main():
    jobs = [({**BASE, **o}, w) for _, o in VARIANTS for w in (IS, OOS)]
    print(f"phase 1: {len(VARIANTS)} variants x 2 windows = {len(jobs)} runs (2 workers, nice 19)", flush=True)
    with Pool(2, initializer=_init) as p:
        res = p.map(run, jobs, chunksize=1)
    rows = []
    for (name, _), k in zip(VARIANTS, range(0, len(res), 2)):
        i_m, o_m = res[k][1], res[k + 1][1]
        rows.append({"variant": name,
                     "IS CAGR": i_m["CAGR"], "IS DD": i_m["MaxDD"], "IS PF": i_m["PF"], "IS trades": i_m["Trades"],
                     "OOS CAGR": o_m["CAGR"], "OOS DD": o_m["MaxDD"], "OOS PF": o_m["PF"], "OOS trades": o_m["Trades"]})
    print(fmt(rows), flush=True)

    # phase 2: combine knobs that beat baseline IN-SAMPLE on both CAGR and CAGR/|DD|
    b = rows[0]
    good = {}
    for (name, o), r in zip(VARIANTS[1:], rows[1:]):
        if r["IS CAGR"] > b["IS CAGR"] and r["IS CAGR"] / abs(r["IS DD"]) >= b["IS CAGR"] / abs(b["IS DD"]):
            good.update(o)
    print(f"\nknobs that beat baseline in-sample (CAGR and CAGR/DD): {good or 'none'}", flush=True)
    if good:
        combo = {**BASE, **good}
        with Pool(2, initializer=_init) as p:
            outs = p.map(run, [(combo, OOS), (combo, FULL), (BASE, FULL)], chunksize=1)
        print("\n=== combination vs baseline ===")
        print(fmt([{"cfg": "combination", "window": "OOS", **outs[0][1]},
                   {"cfg": "combination", "window": "FULL", **outs[1][1]},
                   {"cfg": "baseline", "window": "FULL", **outs[2][1]}]), flush=True)


if __name__ == "__main__":
    main()
