"""
Split-sample parameter search for the Scanner Top-N momentum model (simulate_momentum_replay.py --strategy scanner_top).

Tuned on IN-SAMPLE 2020-01-10..2023-12-29 only, ranked by Calmar (CAGR / |MaxDD|, configs with < 40 trades
excluded). The top 3 are then run ONCE on the held-out 2024-01-01..2026-11-20 window and on the full period, next
to the scanner defaults and to turtle_rs on the same windows. Nothing is chosen on the held-out window, and every
config tried is counted and printed.

Engine v2 (compounding, weekly rotation, data-gap rules), Nifty 500, Rs 5L, Nifty 50 weekly regime, delivery costs.
Replays go to a temp dir (the dashboard cache is untouched). Output: debug/scanner_top_sweep/results.md + CSVs.

    venv/bin/python scripts/analysis/optimise_scanner_top.py
"""
from __future__ import annotations

import itertools
import os
import sys
import tempfile
from datetime import date
from multiprocessing import Pool

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts", "analysis"))

OUT_DIR = os.path.join(ROOT, "debug", "scanner_top_sweep")
END = date(2026, 11, 20)
IS = ("tune 2020-23", date(2020, 1, 10), date(2023, 12, 29))
OOS = ("held-out 2024-26", date(2024, 1, 1), END)
FULL = ("full 2020-26", date(2020, 1, 10), END)
MIN_TRADES = 40
NO_CAP = 99                     # "sector cap off"

GRID = dict(
    n=[10, 15],
    sell_mult=[1, 2, 3, 0],      # sell buffer = mult x N; 0 means a fixed rank 60
    stop=[12.0, 20.0],
    sector_cap=[2, NO_CAP],
)


def sell_rank(c: dict) -> int:
    return 60 if c["sell_mult"] == 0 else c["sell_mult"] * c["n"]


def metrics(res: dict) -> dict:
    snaps = res["snapshots"]
    eq = pd.Series({pd.Timestamp(s["date"]): s["equity"] for s in snaps})
    trades = res["closed_trades"]
    yrs = max((eq.index[-1] - eq.index[0]).days / 365.25, 1e-9)
    start_eq = res["initial_capital"]
    cagr = ((eq.iloc[-1] / start_eq) ** (1 / yrs) - 1) * 100
    dd = ((eq / eq.cummax().clip(lower=start_eq)) - 1).min() * 100
    w = sum(t["pnl"] for t in trades if t["pnl"] > 0)
    l = -sum(t["pnl"] for t in trades if t["pnl"] < 0)
    holds = sorted(t["hold_days"] for t in trades)
    return dict(CAGR=cagr, MaxDD=dd, Calmar=cagr / abs(dd) if dd < 0 else np.nan,
                PF=(w / l if l > 0 else np.nan), Trades=len(trades),
                Win=(100 * sum(t["pnl"] > 0 for t in trades) / len(trades) if trades else np.nan),
                MedianHold=(holds[len(holds) // 2] if holds else np.nan))


def run(job):
    c, window = job
    import simulate_momentum_replay as sim
    from lib.momentum import MomentumConfig
    tmp = tempfile.TemporaryDirectory(prefix="scan_opt_")     # each replay JSON is large; drop it after the run
    sim.REPLAYS_DIR = tmp.name
    try:
        if c.get("model") == "turtle_rs":
            cfg = MomentumConfig(capital=500_000.0, slots=10, stop_pct=12.0)
            res = sim.run_replay_simulation(cfg, window[1], window[2], strategy="turtle_rs", force=True)
        else:
            cfg = MomentumConfig(capital=500_000.0, slots=c["n"], stop_pct=c["stop"], sector_cap=c["sector_cap"],
                                 regime_enabled=c.get("regime", True))
            res = sim.run_replay_simulation(cfg, window[1], window[2], strategy="scanner_top", force=True,
                                            sell_rank=sell_rank(c))
        return c, window[0], metrics(res)
    finally:
        tmp.cleanup()


def label(c: dict) -> str:
    if c.get("model") == "turtle_rs":
        return "turtle_rs (live default)"
    cap = "off" if c["sector_cap"] == NO_CAP else str(c["sector_cap"])
    reg = "" if c.get("regime", True) else ", no regime"
    return f"N={c['n']} sell>{sell_rank(c)} stop {c['stop']:g}% cap {cap}{reg}"


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    keys = list(GRID)
    cfgs = [dict(zip(keys, v)) for v in itertools.product(*GRID.values())]
    print(f"configs tried on the tune window: {len(cfgs)}", flush=True)
    with Pool(4) as p:
        tune = p.map(run, [(c, IS) for c in cfgs])
    tdf = pd.DataFrame([{"config": label(c), **c, **m} for c, _w, m in tune])
    tdf["rankable"] = tdf["Trades"] >= MIN_TRADES
    tdf = tdf.sort_values(["rankable", "Calmar"], ascending=[False, False])
    tdf.to_csv(os.path.join(OUT_DIR, "tune.csv"), index=False)
    print(tdf[["config", "CAGR", "MaxDD", "Calmar", "PF", "Trades", "MedianHold"]].round(2).to_string(index=False), flush=True)

    top = [dict(zip(keys, r[keys])) for _, r in tdf[tdf["rankable"]].head(3).iterrows()]
    default = dict(n=10, sell_mult=2, stop=12.0, sector_cap=2)
    picks = top + ([default] if default not in top else [])
    picks += [{**top[0], "regime": False}, {"model": "turtle_rs"}]
    jobs = [(c, w) for c in picks for w in (IS, OOS, FULL)]
    with Pool(4) as p:
        outs = p.map(run, jobs)
    rows = [{"config": label(c), "window": w, **m} for c, w, m in outs]
    odf = pd.DataFrame(rows)
    odf.to_csv(os.path.join(OUT_DIR, "picks.csv"), index=False)

    cols = ["config", "window", "CAGR", "MaxDD", "Calmar", "PF", "Trades", "Win", "MedianHold"]
    with open(os.path.join(OUT_DIR, "results.md"), "w", encoding="utf-8") as f:
        f.write("# Scanner Top-N split-sample sweep\n\n")
        f.write(f"{len(cfgs)} configs tuned on {IS[1]}..{IS[2]}, ranked by Calmar (>= {MIN_TRADES} trades). "
                f"Top 3, the default, the winner without the regime filter, and turtle_rs run on every window.\n\n")
        f.write("## Tune window, all configs\n\n")
        f.write(tdf[["config", "CAGR", "MaxDD", "Calmar", "PF", "Trades", "MedianHold"]].round(2).to_markdown(index=False))
        f.write("\n\n## Picks on every window\n\n")
        f.write(odf[cols].round(2).to_markdown(index=False))
        f.write("\n")
    print("\n" + odf[cols].round(2).to_string(index=False))
    print(f"\nWrote {OUT_DIR}/results.md")


if __name__ == "__main__":
    main()
