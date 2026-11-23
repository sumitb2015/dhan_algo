#!/usr/bin/env python3
"""
Multi-Strategy Backtest & Performance Comparison on Nifty 500 Historical Data.

Every momentum model in the /momentum replay (Turtle RS and its optimised variant, Minervini, 52-Week High,
Clenow, EMA + Supertrend, RS + Supertrend, Weinstein) is run through the replay engine itself, so the table
describes the same rules the replay and the live bot use. Connors RSI-2 (mean reversion) is a contrast with its
own runner below; it fills at the signal day's close, which flatters it slightly.

Outputs CAGR, Max Drawdown, Sharpe Ratio, Win Rate, Total Trades, and Profit Factor.
"""

from __future__ import annotations

import math
import os
from concurrent.futures import ProcessPoolExecutor
import sys
import json
from dataclasses import dataclass
from datetime import date, datetime
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, PROJECT_ROOT)

DEBUG_DIR = os.path.join(PROJECT_ROOT, "debug")

from lib.scanner_score import SCANNER_TOP_DEFAULTS as _SCAN
from lib.momentum import (
    MomentumConfig,
    load_benchmark,
    load_price_map,
    load_universe,
)

STOCK_DIR = os.path.join(PROJECT_ROOT, "Daily_Historical_Data_Fresh")


@dataclass
class TradeRecord:
    strategy: str
    symbol: str
    entry_date: date
    exit_date: date
    entry_price: float
    exit_price: float
    qty: int
    invested: float
    pnl: float
    pnl_pct: float
    exit_reason: str
    hold_days: int


def _replay_worker(job):
    """Run one model through the replay engine in a worker process; return only what the table needs (a full replay
    payload carries every daily snapshot and is too large to ship back between processes)."""
    label, strategy, cfg_kw, capital, slots, start_date, end_date = job
    from scripts.analysis.simulate_momentum_replay import run_replay_simulation, default_stop_pct
    kw = dict(slots=slots, stop_pct=default_stop_pct(strategy))
    kw.update(cfg_kw)                                        # a model may override slots / stop / sector cap
    cfg = MomentumConfig(universe="nifty500", capital=capital, regime_enabled=True, **kw)
    sim = run_replay_simulation(cfg, start_date, end_date, strategy=strategy)
    eq = pd.Series({datetime.strptime(x["date"], "%Y-%m-%d").date(): x["equity"] for x in sim["snapshots"]})
    trades = [
        TradeRecord(label, t["symbol"],
                    datetime.strptime(t["entry_date"], "%Y-%m-%d").date(),
                    datetime.strptime(t["exit_date"], "%Y-%m-%d").date(),
                    t["entry_price"], t["exit_price"], t["qty"], t["invested"], t["pnl"], t["pnl_pct"],
                    t["exit_reason"], t["hold_days"])
        for t in sim["closed_trades"]
    ]
    return label, eq, trades


def calculate_metrics(equity_series: pd.Series, trades: List[TradeRecord], initial_capital: float) -> dict:
    if equity_series.empty or len(equity_series) < 2:
        return {}

    final_val = float(equity_series.iloc[-1])
    days = (equity_series.index[-1] - equity_series.index[0]).days
    years = max(days / 365.25, 0.1)

    cagr = ((final_val / initial_capital) ** (1.0 / years) - 1.0) * 100.0 if final_val > 0 else -100.0

    curve = equity_series.to_numpy(dtype=float)
    peak = np.maximum.accumulate(curve)
    drawdowns = (curve - peak) / peak
    max_dd = float(drawdowns.min() * 100.0)

    daily_ret = equity_series.pct_change().dropna()
    sharpe = float(daily_ret.mean() / daily_ret.std() * np.sqrt(252)) if daily_ret.std() > 0 else 0.0

    wins = [t for t in trades if t.pnl > 0]
    losses = [t for t in trades if t.pnl <= 0]
    win_rate = (len(wins) / len(trades) * 100.0) if trades else 0.0

    gross_profit = sum(t.pnl for t in wins)
    gross_loss = abs(sum(t.pnl for t in losses))
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else (99.0 if gross_profit > 0 else 0.0)

    avg_gain = np.mean([t.pnl_pct for t in wins]) if wins else 0.0
    avg_loss = np.mean([t.pnl_pct for t in losses]) if losses else 0.0
    calmar = abs(cagr / max_dd) if max_dd != 0 else 0.0

    return {
        "final_equity": round(final_val, 2),
        "cagr_pct": round(cagr, 2),
        "max_drawdown_pct": round(max_dd, 2),
        "sharpe": round(sharpe, 2),
        "calmar": round(calmar, 2),
        "total_trades": len(trades),
        "win_rate_pct": round(win_rate, 1),
        "profit_factor": round(profit_factor, 2),
        "avg_gain_pct": round(avg_gain, 1),
        "avg_loss_pct": round(avg_loss, 1),
    }


def main():
    print("=" * 80)
    print("MULTI-STRATEGY COMPARATIVE RESEARCH & BACKTEST (NIFTY 500)")
    print("=" * 80)

    bench = load_benchmark()
    universe = load_universe("nifty500")
    symbols = [u["symbol"] for u in universe]
    print(f"Loading daily price map for {len(symbols)} Nifty 500 constituents...")
    price_map = load_price_map(symbols, min_bars=250)
    print(f"Loaded {len(price_map)} stocks with sufficient history.")

    # Benchmark dates
    bench_dates = sorted(set(bench["date"]))
    start_date = max(date(2019, 6, 1), bench_dates[250])
    end_date = bench_dates[-1]
    print(f"Backtest period: {start_date} to {end_date} ({(end_date - start_date).days / 365.25:.1f} years)")

    capital = 500_000.0
    slots = 10
    slot_alloc = capital / slots

    # Precompute common indicators across all symbols
    print("Precomputing indicators (Moving Averages, Breakouts, ATR, 52W Highs, Slopes)...")
    indicators = {}
    for sym, df in price_map.items():
        closes = df["close"].values
        highs = df["high"].values
        lows = df["low"].values
        volumes = df["volume"].values
        dates = list(df["date"])

        n = len(df)
        if n < 250:
            continue

        c_series = pd.Series(closes)
        ema20 = c_series.ewm(span=20, adjust=False).mean().values
        ema50 = c_series.ewm(span=50, adjust=False).mean().values
        sma50 = c_series.rolling(50, min_periods=50).mean().values
        sma100 = c_series.rolling(100, min_periods=100).mean().values
        sma150 = c_series.rolling(150, min_periods=150).mean().values
        sma200 = c_series.rolling(200, min_periods=200).mean().values
        vol20 = pd.Series(volumes).rolling(20, min_periods=10).mean().values

        # 55-day and 20-day Donchian highs
        high55 = c_series.rolling(55, min_periods=55).max().shift(1).values
        high20 = c_series.rolling(20, min_periods=20).max().shift(1).values

        # 52-week (250-day) high & low
        high250 = pd.Series(highs).rolling(250, min_periods=200).max().shift(1).values
        low250 = pd.Series(lows).rolling(250, min_periods=200).min().shift(1).values

        # ATR 14
        tr = np.maximum(highs - lows, np.maximum(abs(highs - np.roll(closes, 1)), abs(lows - np.roll(closes, 1))))
        tr[0] = highs[0] - lows[0]
        atr14 = pd.Series(tr).rolling(14, min_periods=14).mean().values

        # RSI 2
        delta = c_series.diff()
        gain = delta.clip(lower=0)
        loss = -delta.clip(upper=0)
        avg_gain = gain.rolling(2, min_periods=2).mean()
        avg_loss = loss.rolling(2, min_periods=2).mean()
        rs = avg_gain / avg_loss.replace(0, np.nan)
        rsi2 = (100 - (100 / (1 + rs))).fillna(50).values

        # Clenow exponential regression slope * R^2 over 90 days (fast vectorized)
        clenow_score = np.zeros(n)
        dx = np.arange(90) - 44.5
        sxx = 60742.5
        for i in range(90, n):
            sub_y = closes[i - 90:i]
            if np.all(sub_y > 0):
                y = np.log(sub_y)
                sxy = float(np.dot(dx, y))
                slope = sxy / sxx
                dy = y - np.mean(y)
                syy = float(np.dot(dy, dy))
                r2 = (sxy * sxy) / (sxx * syy) if syy > 0 else 0.0
                ann_slope = (math.exp(slope * 250.0) - 1.0) * 100.0
                clenow_score[i] = ann_slope * r2

        # 15% 1-day gap filter: max daily absolute return over past 90 days
        daily_ret = c_series.pct_change().abs()
        max_gap_90 = daily_ret.rolling(90, min_periods=90).max().values

        # 200 SMA rising check (22 trading days ago)
        sma200_prev = pd.Series(sma200).shift(22).values

        # 6-month composite RS score for ranking
        rs_score = (c_series / c_series.shift(126) - 1.0).fillna(0.0).values

        date_idx = {d: i for i, d in enumerate(dates)}
        indicators[sym] = {
            "dates": date_idx,
            "closes": closes,
            "highs": highs,
            "lows": lows,
            "opens": df["open"].values,
            "volumes": volumes,
            "ema20": ema20,
            "ema50": ema50,
            "sma50": sma50,
            "sma100": sma100,
            "sma150": sma150,
            "sma200": sma200,
            "sma200_prev": sma200_prev,
            "vol20": vol20,
            "high55": high55,
            "high20": high20,
            "high250": high250,
            "low250": low250,
            "atr14": atr14,
            "rsi2": rsi2,
            "clenow": clenow_score,
            "max_gap_90": max_gap_90,
            "rs_score": rs_score,
        }

    # Benchmark regime (Nifty 500 vs daily 200 SMA)
    bench_closes = bench["close"].values
    bench_sma200 = pd.Series(bench_closes).rolling(200, min_periods=200).mean().values
    bench_date_idx = {d: i for i, d in enumerate(bench["date"])}

    trading_days = [d for d in bench_dates if d >= start_date]

    # Run simulations
    print("\nRunning backtests across every momentum model plus Connors RSI-2...")

    results = {}

    # ──────────────────────────────────────────────────────────────────────────
    # 4. Strategy: Connors RSI-2 Mean Reversion Swing
    # ──────────────────────────────────────────────────────────────────────────
    def run_connors_rsi2():
        cash = capital
        portfolio = {}
        trades = []
        equity_records = {}

        for d_idx, d in enumerate(trading_days):
            b_i = bench_date_idx.get(d)
            regime_on = (bench_closes[b_i] > bench_sma200[b_i]) if (b_i and not np.isnan(bench_sma200[b_i])) else True

            for sym, pos in list(portfolio.items()):
                ind = indicators[sym]
                i = ind["dates"].get(d)
                if i is None:
                    continue
                px = ind["closes"][i]
                hold_d = (d - pos["entry_date"]).days

                # Exit rule: Close > 5-day SMA or holding > 6 days or stop 6%
                sma5 = np.mean(ind["closes"][max(0, i-4):i+1])
                if px > sma5 or hold_d >= 6 or px < pos["entry_price"] * 0.94:
                    proceeds = px * pos["qty"] * 0.998
                    cost = pos["entry_price"] * pos["qty"] * 1.002
                    pnl = proceeds - cost
                    trades.append(TradeRecord("Connors_RSI2", sym, pos["entry_date"], d, pos["entry_price"], px, pos["qty"], cost, pnl, (pnl / cost) * 100, "RSI2_EXIT", hold_d))
                    cash += proceeds
                    del portfolio[sym]

            # Daily scan when regime ON
            if regime_on:
                free_slots = slots - len(portfolio)
                if free_slots > 0:
                    candidates = []
                    for sym, ind in indicators.items():
                        if sym in portfolio:
                            continue
                        i = ind["dates"].get(d)
                        if i is None or i < 200:
                            continue
                        px = ind["closes"][i]
                        # Connors: Close > 200 SMA, RSI(2) < 10
                        if px > ind["sma200"][i] and ind["rsi2"][i] < 10 and ind["volumes"][i] > ind["vol20"][i] * 0.8:
                            candidates.append((sym, ind["rsi2"][i], px))

                    # Lowest RSI first (deepest oversold)
                    candidates.sort(key=lambda x: x[1])
                    for sym, _, px in candidates[:free_slots]:
                        alloc = (cash / free_slots) * 0.95
                        qty = int(alloc // px)
                        if qty > 0 and cash >= px * qty * 1.002:
                            spend = px * qty * 1.002
                            cash -= spend
                            portfolio[sym] = {
                                "entry_date": d,
                                "entry_price": px,
                                "qty": qty,
                                "peak_price": px,
                            }
                            free_slots -= 1

            # End of day Mark-to-market
            total_val = cash
            for sym, pos in portfolio.items():
                ind = indicators[sym]
                i = ind["dates"].get(d)
                px = ind["closes"][i] if i is not None else pos["entry_price"]
                total_val += px * pos["qty"]
            equity_records[d] = total_val

        return pd.Series(equity_records), trades

    # ──────────────────────────────────────────────────────────────────────────
    # Every momentum model runs through the replay engine (simulate_momentum_replay.py), i.e. the same rules,
    # fills, costs, compounding and data-gap handling the /momentum replay and the live bot use. This file used to
    # carry its own copies of the 52W / Clenow / Minervini rules, which had drifted from lib/. Only Connors RSI-2,
    # a mean-reversion contrast the replay does not implement, keeps a runner here.
    # ──────────────────────────────────────────────────────────────────────────

    # Keys must match STRATEGY_DETAILS in rs_dashboard/components/StrategyBenchmarkPanel.tsx.
    replay_models = [
        ("1. EMA & Supertrend (Trend Follower)", "ema_supertrend", {"breakout_days": 20}),
        ("2. Andreas Clenow Momentum", "clenow", {}),
        ("3. Minervini Trend Template", "minervini", {"breakout_days": 20}),
        ("4. 52-Week High Breakout", "52w_high", {"breakout_days": 5}),
        ("5. Current Turtle RS Breakout", "turtle_rs", {}),
        ("5b. Turtle RS Optimised", "turtle_rs_opt", {}),
        ("7. RS + Supertrend (Vivek Bajaj)", "rs_supertrend", {"breakout_days": 20}),
        ("8. Weinstein Stage 2", "weinstein", {}),
        ("9. Scanner Top-N", "scanner_top", {"slots": _SCAN["n"], "sector_cap": _SCAN["sector_cap"]}),
    ]
    strategies = {}
    print(f"Running {len(replay_models)} replay models in parallel (cached replays are reused)...")
    jobs = [(label, key, kw, capital, slots, start_date, end_date) for label, key, kw in replay_models]
    with ProcessPoolExecutor(max_workers=min(4, os.cpu_count() or 1)) as pool:
        for label, eq, trades in pool.map(_replay_worker, jobs):
            strategies[label] = (eq, trades)
            print(f"  done: {label} ({len(trades)} trades)")

    print("Running Connors RSI-2 Mean Reversion Swing...")
    strategies["6. Connors RSI-2 Mean Reversion"] = run_connors_rsi2()
    strategies = dict(sorted(strategies.items()))

    summary_rows = []
    for name, (eq_s, tr_list) in strategies.items():
        stats = calculate_metrics(eq_s, tr_list, capital)
        summary_rows.append({
            "Strategy": name,
            "CAGR (%)": f"{stats.get('cagr_pct', 0):+.2f}%",
            "Max Drawdown": f"{stats.get('max_drawdown_pct', 0):.2f}%",
            "Sharpe": f"{stats.get('sharpe', 0):.2f}",
            "Calmar": f"{stats.get('calmar', 0):.2f}",
            "Win Rate": f"{stats.get('win_rate_pct', 0):.1f}%",
            "Profit Factor": f"{stats.get('profit_factor', 0):.2f}",
            "Total Trades": stats.get('total_trades', 0),
            "Final Value (5L)": f"Rs {stats.get('final_equity', 0):,.0f}",
        })

    df_summary = pd.DataFrame(summary_rows)
    print("\n" + "=" * 90)
    print(f"BACKTEST PERFORMANCE COMPARISON ({start_date} to {end_date}, NIFTY 500)")
    print("=" * 90)
    print(df_summary.to_string(index=False))
    print("=" * 90)

    # Save to JSON for UI consumption
    output_path = os.path.join(DEBUG_DIR, "strategy_comparison_results.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(summary_rows, f, indent=2)
    print(f"\nSaved strategy comparison payload to {output_path}")


if __name__ == "__main__":
    main()
