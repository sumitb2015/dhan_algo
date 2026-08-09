"""
Backtest the simple daily swing-breakout rules (lib/swing_breakout.py).

Screen: N-day breakout + daily Supertrend + EMA stack + volume + relative strength.
Hold days-to-weeks; exit on a Supertrend flip or an ATR chandelier trail.

All rules come from lib/swing_breakout.py, which the live strategy will also import,
per the lib/momentum.py precedent — nothing is reimplemented here.

ROBUSTNESS IS PRINTED BY DEFAULT, NOT ON REQUEST.
Every run reports the drop-top-N curve and P&L concentration. The existing momentum
system looked strong on headline stats while 96% of its P&L came from 10 of 294 trades,
and dropping its top 3 put it below the index. Headline CAGR alone is not evidence.

Also note the universe is TODAY'S Nifty 500, so results carry survivorship bias.
Use --universe nifty50 for the cleanest available read (stable membership).

Usage:
    venv\\Scripts\\python.exe scripts/analysis/backtest_swing_breakout.py
    venv\\Scripts\\python.exe scripts/analysis/backtest_swing_breakout.py --universe nifty50
    venv\\Scripts\\python.exe scripts/analysis/backtest_swing_breakout.py --breakout-days 20 --st-mult 2.5
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from lib.momentum import load_benchmark, load_price_map, load_universe  # noqa: E402
from lib.swing_breakout import (  # noqa: E402
    SwingConfig, SwingPosition, benchmark_ret60, build_indicators, build_regime,
    concentration, drop_top_n_curve, exit_reason, initial_stop, position_size,
    screen, trail_stop,
)

DEBUG_DIR = os.path.join(ROOT, "debug")
SUMMARY = os.path.join(DEBUG_DIR, "swing_breakout_summary.json")


@dataclass
class Trade:
    symbol: str
    industry: str
    entry_date: date
    exit_date: date
    entry_price: float
    exit_price: float
    qty: int
    pnl: float
    pnl_pct: float
    costs: float
    exit_reason: str
    hold_days: int
    entry_strength: float


@dataclass
class Result:
    cfg: SwingConfig
    trades: List[Trade] = field(default_factory=list)
    equity: pd.Series = field(default_factory=pd.Series)
    start: Optional[date] = None
    end: Optional[date] = None
    symbols: int = 0
    screen_fails: Dict[str, int] = field(default_factory=dict)

    def df(self) -> pd.DataFrame:
        if not self.trades:
            return pd.DataFrame()
        return pd.DataFrame([t.__dict__ for t in self.trades])

    @property
    def years(self) -> float:
        if not self.start or not self.end:
            return 0.0
        return max((self.end - self.start).days / 365.25, 1e-9)


# ── Core ──────────────────────────────────────────────────────────────────────
def run_backtest(cfg: SwingConfig, start: Optional[date] = None,
                 end: Optional[date] = None, verbose: bool = True) -> Result:
    cfg.validate()

    universe = load_universe(cfg.universe)
    industry = {u["symbol"]: u.get("industry", "NA") for u in universe}
    symbols = [u["symbol"] for u in universe]
    if verbose:
        print(f"  Loading {len(symbols)} symbols ({cfg.universe})…")

    price_map = load_price_map(symbols, min_bars=cfg.min_history_bars)
    bench = load_benchmark()

    tables: Dict[str, pd.DataFrame] = {}
    for sym, df in price_map.items():
        ind = build_indicators(df, cfg)
        if ind is not None and len(ind):
            tables[sym] = ind
    if not tables:
        raise SystemExit("No symbols with enough history")

    regime = build_regime(bench, cfg)
    bret60 = benchmark_ret60(bench)

    all_days = sorted({d for t in tables.values() for d in t.index})
    if start:
        all_days = [d for d in all_days if d.date() >= start]
    if end:
        all_days = [d for d in all_days if d.date() <= end]
    if len(all_days) < 2:
        raise SystemExit("Not enough trading days in the window")

    res = Result(cfg=cfg, start=all_days[0].date(), end=all_days[-1].date(),
                 symbols=len(tables))

    cash = cfg.capital
    book: Dict[str, SwingPosition] = {}
    equity_pts: List[tuple] = []
    fails: Dict[str, int] = {}

    # Row lookup per symbol keyed by timestamp — dict hits, not pandas .loc, which
    # dominates runtime over 500 symbols x 1700 days.
    lut = {s: t.to_dict("index") for s, t in tables.items()}

    for i, ts in enumerate(all_days[:-1]):
        nxt = all_days[i + 1]
        today = ts.date()
        regime_on = bool(regime.get(ts, False))

        # ── 1. Exits, evaluated on today's bar, filled at tomorrow's open ────
        for sym in list(book):
            row = lut[sym].get(ts)
            if row is None:
                continue
            pos = book[sym]
            pos.stop = trail_stop(pos, row, cfg)
            held = (today - pos.entry_date).days
            why = exit_reason(pos, row, cfg, held, regime_on)
            if not why:
                continue

            nrow = lut[sym].get(nxt)
            if why == "STOP":
                # Fill at the stop, or at the next open when the bar gapped through
                # it. Assuming a clean stop fill overstates every trend system.
                nxt_open = float(nrow["Open"]) if nrow else pos.stop
                fill = min(pos.stop, nxt_open)
            else:
                fill = float(nrow["Open"]) if nrow else float(row["Close"])
            fill *= (1 - cfg.slippage_pct / 100)

            gross = (fill - pos.entry_price) * pos.qty
            costs = (pos.entry_price + fill) * pos.qty * (cfg.cost_pct / 100) / 2
            cash += fill * pos.qty
            res.trades.append(Trade(
                symbol=sym, industry=pos.industry, entry_date=pos.entry_date,
                exit_date=nxt.date(), entry_price=round(pos.entry_price, 2),
                exit_price=round(fill, 2), qty=pos.qty,
                pnl=round(gross - costs, 2),
                pnl_pct=round((fill / pos.entry_price - 1) * 100, 2),
                costs=round(costs, 2), exit_reason=why, hold_days=held,
                entry_strength=round(pos.entry_strength, 4)))
            del book[sym]

        # ── 2. Screen for entries ────────────────────────────────────────────
        if cfg.regime_enabled and not regime_on:
            candidates = []
        else:
            b60 = float(bret60.get(ts, 0.0) or 0.0)
            candidates = []
            for sym, rows in lut.items():
                if sym in book:
                    continue
                row = rows.get(ts)
                if row is None:
                    continue
                sr = screen(pd.Series(row), cfg, b60)
                if sr.passed:
                    candidates.append((sr.strength, sym, row))
                else:
                    for f in sr.reasons:
                        fails[f] = fails.get(f, 0) + 1
            candidates.sort(key=lambda x: (-x[0], x[1]))

        # ── 3. Enter, filled at tomorrow's open ──────────────────────────────
        opened = 0
        for strength, sym, row in candidates:
            if len(book) >= cfg.slots or opened >= cfg.max_new_per_day:
                break
            sec = industry.get(sym, "NA")
            if sum(1 for p in book.values() if p.industry == sec) >= cfg.sector_cap:
                continue
            nrow = lut[sym].get(nxt)
            if nrow is None:
                continue
            entry = float(nrow["Open"]) * (1 + cfg.slippage_pct / 100)
            atr_v = float(row.get("atr", np.nan))
            if not np.isfinite(entry) or entry <= 0 or not np.isfinite(atr_v) or atr_v <= 0:
                continue

            equity_now = cash + sum(p.notional() for p in book.values())
            qty = position_size(entry, equity_now, cfg)
            if qty <= 0 or qty * entry > cash:
                continue

            cash -= qty * entry
            book[sym] = SwingPosition(
                symbol=sym, industry=sec, qty=qty, entry_price=entry,
                entry_date=nxt.date(), stop=initial_stop(entry, atr_v, cfg),
                high_water=entry, entry_strength=strength)
            opened += 1

        # ── 4. Mark to market ────────────────────────────────────────────────
        mtm = cash
        for sym, pos in book.items():
            row = lut[sym].get(ts)
            mtm += (float(row["Close"]) if row else pos.entry_price) * pos.qty
        equity_pts.append((today, mtm))

    # Force-close whatever is still open at the final bar.
    last = all_days[-1]
    for sym, pos in list(book.items()):
        row = lut[sym].get(last)
        px = float(row["Close"]) if row else pos.entry_price
        gross = (px - pos.entry_price) * pos.qty
        costs = (pos.entry_price + px) * pos.qty * (cfg.cost_pct / 100) / 2
        cash += px * pos.qty
        res.trades.append(Trade(
            symbol=sym, industry=pos.industry, entry_date=pos.entry_date,
            exit_date=last.date(), entry_price=round(pos.entry_price, 2),
            exit_price=round(px, 2), qty=pos.qty, pnl=round(gross - costs, 2),
            pnl_pct=round((px / pos.entry_price - 1) * 100, 2), costs=round(costs, 2),
            exit_reason="OPEN_AT_END", hold_days=(last.date() - pos.entry_date).days,
            entry_strength=round(pos.entry_strength, 4)))

    res.equity = pd.Series(dict(equity_pts)).sort_index()
    res.screen_fails = dict(sorted(fails.items(), key=lambda kv: -kv[1]))
    return res


# ── Metrics / report ──────────────────────────────────────────────────────────
def bench_stats(cfg: SwingConfig, res: Result) -> dict:
    b = load_benchmark()
    b = b.set_index(pd.to_datetime(b["date"]))["close"].sort_index()
    b = b[(b.index.date >= res.start) & (b.index.date <= res.end)]
    if len(b) < 2:
        return {}
    cagr = ((b.iloc[-1] / b.iloc[0]) ** (1 / res.years) - 1) * 100
    dd = (b / b.cummax() - 1).min() * 100
    return {"cagr": round(cagr, 2), "max_dd": round(dd, 2)}


def metrics(res: Result) -> dict:
    df = res.df()
    cfg = res.cfg
    if df.empty:
        return {"trades": 0}
    eq = res.equity
    final = float(eq.iloc[-1]) if len(eq) else cfg.capital
    cagr = ((final / cfg.capital) ** (1 / res.years) - 1) * 100 if final > 0 else float("nan")
    dd = float((eq / eq.cummax() - 1).min() * 100) if len(eq) else 0.0
    rets = eq.pct_change().dropna() if len(eq) > 2 else pd.Series(dtype=float)
    sharpe = float(rets.mean() / rets.std() * np.sqrt(252)) if len(rets) > 10 and rets.std() else 0.0
    wins, losses = df[df.pnl > 0], df[df.pnl <= 0]
    gl = float(-losses.pnl.sum())
    return {
        "trades": len(df), "years": round(res.years, 2), "symbols": res.symbols,
        "final_equity": round(final, 0), "cagr_pct": round(cagr, 2),
        "max_dd_pct": round(dd, 2), "sharpe": round(sharpe, 2),
        "win_rate": round(len(wins) / len(df) * 100, 1),
        "profit_factor": round(float(wins.pnl.sum()) / gl, 2) if gl > 0 else float("inf"),
        "avg_win_pct": round(float(wins.pnl_pct.mean()) if len(wins) else 0, 2),
        "avg_loss_pct": round(float(losses.pnl_pct.mean()) if len(losses) else 0, 2),
        "avg_hold_days": round(float(df.hold_days.mean()), 1),
        "median_pnl": round(float(df.pnl.median()), 0),
        "costs": round(float(df.costs.sum()), 0),
        "net_pnl": round(float(df.pnl.sum()), 0),
        "top10_pct_of_pnl": round(concentration(df.pnl.tolist(), 10), 1),
    }


def print_report(res: Result) -> dict:
    m = metrics(res)
    bm = bench_stats(res.cfg, res)
    line = "=" * 78
    print(f"\n{line}\nSWING BREAKOUT (daily Supertrend + {res.cfg.breakout_days}d breakout)\n{line}")
    print(f"  {res.start} -> {res.end}  ({m.get('years', 0)} yrs, {m.get('symbols', 0)} symbols, "
          f"universe={res.cfg.universe})")
    print(line)
    if not m.get("trades"):
        print("  NO TRADES — the screen never passed. Top blocking gates:")
        for k, v in list(res.screen_fails.items())[:8]:
            print(f"    {k:<14} {v:,}")
        print(line)
        return m

    print(f"  CAGR            {m['cagr_pct']:>8.2f}%     benchmark {bm.get('cagr', float('nan')):>7.2f}%")
    print(f"  Max drawdown    {m['max_dd_pct']:>8.2f}%     benchmark {bm.get('max_dd', float('nan')):>7.2f}%")
    print(f"  Final equity    {m['final_equity']:>12,.0f}  from {res.cfg.capital:,.0f}")
    print(f"  Sharpe          {m['sharpe']:>8.2f}")
    print(f"  Trades          {m['trades']:>8}   win {m['win_rate']}%   PF {m['profit_factor']}")
    print(f"  Avg win / loss  {m['avg_win_pct']:>8.2f}% / {m['avg_loss_pct']:.2f}%   "
          f"hold {m['avg_hold_days']}d")
    print(f"  Median trade    {m['median_pnl']:>12,.0f}   costs {m['costs']:,.0f}")

    print(f"\n  ROBUSTNESS — is this a strategy or a few lucky trades?")
    curve = drop_top_n_curve(res.df().pnl.tolist(), res.cfg.capital, res.years)
    for _, r in curve.iterrows():
        flag = ""
        if bm.get("cagr") is not None and r["cagr_pct"] < bm.get("cagr", 0):
            flag = "  <-- below benchmark"
        print(f"    drop top {int(r['dropped']):>2} winners -> CAGR {r['cagr_pct']:>7.2f}%{flag}")
    conc = m.get("top10_pct_of_pnl")
    if conc is None or not np.isfinite(conc):
        print("    (concentration not meaningful — total P&L is negative)")
    else:
        print(f"    top 10 trades = {conc}% of all P&L")
        if conc > 80:
            print("    WARNING: P&L is concentrated in a handful of trades — wide error bars.")

    df = res.df()
    print(f"\n  Exit reasons:")
    for r_, g in df.groupby("exit_reason"):
        print(f"    {r_:<14} {len(g):>4}  net {g.pnl.sum():>12,.0f}  avg {g.pnl_pct.mean():>7.2f}%")

    print(f"\n  Top / bottom symbols:")
    per = df.groupby("symbol").agg(n=("pnl", "size"), net=("pnl", "sum")).sort_values("net", ascending=False)
    for _, (sym, r_) in enumerate(pd.concat([per.head(5), per.tail(5)]).iterrows()):
        print(f"    {sym:<12} {int(r_['n']):>3} trades  net {r_['net']:>12,.0f}")

    print(f"\n  NOTE: universe is TODAY'S {res.cfg.universe} list — survivorship bias.")
    print(f"        Treat CAGR as an upper bound. --universe nifty50 is the cleanest read.")
    print(line)
    return m


def main():
    p = argparse.ArgumentParser(description="Backtest daily swing-breakout rules.")
    p.add_argument("--universe", choices=["nifty500", "nifty50"], default="nifty500")
    p.add_argument("--start"); p.add_argument("--end")
    p.add_argument("--breakout-days", type=int)
    p.add_argument("--st-period", type=int); p.add_argument("--st-mult", type=float)
    p.add_argument("--slots", type=int); p.add_argument("--sector-cap", type=int)
    p.add_argument("--atr-stop-mult", type=float); p.add_argument("--trail-atr-mult", type=float)
    p.add_argument("--vol-mult", type=float); p.add_argument("--adx-min", type=float)
    p.add_argument("--capital", type=float)
    p.add_argument("--no-regime", action="store_true")
    p.add_argument("--regime-exit", action="store_true")
    p.add_argument("--no-ema-stack", action="store_true")
    p.add_argument("--no-volume", action="store_true")
    p.add_argument("--no-supertrend", action="store_true")
    p.add_argument("--no-st-exit", action="store_true")
    p.add_argument("--atr-trail", action="store_true",
                   help="Re-enable the ATR chandelier trail (measured harmful)")
    p.add_argument("--max-hold-days", type=int)
    args = p.parse_args()

    cfg = SwingConfig(universe=args.universe)
    for a, f in (("breakout_days", "breakout_days"), ("st_period", "st_period"),
                 ("st_mult", "st_multiplier"), ("slots", "slots"),
                 ("sector_cap", "sector_cap"), ("atr_stop_mult", "atr_stop_mult"),
                 ("trail_atr_mult", "trail_atr_mult"), ("vol_mult", "vol_mult"),
                 ("adx_min", "adx_min"), ("capital", "capital"),
                 ("max_hold_days", "max_hold_days")):
        v = getattr(args, a, None)
        if v is not None:
            setattr(cfg, f, v)
    if args.no_regime:      cfg.regime_enabled = False
    if args.regime_exit:    cfg.regime_exit = True
    if args.no_ema_stack:   cfg.require_ema_stack = False
    if args.no_volume:      cfg.require_volume = False
    if args.no_supertrend:  cfg.require_supertrend = False
    if args.no_st_exit:     cfg.exit_on_st_flip = False
    if args.atr_trail:      cfg.atr_trail_enabled = True

    start = datetime.strptime(args.start, "%Y-%m-%d").date() if args.start else None
    end = datetime.strptime(args.end, "%Y-%m-%d").date() if args.end else None

    res = run_backtest(cfg, start, end)
    m = print_report(res)

    os.makedirs(DEBUG_DIR, exist_ok=True)
    with open(SUMMARY, "w") as f:
        json.dump({"generated_at": datetime.now().isoformat(), "config": cfg.to_dict(),
                   "metrics": m, "benchmark": bench_stats(cfg, res),
                   "screen_fails": res.screen_fails,
                   "caveat": "Universe is today's constituent list — survivorship bias."},
                  f, indent=2, default=str)
    print(f"  summary -> {os.path.relpath(SUMMARY, ROOT)}")


if __name__ == "__main__":
    main()
