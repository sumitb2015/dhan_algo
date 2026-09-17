"""
OpenStatz tearsheet integration for the VectorBT backtest engine.

Ported from the vectorbt-backtesting-skills package's rules/openstatz-tearsheet.md
(installed under .claude/skills/vectorbt-expert/), with one change: that rule's
benchmark example fetches NIFTY 50 from Yahoo Finance via
`ostz.providers.download_returns("^NSEI")`. This project already installs
openstatz for scripts/analysis/backtest_momentum_portfolio.py, and its own
benchmark there is a Dhan CSV, not yfinance — so this module takes the benchmark
as an already-loaded returns Series (see data.load_benchmark_returns) instead of
fetching one itself, keeping every price series in this engine Dhan-sourced.

OpenStatz's own docs suggest `import openstatz as os`; this project already uses
`os` for the stdlib module everywhere (os.getenv, path handling), so every script
in this engine must alias it `ostz`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import pandas as pd


def generate_tearsheet(
    strategy_returns: pd.Series,
    strategy_name: str,
    output_path: Path,
    benchmark_returns: Optional[pd.Series] = None,
    benchmark_name: str = "NIFTY 50",
    open_browser: bool = False,
) -> Optional[Path]:
    """Render the OpenStatz offline dashboard tearsheet for one backtest run.

    Returns the output path on success, or None if openstatz is not installed
    (the caller should treat that as non-fatal — the backtest itself already
    ran and printed pf.stats()).
    """
    try:
        import openstatz as ostz
    except ImportError:
        print("\nopenstatz not installed — skipping tearsheet. "
              "Install with: pip install --no-deps openstatz==0.4.1")
        return None

    returns = strategy_returns.copy()
    if returns.index.tz is not None:
        returns.index = returns.index.tz_convert(None)
    returns.name = strategy_name

    benchmark = None
    if benchmark_returns is not None:
        benchmark = benchmark_returns.reindex(returns.index).fillna(0.0)
        if benchmark.index.tz is not None:
            benchmark.index = benchmark.index.tz_convert(None)
        benchmark.name = benchmark_name

    ostz.dashboard(
        returns,
        benchmark=benchmark,
        output=str(output_path),
        title=strategy_name,
        open_browser=open_browser,
    )
    print(f"\nOpenStatz tearsheet saved to {output_path}")
    return output_path


def monte_carlo_summary(strategy_returns: pd.Series, sims: int = 1000,
                         bust: float = -0.20, goal: float = 0.50) -> Optional[str]:
    """One-line Monte Carlo bust/goal probability summary, or None if openstatz is missing."""
    try:
        import openstatz as ostz
    except ImportError:
        return None
    mc = ostz.stats.montecarlo(strategy_returns, sims=sims, bust=bust, goal=goal)
    return (f"Monte Carlo ({sims} sims): "
            f"Bust prob (>{abs(bust):.0%} loss)={mc.bust_probability:.2%}, "
            f"Goal prob (>{goal:.0%} gain)={mc.goal_probability:.2%}")
