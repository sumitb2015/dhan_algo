"""
End-to-end smoke test / usage example for the VectorBT backtest engine.

This is a demo wiring, not a production strategy: a plain EMA20/EMA50 crossover
on NIFTY daily closes, chosen only because it needs no strategy-specific state to
explain. None of this repo's live strategies (strategies/) are wired to vectorbt —
that is deliberately left for a follow-up once this engine itself is reviewed.

Usage:
    venv/bin/python scripts/analysis/vectorbt_engine/example_ema_crossover.py
    venv/bin/python scripts/analysis/vectorbt_engine/example_ema_crossover.py --start 2022-01-01
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, ROOT)

import pandas_ta as pta  # noqa: E402 — project convention (see CLAUDE.md AGENT_FUNCTION_REFERENCE)

from scripts.analysis.vectorbt_engine import costs, data, engine, tearsheet  # noqa: E402

SCRIPT_DIR = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--symbol", default="NIFTY")
    parser.add_argument("--start", default="2021-01-01")
    parser.add_argument("--fast", type=int, default=20)
    parser.add_argument("--slow", type=int, default=50)
    parser.add_argument("--no-tearsheet", action="store_true")
    args = parser.parse_args()

    df = data.load_index_daily(args.symbol)
    df = data.clip_date_range(df, start=args.start)
    close = df["close"]

    ema_fast = pta.ema(close, length=args.fast)
    ema_slow = pta.ema(close, length=args.slow)

    entries = (ema_fast > ema_slow) & (ema_fast.shift(1) <= ema_slow.shift(1))
    exits = (ema_fast < ema_slow) & (ema_fast.shift(1) >= ema_slow.shift(1))

    strategy_name = f"EMA {args.fast}/{args.slow} Crossover"
    run = engine.run_backtest(
        close, entries, exits,
        cost_profile=costs.DELIVERY_EQUITY,
        symbol=args.symbol,
        strategy_name=strategy_name,
    )

    benchmark_close = data.load_index_daily(args.symbol)["close"]
    benchmark_close = data.clip_date_range(benchmark_close.to_frame("close"), start=args.start)["close"]
    comparison = engine.compare_to_benchmark(run, benchmark_close)
    engine.print_report(run, comparison)

    if not args.no_tearsheet:
        benchmark_returns = data.load_benchmark_returns(run.portfolio.wrapper.index, symbol=args.symbol)
        tearsheet.generate_tearsheet(
            run.portfolio.returns(),
            strategy_name=f"{strategy_name} - {args.symbol}",
            output_path=SCRIPT_DIR / f"{args.symbol}_ema_crossover_tearsheet.html",
            benchmark_returns=benchmark_returns,
            open_browser=False,
        )
        mc = tearsheet.monte_carlo_summary(run.portfolio.returns())
        if mc:
            print(mc)


if __name__ == "__main__":
    main()
