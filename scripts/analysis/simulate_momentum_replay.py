#!/usr/bin/env python3
"""
Momentum Portfolio Historical Replay & Time-Travel Simulator.

Simulates the Nifty 500 momentum portfolio day-by-day across any requested
historical date range (from 2019 to present). Generates complete daily snapshots:
  - Account equity, cash, invested capital, daily P&L
  - Trade executions that filled on that day (at open)
  - Pending orders queued for next open
  - All open holdings with marked LTPs, ratcheted stops, stage, and room to stop %
  - Top 25 momentum ranking with industry, RS score, and qualification / rejection reasons
  - Cumulative closed trades up to that day

Caches results to debug/replays/replay_{start}_{end}_{capital}_{slots}.json for instant UI scrubbing.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import date, datetime
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, PROJECT_ROOT)

from lib import minervini, fifty_two_week, clenow, ema_supertrend, weinstein, data_quality      # noqa: E402
from lib.momentum import (
    MomentumConfig, Position,
    STAGE_INITIAL, STAGE_BREAKEVEN, STAGE_TRAIL,
    build_regime_daily, build_rs_matrix, build_tables,
    load_benchmark, load_price_map, load_universe,
    rank_rotation_exits, rank_universe, ranks_by_symbol,
    select_candidates, size_position, passes_entry_filters, sector_counts,
)

DEBUG_DIR = os.path.join(PROJECT_ROOT, "debug")
REPLAYS_DIR = os.path.join(DEBUG_DIR, "replays")

# Optional portfolio risk controls (OFF by default, so existing results are unchanged). Set by the CLI flags below.
#   dd_brake      [(drawdown %, size multiplier), ...]: new entries are scaled by the multiplier of the deepest tier
#                 the account's current drawdown from its equity peak has reached (0 = no new entries).
#   atr_risk_pct  size each new position so a 'atr_mult x ATR14' adverse move costs at most this % of equity.
RISK = {"dd_brake": [], "atr_risk_pct": 0.0, "atr_mult": 2.0}


def dd_scale(dd_pct: float) -> float:
    scale = 1.0
    for thr, mult in sorted(RISK["dd_brake"]):
        if dd_pct >= thr:
            scale = mult
    return scale


def risk_suffix() -> str:
    out = ""
    if RISK["dd_brake"]:
        out += "_ddb" + "-".join(f"{t:g}x{m:g}" for t, m in sorted(RISK["dd_brake"]))
    if RISK["atr_risk_pct"] > 0:
        out += f"_atr{RISK['atr_risk_pct']:g}m{RISK['atr_mult']:g}"
    return out


DEFAULT_SECTOR_CAP = 2     # max concurrent positions per Industry; mirrored by the replay route


def default_stop_pct(strategy: str) -> float:
    """Stop distance each model used before the stop became a user setting."""
    return 15.0 if strategy == "clenow" else 12.0


def stop_suffix(strategy: str, stop_pct: float) -> str:
    """Cache-name suffix; empty at the model's default. Must mirror stopSuffix() in the simulation route."""
    return "" if abs(stop_pct - default_stop_pct(strategy)) < 1e-9 else f"_sl{stop_pct:g}"


STRATEGY_NAMES = {
    "turtle_rs": "Turtle RS Breakout (Composite RS + 55d Breakout)",
    "minervini": "Minervini Trend Template (Stage 2 Superperformance)",
    "52w_high": "52-Week High Breakout (Yearly High Proximity)",
    "clenow": "Andreas Clenow Momentum (Smooth Exponential Slope)",
    "ema_supertrend": "EMA & Supertrend (EMA 20 > 50 > 200 + Bullish Supertrend)",
    "weinstein": "Weinstein Stage 2 (weekly base breakout, 30-week MA exit)",
}


def passes_strategy_entry(strategy: str, sym: str, tables: dict, d: date, cfg: MomentumConfig,
                          rs_pct: Optional[Dict[str, float]] = None) -> Tuple[bool, str]:
    t = tables.get(sym)
    if not t:
        return False, "no data"
    px_row = t["px"].get(d)
    if not px_row:
        return False, "no bar today"
    close = float(px_row.close)
    vol = float(px_row.volume) if px_row.volume and not np.isnan(px_row.volume) else 0.0
    vol20 = float(t["vol20"].get(d, 0.0) or 0.0)

    if strategy == "turtle_rs":
        return passes_entry_filters(sym, tables, d, cfg)

    elif strategy == "minervini":
        return minervini.entry_check(sym, tables, d, cfg.breakout_days, rs_pct)

    elif strategy == "52w_high":
        strict = cfg.breakout_days not in (5, 10)
        return fifty_two_week.entry_check(sym, tables, d, strict_breakout=strict, max_proximity_pct=float(cfg.breakout_days))

    elif strategy == "clenow":
        return clenow.entry_check(sym, tables, d)

    elif strategy == "ema_supertrend":
        return ema_supertrend.entry_check(sym, tables, d, rs_pct)

    elif strategy == "weinstein":
        return weinstein.entry_check(sym, tables, d, rs_pct)

    return False, "unknown strategy"


def check_strategy_exit(strategy: str, pos: Position, close: float, tables: dict, d: date, cfg: MomentumConfig) -> Optional[str]:
    t = tables.get(pos.symbol)
    if strategy == "turtle_rs":
        return pos.update(close, cfg)

    elif strategy == "minervini":
        return minervini.exit_check(pos, close, tables, d, STAGE_TRAIL)

    elif strategy == "52w_high":
        return fifty_two_week.exit_check(pos, close, stop_pct=cfg.stop_pct)

    elif strategy == "clenow":
        return clenow.exit_check(pos, close, tables, d, stop_pct=cfg.stop_pct)

    elif strategy == "ema_supertrend":
        return ema_supertrend.exit_check(pos, close, tables, d, stop_pct=cfg.stop_pct)

    elif strategy == "weinstein":
        return weinstein.exit_check(pos, close, tables, d, stop_pct=cfg.stop_pct)

    return None


def run_replay_simulation(cfg: MomentumConfig, start: date, end: date, strategy: str = "turtle_rs", force: bool = False) -> dict:
    if start > end:
        raise ValueError(f"Start date {start} cannot be after end date {end}")

    strategy = strategy.lower().strip()
    if strategy not in STRATEGY_NAMES:
        strategy = "turtle_rs"

    os.makedirs(REPLAYS_DIR, exist_ok=True)
    regime_suffix = "" if cfg.regime_enabled else "_no_regime"
    bench_suffix = "" if getattr(cfg, "benchmark", "nifty50") == "nifty50" else f"_{cfg.benchmark}"
    interval_suffix = "" if getattr(cfg, "regime_interval", "weekly") == "weekly" else f"_{cfg.regime_interval}"
    if strategy == "clenow":
        bo_suffix = ""
    elif strategy == "minervini":
        bo_suffix = "" if cfg.breakout_days in (20, 55) else f"_bo{cfg.breakout_days}"
    elif strategy == "52w_high":
        bo_suffix = "" if cfg.breakout_days in (5, 55) else f"_bo{cfg.breakout_days}"
    elif strategy == "ema_supertrend":
        bo_suffix = "" if cfg.breakout_days in (20, 55) else f"_bo{cfg.breakout_days}"
    else:
        bo_suffix = "" if cfg.breakout_days == 55 else f"_bo{cfg.breakout_days}"

    strat_prefix = f"{strategy}_" if strategy != "turtle_rs" else ""
    bo_suffix += stop_suffix(strategy, cfg.stop_pct)
    bo_suffix += "" if cfg.sector_cap == DEFAULT_SECTOR_CAP else f"_sc{cfg.sector_cap}"
    bo_suffix += risk_suffix()

    cache_file = os.path.join(
        REPLAYS_DIR, f"replay_{strat_prefix}{start}_{end}_{int(cfg.capital)}_{cfg.slots}{regime_suffix}{bench_suffix}{interval_suffix}{bo_suffix}.json"
    )

    # Legacy cache (turtle_rs files written before the strategy prefix existed). No other fallback: serving a
    # file from a different setting (bo / stop / regime) would silently show the wrong replay.
    legacy_file = os.path.join(
        REPLAYS_DIR, f"replay_{start}_{end}_{int(cfg.capital)}_{cfg.slots}{regime_suffix}{bench_suffix}{interval_suffix}{bo_suffix}.json"
    )
    target_cache = cache_file if os.path.exists(cache_file) else (
        legacy_file if strategy == "turtle_rs" and os.path.exists(legacy_file) else None)

    if not force and target_cache and os.path.exists(target_cache):
        try:
            with open(target_cache, "r", encoding="utf-8") as f:
                data = json.load(f)
                if data and data.get("success"):
                    return data
        except Exception:
            pass

    universe = load_universe(cfg.universe)
    symbols = [u["symbol"] for u in universe]
    industries = {u["symbol"]: u["industry"] for u in universe}
    bench = load_benchmark(getattr(cfg, "benchmark", "nifty50"))
    price_map = load_price_map(symbols, min_bars=cfg.min_history_bars)
    data_warnings = data_quality.find_suspect_breaks(price_map, bench=bench)
    for w in data_warnings:
        print(f"DATA WARNING {w['symbol']} {w['date']}: close {w['prev_close']} -> {w['close']} (x{w['ratio']}) "
              f"looks like an unadjusted corporate action; repair with scripts/downloader/repair_symbol_history.py")

    tables = build_tables(price_map, cfg)
    calendar = build_regime_daily(bench, cfg)
    rs_matrix = build_rs_matrix(price_map, bench)

    # Enrich tables conditionally based on selected strategy (fast vectorized)
    if strategy == "minervini":
        minervini.add_tables(price_map, tables)         # shared with the live bot: lib/minervini.py
    elif strategy == "52w_high":
        fifty_two_week.add_tables(price_map, tables)    # shared: lib/fifty_two_week.py
    elif strategy == "clenow":
        clenow.add_tables(price_map, tables)            # shared: lib/clenow.py
    elif strategy == "ema_supertrend":
        ema_supertrend.add_tables(price_map, tables)    # shared: lib/ema_supertrend.py
    elif strategy == "weinstein":
        weinstein.add_tables(price_map, tables, bench)  # shared: lib/weinstein.py

    # Determine trading days in window
    all_trading_days = [d for d in calendar.trading_days if start <= d <= end]
    if not all_trading_days:
        raise ValueError(f"No trading days found between {start} and {end}")

    portfolio: Dict[str, Position] = {}
    cash = float(cfg.capital)
    realized_pnl = 0.0
    closed_trades: List[dict] = []
    cooldowns: Dict[str, date] = {}
    pending_buys: List[dict] = []
    pending_sells: List[Tuple[str, str]] = []
    entry_costs: Dict[str, float] = {}

    def bar(sym: str, d: date):
        t = tables.get(sym)
        return t["px"].get(d) if t else None

    snapshots = []
    prev_equity = cfg.capital
    peak_equity = cfg.capital
    if RISK["atr_risk_pct"] > 0:                      # ATR14 (simple mean of true range), known at each close
        for sym, df in price_map.items():
            if sym in tables:
                pc = df["close"].shift(1)
                tr = pd.concat([df["high"] - df["low"], (df["high"] - pc).abs(), (df["low"] - pc).abs()], axis=1).max(axis=1)
                tables[sym]["atr14"] = dict(zip(df["date"], tr.rolling(14, min_periods=14).mean()))
    rs_day_cache: Dict[date, Tuple[list, Dict[str, float]]] = {}

    def rs_ranking(d: date):
        """Composite-RS ranking + percentiles for day d, computed once per day."""
        if d not in rs_day_cache:
            r = rank_universe(price_map, bench, d, cfg, matrix=rs_matrix) or []
            rs_day_cache[d] = (r, minervini.rs_percentiles(r))
        return rs_day_cache[d]

    for day_idx, d in enumerate(all_trading_days):
        executions_today = []

        # ── 1. Fill pending sells from yesterday at today's open ──────────────
        for sym, reason in pending_sells:
            pos = portfolio.get(sym)
            row = bar(sym, d)
            if pos is None or row is None:
                continue
            fill = float(row.open)
            proceeds = fill * pos.qty
            cost = cfg.trade_cost(proceeds)
            cash += proceeds - cost
            entry_cost = entry_costs.pop(sym, 0.0)
            pnl = (fill - pos.entry_price) * pos.qty - cost - entry_cost
            realized_pnl += pnl

            trade_record = {
                "symbol": sym,
                "industry": pos.industry,
                "entry_date": pos.entry_date.isoformat(),
                "exit_date": d.isoformat(),
                "entry_price": round(pos.entry_price, 2),
                "exit_price": round(fill, 2),
                "qty": pos.qty,
                "invested": round(pos.invested, 2),
                "pnl": round(pnl, 2),
                "pnl_pct": round(pnl / pos.invested * 100.0, 2) if pos.invested else 0.0,
                "cost": round(cost + entry_cost, 2),
                "exit_reason": reason,
                "hold_days": (d - pos.entry_date).days,
            }
            closed_trades.append(trade_record)
            executions_today.append({
                "symbol": sym,
                "action": "SELL",
                "qty": pos.qty,
                "price": round(fill, 2),
                "amount": round(proceeds, 2),
                "pnl": round(pnl, 2),
                "pnl_pct": round(pnl / pos.invested * 100.0, 2) if pos.invested else 0.0,
                "reason": f"Exit: {reason}",
            })

            if reason == "stop":
                cooldowns[sym] = d + pd.Timedelta(days=cfg.cooldown_days).to_pytimedelta()
            del portfolio[sym]

        pending_sells = [(s, r) for s, r in pending_sells if s in portfolio]

        # ── 2. Fill pending buys from yesterday at today's open ───────────────
        for order in pending_buys:
            sym = order["symbol"]
            row = bar(sym, d)
            if row is None or sym in portfolio:
                continue
            fill = float(row.open)
            spendable = (cash - cfg.fixed_fee) / (1.0 + (cfg.fee_pct + cfg.slippage_pct) / 100.0)
            qty = size_position(fill, order["rank"], cfg, max(spendable, 0.0))
            if qty > 0 and RISK["dd_brake"]:
                dd_now = (peak_equity - prev_equity) / peak_equity * 100.0 if peak_equity > 0 else 0.0
                qty = int(qty * dd_scale(dd_now))
            if qty > 0 and RISK["atr_risk_pct"] > 0 and day_idx > 0:
                atr = tables.get(sym, {}).get("atr14", {}).get(all_trading_days[day_idx - 1])
                if atr and not np.isnan(atr) and atr > 0:
                    qty = min(qty, int(prev_equity * RISK["atr_risk_pct"] / 100.0 / (RISK["atr_mult"] * atr)))
            if qty <= 0:
                continue
            spend = fill * qty
            cost = cfg.trade_cost(spend)
            if spend + cost > cash:
                continue
            cash -= spend + cost
            entry_costs[sym] = cost
            pos = Position(sym, d, fill, qty, cfg,
                           rank_at_entry=order["rank"],
                           industry=order.get("industry", industries.get(sym, "")))
            portfolio[sym] = pos
            executions_today.append({
                "symbol": sym,
                "action": "BUY",
                "qty": qty,
                "price": round(fill, 2),
                "amount": round(spend, 2),
                "reason": f"Entry (Rank #{order['rank']}, {pos.industry})",
            })

        pending_buys = []

        # ── 3. Mark to market on today's close ────────────────────────────────
        invested_val = sum(p.entry_price * p.qty for p in portfolio.values())
        unrealised_val = 0.0
        closes: Dict[str, float] = {}
        for sym, pos in portfolio.items():
            row = bar(sym, d)
            close = float(row.close) if row is not None else pos.last_close
            closes[sym] = close
            unrealised_val += pos.unrealised(close)

        current_equity = cash + invested_val + unrealised_val
        day_pnl = current_equity - prev_equity
        prev_equity = current_equity
        peak_equity = max(peak_equity, current_equity)

        # ── 4. Evaluate stop ladders for today's close ────────────────────────
        queued_sells = {s for s, _ in pending_sells}
        for sym, pos in list(portfolio.items()):
            if sym in queued_sells:
                continue
            reason = check_strategy_exit(strategy, pos, closes[sym], tables, d, cfg)
            if reason:
                pending_sells.append((sym, reason))
                queued_sells.add(sym)

        # ── 5. Daily scan & rebalancing ──────────────────────────────────────
        is_review = calendar.is_review_day(d)
        regime_on = bool(calendar.is_on(d))

        # All strategies evaluate regime, rank rotation, and new entries daily.
        if not regime_on:
            if cfg.regime_exit:
                for sym in portfolio:
                    if sym not in queued_sells:
                        pending_sells.append((sym, "regime"))
                        queued_sells.add(sym)
        else:
            # Rank universe based on strategy
            if strategy == "turtle_rs":
                ranking = rank_universe(price_map, bench, d, cfg, matrix=rs_matrix) or []
            elif strategy in ("minervini", "ema_supertrend", "weinstein"):
                ranking = rs_ranking(d)[0]
            elif strategy == "52w_high":
                cands = []
                for sym, t in tables.items():
                    px_r = t["px"].get(d)
                    if not px_r:
                        continue
                    h250 = t["high250"].get(d)
                    if h250 and not np.isnan(h250) and h250 > 0:
                        cands.append((sym, float(px_r.close) / float(h250)))
                cands.sort(key=lambda x: x[1], reverse=True)
                ranking = cands
            elif strategy == "clenow":
                cands = []
                for sym, t in tables.items():
                    px_r = t["px"].get(d)
                    if not px_r:
                        continue
                    score = t["clenow"].get(d, 0.0)
                    if score > 0:
                        cands.append((sym, float(score)))
                cands.sort(key=lambda x: x[1], reverse=True)
                ranking = cands
            else:
                ranking = []

            if ranking:
                ranks = ranks_by_symbol(ranking)
                survivors = {s: p for s, p in portfolio.items() if s not in queued_sells}

                # Daily rank rotation / rebalancing
                if strategy == "turtle_rs":
                    for sym, reason in rank_rotation_exits(survivors, ranks, d, cfg):
                        pending_sells.append((sym, "rebalance"))
                        queued_sells.add(sym)
                elif strategy == "clenow":
                    for sym, reason in clenow.rank_rotation_exits(survivors, ranking, min_percentile=80.0):
                        pending_sells.append((sym, "rotation"))
                        queued_sells.add(sym)

                # Daily buys for next session open
                slots_free = cfg.slots - (len(portfolio) - len(queued_sells))
                if slots_free > 0:
                    counts = sector_counts(survivors)
                    picks = []
                    for s, _ in ranking:
                        if len(picks) >= slots_free:
                            break
                        if s in survivors or s in queued_sells:
                            continue
                        if s in cooldowns and d < cooldowns[s]:
                            continue
                        ind = industries.get(s, "")
                        if counts.get(ind, 0) >= cfg.sector_cap:
                            continue
                        ok, _ = passes_strategy_entry(
                            strategy, s, tables, d, cfg,
                            rs_pct=rs_ranking(d)[1] if strategy in ("minervini", "ema_supertrend") else None)
                        if not ok:
                            continue
                        picks.append({"symbol": s, "rank": ranks.get(s, 999), "industry": ind})
                        counts[ind] = counts.get(ind, 0) + 1

                    for pick in picks:
                        pending_buys.append({
                            "symbol": pick["symbol"],
                            "rank": pick["rank"],
                            "industry": pick["industry"],
                        })

        # ── 6. Compute Top 25 Ranking snapshot for today ───────────────────────
        if strategy == "turtle_rs":
            ranking_today = rank_universe(price_map, bench, d, cfg, matrix=rs_matrix) or []
        elif strategy in ("minervini", "ema_supertrend", "weinstein"):
            ranking_today = rs_ranking(d)[0]
        elif strategy == "52w_high":
            cands = []
            for sym, t in tables.items():
                px_r = t["px"].get(d)
                if not px_r:
                    continue
                h250 = t["high250"].get(d)
                if h250 and not np.isnan(h250) and h250 > 0:
                    cands.append((sym, float(px_r.close) / float(h250)))
            cands.sort(key=lambda x: x[1], reverse=True)
            ranking_today = cands
        elif strategy == "clenow":
            cands = []
            for sym, t in tables.items():
                px_r = t["px"].get(d)
                if not px_r:
                    continue
                score = t["clenow"].get(d, 0.0)
                if score > 0:
                    cands.append((sym, float(score)))
            cands.sort(key=lambda x: x[1], reverse=True)
            ranking_today = cands
        else:
            ranking_today = []

        ranks_today = ranks_by_symbol(ranking_today)
        counts = sector_counts(portfolio)
        top_ranks_data = []

        for s, rs in ranking_today[:25]:
            ind = industries.get(s, "")
            item_status = "QUALIFIED"
            if s in portfolio:
                item_status = "HELD"
            elif s in cooldowns and d < cooldowns[s]:
                item_status = f"Cooldown ({cooldowns[s]})"
            elif counts.get(ind, 0) >= cfg.sector_cap:
                item_status = f"Sector cap ({ind})"
            elif tables:
                ok, reason = passes_strategy_entry(
                    strategy, s, tables, d, cfg,
                    rs_pct=rs_ranking(d)[1] if strategy == "minervini" else None)
                if not ok:
                    item_status = reason
            top_ranks_data.append({
                "rank": ranks_today.get(s, 0),
                "symbol": s,
                "industry": ind,
                "rs": round(rs, 4),
                "status": item_status,
            })

        # ── 7. Build current holdings list for today ───────────────────────────
        holdings_list = []
        for sym, pos in portfolio.items():
            px = closes[sym]
            pos_val = px * pos.qty
            unr = pos.unrealised(px)
            span = px - pos.stop_price
            room_pct = max(0.0, (span / px) * 100.0) if px > 0 else 0.0
            holdings_list.append({
                "symbol": sym,
                "industry": pos.industry,
                "qty": pos.qty,
                "entry_price": round(pos.entry_price, 2),
                "ltp": round(px, 2),
                "value": round(pos_val, 2),
                "weight_pct": round(pos_val / current_equity * 100.0, 1) if current_equity else 0.0,
                "unrealised": round(unr, 2),
                "unrealised_pct": round(pos.gain_pct(px), 2),
                "stop_price": round(pos.stop_price, 2),
                "stage": pos.stage_label(),
                "room_to_stop_pct": round(room_pct, 1),
                "hold_days": (d - pos.entry_date).days,
                "rank": ranks_today.get(sym),
                "rank_at_entry": pos.rank_at_entry,
                "rank_strikes": pos.rank_strikes,
            })
        holdings_list.sort(key=lambda h: h["unrealised_pct"], reverse=True)

        snapshots.append({
            "date": d.isoformat(),
            "day_name": d.strftime("%A"),
            "day_index": day_idx,
            "is_review_day": is_review,
            "regime_on": regime_on,
            "regime_enabled": cfg.regime_enabled,
            "breakout_days": cfg.breakout_days,
            "strategy": strategy,
            "equity": round(current_equity, 2),
            "cash": round(cash, 2),
            "invested": round(invested_val, 2),
            "deployed_pct": round(invested_val / current_equity * 100.0, 1) if current_equity else 0.0,
            "realized_pnl": round(realized_pnl, 2),
            "unrealised_pnl": round(unrealised_val, 2),
            "total_pnl": round(realized_pnl + unrealised_val, 2),
            "total_pnl_pct": round((current_equity / cfg.capital - 1.0) * 100.0, 2),
            "day_pnl": round(day_pnl, 2),
            "slots": cfg.slots,
            "active_slots": len(portfolio),
            "executions_today": executions_today,
            "holdings": holdings_list,
            "top_ranks": top_ranks_data,
            "closed_trades": list(closed_trades),
        })

    # Calculate simulation performance metrics across the window
    wins = [t for t in closed_trades if t.get("pnl", 0) > 0]
    losses = [t for t in closed_trades if t.get("pnl", 0) <= 0]
    winning_trades = len(wins)
    losing_trades = len(losses)
    total_trades = len(closed_trades)
    win_rate_pct = round((winning_trades / total_trades * 100.0), 1) if total_trades > 0 else 0.0

    gross_profit = sum(t.get("pnl", 0) for t in wins)
    gross_loss = abs(sum(t.get("pnl", 0) for t in losses))
    if gross_loss > 0:
        profit_factor = round(gross_profit / gross_loss, 2)
    elif gross_profit > 0:
        profit_factor = 999.0
    else:
        profit_factor = 0.0

    peak = cfg.capital
    max_dd = 0.0
    for s in snapshots:
        eq = s.get("equity", cfg.capital)
        if eq > peak:
            peak = eq
        if peak > 0:
            dd = (eq - peak) / peak * 100.0
            if dd < max_dd:
                max_dd = dd
    max_drawdown_pct = round(max_dd, 2)

    avg_trade_pnl = round(sum(t.get("pnl", 0) for t in closed_trades) / total_trades, 2) if total_trades > 0 else 0.0
    avg_trade_pct = round(sum(t.get("pnl_pct", 0) for t in closed_trades) / total_trades, 2) if total_trades > 0 else 0.0
    avg_hold_days = round(sum(t.get("hold_days", 0) for t in closed_trades) / total_trades, 1) if total_trades > 0 else 0.0

    metrics = {
        "total_trades": total_trades,
        "winning_trades": winning_trades,
        "losing_trades": losing_trades,
        "win_rate_pct": win_rate_pct,
        "profit_factor": profit_factor,
        "gross_profit": round(gross_profit, 2),
        "gross_loss": round(gross_loss, 2),
        "max_drawdown_pct": max_drawdown_pct,
        "avg_trade_pnl": avg_trade_pnl,
        "avg_trade_pct": avg_trade_pct,
        "avg_hold_days": avg_hold_days,
        "open_positions": len(portfolio),
    }

    result_payload = {
        "success": True,
        "data_warnings": data_warnings,
        "config": {
            "universe": cfg.universe,
            "capital": cfg.capital,
            "slots": cfg.slots,
            "strategy": strategy,
            "strategy_name": STRATEGY_NAMES.get(strategy, strategy),
            "regime_enabled": cfg.regime_enabled,
            "breakout_days": cfg.breakout_days,
            "stop_pct": cfg.stop_pct,
            "sector_cap": cfg.sector_cap,
            "start": start.isoformat(),
            "end": end.isoformat(),
            "trading_days": len(all_trading_days),
        },
        "initial_capital": cfg.capital,
        "final_equity": snapshots[-1]["equity"] if snapshots else cfg.capital,
        "total_return_pct": snapshots[-1]["total_pnl_pct"] if snapshots else 0.0,
        "total_trades": total_trades,
        "profit_factor": profit_factor,
        "win_rate_pct": win_rate_pct,
        "max_drawdown_pct": max_drawdown_pct,
        "metrics": metrics,
        "closed_trades": closed_trades,
        "snapshots": snapshots,
    }

    with open(cache_file, "w", encoding="utf-8") as f:
        json.dump(result_payload, f, indent=2)

    return result_payload


def main():
    p = argparse.ArgumentParser(description="Simulate momentum daily time-travel replay")
    p.add_argument("--start", default="2026-10-15", help="Start date YYYY-MM-DD")
    p.add_argument("--end", default="2026-11-20", help="End date YYYY-MM-DD")
    p.add_argument("--capital", type=float, default=500_000.0)
    p.add_argument("--slots", type=int, default=10)
    p.add_argument("--universe", choices=["nifty500", "nifty50"], default="nifty500")
    p.add_argument("--strategy", choices=["turtle_rs", "minervini", "52w_high", "clenow", "ema_supertrend", "weinstein"], default="turtle_rs", help="Strategy to simulate")
    p.add_argument("--benchmark", choices=["nifty50", "nifty500"], default="nifty50", help="Benchmark index for RS and regime (default nifty50)")
    p.add_argument("--regime-interval", choices=["weekly", "daily"], default="weekly", help="Regime check frequency: weekly (prior week close) or daily (default weekly)")
    p.add_argument("--regime", type=lambda x: str(x).lower() in ("true", "1", "yes"), default=True, help="Enable 200-SMA regime filter")
    p.add_argument("--no-regime", dest="regime", action="store_false", help="Disable regime filter (always ON)")
    p.add_argument("--breakout-days", type=int, default=55, help="Donchian breakout lookback days (default 55)")
    p.add_argument("--sector-cap", type=int, default=DEFAULT_SECTOR_CAP, help="max positions per sector/industry (default 2)")
    p.add_argument("--dd-brake", default="", help='scale new entries when the account is in drawdown, e.g. "5:0.5,10:0" (>=5%% dd: half size, >=10%%: no new entries)')
    p.add_argument("--atr-risk-pct", type=float, default=0.0, help="size so an ATR-multiple adverse move costs at most this %% of equity (0=off)")
    p.add_argument("--atr-mult", type=float, default=2.0, help="ATR multiple for --atr-risk-pct (default 2)")
    p.add_argument("--stop-pct", type=float, default=None, help="Stop-loss distance in %% (default: 12, Clenow 10)")
    p.add_argument("--force", action="store_true", help="force recomputation even if cached")
    p.add_argument("--clear-cache", action="store_true", help="Delete all cached replay json files and exit")
    args = p.parse_args()
    RISK["dd_brake"] = [(float(a), float(b)) for a, b in (x.split(":") for x in args.dd_brake.split(",") if x.strip())]
    RISK["atr_risk_pct"] = args.atr_risk_pct
    RISK["atr_mult"] = args.atr_mult

    if args.clear_cache:
        count = 0
        if os.path.exists(REPLAYS_DIR):
            for f in os.listdir(REPLAYS_DIR):
                if f.startswith("replay_") and f.endswith(".json"):
                    try:
                        os.remove(os.path.join(REPLAYS_DIR, f))
                        count += 1
                    except Exception:
                        pass
        print(f"Cleared {count} cached replay files in {REPLAYS_DIR}")
        return

    start_date = datetime.strptime(args.start, "%Y-%m-%d").date()
    end_date = datetime.strptime(args.end, "%Y-%m-%d").date()
    cfg = MomentumConfig(
        universe=args.universe,
        capital=args.capital,
        slots=args.slots,
        benchmark=args.benchmark,
        regime_interval=args.regime_interval,
        regime_enabled=args.regime,
        breakout_days=args.breakout_days,
        stop_pct=args.stop_pct if args.stop_pct is not None else default_stop_pct(args.strategy),
        sector_cap=max(1, args.sector_cap),
    )

    print(f"Simulating momentum replay [{args.strategy}] from {start_date} to {end_date} (capital: {cfg.capital:,.0f}, regime: {cfg.regime_enabled})...")
    res = run_replay_simulation(cfg, start_date, end_date, strategy=args.strategy, force=args.force)
    print(f"Done! {len(res['snapshots'])} daily snapshots generated. Final equity: Rs {res['final_equity']:,.2f} ({res['total_return_pct']:+.2f}%)")


if __name__ == "__main__":
    main()
