"""
Backtest of NSE's Nifty500 Momentum 50 selection rule (Methodology Document, Nov 2026, p. 210)
on the repo's Nifty-500 daily CSVs, benchmarked against Nifty 50 / Nifty 500.

Rule (price-only parts; pledge and circuit filters need data the repo does not have):
    eligible : >= 1y history, not in bottom 10 percentile of 6m average daily turnover
    MR_n     : n-month return (P[t-1m] / P[t-(n+1)m] - 1, i.e. skips the latest month) / annualised
               stdev of 1y daily log returns
    Z        : 0.5 * z(MR12) + 0.5 * z(MR6), z across the eligible universe
    score    : 1+Z if Z>=0 else 1/(1-Z)
    pick     : top N by score, rank buffer (existing members kept while rank <= buffer)
    weights  : equal, or score-proportional capped at 5% (free-float cap is not in the repo)

Execution: signal on the rebalance day's close, fill at the NEXT session's open, costs per side
(0.111% + slippage + Rs 20/order), same model as backtest_momentum_portfolio.py.
Survivorship: stock CSVs are today's Nifty 500 constituents, so every absolute number is flattered.

Usage:  venv/bin/python scripts/analysis/backtest_nse_momentum50.py
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)
from lib.momentum import load_benchmark, load_price_map, load_universe  # noqa: E402


def build_panels(start: str):
    syms = [u["symbol"] for u in load_universe("nifty500")]
    pm = load_price_map(syms, min_bars=300)
    cl = pd.DataFrame({s: d.set_index(pd.to_datetime(d["date"]))["close"] for s, d in pm.items()})
    op = pd.DataFrame({s: d.set_index(pd.to_datetime(d["date"]))["open"] for s, d in pm.items()})
    vo = pd.DataFrame({s: d.set_index(pd.to_datetime(d["date"]))["volume"] for s, d in pm.items()})
    cl, op, vo = (x.sort_index() for x in (cl, op, vo))
    cl = cl.ffill(limit=5)
    return cl, op.reindex(cl.index), vo.reindex(cl.index)


def scores_at(cl: pd.DataFrame, vo: pd.DataFrame, i: int) -> pd.Series:
    """NSE normalised momentum score as of row i (uses data up to and including i)."""
    idx = cl.index
    d = idx[i]

    def px_at(months_back: int) -> pd.Series:
        t = d - pd.DateOffset(months=months_back)
        j = idx.searchsorted(t, side="right") - 1
        return cl.iloc[j] if j >= 0 else pd.Series(np.nan, index=cl.columns)

    if idx.searchsorted(d - pd.DateOffset(months=13), side="right") - 1 < 0:
        return pd.Series(dtype=float)
    p1, p7, p13 = px_at(1), px_at(7), px_at(13)
    win = cl.iloc[max(0, i - 251): i + 1]
    ok = win.notna().sum() >= 240
    sig = np.log(win / win.shift()).std() * np.sqrt(252)
    turn = (cl * vo).iloc[max(0, i - 125): i + 1].mean()
    ok &= turn > turn.quantile(0.10)
    mr12 = (p1 / p13 - 1) / sig
    mr6 = (p1 / p7 - 1) / sig
    mr12, mr6 = mr12[ok].dropna(), mr6[ok].dropna()
    common = mr12.index.intersection(mr6.index)
    z = 0.5 * (mr12[common] - mr12[common].mean()) / mr12[common].std() \
        + 0.5 * (mr6[common] - mr6[common].mean()) / mr6[common].std()
    return pd.Series(np.where(z >= 0, 1 + z, 1 / (1 - z)), index=common)


def rebal_indices(idx: pd.DatetimeIndex, months: list[int], first: pd.Timestamp) -> list[int]:
    out = []
    for k in range(1, len(idx)):
        if idx[k].month != idx[k - 1].month and idx[k - 1].month in months and idx[k - 1] >= first:
            out.append(k - 1)
    return out


def run(cl, op, vo, months, n, buffer, weighting, first, cost_pct, fixed, capital, regime=None):
    idx = cl.index
    clv = cl.ffill()
    opv = op.where(op.notna(), clv)
    cash, hold = capital, {}          # symbol -> shares
    eq, turnover_total, n_orders = {}, 0.0, 0
    rebs = {i + 1: i for i in rebal_indices(idx, months, first)}   # fill row -> signal row
    start_row = min(rebs) if rebs else 0
    members: list[str] = []
    prev_on = True
    for k in range(start_row, len(idx)):
        on = True if regime is None else bool(regime.iloc[k - 1])   # decided on k-1 close, acts at k open
        if not on and hold:                                          # regime off: liquidate at the open
            px = opv.iloc[k]
            for s_ in list(hold):
                if pd.notna(px[s_]):
                    val = hold[s_] * px[s_]
                    cash += val - val * cost_pct / 100 - fixed
                    turnover_total += val; n_orders += 1
                    del hold[s_]
            members = []
        do_rebal = on and (k in rebs or not prev_on)
        sig = rebs.get(k, k - 1)
        prev_on = on
        if do_rebal:
            sc = scores_at(cl, vo, sig).sort_values(ascending=False)
            if len(sc):
                rank = {s: r for r, s in enumerate(sc.index)}
                keep = [s for s in members if s in rank and rank[s] < buffer]
                fresh = [s for s in sc.index if s not in keep]
                members = (keep + fresh)[:n]
                if weighting == "score":
                    w = sc[members] / sc[members].sum()
                    for _ in range(10):       # cap 5%, redistribute
                        w = w.clip(upper=0.05)
                        w = w / w.sum() if w.sum() < 0.999 and (w < 0.05).any() else w
                    w = w / w.sum()
                else:
                    w = pd.Series(1 / len(members), index=members)
                px = opv.iloc[k]
                total = cash + sum(sh * px[s] for s, sh in hold.items() if pd.notna(px[s]))
                target = {s: total * w[s] for s in members if pd.notna(px.get(s))}
                for s in list(hold):                      # sells first
                    if pd.isna(px[s]):
                        continue
                    p = px[s]
                    want = target.get(s, 0.0) / p if s in target else 0.0
                    delta = hold[s] - want
                    if delta > 1e-9:
                        val = delta * p
                        cash += val - val * cost_pct / 100 - fixed
                        turnover_total += val; n_orders += 1
                        hold[s] = want
                        if want <= 1e-9:
                            del hold[s]
                for s, tv in target.items():              # buys
                    p = px[s]
                    cur = hold.get(s, 0.0) * p
                    if tv - cur > 1.0:
                        val = min(tv - cur, max(cash - fixed, 0) / (1 + cost_pct / 100))
                        if val <= 0:
                            continue
                        cash -= val + val * cost_pct / 100 + fixed
                        hold[s] = hold.get(s, 0.0) + val / p
                        turnover_total += val; n_orders += 1
        row = clv.iloc[k]
        eq[idx[k]] = cash + sum(sh * row[s] for s, sh in hold.items() if pd.notna(row[s]))
    return pd.Series(eq), turnover_total, n_orders


def weekly_regime(bench: pd.Series, idx: pd.DatetimeIndex, sma: int = 200) -> pd.Series:
    """Nifty 50 > its 200d SMA, sampled at each week's last close, applied from the following week."""
    b = bench.reindex(idx).ffill()
    flag = (b > b.rolling(sma).mean()) & b.rolling(sma).mean().notna()
    per = idx.to_period("W")
    last = flag.groupby(per).last()                    # the week's closing signal
    prev = last.shift(1).fillna(False).astype(bool)    # known only from the NEXT week (no look-ahead)
    return pd.Series(prev.reindex(per).to_numpy(), index=idx)


def stats(eq: pd.Series, label: str, capital: float | None = None) -> dict:
    eq = eq.dropna()
    yrs = (eq.index[-1] - eq.index[0]).days / 365.25
    r = eq.pct_change().dropna()
    dd = (eq / eq.cummax() - 1).min() * 100
    return {"strategy": label, "CAGR%": round(((eq.iloc[-1] / eq.iloc[0]) ** (1 / yrs) - 1) * 100, 1),
            "MaxDD%": round(dd, 1), "Sharpe": round(r.mean() / r.std() * np.sqrt(252), 2),
            "Calmar": round(((eq.iloc[-1] / eq.iloc[0]) ** (1 / yrs) - 1) * 100 / abs(dd), 2),
            "Final": round(eq.iloc[-1] / eq.iloc[0], 2)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2020-03-01")
    ap.add_argument("--capital", type=float, default=1_000_000)
    ap.add_argument("--slippage", type=float, default=0.05)
    ap.add_argument("--csv", default=os.path.join(ROOT, "debug", "nse_momentum50_results.csv"))
    a = ap.parse_args()
    cl, op, vo = build_panels(a.start)
    print(f"universe {cl.shape[1]} stocks, {cl.index[0].date()} -> {cl.index[-1].date()}")
    cost = 0.111 + a.slippage
    first = pd.Timestamp(a.start)
    variants = {
        "NSE semi-annual EW":      dict(months=[5, 11], n=50, buffer=75, weighting="equal"),
        "NSE semi-annual score-wt": dict(months=[5, 11], n=50, buffer=75, weighting="score"),
        "NSE quarterly EW":        dict(months=[2, 5, 8, 11], n=50, buffer=75, weighting="equal"),
        "NSE monthly EW":          dict(months=list(range(1, 13)), n=50, buffer=75, weighting="equal"),
        "NSE monthly top20 EW":    dict(months=list(range(1, 13)), n=20, buffer=30, weighting="equal"),
    }
    rows, curves = [], {}
    n50 = load_benchmark("nifty50")
    reg = weekly_regime(n50.set_index(pd.to_datetime(n50["date"]))["close"], cl.index)
    print(f"regime ON {reg[reg.index >= first].mean():.0%} of days since {first.date()}")
    runs = [(nm, kw, None) for nm, kw in variants.items()] + \
           [(nm + " +regime", kw, reg) for nm, kw in variants.items()]
    for name, kw, rg in runs:
        eq, tv, no = run(cl, op, vo, first=first, cost_pct=cost, fixed=20.0, capital=a.capital,
                         regime=rg, **kw)
        curves[name] = eq
        s = stats(eq, name)
        yrs = (eq.index[-1] - eq.index[0]).days / 365.25
        s["Turnover x/yr"] = round(tv / a.capital / yrs, 1)
        s["Orders"] = no
        rows.append(s)
    start_ts = max(c.index[0] for c in curves.values())
    curves = {k: v[v.index >= start_ts] for k, v in curves.items()}
    for nm, key in (("Nifty 50 (buy&hold)", "nifty50"), ("Nifty 500 (buy&hold)", "nifty500")):
        b = load_benchmark(key)
        b = b.set_index(pd.to_datetime(b["date"]))["close"]
        b = b[b.index >= start_ts]
        rows.append(stats(b, nm))
        curves[nm] = b
    df = pd.DataFrame(rows)
    pd.set_option("display.width", 200)
    print("\n=== full window ===\n", df.to_string(index=False))
    # sub-periods: calendar halves of the common window
    mid = start_ts + (curves["NSE semi-annual EW"].index[-1] - start_ts) / 2
    for lbl, lo, hi in (("first half", start_ts, mid), ("second half", mid, None)):
        out = []
        for nm, c in curves.items():
            seg = c[(c.index >= lo) & ((c.index <= hi) if hi is not None else True)]
            out.append(stats(seg, nm))
        print(f"\n=== {lbl} ({lo.date()} -> {(hi or c.index[-1]).date()}) ===\n",
              pd.DataFrame(out).to_string(index=False))
    df.to_csv(a.csv, index=False)


if __name__ == "__main__":
    main()
