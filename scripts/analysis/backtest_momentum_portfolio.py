"""
Backtest for the Nifty 500 momentum investing portfolio.

Every rule lives in lib/momentum.py — this file only supplies the event loop, the
accounting and the reporting. That separation is the point: the live strategy imports the
same module, so what is validated here is what trades.

Execution model (no look-ahead anywhere):
    Signals are generated from day D's CLOSE and filled at day D+1's OPEN. That applies to
    stops too — an end-of-day system cannot fill at its stop price intraday, so exits take
    the next open, whatever it is. Gap risk is therefore real in these numbers, unlike the
    older backtest_nifty50_rs_v*.py scripts which fill stops at the stop price.

Costs: the Indian delivery-equity model from the DhanHQ skill's backtests — 0.111% statutory
per side + Rs 20 per order + 0.05% slippage, charged on both entry and exit. The older
backtest_nifty50_rs_v*.py scripts model zero cost, which flatters a weekly-turnover system.
The fixed Rs 20 leg is not a rounding error here: on a Rs 15,000 slot it is another 0.13%
per side.

Usage:
    venv\\Scripts\\python.exe scripts/analysis/backtest_momentum_portfolio.py
    venv\\Scripts\\python.exe scripts/analysis/backtest_momentum_portfolio.py --universe nifty50 --start 2025-01-01
    venv\\Scripts\\python.exe scripts/analysis/backtest_momentum_portfolio.py --sweep
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from dataclasses import replace
from datetime import date, datetime
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from lib.momentum import (  # noqa: E402
    MomentumConfig, Position,
    build_regime_weekly, build_rs_matrix, build_tables,
    load_benchmark, load_price_map, load_universe,
    rank_rotation_exits, rank_universe, ranks_by_symbol, select_candidates, size_position,
)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEBUG_DIR = os.path.join(ROOT, "debug")


# ──────────────────────────────────────────────────────────────────────────────
# Result container
# ──────────────────────────────────────────────────────────────────────────────

class BacktestResult:
    def __init__(self, cfg: MomentumConfig, trades: List[dict], equity: pd.DataFrame,
                 open_positions: List[dict], bench: pd.DataFrame):
        self.cfg = cfg
        self.trades = pd.DataFrame(trades)
        self.equity = equity
        self.open_positions = pd.DataFrame(open_positions)
        self.bench = bench
        self.stats = self._compute_stats()

    def _compute_stats(self) -> dict:
        eq = self.equity
        if eq.empty:
            return {}
        start_val, end_val = float(eq["equity"].iloc[0]), float(eq["equity"].iloc[-1])
        years = max((eq["date"].iloc[-1] - eq["date"].iloc[0]).days / 365.25, 1e-9)

        curve = eq["equity"].to_numpy(dtype=float)
        peak = np.maximum.accumulate(curve)
        drawdown = (curve - peak) / peak
        max_dd = float(drawdown.min() * 100.0)

        daily_ret = eq["equity"].pct_change().dropna()
        sharpe = float(daily_ret.mean() / daily_ret.std() * np.sqrt(252)) if daily_ret.std() else 0.0
        downside = daily_ret[daily_ret < 0]
        sortino = float(daily_ret.mean() / downside.std() * np.sqrt(252)) if len(downside) and downside.std() else 0.0

        # Benchmark over the identical window, for an honest comparison.
        b = self.bench[(self.bench["date"] >= eq["date"].iloc[0]) &
                       (self.bench["date"] <= eq["date"].iloc[-1])]
        bench_ret = (float(b["close"].iloc[-1]) / float(b["close"].iloc[0]) - 1.0) * 100.0 if len(b) > 1 else 0.0
        bench_cagr = ((float(b["close"].iloc[-1]) / float(b["close"].iloc[0])) ** (1 / years) - 1) * 100.0 if len(b) > 1 else 0.0
        bcurve = b["close"].to_numpy(dtype=float)
        bench_dd = float(((bcurve - np.maximum.accumulate(bcurve)) / np.maximum.accumulate(bcurve)).min() * 100.0) if len(b) > 1 else 0.0

        t = self.trades
        wins = t[t["pnl"] > 0] if not t.empty else pd.DataFrame()
        losses = t[t["pnl"] <= 0] if not t.empty else pd.DataFrame()
        gross_win = float(wins["pnl"].sum()) if not wins.empty else 0.0
        gross_loss = abs(float(losses["pnl"].sum())) if not losses.empty else 0.0

        return {
            "start": eq["date"].iloc[0],
            "end": eq["date"].iloc[-1],
            "years": years,
            "start_equity": start_val,
            "end_equity": end_val,
            "total_return_pct": (end_val / start_val - 1.0) * 100.0,
            "cagr_pct": ((end_val / start_val) ** (1 / years) - 1.0) * 100.0,
            "max_drawdown_pct": max_dd,
            "sharpe": sharpe,
            "sortino": sortino,
            "calmar": ((end_val / start_val) ** (1 / years) - 1.0) * 100.0 / abs(max_dd) if max_dd else 0.0,
            "bench_return_pct": bench_ret,
            "bench_cagr_pct": bench_cagr,
            "bench_max_drawdown_pct": bench_dd,
            "trades": int(len(t)),
            "win_rate_pct": float(len(wins) / len(t) * 100.0) if len(t) else 0.0,
            "avg_win_pct": float(wins["pnl_pct"].mean()) if not wins.empty else 0.0,
            "avg_loss_pct": float(losses["pnl_pct"].mean()) if not losses.empty else 0.0,
            "profit_factor": gross_win / gross_loss if gross_loss else float("inf"),
            "avg_hold_days": float(t["hold_days"].mean()) if not t.empty else 0.0,
            "total_costs": float(t["cost"].sum()) if not t.empty else 0.0,
            "realized_pnl": float(t["pnl"].sum()) if not t.empty else 0.0,
            "open_positions": int(len(self.open_positions)),
            "exit_breakdown": t["exit_reason"].value_counts().to_dict() if not t.empty else {},
        }


# ──────────────────────────────────────────────────────────────────────────────
# The event loop
# ──────────────────────────────────────────────────────────────────────────────

def run_backtest(cfg: MomentumConfig, start: date, end: Optional[date] = None,
                 verbose: bool = True, preloaded: Optional[tuple] = None) -> BacktestResult:
    cfg.validate()

    if preloaded is not None:
        universe, price_map, bench = preloaded
    else:
        universe = load_universe(cfg.universe)
        symbols = [u["symbol"] for u in universe]
        bench = load_benchmark()
        price_map = load_price_map(symbols, min_bars=cfg.min_history_bars)

    industries = {u["symbol"]: u["industry"] for u in universe}
    tables = build_tables(price_map, cfg)
    calendar = build_regime_weekly(bench, cfg)
    # Built once and reused on every review day: rank_universe would otherwise rebuild the
    # benchmark-aligned close matrix ~370 times over a 7-year run.
    rs_matrix = build_rs_matrix(price_map, bench)

    end = end or calendar.trading_days[-1]
    days = [d for d in calendar.trading_days if start <= d <= end]
    if not days:
        raise ValueError(f"No trading days between {start} and {end}")

    if verbose:
        print(f"  Universe      : {cfg.universe} — {len(price_map)}/{len(universe)} symbols with data")
        print(f"  Window        : {days[0]} to {days[-1]} ({len(days)} trading days)")

    portfolio: Dict[str, Position] = {}
    cash = cfg.capital
    trades: List[dict] = []
    cooldowns: Dict[str, date] = {}
    equity_rows: List[dict] = []
    pending_buys: List[dict] = []
    pending_sells: List[Tuple[str, str]] = []
    entry_costs: Dict[str, float] = {}     # cost paid to open, charged again at exit

    def bar(sym: str, d: date):
        t = tables.get(sym)
        return t["px"].get(d) if t else None

    for d in days:
        # ── 1. fill yesterday's orders at today's open ────────────────────────
        for sym, reason in pending_sells:
            pos = portfolio.get(sym)
            row = bar(sym, d)
            if pos is None:
                continue
            # No bar today (halt/suspension): carry the order to the next session.
            if row is None:
                continue
            fill = float(row.open)
            proceeds = fill * pos.qty
            cost = cfg.trade_cost(proceeds)
            cash += proceeds - cost
            entry_cost = entry_costs.pop(sym, 0.0)
            pnl = (fill - pos.entry_price) * pos.qty - cost - entry_cost
            trades.append({
                "symbol": sym, "industry": pos.industry,
                "entry_date": pos.entry_date, "exit_date": d,
                "entry_price": pos.entry_price, "exit_price": fill,
                "qty": pos.qty, "invested": pos.invested,
                "pnl": pnl, "pnl_pct": pnl / pos.invested * 100.0 if pos.invested else 0.0,
                "cost": cost + entry_cost,
                "exit_reason": reason, "rank_at_entry": pos.rank_at_entry,
                "hold_days": (d - pos.entry_date).days,
                "peak_gain_pct": (pos.peak_close / pos.entry_price - 1.0) * 100.0,
            })
            if reason == "stop":
                cooldowns[sym] = d + pd.Timedelta(days=cfg.cooldown_days).to_pytimedelta()
            del portfolio[sym]
        pending_sells = [(s, r) for s, r in pending_sells if s in portfolio]

        for order in pending_buys:
            sym = order["symbol"]
            row = bar(sym, d)
            if row is None or sym in portfolio:
                continue
            fill = float(row.open)
            # Size against cash net of the costs the buy itself will incur, or a slot sized
            # to the last rupee would be rejected below for being a few rupees short.
            spendable = (cash - cfg.fixed_fee) / (1.0 + (cfg.fee_pct + cfg.slippage_pct) / 100.0)
            qty = size_position(fill, order["rank"], cfg, max(spendable, 0.0))
            if qty <= 0:
                continue
            spend = fill * qty
            cost = cfg.trade_cost(spend)
            if spend + cost > cash:
                continue
            cash -= spend + cost
            entry_costs[sym] = cost
            portfolio[sym] = Position(sym, d, fill, qty, cfg,
                                      rank_at_entry=order["rank"],
                                      industry=order.get("industry", ""))
        pending_buys = []

        # ── 2. mark to market on today's close ────────────────────────────────
        holdings_value = 0.0
        closes: Dict[str, float] = {}
        for sym, pos in portfolio.items():
            row = bar(sym, d)
            close = float(row.close) if row is not None else pos.last_close
            closes[sym] = close
            holdings_value += close * pos.qty
        equity_rows.append({"date": d, "equity": cash + holdings_value,
                            "cash": cash, "holdings": holdings_value,
                            "positions": len(portfolio),
                            "regime": calendar.is_on(d)})

        # ── 3. generate signals from today's close, for tomorrow's open ───────
        queued = {s for s, _ in pending_sells}
        for sym, pos in portfolio.items():
            if sym in queued:
                continue
            reason = pos.update(closes[sym], cfg)
            if reason:
                pending_sells.append((sym, reason))
                queued.add(sym)

        if not calendar.is_review_day(d):
            continue

        # ── 4. weekly review ──────────────────────────────────────────────────
        if not calendar.is_on(d):
            if cfg.regime_exit:
                for sym in portfolio:
                    if sym not in queued:
                        pending_sells.append((sym, "regime"))
                        queued.add(sym)
            continue

        ranking = rank_universe(price_map, bench, d, cfg, matrix=rs_matrix)
        if not ranking:
            continue
        ranks = ranks_by_symbol(ranking)

        survivors = {s: p for s, p in portfolio.items() if s not in queued}
        for sym, reason in rank_rotation_exits(survivors, ranks, d, cfg):
            pending_sells.append((sym, "rebalance"))
            queued.add(sym)

        held_after = {s: p for s, p in portfolio.items() if s not in queued}
        free_slots = cfg.slots - len(held_after)
        if free_slots <= 0:
            continue

        picks, _ = select_candidates(ranking, held_after, tables, industries, d,
                                     cooldowns, cfg, free_slots)
        pending_buys = picks

    # ── final snapshot ────────────────────────────────────────────────────────
    last_day = days[-1]
    open_positions = []
    for sym, pos in portfolio.items():
        close = closes.get(sym, pos.last_close)
        open_positions.append({
            "symbol": sym, "industry": pos.industry,
            "entry_date": pos.entry_date, "entry_price": pos.entry_price,
            "qty": pos.qty, "invested": pos.invested,
            "last_close": close, "unrealised": pos.unrealised(close),
            "unrealised_pct": pos.gain_pct(close),
            "stop_price": pos.stop_price, "stage": pos.stage_label(),
            "peak_close": pos.peak_close, "hold_days": pos.hold_days(last_day),
            "rank_at_entry": pos.rank_at_entry,
        })

    return BacktestResult(cfg, trades, pd.DataFrame(equity_rows), open_positions, bench)


# ──────────────────────────────────────────────────────────────────────────────
# Reporting
# ──────────────────────────────────────────────────────────────────────────────

def print_report(res: BacktestResult, fd_rate: float = 6.45) -> None:
    s = res.stats
    if not s:
        print("  No results.")
        return
    cfg = res.cfg

    print()
    print("=" * 78)
    print("  MOMENTUM PORTFOLIO BACKTEST")
    print("=" * 78)
    print(f"  Period          : {s['start']} → {s['end']}  ({s['years']:.2f} years)")
    print(f"  Capital         : Rs {cfg.capital:,.0f}   Slots: {cfg.slots}")
    target_txt = "no target" if cfg.target_pct is None else f"target +{cfg.target_pct:g}%"
    print(f"  Ladder          : {target_txt}, stop -{cfg.stop_pct:g}%, "
          f"BE at +{cfg.breakeven_trigger_pct:g}%, trail {cfg.trail_pct:g}% from peak at +{cfg.trail_trigger_pct:g}%")
    print(f"  Entry           : rank<={cfg.buy_rank_limit}, {cfg.breakout_days}d breakout"
          f"{' (2-close confirm)' if cfg.breakout_confirm else ''}"
          f"{', stacked EMA' if cfg.require_stacked_ema else ''}"
          f"{', volume' if cfg.require_volume else ''}")
    new_cap = "free slots" if cfg.max_new_per_review is None else f"{cfg.max_new_per_review}"
    print(f"  Rotation        : sell if rank>{cfg.sell_rank_limit} for {cfg.sell_rank_strikes} reviews, "
          f"min hold {cfg.min_hold_days}d, max new/review: {new_cap}")
    print("  Regime          : " + ("DISABLED (always invested)" if not cfg.regime_enabled else
          f"weekly Nifty > {cfg.regime_sma} SMA"
          f"{', liquidate when off' if cfg.regime_exit else ', stay invested when off'}"))
    print(f"  Costs           : {cfg.fee_pct:g}% + Rs {cfg.fixed_fee:g}/order + "
          f"{cfg.slippage_pct:g}% slippage, per side")
    print("-" * 78)

    # Fixed deposit is the honest do-nothing alternative for a multi-year investing system.
    fd_final = cfg.capital * (1 + fd_rate / 100.0) ** s["years"]
    fd_return = (fd_final / cfg.capital - 1.0) * 100.0
    print(f"  {'':<20}{'STRATEGY':>13}{'NIFTY 50':>13}{'FD @' + f'{fd_rate:g}%':>13}")
    print(f"  {'Total return':<20}{s['total_return_pct']:>12.2f}%{s['bench_return_pct']:>12.2f}%{fd_return:>12.2f}%")
    print(f"  {'CAGR':<20}{s['cagr_pct']:>12.2f}%{s['bench_cagr_pct']:>12.2f}%{fd_rate:>12.2f}%")
    print(f"  {'Max drawdown':<20}{s['max_drawdown_pct']:>12.2f}%{s['bench_max_drawdown_pct']:>12.2f}%{0.0:>12.2f}%")
    print(f"  {'Final value':<20}{s['end_equity']:>13,.0f}{'':>13}{fd_final:>13,.0f}")
    print("-" * 78)
    print(f"  Equity          : Rs {s['start_equity']:,.0f} → Rs {s['end_equity']:,.0f}")
    print(f"  Sharpe / Sortino: {s['sharpe']:.2f} / {s['sortino']:.2f}      Calmar: {s['calmar']:.2f}")
    print(f"  Trades          : {s['trades']}  (win rate {s['win_rate_pct']:.1f}%, "
          f"profit factor {s['profit_factor']:.2f})")
    print(f"  Avg win / loss  : +{s['avg_win_pct']:.2f}% / {s['avg_loss_pct']:.2f}%")
    print(f"  Avg hold        : {s['avg_hold_days']:.0f} days")
    print(f"  Costs paid      : Rs {s['total_costs']:,.0f}   Realized P&L: Rs {s['realized_pnl']:,.0f}")
    print(f"  Still open      : {s['open_positions']}")
    if s["exit_breakdown"]:
        breakdown = "  ".join(f"{k}={v}" for k, v in sorted(s["exit_breakdown"].items()))
        print(f"  Exit reasons    : {breakdown}")
    print("=" * 78)

    if not res.open_positions.empty:
        print("\n  OPEN POSITIONS")
        cols = ["symbol", "entry_date", "entry_price", "qty", "last_close",
                "unrealised_pct", "stop_price", "stage", "hold_days"]
        print(res.open_positions[cols].to_string(index=False,
                                                 float_format=lambda x: f"{x:,.2f}"))

    if not res.trades.empty:
        print("\n  LAST 10 CLOSED TRADES")
        cols = ["symbol", "entry_date", "exit_date", "entry_price", "exit_price",
                "pnl", "pnl_pct", "exit_reason", "hold_days"]
        print(res.trades.tail(10)[cols].to_string(index=False,
                                                  float_format=lambda x: f"{x:,.2f}"))

    # ── how to read it ────────────────────────────────────────────────────────
    print("\n  READING THE REPORT")
    alpha = s["total_return_pct"] - s["bench_return_pct"]
    verdict = "BEAT" if alpha > 0 else "UNDERPERFORMED"
    print(f"  * {verdict} the Nifty 50 by {abs(alpha):.2f}% over the period.")
    if s["cagr_pct"] > fd_rate:
        print(f"  * CAGR {s['cagr_pct']:.2f}% beats a {fd_rate:g}% FD by "
              f"{s['cagr_pct'] - fd_rate:.2f}%/yr — the risk is being paid for.")
    else:
        print(f"  * CAGR {s['cagr_pct']:.2f}% LOSES to a risk-free {fd_rate:g}% FD. "
              f"Equity risk is not being compensated here.")
    print(f"  * Max drawdown {s['max_drawdown_pct']:.2f}% = Rs "
          f"{abs(s['max_drawdown_pct']) / 100 * cfg.capital:,.0f} on Rs {cfg.capital:,.0f}. "
          f"Could you hold through that?")
    if s["trades"] < 30:
        print(f"  * ONLY {s['trades']} TRADES — too few to be statistically meaningful. "
              f"Widen the universe/window or loosen the entry gate before trusting this.")
    else:
        print(f"  * {s['trades']} trades is enough for the win rate and profit factor to mean something.")
    pf_val = s["profit_factor"]
    pf_word = "excellent" if pf_val > 2 else "good" if pf_val > 1.5 else "marginal" if pf_val > 1 else "unprofitable"
    print(f"  * Profit factor {pf_val:.2f} ({pf_word}); Sharpe {s['sharpe']:.2f} "
          f"({'good' if s['sharpe'] > 1 else 'below 1 — needs work'}).")
    if s["realized_pnl"]:
        print(f"  * Costs ate Rs {s['total_costs']:,.0f}, i.e. "
              f"{abs(s['total_costs'] / s['realized_pnl'] * 100):.1f}% of gross realized P&L.")


def monthly_pnl(res: BacktestResult) -> pd.DataFrame:
    """Month-end equity and its change — the table that shows where returns came from."""
    if res.equity.empty:
        return pd.DataFrame()
    eq = res.equity.copy()
    eq["month"] = pd.to_datetime(eq["date"]).dt.to_period("M")
    grouped = eq.groupby("month").agg(month_end=("equity", "last"),
                                      positions=("positions", "last")).reset_index()
    grouped["month"] = grouped["month"].astype(str)
    grouped["pnl"] = grouped["month_end"].diff()
    grouped.loc[grouped.index[0], "pnl"] = grouped["month_end"].iloc[0] - res.cfg.capital
    grouped["return_pct"] = grouped["pnl"] / (grouped["month_end"] - grouped["pnl"]) * 100.0
    return grouped


def write_summary_json(res: BacktestResult, path: str, artifacts: Dict[str, bool]) -> str:
    """Headline stats for the dashboard to show alongside the live portfolio.

    The Excel/HTML reports are the detail; this small file is what /api/momentum reads so
    the page can display "last backtest: X% CAGR" without parsing a spreadsheet in Node.
    """
    s = res.stats
    payload = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "period": {"start": str(s["start"]), "end": str(s["end"]), "years": round(s["years"], 2)},
        "universe": res.cfg.universe,
        "capital": res.cfg.capital,
        "stats": {k: (round(v, 4) if isinstance(v, float) else v)
                  for k, v in s.items() if k not in ("start", "end", "exit_breakdown")},
        "exit_breakdown": s.get("exit_breakdown", {}),
        "config": {k: v for k, v in res.cfg.to_dict().items()},
        "artifacts": artifacts,
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, indent=2, default=str)
    os.replace(tmp, path)
    return path


def write_excel(res: BacktestResult, path: str) -> Optional[str]:
    # pandas needs openpyxl to write .xlsx but only fails at write time; check up front so a
    # missing optional dependency degrades to a warning instead of losing the whole run.
    if importlib.util.find_spec("openpyxl") is None:
        print("  (openpyxl not installed — skipping Excel report)")
        return None

    os.makedirs(os.path.dirname(path), exist_ok=True)
    s = res.stats
    summary = pd.DataFrame(
        [{"Metric": k, "Value": v} for k, v in {
            "Period": f"{s['start']} to {s['end']}",
            "Years": round(s["years"], 2),
            "Starting capital": s["start_equity"],
            "Ending equity": round(s["end_equity"], 2),
            "Total return %": round(s["total_return_pct"], 2),
            "CAGR %": round(s["cagr_pct"], 2),
            "Max drawdown %": round(s["max_drawdown_pct"], 2),
            "Sharpe": round(s["sharpe"], 2),
            "Sortino": round(s["sortino"], 2),
            "Calmar": round(s["calmar"], 2),
            "Nifty 50 return %": round(s["bench_return_pct"], 2),
            "Nifty 50 CAGR %": round(s["bench_cagr_pct"], 2),
            "Nifty 50 max DD %": round(s["bench_max_drawdown_pct"], 2),
            "Trades": s["trades"],
            "Win rate %": round(s["win_rate_pct"], 2),
            "Profit factor": round(s["profit_factor"], 2),
            "Avg win %": round(s["avg_win_pct"], 2),
            "Avg loss %": round(s["avg_loss_pct"], 2),
            "Avg hold days": round(s["avg_hold_days"], 1),
            "Costs paid": round(s["total_costs"], 2),
            "Open positions": s["open_positions"],
        }.items()])

    config = pd.DataFrame([{"Parameter": k, "Value": str(v)}
                           for k, v in res.cfg.to_dict().items()])

    with pd.ExcelWriter(path, engine="openpyxl") as xl:
        summary.to_excel(xl, sheet_name="Summary", index=False)
        config.to_excel(xl, sheet_name="Config", index=False)
        if not res.trades.empty:
            res.trades.to_excel(xl, sheet_name="Trades", index=False)
        mp = monthly_pnl(res)
        if not mp.empty:
            mp.to_excel(xl, sheet_name="Monthly PNL", index=False)
        if not res.open_positions.empty:
            res.open_positions.to_excel(xl, sheet_name="Open Positions", index=False)
        res.equity.to_excel(xl, sheet_name="Equity Curve", index=False)
    return path


def _returns_series(res: BacktestResult) -> Tuple[pd.Series, pd.Series]:
    """Daily strategy and benchmark return series on a shared DatetimeIndex."""
    eq = res.equity.copy()
    eq.index = pd.to_datetime(eq["date"])
    strat = eq["equity"].pct_change().fillna(0.0)
    strat.name = "Momentum Portfolio"

    b = res.bench.copy()
    b.index = pd.to_datetime(b["date"])
    bench = b["close"].reindex(strat.index).ffill().bfill().pct_change().fillna(0.0)
    bench.name = "NIFTY 50"
    return strat, bench


def write_tearsheet(res: BacktestResult, path: str) -> Optional[str]:
    """Interactive offline tearsheet via openstatz.

    openstatz declares `pandas<3` but runs correctly on this venv's pandas 3.0.0, so it is
    installed with `--no-deps` (see requirements.txt). If that ever stops holding, this
    degrades to a warning rather than failing the backtest.
    """
    try:
        import openstatz as ostz
    except ImportError:
        print("  (openstatz not installed — skipping tearsheet)")
        return None

    strat, bench = _returns_series(res)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        ostz.dashboard(strat, benchmark=bench, output=path,
                       title="Nifty 500 Momentum Portfolio", open_browser=False)
    except Exception as e:
        print(f"  (tearsheet failed: {type(e).__name__}: {e})")
        return None

    try:
        mc = ostz.stats.montecarlo(strat, sims=1000, bust=-0.20, goal=0.30)
        print(f"  Monte Carlo (1000 sims): P(-20% bust) = {mc.bust_probability:.1%}, "
              f"P(+30% goal) = {mc.goal_probability:.1%}")
    except Exception:
        pass
    return path


def write_plot(res: BacktestResult, path: str, fd_rate: float = 6.45) -> Optional[str]:
    """Equity curve versus Nifty 50 and an FD, with the drawdown underneath."""
    try:
        import plotly.graph_objects as go
        from plotly.subplots import make_subplots
    except ImportError:
        print("  (plotly not installed — skipping plot)")
        return None

    eq = res.equity.copy()
    eq.index = pd.to_datetime(eq["date"])
    equity = eq["equity"]
    cum_strat = equity / equity.iloc[0] - 1.0

    b = res.bench.copy()
    b.index = pd.to_datetime(b["date"])
    bench_close = b["close"].reindex(equity.index).ffill().bfill()
    cum_bench = bench_close / bench_close.iloc[0] - 1.0

    daily_fd = (1 + fd_rate / 100.0) ** (1 / 365.25) - 1
    cum_fd = pd.Series((1 + daily_fd) ** np.arange(len(equity)) - 1.0, index=equity.index)

    drawdown = equity / equity.cummax() - 1.0
    invested = eq["holdings"] / equity * 100.0     # capital utilisation, the suspected drag

    fig = make_subplots(rows=3, cols=1, shared_xaxes=True,
                        row_heights=[0.54, 0.23, 0.23], vertical_spacing=0.05,
                        subplot_titles=("Cumulative return", "Drawdown", "% of capital deployed"))
    fig.add_trace(go.Scatter(x=cum_strat.index, y=cum_strat * 100, name="Momentum Portfolio",
                             line=dict(color="#00d4aa", width=2.5)), row=1, col=1)
    fig.add_trace(go.Scatter(x=cum_bench.index, y=cum_bench * 100, name="NIFTY 50",
                             line=dict(color="#ff6688", width=1.5, dash="dash")), row=1, col=1)
    fig.add_trace(go.Scatter(x=cum_fd.index, y=cum_fd * 100, name=f"FD {fd_rate:g}%",
                             line=dict(color="#888888", width=1.5, dash="dashdot")), row=1, col=1)
    fig.add_trace(go.Scatter(x=drawdown.index, y=drawdown * 100, name="Drawdown",
                             fill="tozeroy", line=dict(color="#ff4444", width=1),
                             showlegend=False), row=2, col=1)
    fig.add_trace(go.Scatter(x=invested.index, y=invested, name="Deployed",
                             fill="tozeroy", line=dict(color="#4488ff", width=1),
                             showlegend=False), row=3, col=1)

    fig.update_yaxes(ticksuffix="%", side="right")
    fig.update_layout(template="plotly_dark", height=880,
                      title=f"Nifty 500 Momentum Portfolio — {res.stats['start']} to {res.stats['end']}")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fig.write_html(path)
    return path


# ──────────────────────────────────────────────────────────────────────────────
# Parameter sweep
# ──────────────────────────────────────────────────────────────────────────────

SWEEP_GRID = [
    ("target_pct", [25.0, 30.0, 40.0, 60.0, 1000.0]),   # 1000 == effectively no target
    ("stop_pct", [8.0, 10.0, 12.0, 15.0]),
    ("trail_pct", [10.0, 15.0, 20.0]),
    ("breakout_days", [20, 55, 100]),
    ("slots", [8, 10, 15]),
    ("buy_rank_limit", [10, 20, 30, 50]),
    # Refill rate: with 10 slots and 2 buys/review the book needs five weeks to fill, and
    # every regime liquidation restarts that clock with capital sitting in cash.
    ("max_new_per_review", [2, 4, 6, 10]),
    ("min_hold_days", [7, 21, 45]),
    ("sell_rank_limit", [25, 40, 60]),
    ("regime_exit", [True, False]),
]


def run_sweep(base: MomentumConfig, start: date, end: Optional[date]) -> pd.DataFrame:
    """One-parameter-at-a-time sweep off the base config (an ablation, not a full grid).

    A full grid over six knobs would be thousands of runs and would overfit far harder than
    it would inform. Varying one at a time shows which knobs the result is actually
    sensitive to.
    """
    universe = load_universe(base.universe)
    bench = load_benchmark()
    price_map = load_price_map([u["symbol"] for u in universe], min_bars=base.min_history_bars)
    preloaded = (universe, price_map, bench)

    rows = []
    seen = set()
    for param, values in SWEEP_GRID:
        for val in values:
            cfg = replace(base, **{param: val})
            key = tuple(sorted(cfg.to_dict().items(), key=lambda kv: kv[0]))
            key = str(key)
            if key in seen:
                continue
            seen.add(key)
            try:
                cfg.validate()
            except ValueError as e:
                rows.append({"param": param, "value": val, "error": str(e)})
                continue
            res = run_backtest(cfg, start, end, verbose=False, preloaded=preloaded)
            s = res.stats
            rows.append({
                "param": param, "value": val,
                "cagr_pct": round(s["cagr_pct"], 2),
                "max_dd_pct": round(s["max_drawdown_pct"], 2),
                "calmar": round(s["calmar"], 2),
                "sharpe": round(s["sharpe"], 2),
                "trades": s["trades"],
                "win_rate_pct": round(s["win_rate_pct"], 1),
                "end_equity": round(s["end_equity"], 0),
            })
            print(f"    {param}={val!s:<8} CAGR {s['cagr_pct']:7.2f}%  "
                  f"maxDD {s['max_drawdown_pct']:7.2f}%  Calmar {s['calmar']:5.2f}  "
                  f"trades {s['trades']:4d}")
    return pd.DataFrame(rows)


# ──────────────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────────────

def main() -> None:
    p = argparse.ArgumentParser(
        description="Backtest the Nifty 500 momentum investing portfolio.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    p.add_argument("--start", default="2019-06-01", help="YYYY-MM-DD (default 2019-06-01)")
    p.add_argument("--end", default=None, help="YYYY-MM-DD (default: last data date)")
    p.add_argument("--universe", choices=["nifty500", "nifty50"], default="nifty500")
    p.add_argument("--capital", type=float, default=175_000.0)
    p.add_argument("--slots", type=int, default=10)
    p.add_argument("--target", default="none",
                   help="profit target %%, or 'none' (default) to let winners run")
    p.add_argument("--stop", type=float, default=12.0, help="initial stop loss %%")
    p.add_argument("--trail-pct", type=float, default=25.0,
                   help="trailing stop distance below the peak close %%")
    p.add_argument("--trail-trigger", type=float, default=25.0,
                   help="unrealised gain %% at which the trail arms")
    p.add_argument("--breakeven-trigger", type=float, default=15.0,
                   help="unrealised gain %% at which the stop moves to entry")
    p.add_argument("--min-hold-days", type=int, default=7)
    p.add_argument("--breakout-days", type=int, default=55)
    p.add_argument("--buy-rank-limit", type=int, default=20)
    p.add_argument("--sell-rank-limit", type=int, default=25)
    p.add_argument("--max-new-per-review", type=int, default=None,
                   help="cap on new buys per review (default: no cap beyond free slots)")
    p.add_argument("--sector-cap", type=int, default=2)
    p.add_argument("--fee-pct", type=float, default=0.111,
                   help="statutory charges %%%% per side (default 0.111, Indian delivery)")
    p.add_argument("--fixed-fee", type=float, default=20.0, help="Rs per order per side")
    p.add_argument("--slippage-pct", type=float, default=0.05, help="%%%% per side")
    p.add_argument("--no-costs", action="store_true",
                   help="zero all costs (comparable to the older backtest_nifty50_rs_v*.py)")
    p.add_argument("--fd-rate", type=float, default=6.45,
                   help="fixed-deposit %%%% p.a. to compare against (default 6.45)")
    p.add_argument("--no-regime-exit", action="store_true",
                   help="stay invested when the regime turns off (still blocks new buys)")
    p.add_argument("--no-regime", action="store_true",
                   help="disable the market filter entirely — always fully invested")
    p.add_argument("--regime-sma", type=int, default=200,
                   help="weekly Nifty close vs this SMA (default 200)")
    p.add_argument("--no-breakout-confirm", action="store_true")
    p.add_argument("--sweep", action="store_true", help="one-at-a-time parameter ablation")
    p.add_argument("--excel", default=None, help="output path (default debug/momentum_backtest.xlsx)")
    p.add_argument("--no-excel", action="store_true")
    p.add_argument("--no-tearsheet", action="store_true", help="skip the openstatz tearsheet")
    p.add_argument("--no-plot", action="store_true", help="skip the plotly equity/drawdown plot")
    args = p.parse_args()

    target = None if str(args.target).strip().lower() in ("none", "off", "") else float(args.target)

    cfg = MomentumConfig(
        universe=args.universe,
        capital=args.capital,
        slots=args.slots,
        target_pct=target,
        stop_pct=args.stop,
        trail_pct=args.trail_pct,
        trail_trigger_pct=args.trail_trigger,
        breakeven_trigger_pct=args.breakeven_trigger,
        min_hold_days=args.min_hold_days,
        breakout_days=args.breakout_days,
        buy_rank_limit=args.buy_rank_limit,
        sell_rank_limit=args.sell_rank_limit,
        max_new_per_review=args.max_new_per_review,
        sector_cap=args.sector_cap,
        fee_pct=0.0 if args.no_costs else args.fee_pct,
        fixed_fee=0.0 if args.no_costs else args.fixed_fee,
        slippage_pct=0.0 if args.no_costs else args.slippage_pct,
        regime_exit=not args.no_regime_exit,
        regime_enabled=not args.no_regime,
        regime_sma=args.regime_sma,
        breakout_confirm=not args.no_breakout_confirm,
    )

    start = datetime.strptime(args.start, "%Y-%m-%d").date()
    end = datetime.strptime(args.end, "%Y-%m-%d").date() if args.end else None

    if args.sweep:
        print("=" * 78)
        print("  PARAMETER ABLATION (one knob at a time, off the base config)")
        print("=" * 78)
        df = run_sweep(cfg, start, end)
        out = os.path.join(DEBUG_DIR, "momentum_sweep.csv")
        os.makedirs(DEBUG_DIR, exist_ok=True)
        df.to_csv(out, index=False)
        print(f"\n  Wrote {out}")
        ranked = df.dropna(subset=["calmar"]).sort_values("calmar", ascending=False)
        print("\n  Top 10 by Calmar (CAGR / max drawdown):")
        print(ranked.head(10).to_string(index=False))
        return

    print("=" * 78)
    print("  Loading data...")
    res = run_backtest(cfg, start, end)
    print_report(res, fd_rate=args.fd_rate)

    print()
    artifacts = {"excel": False, "plot": False, "tearsheet": False}
    if not args.no_excel:
        written = write_excel(res, args.excel or os.path.join(DEBUG_DIR, "momentum_backtest.xlsx"))
        if written:
            artifacts["excel"] = True
            print(f"  Excel report : {written}")
    if not args.no_plot:
        written = write_plot(res, os.path.join(DEBUG_DIR, "momentum_backtest_plot.html"),
                             fd_rate=args.fd_rate)
        if written:
            artifacts["plot"] = True
            print(f"  Plot         : {written}")
    if not args.no_tearsheet:
        written = write_tearsheet(res, os.path.join(DEBUG_DIR, "momentum_tearsheet.html"))
        if written:
            artifacts["tearsheet"] = True
            print(f"  Tearsheet    : {written}")

    summary = write_summary_json(
        res, os.path.join(DEBUG_DIR, "momentum_backtest_summary.json"), artifacts)
    print(f"  Summary JSON : {summary}   (read by the dashboard's /momentum page)")

    print("\n  NOTE: the universe is today's Nifty 500 constituent list, so results carry")
    print("  survivorship bias — names added to the index after a strong run are ranked")
    print("  during that run. Treat the CAGR as an upper bound, not an expectation.")


if __name__ == "__main__":
    main()
