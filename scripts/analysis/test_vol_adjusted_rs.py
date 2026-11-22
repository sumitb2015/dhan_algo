"""
Does ranking by volatility-adjusted relative strength, or holding more names, improve the
Turtle RS Optimised strategy (rotation sells below rank 6*slots, 20% stop, 2-close breakout)?

Runs the REAL engine (backtest_momentum_portfolio.run_backtest, fixed slots as live) with the
ranking function swapped:
    rs      the live composite RS vs the benchmark (baseline)
    rs_vol  composite RS divided by 1-year annualised stdev of daily log returns
    nse     NSE Momentum 50 score: z(MR12) / z(MR6) of vol-adjusted returns skipping the latest
            month (trading-day offsets 21/147/273 stand in for calendar months)
and the slot count (10 / 15 / 20; buy-rank limit = 2*slots, sell-rank limit = 6*slots).

Survivor-biased universe, Nifty 50 benchmark/regime (matches the 15.5% figure on the dashboard).
Single process, one BLAS thread; run with `nice -n 19`.

Usage: nice -n 19 venv/bin/python scripts/analysis/test_vol_adjusted_rs.py
"""
import os
import sys
from dataclasses import replace
from datetime import date

import numpy as np

os.environ.setdefault("OMP_NUM_THREADS", "1")
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
import backtest_momentum_portfolio as bt  # noqa: E402
from lib.momentum import MomentumConfig, composite_rs, load_benchmark, load_price_map, load_universe  # noqa: E402

MODE = {"v": "rs"}


def _vol(arr: np.ndarray, i: int) -> float:
    w = arr[max(0, i - 251): i + 1]
    w = w[~np.isnan(w)]
    if len(w) < 120:
        return np.nan
    r = np.diff(np.log(w))
    return float(np.std(r, ddof=1) * np.sqrt(252))


def rank_universe(price_map, bench, as_of, cfg, matrix=None):
    m = matrix
    i = m.index_of.get(as_of)
    if i is None or i < 1:
        return []
    base = []
    for sym, arr in m.closes.items():
        if not m.has_bar[sym][i] or m.bar_counts[sym][i] < cfg.min_history_bars:
            continue
        base.append((sym, arr, composite_rs(arr[:i + 1], m.bench[:i + 1], cfg.rs_weights)))
    mode = MODE["v"]
    if mode == "rs":
        out = [(s, rs) for s, _, rs in base]
    elif mode == "rs_vol":
        out = []
        for s, arr, rs in base:
            v = _vol(arr, i)
            if v and v > 0 and not np.isnan(v):
                out.append((s, rs / v))
    else:  # nse
        rows = []
        for s, arr, _ in base:
            v = _vol(arr, i)
            if i < 273 or not v or np.isnan(v) or v <= 0:
                continue
            p1, p7, p13 = arr[i - 21], arr[i - 147], arr[i - 273]
            if not (p1 > 0 and p7 > 0 and p13 > 0):
                continue
            rows.append((s, (p1 / p13 - 1) / v, (p1 / p7 - 1) / v))
        if len(rows) < 30:
            return []
        a12 = np.array([r[1] for r in rows]); a6 = np.array([r[2] for r in rows])
        z = 0.5 * (a12 - a12.mean()) / a12.std() + 0.5 * (a6 - a6.mean()) / a6.std()
        out = [(r[0], 1 + zz if zz >= 0 else 1 / (1 - zz)) for r, zz in zip(rows, z)]
    out.sort(key=lambda x: x[1], reverse=True)
    return out


def main():
    bt.rank_universe = rank_universe
    universe = load_universe("nifty500")
    pm = load_price_map([u["symbol"] for u in universe], min_bars=250)
    bench = load_benchmark("nifty50")
    pre = (universe, pm, bench)
    base = MomentumConfig(universe="nifty500", capital=500_000.0, stop_pct=20.0)
    windows = [("2019-06 -> end", date(2019, 6, 1)), ("2023-08 -> end", date(2023, 8, 28))]
    print(f"{'score':8}{'slots':>6}{'window':>16}{'CAGR%':>8}{'MaxDD%':>8}{'Sharpe':>8}{'PF':>6}{'trades':>8}")
    for mode in ("rs", "rs_vol", "nse"):
        for slots in (10, 15, 20):
            MODE["v"] = mode
            cfg = replace(base, slots=slots, buy_rank_limit=2 * slots, sell_rank_limit=6 * slots)
            for lbl, start in windows:
                res = bt.run_backtest(cfg, start, verbose=False, preloaded=pre)
                s = res.stats
                print(f"{mode:8}{slots:>6}{lbl:>16}{s.get('cagr_pct', float('nan')):8.1f}"
                      f"{s.get('max_drawdown_pct', float('nan')):8.1f}{s.get('sharpe', float('nan')):8.2f}"
                      f"{s.get('profit_factor', float('nan')):6.2f}{s.get('trades', 0):8}", flush=True)


if __name__ == "__main__":
    main()
