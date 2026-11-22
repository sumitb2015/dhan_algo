"""
Walk-forward check of the live momentum strategy's exit / entry settings.

Grid: rank-rotation sell limit x initial stop % x 2-close breakout confirmation, run through
backtest_momentum_portfolio.py (fixed slots, Nifty 500 benchmark). Each setting is ranked on a
TRAIN window by Calmar (CAGR / |max drawdown|), then reported on the TEST window that follows.

Splits (expanding train, fresh book at each test start):
    T0 2020-06-01..2023-08-27 -> V0 2023-08-28..end
    T2 2020-06-01..2024-05-31 -> V2 2024-06-03..end

Throttled on purpose: `nice -n 19`, one BLAS thread per run, 2 workers by default (72 runs, ~15-25 min).

Usage: venv/bin/python scripts/analysis/walk_forward_momentum_exits.py [workers]
Output: debug/walk_forward_momentum_exits.json + a ranked table on stdout.
"""
import collections
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPT = os.path.join(ROOT, "scripts", "analysis", "backtest_momentum_portfolio.py")
OUT = os.path.join(ROOT, "debug", "walk_forward_momentum_exits.json")
WIN = {"T0": ("2020-06-01", "2023-08-27"), "V0": ("2023-08-28", None),
       "T2": ("2020-06-01", "2024-05-31"), "V2": ("2024-06-03", None)}
SPLITS = (("T0", "V0"), ("T2", "V2"))
ROT, STOP, CONF = [25, 60, 9999], [12, 20, 25], [True, False]
ENV = {**os.environ, "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"}


def one(job):
    (rot, stop, conf), w = job
    start, end = WIN[w]
    cmd = ["nice", "-n", "19", sys.executable, SCRIPT, "--start", start, "--benchmark", "nifty500",
           "--no-excel", "--no-tearsheet", "--no-plot", "--sell-rank-limit", str(rot), "--stop", str(stop)]
    if end:
        cmd += ["--end", end]
    if not conf:
        cmd.append("--no-breakout-confirm")
    out = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT, env=ENV).stdout
    cagr = re.search(r"(?m)^  CAGR\s+(-?[\d.]+)%\s+(-?[\d.]+)%", out)
    dd = re.search(r"(?m)^  Max drawdown\s+(-?[\d.]+)%", out)
    tr = re.search(r"Trades\s*:\s*(\d+)", out)
    return {"cfg": f"rot>{rot} stop{stop} {'conf' if conf else 'noconf'}", "win": w,
            "cagr": float(cagr.group(1)), "bench": float(cagr.group(2)),
            "dd": float(dd.group(1)), "trades": int(tr.group(1))}


def main():
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    cfgs = [(r, s, c) for r in ROT for s in STOP for c in CONF]
    with ThreadPoolExecutor(workers) as ex:
        res = list(ex.map(one, [(c, w) for c in cfgs for w in WIN]))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(res, open(OUT, "w"), indent=1)
    d = collections.defaultdict(dict)
    for x in res:
        d[x["cfg"]][x["win"]] = x
    calmar = lambda x: x["cagr"] / abs(x["dd"]) if x["dd"] else 0
    for tr, te in SPLITS:
        print(f"\n== train {tr} -> test {te} (ranked by train Calmar)")
        for c, v in sorted(d.items(), key=lambda kv: -calmar(kv[1][tr])):
            print(f"{c:24} train {v[tr]['cagr']:6.1f}/{v[tr]['dd']:6.1f}  "
                  f"test {v[te]['cagr']:6.1f}/{v[te]['dd']:6.1f}  bench {v[te]['bench']:5.1f}  trades {v[te]['trades']}")


if __name__ == "__main__":
    main()
