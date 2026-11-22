"""
Ablation: which pieces of the live momentum strategy vs NSE's Momentum 50 explain the gap?

One slot-based engine, three switchable parts, everything else identical (Nifty 500 survivor
universe, regime = weekly Nifty 50 > 200 SMA with liquidation, signal at close -> fill at next
open, 0.111% + 0.05% slippage + Rs 20 per order):

    score   : "nse" (vol-adjusted 6/12m z-score, skip-month)  |  "rs" (live strategy's composite RS vs Nifty 500)
    stops   : -12% hard stop, breakeven at +15% peak, 25% trail from peak once +25%; 10-day cooldown
    entry   : live strategy's entry gate: Close>EMA20>EMA50>EMA200 and Close at a 55-day closing high
    size    : n names, equal slots (equity/n at entry; winners are not trimmed)

Simplifications vs the live strategy (so the "rs+stops+entry" row is an approximation of it, not a
replica): no sector cap, no 4:3 rank tilt, no 2-consecutive-review rotation, no 7-day min hold,
no volume filter, 1-close (not 2-close) breakout confirmation.

Usage: venv/bin/python scripts/analysis/backtest_momentum_ablation.py
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from backtest_nse_momentum50 import build_panels, scores_at, stats, weekly_regime  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)
from lib.momentum import load_benchmark  # noqa: E402

COST = 0.111 + 0.05
FIXED = 20.0
CAP = 1_000_000


def rs_scores_at(cl, i, idx500):
    """Live strategy composite RS vs Nifty 500: sum w * ((S/S_n)/(I/I_n) - 1)."""
    if i < 250:
        return pd.Series(dtype=float)
    cur = cl.iloc[i]
    tot = 0
    for n, w in ((10, .10), (21, .20), (63, .40), (126, .30)):
        tot = tot + w * ((cur / cl.iloc[i - n]) / (idx500.iloc[i] / idx500.iloc[i - n]) - 1)
    ok = (cl.iloc[i - 249: i + 1].notna().sum() >= 245) & (cur >= 50)
    ok &= (cl.iloc[i - 19: i + 1] * VOL.iloc[i - 19: i + 1]).mean() >= 5e7
    return tot[ok].dropna()


def review_rows(idx, kind, first):
    rows = []
    for k in range(1, len(idx)):
        if idx[k - 1] < first:
            continue
        if kind == "W" and idx[k].isocalendar()[1] != idx[k - 1].isocalendar()[1]:
            rows.append(k - 1)
        elif kind == "SA" and idx[k].month != idx[k - 1].month and idx[k - 1].month in (5, 11):
            rows.append(k - 1)
    return rows


def run(cl, op, score, n, entry_rank, buffer, reviews, stops, entry_gate, regime, ema, hi55, compound=True):
    idx = cl.index
    clv, opv = cl.ffill(), op.where(op.notna(), cl.ffill())
    cash, hold, meta, eq, orders, traded = CAP, {}, {}, {}, 0, 0.0
    rv = {r + 1: r for r in reviews}
    k0 = min(rv)
    cool: dict = {}
    stop_next: set = set()
    prev_on = True

    def sell(s, px):
        nonlocal cash, orders, traded
        val = hold.pop(s) * px
        cash += val - val * COST / 100 - FIXED
        orders += 1; traded += val
        meta.pop(s, None)

    for k in range(k0, len(idx)):
        on = bool(regime.iloc[k - 1])
        px = opv.iloc[k]
        if not on:
            for s in list(hold):
                if pd.notna(px[s]):
                    sell(s, px[s])
        for s in list(stop_next):
            if s in hold and pd.notna(px[s]):
                sell(s, px[s]); cool[s] = k
        stop_next.clear()
        if on and (k in rv or not prev_on):
            sig = rv.get(k, k - 1)
            sc = score(sig).sort_values(ascending=False)
            rank = {s: r for r, s in enumerate(sc.index)}
            for s in list(hold):                               # rank rotation
                if rank.get(s, 10**6) >= buffer and pd.notna(px[s]):
                    sell(s, px[s])
            total = cash + sum(sh * px[s] for s, sh in hold.items() if pd.notna(px[s]))
            slot = total / n if compound else CAP / n   # live strategy: fixed slot of INITIAL capital
            for s in sc.index[:entry_rank]:
                if len(hold) >= n:
                    break
                if s in hold or pd.isna(px[s]) or (s in cool and k - cool[s] < 10):
                    continue
                if entry_gate:
                    c = clv.iloc[sig][s]
                    if not (c > ema[20].iloc[sig][s] > ema[50].iloc[sig][s] > ema[200].iloc[sig][s]
                            and c >= hi55.iloc[sig][s]):
                        continue
                val = min(slot, max(cash - FIXED, 0) / (1 + COST / 100))
                if val < 1000:
                    continue
                cash -= val + val * COST / 100 + FIXED
                hold[s] = val / px[s]; orders += 1; traded += val
                meta[s] = {"entry": px[s], "peak": px[s], "stop": px[s] * 0.88}
        prev_on = on
        row = clv.iloc[k]
        if stops:
            for s in list(hold):
                m = meta[s]
                m["peak"] = max(m["peak"], row[s])
                g = m["peak"] / m["entry"] - 1
                if g >= .15:
                    m["stop"] = max(m["stop"], m["entry"])
                if g >= .25:
                    m["stop"] = max(m["stop"], m["peak"] * .75)
                if row[s] < m["stop"]:
                    stop_next.add(s)
        eq[idx[k]] = cash + sum(sh * row[s] for s, sh in hold.items() if pd.notna(row[s]))
    yrs = (idx[-1] - idx[k0]).days / 365.25
    return pd.Series(eq), traded / CAP / yrs, orders


def main():
    global VOL
    first = pd.Timestamp("2020-03-01")
    cl, op, VOL = build_panels("2020-03-01")
    n500 = load_benchmark("nifty500")
    i500 = n500.set_index(pd.to_datetime(n500["date"]))["close"].reindex(cl.index).ffill()
    n50 = load_benchmark("nifty50")
    reg = weekly_regime(n50.set_index(pd.to_datetime(n50["date"]))["close"], cl.index)
    clv = cl.ffill()
    ema = {p: clv.ewm(span=p, adjust=False).mean() for p in (20, 50, 200)}
    hi55 = clv.rolling(55).max()

    cache = {"nse": {}, "rs": {}}

    def nse(i):
        if i not in cache["nse"]:
            cache["nse"][i] = scores_at(cl, VOL, i)
        return cache["nse"][i]

    def rs(i):
        if i not in cache["rs"]:
            cache["rs"][i] = rs_scores_at(cl, i, i500)
        return cache["rs"][i]

    W, SA = review_rows(cl.index, "W", first), review_rows(cl.index, "SA", first)
    V = [  # label, score, n, entry_rank, buffer, reviews, stops, gate, compound
        ("A  NSE   top50 semi-annual            ", nse, 50, 50, 75, SA, False, False),
        ("B  RS    top50 semi-annual            ", rs, 50, 50, 75, SA, False, False),
        ("C  NSE   top10 weekly                 ", nse, 10, 20, 25, W, False, False),
        ("D  RS    top10 weekly                 ", rs, 10, 20, 25, W, False, False),
        ("E  NSE   top10 weekly + stops         ", nse, 10, 20, 25, W, True, False),
        ("F  RS    top10 weekly + stops         ", rs, 10, 20, 25, W, True, False),
        ("G  NSE   top10 weekly + stops + gate  ", nse, 10, 20, 25, W, True, True),
        ("H  RS    top10 weekly + stops + gate  ", rs, 10, 20, 25, W, True, True),
        ("H' same as H, FIXED slots (no compounding)", rs, 10, 20, 25, W, True, True, False),
        ("F' RS top10 + stops, FIXED slots           ", rs, 10, 20, 25, W, True, False, False),
        ("G' NSE top10 + stops + gate, FIXED slots   ", nse, 10, 20, 25, W, True, True, False),
    ]
    rows, curves = [], {}
    for lab, sf, n, er, buf, rvw, st, gate, *cp in V:
        eqs, tv, no = run(cl, op, sf, n, er, buf, rvw, st, gate, reg, ema, hi55, *(cp or [True]))
        curves[lab] = eqs
        s = stats(eqs, lab)
        s["Turnover x/yr"], s["Orders"] = round(tv, 1), no
        rows.append(s)
    t0 = max(c.index[0] for c in curves.values())
    b = n500.set_index(pd.to_datetime(n500["date"]))["close"]
    rows.append(stats(b[b.index >= t0], "Nifty 500 buy&hold"))
    pd.set_option("display.width", 200)
    print(f"window {t0.date()} -> {cl.index[-1].date()}, all rows regime-filtered\n")
    print(pd.DataFrame(rows).to_string(index=False))
    mid = t0 + (cl.index[-1] - t0) / 2
    for lbl, lo, hi in (("first half", t0, mid), ("second half", mid, None)):
        out = [stats(c[(c.index >= lo) & ((c.index <= hi) if hi is not None else True)], k)
               for k, c in curves.items()]
        print(f"\n=== {lbl} ===\n", pd.DataFrame(out)[["strategy", "CAGR%", "MaxDD%", "Sharpe"]].to_string(index=False))


if __name__ == "__main__":
    main()
