"""
Backtest: Vivek Bajaj "Relative Strength + Supertrend" (Learn2Trade session 19, aRPG0GAd2EI)
with the bharatTrader RS indicator and four fixed variants of it.

Video rules (stated loosely; the thresholds below are this script's choices):
    Enter when the stock's RS vs Nifty is positive and rising, Supertrend is bullish and price
    is above its moving average. Exit only when Supertrend turns bearish.

RS variants (all computed on daily closes, no look-ahead):
    raw        bharatTrader:  (S/S[N]) / (I/I[N]) - 1                      (N=123 by default)
    log        ln(S/S[N]) - ln(I/I[N])                    symmetric: +x and -x mean the same
    beta       ln(S/S[N]) - beta*ln(I/I[N])               beta = rolling 126d daily beta vs Nifty
    smooth     mean of log RS over 21/63/123, EMA(10)     no single-window cliff, no arbitrary N
    smooth_beta  smooth, but beta-adjusted                 all fixes together
    none       Supertrend + MA only, ranked by raw RS     baseline: does the RS filter add anything?

"Rising" = SMA(50) of the score has risen for 3 bars (bharatTrader's own `ta.rising(sma_res, 3)`).

Execution: signal at day D close, fill at D+1 open (entries and exits). Costs: 0.111% + Rs 20 per
order + 0.05% slippage per side. Slots: equal weight. Universe: today's Nifty 500 (survivorship bias).

Usage:
    venv/bin/python scripts/analysis/backtest_rs_improved.py
    venv/bin/python scripts/analysis/backtest_rs_improved.py --slots 10 --start 2020-01-01
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)

from lib.intraday_signals import supertrend  # noqa: E402
from lib.momentum import load_benchmark, load_price_map, load_universe  # noqa: E402


def build_panels(min_bars=300):
    bench = load_benchmark("nifty50")
    bench = bench.set_index(pd.to_datetime(bench["date"]))
    idx = bench.index
    uni = [u["symbol"] for u in load_universe("nifty500")]
    pm = load_price_map(uni, min_bars=min_bars)
    O, H, L, C, V, ST = {}, {}, {}, {}, {}, {}
    for sym, df in pm.items():
        d = df.copy()
        d.index = pd.to_datetime(d["date"])
        d = d[~d.index.duplicated(keep="last")]
        f = d.rename(columns={"open": "Open", "high": "High", "low": "Low", "close": "Close"})
        st = supertrend(f[["High", "Low", "Close"]].astype(float), 10, 2.0)["st_dir"]
        O[sym] = d["open"].reindex(idx)
        H[sym] = d["high"].reindex(idx)
        L[sym] = d["low"].reindex(idx)
        C[sym] = d["close"].reindex(idx)
        V[sym] = d["volume"].reindex(idx)
        ST[sym] = st.reindex(idx).ffill()
    P = {k: pd.DataFrame(v) for k, v in dict(O=O, H=H, L=L, C=C, V=V, ST=ST).items()}
    return bench["close"], P


def rs_scores(C, I, n=123):
    """Return dict name -> DataFrame score (dates x symbols)."""
    ratio = (C / C.shift(n)).div(I / I.shift(n), axis=0)
    raw = ratio - 1.0
    lc, li = np.log(C), np.log(I)  # li is a Series: always combine with axis=0
    logrs = (lc - lc.shift(n)).sub(li - li.shift(n), axis=0)

    r = C.pct_change(fill_method=None)
    ri = I.pct_change()
    cov = r.rolling(126, min_periods=100).cov(ri)
    var = ri.rolling(126, min_periods=100).var()
    beta = cov.div(var, axis=0).clip(0.2, 2.5)
    beta_rs = (lc - lc.shift(n)) - beta.mul((li - li.shift(n)), axis=0)

    def comp(adj):
        out = None
        for k in (21, 63, 123):
            a = lc - lc.shift(k)
            b = (li - li.shift(k))
            x = a.sub(beta.mul(b, axis=0)) if adj else a.sub(b, axis=0)
            out = x if out is None else out + x
        return (out / 3.0).ewm(span=10, adjust=False, min_periods=1).mean().where(out.notna())

    return {
        "raw": raw, "log": logrs, "beta": beta_rs,
        "smooth": comp(False), "smooth_beta": comp(True),
    }


def rising(score, ma=50, k=3):
    sma = score.rolling(ma, min_periods=ma).mean()
    return (sma > sma.shift(k)) & ((sma.diff(1) > 0).rolling(k).sum() == k)


def simulate(P, I, score, use_rs, start, end, slots, cap, fee_pct=0.00111, fixed=20.0, slip=0.0005,
             ma_len=50, min_value=2e7):
    C, O, ST = P["C"], P["O"], P["ST"]
    dates = C.index
    sma = C.rolling(ma_len, min_periods=ma_len).mean()
    value20 = (C * P["V"]).rolling(20, min_periods=10).median()
    if use_rs:
        entry = (score > 0) & rising(score) & (ST > 0) & (C > sma) & (value20 > min_value)
    else:
        entry = (ST > 0) & (C > sma) & (value20 > min_value)
    cols = list(C.columns)
    Cn, On, STn = C.to_numpy(), O.to_numpy(), ST.to_numpy()
    En, Sn = entry.fillna(False).to_numpy(dtype=bool), score.to_numpy(dtype=float)
    held = {}                # col idx -> [shares, entry_price, entry_date_i, cost_basis]
    cash = cap
    pending_exit, pending_entry = set(), []
    eq = []
    trades = []
    ti0 = int(np.searchsorted(dates, pd.Timestamp(start)))
    ti1 = len(dates) if end is None else int(np.searchsorted(dates, pd.Timestamp(end), side="right"))
    last_close = np.full(len(cols), np.nan)
    for t in range(ti0, ti1):
        # fills at today's open
        for j in sorted(pending_exit):
            if j not in held or np.isnan(On[t, j]):
                continue
            sh, ep, ei, basis = held.pop(j)
            px = On[t, j] * (1 - slip)
            proceeds = sh * px * (1 - fee_pct) - fixed
            cash += proceeds
            trades.append(dict(sym=cols[j], entry=dates[ei], exit=dates[t], ret=proceeds / basis - 1,
                               pnl=proceeds - basis, days=t - ei, open=False))
        pending_exit = set()
        free = slots - len(held)
        for j in pending_entry:
            if free <= 0 or j in held or np.isnan(On[t, j]):
                continue
            slot = min(cash, (cap / slots) * 1.0)
            if slot < 5000:
                continue
            px = On[t, j] * (1 + slip)
            sh = int((slot - fixed) / (px * (1 + fee_pct)))
            if sh < 1:
                continue
            basis = sh * px * (1 + fee_pct) + fixed
            cash -= basis
            held[j] = [sh, px, t, basis]
            free -= 1
        pending_entry = []
        # mark to market, then queue signals from today's close
        ok = ~np.isnan(Cn[t])
        last_close[ok] = Cn[t][ok]
        eq.append(cash + sum(v[0] * last_close[j] for j, v in held.items() if not np.isnan(last_close[j])))
        for j in held:
            if STn[t, j] < 0:
                pending_exit.add(j)
        free_after = slots - (len(held) - len(pending_exit))
        if free_after > 0 and t + 1 < ti1:
            cand = np.where(En[t] & ~np.isnan(Sn[t]))[0]
            cand = [j for j in cand if j not in held]
            cand.sort(key=lambda j: -Sn[t, j])
            pending_entry = cand[:free_after]
    # open positions marked at the end
    for j, (sh, ep, ei, basis) in held.items():
        px = last_close[j]
        if not np.isnan(px):
            trades.append(dict(sym=cols[j], entry=dates[ei], exit=None, ret=sh * px / basis - 1,
                               pnl=sh * px - basis, days=ti1 - 1 - ei, open=True))
    eqs = pd.Series(eq, index=dates[ti0:ti1])
    return eqs, pd.DataFrame(trades)


def metrics(eq, tr, bench_close):
    r = eq.pct_change().dropna()
    yrs = (eq.index[-1] - eq.index[0]).days / 365.25
    cagr = (eq.iloc[-1] / eq.iloc[0]) ** (1 / yrs) - 1
    dd = (eq / eq.cummax() - 1).min()
    sharpe = r.mean() / r.std() * np.sqrt(252) if r.std() > 0 else np.nan
    closed = tr[~tr["open"].astype(bool)]
    w = closed[closed.pnl > 0].pnl.sum()
    l = -closed[closed.pnl < 0].pnl.sum()
    return dict(CAGR=cagr * 100, MaxDD=dd * 100, Sharpe=sharpe, Trades=len(closed),
                Win=(closed.ret > 0).mean() * 100 if len(closed) else np.nan,
                PF=w / l if l > 0 else np.nan, AvgDays=closed.days.mean() if len(closed) else np.nan,
                Final=eq.iloc[-1] / eq.iloc[0])


def bench_metrics(bench_close, start, end):
    b = bench_close.loc[start:end]
    yrs = (b.index[-1] - b.index[0]).days / 365.25
    return dict(CAGR=((b.iloc[-1] / b.iloc[0]) ** (1 / yrs) - 1) * 100,
                MaxDD=(b / b.cummax() - 1).min() * 100)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2020-06-01")
    ap.add_argument("--end", default=None)
    ap.add_argument("--slots", type=int, default=10)
    ap.add_argument("--capital", type=float, default=1_000_000.0)
    ap.add_argument("--split", default="2024-01-01", help="in-sample / out-of-sample boundary")
    a = ap.parse_args()

    I, P = build_panels()
    print(f"universe loaded: {P['C'].shape[1]} symbols, {len(I)} sessions "
          f"{I.index[0].date()}..{I.index[-1].date()}")
    runs = {}
    for n in (55, 123, 252):
        s = rs_scores(P["C"], I, n)
        runs[f"raw N={n}"] = (s["raw"], True)
    s123 = rs_scores(P["C"], I, 123)
    runs["log N=123"] = (s123["log"], True)
    runs["beta N=123"] = (s123["beta"], True)
    runs["smooth 21/63/123"] = (s123["smooth"], True)
    runs["smooth+beta"] = (s123["smooth_beta"], True)
    runs["NO RS filter (rank raw123)"] = (s123["raw"], False)

    periods = {"FULL": (a.start, a.end), "IN-SAMPLE": (a.start, a.split), "OUT-OF-SAMPLE": (a.split, a.end)}
    for pname, (st, en) in periods.items():
        rows = {}
        for name, (score, use) in runs.items():
            eq, tr = simulate(P, I, score, use, st, en, a.slots, a.capital)
            if len(tr) == 0 or len(eq) < 50:
                continue
            rows[name] = metrics(eq, tr, I)
        df = pd.DataFrame(rows).T
        bm = bench_metrics(I, st, en or I.index[-1])
        print(f"\n=== {pname}  {st} -> {en or I.index[-1].date()}   NIFTY 50 buy&hold: "
              f"CAGR {bm['CAGR']:.1f}%  MaxDD {bm['MaxDD']:.1f}% ===")
        print(df.round(2).to_string())


if __name__ == "__main__":
    main()
