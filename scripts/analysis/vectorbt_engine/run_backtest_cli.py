"""
CLI entry point for the VectorBT Options Backtester dashboard terminal
(rs_dashboard `/backtest-signals`, `app/api/backtest-vectorbt/route.ts`).

Runs the exact same multi-leg options simulation as `/backtest`
(backtest_short_straddle.py — same LegConfig, same bar-by-bar entry/SL/target/
trailing-SL/roll decisions) and additionally feeds the resulting per-leg
trades into a grouped, cash-shared vbt.Portfolio (options_engine.py) so
VectorBT computes its own Sharpe/Sortino/drawdown/tearsheet from those same
trades — see options_engine.py's module docstring for exactly how leg trades
map into vbt.Portfolio.from_signals and the two simplifications that implies.

Writes status/result JSON in the same spawn+poll shape every other
dashboard-triggered Python job uses (see app/api/backtest/route.ts):
progress to --status-file as it runs, the final result (custom-engine
cycles/summary/equity_curve plus a "vbt" sub-object) to --output-file, and a
fixed-path OpenStatz tearsheet HTML served by
app/api/backtest-vectorbt/report/route.ts.

Usage:
    venv/bin/python scripts/analysis/vectorbt_engine/run_backtest_cli.py \\
        --start-date 2026-08-17 --end-date 2026-09-15 \\
        --legs '[{"option_type":"CE","position":"sell","lots":1,"strike":"ATM","leg_sl_pct":0,"leg_target_pct":0},
                 {"option_type":"PE","position":"sell","lots":1,"strike":"ATM","leg_sl_pct":0,"leg_target_pct":0}]' \\
        --use-db \\
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

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, ROOT)

import pandas as pd  # noqa: E402

from scripts.analysis import backtest_short_straddle as sb  # noqa: E402
from scripts.analysis.vectorbt_engine import costs, data, options_engine, tearsheet  # noqa: E402

COST_PROFILES = list(costs.PROFILES.keys())
DEFAULT_LEGS = json.dumps(sb.DEFAULT_LEGS)


def write_status(status_file: str, **fields) -> None:
    payload = {"running": True, "done": False, "percent": 0, **fields}
    tmp = status_file + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, status_file)


def stats_to_jsonable(stats: "pd.Series") -> dict:
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
    parser.add_argument("--start-date", default="2021-01-01")
    parser.add_argument("--end-date", default="2026-06-30")
    parser.add_argument("--lot-size", type=int, default=65)
    parser.add_argument("--entry-time", default="09:20")
    parser.add_argument("--eod-time", default="15:15")
    parser.add_argument("--profit-target-pct", type=float, default=50.0)
    parser.add_argument("--overall-sl-pct", type=float, default=0.0)
    parser.add_argument("--commission-per-lot", type=float, default=40.0)
    parser.add_argument("--slippage-pct", type=float, default=0.0)
    parser.add_argument("--strategy-type", default="intraday", choices=["intraday", "expiry_day", "first_day"])
    parser.add_argument("--legs", default=DEFAULT_LEGS)
    parser.add_argument("--use-db", action="store_true", help="Use SQLite database for option price lookups")
    parser.add_argument("--adjustment-mode", default="none", choices=["none", "rolling_straddle"])
    parser.add_argument("--roll-buffer", type=float, default=35.0)
    parser.add_argument("--roll-type", default="points", choices=["points", "percentage"])
    parser.add_argument("--max-rolls", type=int, default=5)
    parser.add_argument("--scalp-floor-pct", type=float, default=0.0)
    parser.add_argument("--trail-sl-pct", type=float, default=0.0)
    parser.add_argument("--square-off-mode", default="one_leg", choices=["one_leg", "all_legs"])
    parser.add_argument("--max-diff-pct", type=float, default=0.0)
    parser.add_argument("--entry-cutoff-time", default="15:00")
    parser.add_argument("--cost-profile", default="fno_options", choices=COST_PROFILES)
    parser.add_argument("--benchmark-symbol", default="NIFTY")
    parser.add_argument("--status-file", required=True)
    parser.add_argument("--output-file", required=True)
    parser.add_argument("--tearsheet-file", required=True)
    args = parser.parse_args()

    started_at = datetime.now(timezone.utc).isoformat()
    write_status(args.status_file, percent=0, current=0, total=0, started_at=started_at, pid=os.getpid())

    try:
        legs_raw = json.loads(args.legs)
        leg_configs = [sb.LegConfig(**l) for l in legs_raw]

        db_conn = None
        if args.use_db:
            import sqlite3
            db_path = os.path.join(ROOT, "Options Data", "nifty_options.db")
            if not os.path.exists(db_path):
                raise FileNotFoundError(
                    f"Database not found at {db_path}. Please run "
                    f"scripts/analysis/convert_options_to_sqlite.py first."
                )
            db_conn = sqlite3.connect(db_path, check_same_thread=False)

        vix_map = sb._load_vix()
        cycles = sb.fetch_multi_leg_cycles(args.start_date, args.end_date, leg_configs, db_conn=db_conn, status_file=args.status_file)

        engine_result = sb.run_backtest(
            leg_configs=leg_configs,
            cycles=cycles,
            lot_size=args.lot_size,
            commission_per_lot=args.commission_per_lot,
            slippage_pct=args.slippage_pct,
            entry_time_str=args.entry_time,
            eod_time_str=args.eod_time,
            profit_target_pct=args.profit_target_pct,
            overall_sl_pct=args.overall_sl_pct,
            vix_map=vix_map,
            strategy_type=args.strategy_type,
            start_date=args.start_date,
            end_date=args.end_date,
            adjustment_mode=args.adjustment_mode,
            roll_buffer=args.roll_buffer,
            roll_type=args.roll_type,
            max_rolls=args.max_rolls,
            scalp_floor_pct=args.scalp_floor_pct,
            trail_sl_pct=args.trail_sl_pct,
            square_off_mode=args.square_off_mode,
            max_diff_pct=args.max_diff_pct,
            entry_cutoff_time_str=args.entry_cutoff_time,
            status_file=args.status_file,
        )
        if db_conn:
            db_conn.close()

        engine_result["params"] = {
            "start_date": args.start_date, "end_date": args.end_date, "lot_size": args.lot_size,
            "entry_time": args.entry_time, "eod_time": args.eod_time,
            "profit_target_pct": args.profit_target_pct, "overall_sl_pct": args.overall_sl_pct,
            "commission_per_lot": args.commission_per_lot, "slippage_pct": args.slippage_pct,
            "strategy_type": args.strategy_type, "legs": legs_raw,
            "adjustment_mode": args.adjustment_mode, "roll_buffer": args.roll_buffer,
            "roll_type": args.roll_type, "max_rolls": args.max_rolls,
            "scalp_floor_pct": args.scalp_floor_pct, "trail_sl_pct": args.trail_sl_pct,
            "square_off_mode": args.square_off_mode,
            "max_diff_pct": args.max_diff_pct,
            "entry_cutoff_time": args.entry_cutoff_time,
        }

        write_status(args.status_file, percent=95, stage="vectorbt_stats",
                     total=engine_result["summary"]["traded_cycles"],
                     current=engine_result["summary"]["traded_cycles"],
                     started_at=started_at, pid=os.getpid())

        cost_profile = costs.get_profile(args.cost_profile)
        vbt_block = None
        try:
            pf = options_engine.run_vbt_options_portfolio(
                cycles=engine_result["cycles"],
                leg_configs=legs_raw,
                lot_size=args.lot_size,
                commission_per_lot=args.commission_per_lot,
                cost_profile=cost_profile,
            )
            if pf is not None:
                strat_daily_returns = options_engine.daily_returns(pf)

                bench_df = data.clip_date_range(
                    data.load_index_daily(args.benchmark_symbol),
                    start=args.start_date, end=args.end_date,
                )
                bench_return = (
                    bench_df["close"].iloc[-1] / bench_df["close"].iloc[0] - 1
                    if len(bench_df) > 1 else 0.0
                )

                comparison = pd.DataFrame([
                    ("Total Return", f"{pf.total_return():.2%}", f"{bench_return:.2%}"),
                    ("Sharpe Ratio", f"{pf.sharpe_ratio():.2f}", "-"),
                    ("Sortino Ratio", f"{pf.sortino_ratio():.2f}", "-"),
                    ("Max Drawdown", f"{pf.max_drawdown():.2%}", "-"),
                    ("Win Rate", f"{pf.trades.win_rate():.2%}" if pf.trades.count() else "-", "-"),
                    ("Trades", f"{pf.trades.count()}", "-"),
                    ("Profit Factor", f"{pf.trades.profit_factor():.2f}" if pf.trades.count() else "-", "-"),
                ], columns=["Metric", "VectorBT Engine", "Benchmark (Buy & Hold)"])

                bench_daily_returns = bench_df["close"].pct_change().reindex(
                    strat_daily_returns.index
                ).fillna(0.0)
                tearsheet_path = tearsheet.generate_tearsheet(
                    strat_daily_returns, strategy_name="Multi-Leg Options (VectorBT)",
                    output_path=args.tearsheet_file,
                    benchmark_returns=bench_daily_returns,
                    benchmark_name=args.benchmark_symbol,
                    open_browser=False,
                )
                mc_summary = tearsheet.monte_carlo_summary(strat_daily_returns)

                vbt_block = {
                    "stats": stats_to_jsonable(pf.stats()),
                    "comparison": comparison.to_dict(orient="records"),
                    "tearsheet_available": tearsheet_path is not None,
                    "monte_carlo_summary": mc_summary,
                }
        except Exception as vbt_exc:  # noqa: BLE001 — VectorBT stats are a bonus; never fail the whole run over them
            print(f"warning: VectorBT stats failed: {vbt_exc}", file=sys.stderr)
            traceback.print_exc()
            vbt_block = {"error": str(vbt_exc)}

        engine_result["vbt"] = vbt_block
        engine_result["generated_at"] = datetime.now(timezone.utc).isoformat()

        tmp = args.output_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump(engine_result, f)
        os.replace(tmp, args.output_file)

        write_status(args.status_file, running=False, done=True, percent=100,
                     total=engine_result["summary"]["traded_cycles"],
                     current=engine_result["summary"]["traded_cycles"],
                     trades=engine_result["summary"]["traded_cycles"],
                     pnl=engine_result["summary"]["total_pnl"],
                     started_at=started_at, pid=os.getpid())

    except Exception as exc:  # noqa: BLE001 — surface any failure to the dashboard, not just a traceback in a dead process
        write_status(args.status_file, running=False, done=True, error=str(exc), percent=0,
                     started_at=started_at, pid=os.getpid())
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
