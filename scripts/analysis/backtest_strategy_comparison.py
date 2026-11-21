#!/usr/bin/env python3
"""
Multi-Strategy Backtest & Performance Comparison on Nifty 500 Historical Data.

Compares 5 popular systematic equity strategies:
1. Composite RS Breakout (Current "Turtle Momentum")
2. Andreas Clenow "Stocks on the Move" (Smooth Exponential Slope * R^2)
3. 52-Week High Breakout (George & Hwang Yearly High Anomaly)
4. Minervini Trend Template (Stage 2 Superperformance)
5. Connors RSI-2 Mean Reversion (Swing Dip-Buying in Uptrends)

Outputs CAGR, Max Drawdown, Sharpe Ratio, Win Rate, Total Trades, and Profit Factor.
"""

from __future__ import annotations

import math
import os
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
    print("\nRunning backtests across the 5 candidate strategies...")

    results = {}

    # ──────────────────────────────────────────────────────────────────────────
    # 1. Strategy: 52-Week High Breakout Momentum (George & Hwang 2004)
    # ──────────────────────────────────────────────────────────────────────────
    def run_52w_high_momentum():
        cash = capital
        portfolio = {}  # sym -> {entry_date, entry_price, qty, peak_price, stop_price}
        trades = []
        equity_records = {}

        for d_idx, d in enumerate(trading_days):
            b_i = bench_date_idx.get(d)
            regime_on = (bench_closes[b_i] > bench_sma200[b_i]) if (b_i and not np.isnan(bench_sma200[b_i])) else True

            # Check trailing stops & exits
            for sym, pos in list(portfolio.items()):
                ind = indicators[sym]
                i = ind["dates"].get(d)
                if i is None:
                    continue
                px = ind["closes"][i]
                pos["peak_price"] = max(pos["peak_price"], px)
                # Trailing stop: 12% below running peak
                stop = pos["peak_price"] * 0.88
                pos["stop_price"] = max(pos["stop_price"], stop)

                # Check stop exit
                if px < pos["stop_price"]:
                    proceeds = px * pos["qty"] * 0.998  # fees
                    cost = pos["entry_price"] * pos["qty"] * 1.002
                    pnl = proceeds - cost
                    trades.append(TradeRecord("52W_High", sym, pos["entry_date"], d, pos["entry_price"], px, pos["qty"], cost, pnl, (pnl / cost) * 100, "STOP", (d - pos["entry_date"]).days))
                    cash += proceeds
                    del portfolio[sym]

            # Daily scan for true 52-week high breakouts
            if regime_on:
                free_slots = slots - len(portfolio)
                if free_slots > 0:
                    candidates = []
                    for sym, ind in indicators.items():
                        if sym in portfolio:
                            continue
                        i = ind["dates"].get(d)
                        if i is None or i < 250:
                            continue
                        px = ind["closes"][i]
                        h250 = ind["high250"][i]
                        if np.isnan(h250) or h250 <= 0:
                            continue
                        # True 52-week high breakout, within 5% extension, stacked MAs, volume confirmation
                        if (px >= h250 and px <= h250 * 1.05 and
                            px > ind["sma50"][i] > ind["sma200"][i] and
                            ind["volumes"][i] >= ind["vol20"][i]):
                            proximity = px / h250
                            candidates.append((sym, proximity, px))

                    candidates.sort(key=lambda x: x[1], reverse=True)
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
                                "stop_price": px * 0.88,
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
    # 2. Strategy: Andreas Clenow "Stocks on the Move" (Slope * R^2)
    # ──────────────────────────────────────────────────────────────────────────
    def run_clenow_momentum():
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
                pos["peak_price"] = max(pos["peak_price"], px)

                # Exit rule: Close below 100-day SMA, or disaster stop 15%
                if px < ind["sma100"][i] or px < pos["entry_price"] * 0.85:
                    proceeds = px * pos["qty"] * 0.998
                    cost = pos["entry_price"] * pos["qty"] * 1.002
                    pnl = proceeds - cost
                    trades.append(TradeRecord("Clenow", sym, pos["entry_date"], d, pos["entry_price"], px, pos["qty"], cost, pnl, (pnl / cost) * 100, "SMA100_EXIT", (d - pos["entry_date"]).days))
                    cash += proceeds
                    del portfolio[sym]

            # Weekly review: Rotation & new entries
            if d.weekday() == 0 and regime_on:
                # Rank universe by Clenow score today
                all_scores = []
                for sym, ind in indicators.items():
                    i = ind["dates"].get(d)
                    if i is not None and i >= 90:
                        all_scores.append((sym, ind["clenow"][i]))
                all_scores.sort(key=lambda x: x[1], reverse=True)
                n_scored = len(all_scores)
                pct_ranks = {s: 100.0 * (n_scored - 1 - idx) / max(1, n_scored - 1) for idx, (s, _) in enumerate(all_scores)}

                # Rotation exit: sell holdings falling out of top 20% (percentile < 80)
                for sym in list(portfolio.keys()):
                    if pct_ranks.get(sym, 0.0) < 80.0:
                        pos = portfolio[sym]
                        ind = indicators[sym]
                        i = ind["dates"].get(d)
                        px = ind["closes"][i] if i is not None else pos["entry_price"]
                        proceeds = px * pos["qty"] * 0.998
                        cost = pos["entry_price"] * pos["qty"] * 1.002
                        pnl = proceeds - cost
                        trades.append(TradeRecord("Clenow", sym, pos["entry_date"], d, pos["entry_price"], px, pos["qty"], cost, pnl, (pnl / cost) * 100, "ROTATION", (d - pos["entry_date"]).days))
                        cash += proceeds
                        del portfolio[sym]

                free_slots = slots - len(portfolio)
                if free_slots > 0:
                    candidates = []
                    for sym, ind in indicators.items():
                        if sym in portfolio:
                            continue
                        i = ind["dates"].get(d)
                        if i is None or i < 90:
                            continue
                        score = ind["clenow"][i]
                        px = ind["closes"][i]
                        # Clenow gates: score > 0, px > 100 SMA & 200 SMA, 15% gap filter
                        if score > 0 and px > ind["sma100"][i] and px > ind["sma200"][i] and ind["max_gap_90"][i] <= 0.15:
                            candidates.append((sym, score, px))

                    candidates.sort(key=lambda x: x[1], reverse=True)
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
                                "stop_price": px * 0.85,
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
    # 3. Strategy: Minervini Trend Template (Stage 2 Superperformance)
    # ──────────────────────────────────────────────────────────────────────────
    def run_minervini_trend():
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
                pos["peak_price"] = max(pos["peak_price"], px)

                # Minervini 12% initial stop, trailing 50 SMA once up 15%
                gain_pct = (pos["peak_price"] / pos["entry_price"] - 1.0) * 100
                if gain_pct >= 15.0:
                    pos["stop_price"] = max(pos["stop_price"], ind["sma50"][i])

                if px < pos["stop_price"]:
                    proceeds = px * pos["qty"] * 0.998
                    cost = pos["entry_price"] * pos["qty"] * 1.002
                    pnl = proceeds - cost
                    trades.append(TradeRecord("Minervini", sym, pos["entry_date"], d, pos["entry_price"], px, pos["qty"], cost, pnl, (pnl / cost) * 100, "STOP", (d - pos["entry_date"]).days))
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
                        if i is None or i < 250:
                            continue
                        px = ind["closes"][i]
                        sma50 = ind["sma50"][i]
                        sma150 = ind["sma150"][i]
                        sma200 = ind["sma200"][i]
                        sma200_prev = ind["sma200_prev"][i]
                        h250 = ind["high250"][i]
                        l250 = ind["low250"][i]
                        h20 = ind["high20"][i]

                        # Full Minervini Trend Template:
                        # 1. Price > 50 > 150 > 200 SMA
                        # 2. 200 SMA rising (higher than 22 bars ago)
                        # 3. Price >= 25% above 52W low
                        # 4. Price within 20% of 52W high
                        # 5. Breakout of 20-day high without being extended > 5%
                        # 6. Volume >= 20d avg
                        if (px > sma50 > sma150 > sma200 and
                            sma200 > sma200_prev and
                            px >= l250 * 1.25 and
                            px >= h250 * 0.80 and
                            px >= h20 and px <= h20 * 1.05 and
                            ind["volumes"][i] >= ind["vol20"][i]):
                            # Rank candidates by RS score
                            score = ind["rs_score"][i]
                            candidates.append((sym, score, px))

                    candidates.sort(key=lambda x: x[1], reverse=True)
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
                                "stop_price": px * 0.88,
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
    # 5. Current Turtle RS Momentum (Benchmark from lib/momentum.py)
    # ──────────────────────────────────────────────────────────────────────────
    from scripts.analysis.simulate_momentum_replay import run_replay_simulation
    cfg_turtle = MomentumConfig(universe="nifty500", capital=capital, slots=slots, regime_enabled=True)
    turtle_sim = run_replay_simulation(cfg_turtle, start_date, end_date)
    turtle_snaps = turtle_sim["snapshots"]
    turtle_eq = pd.Series({datetime.strptime(s["date"], "%Y-%m-%d").date(): s["equity"] for s in turtle_snaps})
    turtle_trades = [
        TradeRecord(
            "Turtle_RS",
            t["symbol"],
            datetime.strptime(t["entry_date"], "%Y-%m-%d").date(),
            datetime.strptime(t["exit_date"], "%Y-%m-%d").date(),
            t["entry_price"],
            t["exit_price"],
            t["qty"],
            t["invested"],
            t["pnl"],
            t["pnl_pct"],
            t["exit_reason"],
            t["hold_days"],
        )
        for s in turtle_snaps for t in s.get("closed_trades", [])
    ]
    # Deduplicate trades (closed_trades list accumulates)
    seen = set()
    unique_turtle_trades = []
    for t in turtle_trades:
        key = (t.symbol, t.entry_date, t.exit_date)
        if key not in seen:
            seen.add(key)
            unique_turtle_trades.append(t)

    print("Running 52W High Breakout Momentum...")
    eq_52w, trades_52w = run_52w_high_momentum()

    print("Running Andreas Clenow 'Stocks on the Move'...")
    eq_clenow, trades_clenow = run_clenow_momentum()

    print("Running Minervini Trend Template (Stage 2 Superperformance)...")
    eq_minervini, trades_minervini = run_minervini_trend()

    print("Running Connors RSI-2 Mean Reversion Swing...")
    eq_rsi2, trades_rsi2 = run_connors_rsi2()

    # Summarize all
    strategies = {
        "1. 52-Week High Breakout": (eq_52w, trades_52w),
        "2. Minervini Trend Template": (eq_minervini, trades_minervini),
        "3. Andreas Clenow Momentum": (eq_clenow, trades_clenow),
        "4. Current Turtle RS Breakout": (turtle_eq, unique_turtle_trades),
        "5. Connors RSI-2 Mean Reversion": (eq_rsi2, trades_rsi2),
    }

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
    print("BACKTEST PERFORMANCE COMPARISON (2019 - 2026, NIFTY 500)")
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
