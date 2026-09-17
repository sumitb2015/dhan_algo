"""
Core VectorBT backtest runner.

Wraps `vbt.Portfolio.from_signals` with this repo's cost-model conventions
(costs.py) and adds a strategy-vs-benchmark comparison table, so individual
backtest scripts only need to supply price data (data.py) and boolean
entry/exit signal series.

This module is deliberately strategy-agnostic — it does not know about any of
this repo's live strategies under strategies/. Wiring a specific strategy's
signal logic into this engine is left to a future backtest script; see
example_ema_crossover.py for the minimal end-to-end shape such a script takes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import pandas as pd
import vectorbt as vbt

from .costs import CostProfile


@dataclass
class BacktestRun:
    portfolio: "vbt.Portfolio"
    cost_profile: CostProfile
    symbol: str
    strategy_name: str


def run_backtest(
    close: pd.Series,
    entries: pd.Series,
    exits: pd.Series,
    cost_profile: CostProfile,
    symbol: str,
    strategy_name: str,
    init_cash: Optional[float] = None,
    freq: Optional[str] = None,
    direction: str = "longonly",
    size: Optional[float] = None,
    size_granularity: Optional[float] = None,
) -> BacktestRun:
    """Run `vbt.Portfolio.from_signals` with this repo's Indian-market cost model.

    `entries`/`exits` must already be cleaned boolean series aligned to `close`'s
    index (e.g. via `entries.fillna(False)`, and duplicate-signal removal if the
    signal source can repeat) — this function does no signal cleanup itself, it
    only runs the simulation and books costs.

    `size`/`size_granularity` are for lot-size-aware instruments (futures/options):
    pass the lot size for both to force whole-lot sizing, matching the skill's
    `min_size=<lot>, size_granularity=<lot>` convention for NIFTY/BANKNIFTY.
    """
    pf = vbt.Portfolio.from_signals(
        close,
        entries.fillna(False),
        exits.fillna(False),
        direction=direction,
        fees=cost_profile.fees,
        fixed_fees=cost_profile.fixed_fees,
        init_cash=init_cash if init_cash is not None else cost_profile.default_init_cash,
        freq=freq if freq is not None else cost_profile.default_freq,
        size=size,
        min_size=size_granularity,
        size_granularity=size_granularity,
    )
    return BacktestRun(portfolio=pf, cost_profile=cost_profile, symbol=symbol,
                        strategy_name=strategy_name)


def compare_to_benchmark(run: BacktestRun, benchmark_close: pd.Series) -> pd.DataFrame:
    """Strategy vs. buy-and-hold-benchmark comparison table.

    `benchmark_close` is a price series (e.g. NIFTY daily close from
    data.load_index_daily) aligned to the same date range as the backtest —
    it is turned into a buy-and-hold return series internally, not passed
    through vectorbt.
    """
    pf = run.portfolio
    bench_aligned = benchmark_close.reindex(pf.wrapper.index).ffill()
    bench_return = bench_aligned.iloc[-1] / bench_aligned.iloc[0] - 1
    bench_returns = bench_aligned.pct_change().fillna(0.0)
    bench_sharpe = _annualized_sharpe(bench_returns)
    bench_dd = (bench_aligned / bench_aligned.cummax() - 1).min()

    strat_returns = pf.returns()

    rows = [
        ("Total Return", f"{pf.total_return():.2%}", f"{bench_return:.2%}"),
        ("Sharpe Ratio", f"{pf.sharpe_ratio():.2f}", f"{bench_sharpe:.2f}"),
        ("Sortino Ratio", f"{pf.sortino_ratio():.2f}", "-"),
        ("Max Drawdown", f"{pf.max_drawdown():.2%}", f"{bench_dd:.2%}"),
        ("Win Rate", f"{pf.trades.win_rate():.2%}" if pf.trades.count() else "-", "-"),
        ("Trades", f"{pf.trades.count()}", "-"),
        ("Profit Factor", f"{pf.trades.profit_factor():.2f}" if pf.trades.count() else "-", "-"),
    ]
    return pd.DataFrame(rows, columns=["Metric", run.strategy_name, "Benchmark (Buy & Hold)"])


def _annualized_sharpe(returns: pd.Series, periods_per_year: int = 252) -> float:
    std = returns.std()
    if not std or pd.isna(std):
        return 0.0
    return (returns.mean() / std) * (periods_per_year ** 0.5)


def print_report(run: BacktestRun, comparison: Optional[pd.DataFrame] = None) -> None:
    """Print `pf.stats()` plus, if given, the strategy-vs-benchmark table."""
    print(f"\n{'=' * 70}")
    print(f"  {run.strategy_name} — {run.symbol} ({run.cost_profile.name} costs)")
    print(f"{'=' * 70}\n")
    print(run.portfolio.stats())
    if comparison is not None:
        print(f"\n--- Strategy vs Benchmark ---")
        print(comparison.to_string(index=False))
