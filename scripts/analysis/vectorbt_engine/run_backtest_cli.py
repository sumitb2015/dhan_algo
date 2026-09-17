"""
CLI entry point for the VectorBT Backtester dashboard terminal
(rs_dashboard `/backtest-vectorbt`, `app/api/backtest-vectorbt/route.ts`).

Wraps this engine's data/costs/engine/tearsheet modules with a small catalog of
signal generators (EMA crossover, RSI, Donchian breakout, Supertrend, MACD) —
all pandas_ta, matching this repo's existing indicator convention (see
CLAUDE.md's DhanHelper.get_indicators_ta) rather than the OpenAlgo skill's
`openalgo.ta`. Writes status/result JSON in the same spawn+poll shape every
other dashboard-triggered Python job uses (see app/api/backtest/route.ts):
progress to --status-file as it runs, the final stats+comparison to
--output-file, and a fixed-path tearsheet HTML the dashboard serves through
app/api/backtest-vectorbt/report/route.ts.

Usage:
    venv/bin/python scripts/analysis/vectorbt_engine/run_backtest_cli.py \\
        --strategy ema-crossover --symbol NIFTY --asset-type index \\
        --status-file debug/vectorbt_backtest_status.json \\
        --output-file debug/vectorbt_backtest_result.json \\
        --tearsheet-file debug/vectorbt_tearsheet.html
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from datetime import datetime, timezone
from typing import Tuple

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, ROOT)

import pandas as pd  # noqa: E402
import pandas_ta as pta  # noqa: E402

from scripts.analysis.vectorbt_engine import costs, data, engine, tearsheet  # noqa: E402

STRATEGIES = ["ema-crossover", "rsi", "donchian", "supertrend", "macd"]
COST_PROFILES = list(costs.PROFILES.keys())


# ─────────────────────────────────────────────────────────────────────────────
# Status/stop-trigger plumbing (same shape as every other dashboard job)
# ─────────────────────────────────────────────────────────────────────────────

def write_status(status_file: str, **fields) -> None:
    payload = {"running": True, "done": False, "percent": 0, **fields}
    tmp = status_file + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, status_file)


def check_stop(stop_file: str) -> bool:
    return os.path.exists(stop_file)


# ─────────────────────────────────────────────────────────────────────────────
# Signal generators — each returns (entries, exits) boolean Series aligned to close
# ─────────────────────────────────────────────────────────────────────────────

def signals_ema_crossover(df: pd.DataFrame, fast: int = 20, slow: int = 50) -> Tuple[pd.Series, pd.Series]:
    close = df["close"]
    ema_fast = pta.ema(close, length=fast)
    ema_slow = pta.ema(close, length=slow)
    entries = (ema_fast > ema_slow) & (ema_fast.shift(1) <= ema_slow.shift(1))
    exits = (ema_fast < ema_slow) & (ema_fast.shift(1) >= ema_slow.shift(1))
    return entries, exits


def signals_rsi(df: pd.DataFrame, length: int = 14, buy_below: float = 30, sell_above: float = 70) -> Tuple[pd.Series, pd.Series]:
    rsi = pta.rsi(df["close"], length=length)
    entries = (rsi < buy_below) & (rsi.shift(1) >= buy_below)
    exits = (rsi > sell_above) & (rsi.shift(1) <= sell_above)
    return entries, exits


def signals_donchian(df: pd.DataFrame, length: int = 20) -> Tuple[pd.Series, pd.Series]:
    dc = pta.donchian(df["high"], df["low"], lower_length=length, upper_length=length)
    upper, lower = dc[f"DCU_{length}_{length}"], dc[f"DCL_{length}_{length}"]
    close = df["close"]
    entries = close >= upper
    exits = close <= lower
    return entries.fillna(False), exits.fillna(False)


def signals_supertrend(df: pd.DataFrame, length: int = 10, multiplier: float = 3.0) -> Tuple[pd.Series, pd.Series]:
    st = pta.supertrend(df["high"], df["low"], df["close"], length=length, multiplier=multiplier)
    direction = st[f"SUPERTd_{length}_{multiplier}"]
    entries = (direction == 1) & (direction.shift(1) != 1)
    exits = (direction == -1) & (direction.shift(1) != -1)
    return entries.fillna(False), exits.fillna(False)


def signals_macd(df: pd.DataFrame, fast: int = 12, slow: int = 26, signal: int = 9) -> Tuple[pd.Series, pd.Series]:
    m = pta.macd(df["close"], fast=fast, slow=slow, signal=signal)
    macd_line, signal_line = m[f"MACD_{fast}_{slow}_{signal}"], m[f"MACDs_{fast}_{slow}_{signal}"]
    entries = (macd_line > signal_line) & (macd_line.shift(1) <= signal_line.shift(1))
    exits = (macd_line < signal_line) & (macd_line.shift(1) >= signal_line.shift(1))
    return entries.fillna(False), exits.fillna(False)


SIGNAL_FUNCS = {
    "ema-crossover": signals_ema_crossover,
    "rsi": signals_rsi,
    "donchian": signals_donchian,
    "supertrend": signals_supertrend,
    "macd": signals_macd,
}


def strategy_display_name(strategy: str, params: dict) -> str:
    if strategy == "ema-crossover":
        return f"EMA {params['fast']}/{params['slow']} Crossover"
    if strategy == "rsi":
        return f"RSI({params['length']}) {params['buy_below']}/{params['sell_above']}"
    if strategy == "donchian":
        return f"Donchian({params['length']}) Breakout"
    if strategy == "supertrend":
        return f"Supertrend({params['length']}, {params['multiplier']})"
    if strategy == "macd":
        return f"MACD {params['fast']}/{params['slow']}/{params['signal']}"
    return strategy


def stats_to_jsonable(stats: pd.Series) -> dict:
    """pf.stats() mixes floats/ints/Timestamps/Timedeltas — normalize to JSON-safe values."""
    out = {}
    for key, val in stats.items():
        if isinstance(val, (pd.Timestamp, pd.Timedelta)):
            out[key] = str(val)
        elif pd.isna(val):
            out[key] = None
        elif hasattr(val, "item"):
            out[key] = val.item()
        else:
            out[key] = val
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strategy", required=True, choices=STRATEGIES)
    parser.add_argument("--symbol", default="NIFTY")
    parser.add_argument("--asset-type", default="index", choices=["index", "equity"])
    parser.add_argument("--start-date", default="2021-01-01")
    parser.add_argument("--end-date", default=None)
    parser.add_argument("--cost-profile", default="delivery_equity", choices=COST_PROFILES)
    parser.add_argument("--benchmark-symbol", default="NIFTY")

    # Strategy params (only the ones relevant to --strategy are read)
    parser.add_argument("--fast", type=int, default=20)
    parser.add_argument("--slow", type=int, default=50)
    parser.add_argument("--rsi-length", type=int, default=14)
    parser.add_argument("--rsi-buy", type=float, default=30)
    parser.add_argument("--rsi-sell", type=float, default=70)
    parser.add_argument("--donchian-length", type=int, default=20)
    parser.add_argument("--supertrend-length", type=int, default=10)
    parser.add_argument("--supertrend-multiplier", type=float, default=3.0)
    parser.add_argument("--macd-fast", type=int, default=12)
    parser.add_argument("--macd-slow", type=int, default=26)
    parser.add_argument("--macd-signal", type=int, default=9)

    parser.add_argument("--status-file", required=True)
    parser.add_argument("--output-file", required=True)
    parser.add_argument("--tearsheet-file", required=True)
    parser.add_argument("--stop-file", default=None)
    args = parser.parse_args()

    started_at = datetime.now(timezone.utc).isoformat()
    write_status(args.status_file, percent=5, stage="loading_data", started_at=started_at, pid=os.getpid())

    try:
        if args.stop_file and check_stop(args.stop_file):
            write_status(args.status_file, running=False, done=True, stopped=True, percent=0)
            return

        loader = data.load_index_daily if args.asset_type == "index" else data.load_equity_daily
        df = loader(args.symbol)
        df = data.clip_date_range(df, start=args.start_date, end=args.end_date)
        if len(df) < 60:
            raise ValueError(f"Only {len(df)} bars loaded for {args.symbol} in the given date range — need at least 60.")

        write_status(args.status_file, percent=25, stage="computing_signals", started_at=started_at, pid=os.getpid())

        params = {
            "ema-crossover": {"fast": args.fast, "slow": args.slow},
            "rsi": {"length": args.rsi_length, "buy_below": args.rsi_buy, "sell_above": args.rsi_sell},
            "donchian": {"length": args.donchian_length},
            "supertrend": {"length": args.supertrend_length, "multiplier": args.supertrend_multiplier},
            "macd": {"fast": args.macd_fast, "slow": args.macd_slow, "signal": args.macd_signal},
        }[args.strategy]

        entries, exits = SIGNAL_FUNCS[args.strategy](df, **params)
        strategy_name = strategy_display_name(args.strategy, params)

        write_status(args.status_file, percent=50, stage="running_backtest", started_at=started_at, pid=os.getpid())

        cost_profile = costs.get_profile(args.cost_profile)
        run = engine.run_backtest(
            df["close"], entries, exits,
            cost_profile=cost_profile,
            symbol=args.symbol,
            strategy_name=strategy_name,
        )

        write_status(args.status_file, percent=75, stage="comparing_benchmark", started_at=started_at, pid=os.getpid())

        benchmark_close = data.load_index_daily(args.benchmark_symbol)["close"]
        comparison = engine.compare_to_benchmark(run, benchmark_close)

        write_status(args.status_file, percent=90, stage="generating_tearsheet", started_at=started_at, pid=os.getpid())

        benchmark_returns = data.load_benchmark_returns(run.portfolio.wrapper.index, symbol=args.benchmark_symbol)
        tearsheet_path = tearsheet.generate_tearsheet(
            run.portfolio.returns(),
            strategy_name=f"{strategy_name} - {args.symbol}",
            output_path=args.tearsheet_file,
            benchmark_returns=benchmark_returns,
            open_browser=False,
        )
        mc_summary = tearsheet.monte_carlo_summary(run.portfolio.returns())

        result = {
            "strategy": args.strategy,
            "strategy_name": strategy_name,
            "symbol": args.symbol,
            "asset_type": args.asset_type,
            "cost_profile": args.cost_profile,
            "params": params,
            "start_date": args.start_date,
            "end_date": args.end_date,
            "bars": len(df),
            "stats": stats_to_jsonable(run.portfolio.stats()),
            "comparison": comparison.to_dict(orient="records"),
            "tearsheet_available": tearsheet_path is not None,
            "monte_carlo_summary": mc_summary,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

        tmp = args.output_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump(result, f)
        os.replace(tmp, args.output_file)

        write_status(args.status_file, running=False, done=True, percent=100,
                     started_at=started_at, pid=os.getpid())

    except Exception as exc:  # noqa: BLE001 — surface any failure to the dashboard, not just a traceback in a dead process
        write_status(args.status_file, running=False, done=True, error=str(exc), percent=0,
                     started_at=started_at, pid=os.getpid())
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
