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

from lib import minervini                                              # noqa: E402
from lib.momentum import (
    MomentumConfig, Position,
    STAGE_INITIAL, STAGE_BREAKEVEN, STAGE_TRAIL,
    build_regime_weekly, build_rs_matrix, build_tables,
    load_benchmark, load_price_map, load_universe,
    rank_rotation_exits, rank_universe, ranks_by_symbol,
    select_candidates, size_position, passes_entry_filters, sector_counts,
)

DEBUG_DIR = os.path.join(PROJECT_ROOT, "debug")
REPLAYS_DIR = os.path.join(DEBUG_DIR, "replays")

def default_stop_pct(strategy: str) -> float:
    """Stop distance each model used before the stop became a user setting."""
    return 10.0 if strategy == "clenow" else 12.0


def stop_suffix(strategy: str, stop_pct: float) -> str:
    """Cache-name suffix; empty at the model's default. Must mirror stopSuffix() in the simulation route."""
    return "" if abs(stop_pct - default_stop_pct(strategy)) < 1e-9 else f"_sl{stop_pct:g}"


STRATEGY_NAMES = {
    "turtle_rs": "Turtle RS Breakout (Composite RS + 55d Breakout)",
    "minervini": "Minervini Trend Template (Stage 2 Superperformance)",
    "52w_high": "52-Week High Breakout (Yearly High Proximity)",
    "clenow": "Andreas Clenow Momentum (Smooth Exponential Slope)",
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
        sma50 = t["sma50"].get(d)
        sma200 = t["sma200"].get(d)
        h250 = t["high250"].get(d)
        if any(v is None or np.isnan(v) for v in (sma50, sma200, h250)):
            return False, "insufficient history (<250d)"
        proximity = close / h250
        min_prox = (1.0 - cfg.breakout_days / 100.0) if cfg.breakout_days in (5, 10) else 0.95
        if proximity < min_prox:
            return False, f"proximity <{min_prox*100:.0f}% ({proximity*100:.1f}%)"
        if not (close > sma50 > sma200):
            return False, "Close < 50 SMA or 50 < 200 SMA"
        if vol < vol20:
            return False, "volume < 20d average"
        return True, "QUALIFIED"
        return True, "QUALIFIED"

    elif strategy == "clenow":
        score = t["clenow"].get(d, 0.0)
        sma100 = t["sma100"].get(d)
        sma200 = t["sma200"].get(d)
        if any(v is None or np.isnan(v) for v in (sma100, sma200)):
            return False, "insufficient history (<200d)"
        if score <= 0:
            return False, "negative or flat exponential slope"
        if not (close > sma100 and close > sma200):
            return False, "Close < 100 SMA or 200 SMA"
        return True, "QUALIFIED"

    return False, "unknown strategy"


def check_strategy_exit(strategy: str, pos: Position, close: float, tables: dict, d: date, cfg: MomentumConfig) -> Optional[str]:
    t = tables.get(pos.symbol)
    if strategy == "turtle_rs":
        return pos.update(close, cfg)

    elif strategy == "minervini":
        return minervini.exit_check(pos, close, tables, d, STAGE_TRAIL)

    elif strategy == "52w_high":
        pos.peak_close = max(pos.peak_close, close)
        pos.last_close = close
        pos.stop_price = max(pos.stop_price, pos.peak_close * (1.0 - cfg.stop_pct / 100.0))
        pos.stage = STAGE_TRAIL
        if close < pos.stop_price:
            return "stop"
        return None

    elif strategy == "clenow":
        pos.peak_close = max(pos.peak_close, close)
        pos.last_close = close
        sma100 = t["sma100"].get(d) if t else None
        pos.stop_price = pos.entry_price * (1.0 - cfg.stop_pct / 100.0)
        pos.stage = STAGE_INITIAL
        if (sma100 and not np.isnan(sma100) and close < float(sma100)) or close < pos.stop_price:
            return "sma100_exit"
        return None

    return None


def run_replay_simulation(cfg: MomentumConfig, start: date, end: date, strategy: str = "turtle_rs", force: bool = False) -> dict:
    if start > end:
        raise ValueError(f"Start date {start} cannot be after end date {end}")

    strategy = strategy.lower().strip()
    if strategy not in STRATEGY_NAMES:
        strategy = "turtle_rs"

    os.makedirs(REPLAYS_DIR, exist_ok=True)
    regime_suffix = "" if cfg.regime_enabled else "_no_regime"
    if strategy == "clenow":
        bo_suffix = ""
    elif strategy == "minervini":
        bo_suffix = "" if cfg.breakout_days in (20, 55) else f"_bo{cfg.breakout_days}"
    elif strategy == "52w_high":
        bo_suffix = "" if cfg.breakout_days in (5, 55) else f"_bo{cfg.breakout_days}"
    else:
        bo_suffix = "" if cfg.breakout_days == 55 else f"_bo{cfg.breakout_days}"

    strat_prefix = f"{strategy}_" if strategy != "turtle_rs" else ""
    bo_suffix += stop_suffix(strategy, cfg.stop_pct)

    cache_file = os.path.join(
        REPLAYS_DIR, f"replay_{strat_prefix}{start}_{end}_{int(cfg.capital)}_{cfg.slots}{regime_suffix}{bo_suffix}.json"
    )

    # Legacy cache (turtle_rs files written before the strategy prefix existed). No other fallback: serving a
    # file from a different setting (bo / stop / regime) would silently show the wrong replay.
    legacy_file = os.path.join(
        REPLAYS_DIR, f"replay_{start}_{end}_{int(cfg.capital)}_{cfg.slots}{regime_suffix}{bo_suffix}.json"
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
    bench = load_benchmark()
    price_map = load_price_map(symbols, min_bars=cfg.min_history_bars)

    tables = build_tables(price_map, cfg)
    calendar = build_regime_weekly(bench, cfg)
    rs_matrix = build_rs_matrix(price_map, bench)

    # Enrich tables conditionally based on selected strategy (fast vectorized)
    if strategy == "minervini":
        minervini.add_tables(price_map, tables)         # shared with the live bot: lib/minervini.py
    elif strategy == "52w_high":
        for sym, df in price_map.items():
            if sym in tables:
                c_ser = df["close"]
                d_list = list(df["date"])
                tables[sym]["sma50"] = dict(zip(d_list, c_ser.rolling(50, min_periods=50).mean()))
                tables[sym]["sma200"] = dict(zip(d_list, c_ser.rolling(200, min_periods=200).mean()))
                tables[sym]["high250"] = dict(zip(d_list, df["high"].rolling(250, min_periods=200).max().shift(1)))

    elif strategy == "clenow":
        dx = np.arange(90) - 44.5
        sxx = 60742.5
        for sym, df in price_map.items():
            if sym in tables:
                c_ser = df["close"]
                d_list = list(df["date"])
                tables[sym]["sma100"] = dict(zip(d_list, c_ser.rolling(100, min_periods=100).mean()))
                tables[sym]["sma200"] = dict(zip(d_list, c_ser.rolling(200, min_periods=200).mean()))
                c_arr = c_ser.values
                n_len = len(c_arr)
                clen_vals = np.zeros(n_len)
                for b_i in range(90, n_len):
                    sub_y = c_arr[b_i - 90:b_i]
                    if np.all(sub_y > 0):
                        y = np.log(sub_y)
                        sxy = float(np.dot(dx, y))
                        slope = sxy / sxx
                        dy = y - np.mean(y)
                        syy = float(np.dot(dy, dy))
                        r2 = (sxy * sxy) / (sxx * syy) if syy > 0 else 0.0
                        clen_vals[b_i] = (math.exp(slope * 250) - 1.0) * 100.0 * r2
                tables[sym]["clenow"] = dict(zip(d_list, clen_vals))

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

        # ── 4. Evaluate stop ladders for today's close ────────────────────────
        queued_sells = {s for s, _ in pending_sells}
        for sym, pos in list(portfolio.items()):
            if sym in queued_sells:
                continue
            reason = check_strategy_exit(strategy, pos, closes[sym], tables, d, cfg)
            if reason:
                pending_sells.append((sym, reason))
                queued_sells.add(sym)

        # ── 5. Review day logic ──────────────────────────────────────────────
        is_review = calendar.is_review_day(d)
        regime_on = bool(calendar.is_on(d))

        # Minervini breakouts are not tied to a weekly calendar: scan for entries every session.
        # Liquidation on a regime flip and rank rotation stay review-day-only.
        if is_review or strategy == "minervini":
            if not regime_on:
                if cfg.regime_exit and is_review:
                    for sym in portfolio:
                        if sym not in queued_sells:
                            pending_sells.append((sym, "regime"))
                            queued_sells.add(sym)
            else:
                # Rank universe based on strategy
                if strategy == "turtle_rs":
                    ranking = rank_universe(price_map, bench, d, cfg, matrix=rs_matrix) or []
                elif strategy == "minervini":
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
                    if strategy == "turtle_rs":
                        for sym, reason in rank_rotation_exits(survivors, ranks, d, cfg):
                            pending_sells.append((sym, "rebalance"))
                            queued_sells.add(sym)

                    # Buys for next session open
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
                                rs_pct=rs_ranking(d)[1] if strategy == "minervini" else None)
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
        elif strategy == "minervini":
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

    result_payload = {
        "success": True,
        "config": {
            "universe": cfg.universe,
            "capital": cfg.capital,
            "slots": cfg.slots,
            "strategy": strategy,
            "strategy_name": STRATEGY_NAMES.get(strategy, strategy),
            "regime_enabled": cfg.regime_enabled,
            "breakout_days": cfg.breakout_days,
            "start": start.isoformat(),
            "end": end.isoformat(),
            "trading_days": len(all_trading_days),
        },
        "initial_capital": cfg.capital,
        "final_equity": snapshots[-1]["equity"] if snapshots else cfg.capital,
        "total_return_pct": snapshots[-1]["total_pnl_pct"] if snapshots else 0.0,
        "total_trades": len(closed_trades),
        "snapshots": snapshots,
    }

    with open(cache_file, "w", encoding="utf-8") as f:
        json.dump(result_payload, f, indent=2)

    return result_payload


def main():
    p = argparse.ArgumentParser(description="Simulate momentum daily time-travel replay")
    p.add_argument("--start", default="2026-10-15", help="Start date YYYY-MM-DD")
    p.add_argument("--end", default="2026-11-20", help="End date YYYY-MM-DD")
    p.add_argument("--capital", type=float, default=175_000.0)
    p.add_argument("--slots", type=int, default=10)
    p.add_argument("--universe", choices=["nifty500", "nifty50"], default="nifty500")
    p.add_argument("--strategy", choices=["turtle_rs", "minervini", "52w_high", "clenow"], default="turtle_rs", help="Strategy to simulate")
    p.add_argument("--regime", type=lambda x: str(x).lower() in ("true", "1", "yes"), default=True, help="Enable 200-SMA weekly regime filter")
    p.add_argument("--no-regime", dest="regime", action="store_false", help="Disable regime filter (always ON)")
    p.add_argument("--breakout-days", type=int, default=55, help="Donchian breakout lookback days (default 55)")
    p.add_argument("--stop-pct", type=float, default=None, help="Stop-loss distance in %% (default: 12, Clenow 10)")
    p.add_argument("--force", action="store_true", help="force recomputation even if cached")
    args = p.parse_args()

    start_date = datetime.strptime(args.start, "%Y-%m-%d").date()
    end_date = datetime.strptime(args.end, "%Y-%m-%d").date()
    cfg = MomentumConfig(
        universe=args.universe,
        capital=args.capital,
        slots=args.slots,
        regime_enabled=args.regime,
        breakout_days=args.breakout_days,
        stop_pct=args.stop_pct if args.stop_pct is not None else default_stop_pct(args.strategy),
    )

    print(f"Simulating momentum replay [{args.strategy}] from {start_date} to {end_date} (capital: {cfg.capital:,.0f}, regime: {cfg.regime_enabled})...")
    res = run_replay_simulation(cfg, start_date, end_date, strategy=args.strategy, force=args.force)
    print(f"Done! {len(res['snapshots'])} daily snapshots generated. Final equity: Rs {res['final_equity']:,.2f} ({res['total_return_pct']:+.2f}%)")


if __name__ == "__main__":
    main()
