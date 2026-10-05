"""
Backtest Engine for Nifty Delta-Controlled, Low-Gamma Diagonal Covered-Call Strategy.

Simulates the diagonal covered-call strategy on historical 1-minute Nifty options data
from `Options Data/nifty_options.db` from 2026-01-01 to 2026-09-30 (39 weekly expiries).

Evaluates:
  1. Systematic short-call theta harvesting using Score = Theta / |Gamma|.
  2. Delta-controlled short sizing: Target Short Delta = Long Delta - Target Net Delta.
  3. Realistic Dhan friction: Brokerage (Rs 20/order) + GST (18%) + STT (0.1% on sell turnover) + NSE + SEBI + Stamp Duty.
  4. Dynamic Long Cost Recovery (LCR) engine: LCR = (Cumulative Net Short Premium / Initial Long Debit) * 100%.
  5. The "Free Long Call" milestone (LCR >= 100%) and defensive regime shift (0.08-0.15 delta, 0.60x max short ratio).
  6. The "Zero-Recovery Worst Case": If the long call loses up to 100% of its initial cost, does short income cover it?

Usage:
  ./venv/bin/python scripts/analysis/backtest_diagonal_call.py --start-date 2026-01-01 --end-date 2026-09-30
"""

import sys
import os
import math
import json
import sqlite3
import argparse
from datetime import datetime, date, time, timedelta
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass, field
import pandas as pd
import numpy as np

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from lib.options_pricing import greeks_from_days, price_option, years_from_days  # noqa: E402

DB_PATH = os.path.join(PROJECT_ROOT, "Options Data", "nifty_options.db")
BACKTESTS_DIR = os.path.join(PROJECT_ROOT, "debug", "backtests", "options")
LOT_SIZE_DEFAULT = 65


def calc_dhan_cost(txn_type: str, qty: int, price: float) -> float:
    """Exact Dhan broker + statutory taxes for one executed F&O leg order."""
    turnover = qty * price
    brokerage = 20.0
    gst_brokerage = brokerage * 0.18  # Rs 3.60
    exch_charge = turnover * 0.0005
    gst_exch = exch_charge * 0.18
    stt = (turnover * 0.0010) if txn_type.upper() == "SELL" else 0.0
    stamp = (turnover * 0.00003) if txn_type.upper() == "BUY" else 0.0
    sebi = turnover * 0.000001 * 1.18
    return brokerage + gst_brokerage + exch_charge + gst_exch + stt + stamp + sebi


# Pricing and Greeks come from lib/options_pricing.py — the same library (and rate) the live strategy and the dashboard use, so the
# backtest sizes off the Greeks the strategy actually trades on.
def bs_price_floor(spot: float, strike: float, dte_days: float, iv: float, opt_type: str = "CE") -> float:
    """Theoretical premium, floored at one tick (0.05) so a worthless leg still has a price to exit at."""
    return max(0.05, price_option(opt_type, spot, strike, years_from_days(dte_days, 0.001), max(iv, 0.05)))


def score_short_call(theta_day: float, gamma: float) -> float:
    decay = -theta_day
    if decay <= 0 or gamma <= 0:
        return 0.0
    return decay / gamma


def calculate_required_short_lots(
    long_delta_shares: float,
    target_net_delta_shares: float,
    short_call_delta: float,
    lot_size: int,
    max_short_ratio: float = 1.25,
    max_short_lots: int = 6,
) -> int:
    if short_call_delta <= 0.001 or lot_size <= 0:
        return 0
    target_short_delta = max(0.0, long_delta_shares - target_net_delta_shares)
    raw_lots = int(round(target_short_delta / (short_call_delta * lot_size)))
    max_short_delta = long_delta_shares * max_short_ratio
    delta_capped = max(1, int(max_short_delta / (short_call_delta * lot_size)))
    ceiling = max(1, max_short_lots)
    return max(1, min(raw_lots, delta_capped, ceiling))


@dataclass
class CycleTrade:
    cycle_num: int
    expiry: str
    strike: float
    entry_datetime: str
    entry_price: float
    exit_datetime: str
    exit_price: float
    lots: int
    qty: int
    exit_reason: str
    entry_delta: float
    score: float
    gross_pnl: float
    friction: float
    net_pnl: float
    cumulative_net_premium: float
    lcr_pct: float
    is_free_long_call: bool


def run_diagonal_call_backtest(
    start_date: str = "2026-01-01",
    end_date: str = "2026-09-30",
    long_lots: int = 3,
    long_strike: Optional[float] = None,
    long_dte_initial: float = 90.0,
    target_net_delta: float = 13.0,
    short_target_delta: float = 0.18,
    short_profit_pct: float = 65.0,
    short_roll_delta: float = 0.35,
    max_short_ratio: float = 1.25,
    max_short_lots: int = 6,
    lot_size: int = LOT_SIZE_DEFAULT,
    capital: float = 500000.0,
    output_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """Runs simulated backtest using real expired 1-minute options data from nifty_options.db."""

    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"Database not found at {DB_PATH}")

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Query all distinct expiries between start_date and end_date
    cursor.execute("""
        SELECT DISTINCT expiry
        FROM option_prices
        WHERE expiry >= ? AND expiry <= ?
        ORDER BY expiry
    """, (start_date, end_date))
    expiries = [r[0] for r in cursor.fetchall()]

    if not expiries:
        print(f"No expiries found between {start_date} and {end_date}")
        return {}

    print("\n" + "=" * 80)
    print("  NIFTY DELTA-CONTROLLED DIAGONAL COVERED CALL BACKTEST (2026 DATA)")
    print("=" * 80)
    print(f"  Period:                 {start_date} to {end_date} ({len(expiries)} Weekly Expiries)")
    print(f"  Core Long Call:         {long_lots} Lots ({long_lots * lot_size} Qty) | Initial DTE: ~{long_dte_initial:.0f}d")
    print(f"  Target Net Delta:       +{target_net_delta:.1f} shares (~+0.20 lots)")
    print(f"  Short Call Target:      Delta {short_target_delta:.2f} | Profit Lock: {short_profit_pct:.0f}% decay")
    print(f"  Short Roll Triggers:    Short Delta >= {short_roll_delta:.2f} | DTE <= 0 (Expiry EOD)")
    print(f"  Capital Allocation:     Rs {capital:,.0f} | Lot Size: {lot_size}")
    print("=" * 80 + "\n")

    # Fetch initial spot from first available bar in 2026
    cursor.execute("""
        SELECT spot, datetime FROM option_prices
        WHERE datetime >= ? AND option_type = 'CE'
        ORDER BY datetime ASC LIMIT 1
    """, (f"{start_date} 09:15:00",))
    initial_row = cursor.fetchone()
    if not initial_row:
        raise RuntimeError(f"No initial spot data found on {start_date}")
    initial_spot = float(initial_row[0])
    initial_dt_str = str(initial_row[1])

    # Establish Long Call baseline
    if long_strike is None:
        # ATM or slightly ITM (e.g. 26000 CE if spot is 26150)
        long_strike = float(math.floor(initial_spot / 100.0) * 100.0)

    # Calculate initial long call price via Black-Scholes using prevailing IV (~13.5%)
    initial_iv = 0.135
    initial_long_price = bs_price_floor(initial_spot, long_strike, long_dte_initial, initial_iv)
    long_qty = long_lots * lot_size
    initial_long_debit = initial_long_price * long_qty
    initial_long_greeks = greeks_from_days("CE", initial_spot, long_strike, long_dte_initial, initial_iv)
    initial_long_delta_shares = long_qty * initial_long_greeks.delta

    print(f"  [LONG LEG INITIAL ENTRY - {initial_dt_str}]")
    print(f"  Spot:                   Rs {initial_spot:,.2f}")
    print(f"  Long Strike:            {long_strike:.0f} CE (ATM/ITM, Delta: {initial_long_greeks.delta:.2f})")
    print(f"  Estimated Entry Price:  Rs {initial_long_price:.2f}")
    print(f"  Total Long Debit:       Rs {initial_long_debit:,.2f} ({long_lots} lots / {long_qty} units)")
    print(f"  Initial Long Delta:     +{initial_long_delta_shares:.1f} shares")
    print("-" * 80 + "\n")

    # Tracking variables
    cumulative_gross_premium = 0.0
    cumulative_friction = 0.0
    cumulative_net_short_premium = 0.0
    trades: List[CycleTrade] = []
    equity_curve: List[Dict[str, Any]] = []

    free_long_call_reached = False
    free_long_call_date = None
    free_long_call_cycle = None

    # Step through each expiry in 2026
    for exp_idx, expiry_str in enumerate(expiries, 1):
        # Query all 1-minute CE bars for this expiry
        query = """
            SELECT datetime, strike, open, high, low, close, spot, iv
            FROM option_prices
            WHERE expiry = ? AND option_type = 'CE'
            ORDER BY datetime ASC
        """
        df_exp = pd.read_sql_query(query, conn, params=(expiry_str,))
        if df_exp.empty:
            continue

        expiry_date = datetime.strptime(expiry_str, "%Y-%m-%d").date()
        all_times = sorted(df_exp["datetime"].unique())
        if not all_times:
            continue

        # Fast lookup map: datetime -> dict of strike -> (close, spot, iv)
        bars_by_dt: Dict[str, Dict[float, Tuple[float, float, float]]] = {}
        spot_by_dt: Dict[str, float] = {}

        for row in df_exp.itertuples():
            dt_s = str(row.datetime)
            stk = float(row.strike)
            cls = float(row.close)
            spt = float(row.spot)
            iv = float(row.iv) if (row.iv is not None and not np.isnan(row.iv) and row.iv > 0) else 0.14
            if iv > 1.0:
                iv = iv / 100.0  # normalize percent to decimal

            if dt_s not in bars_by_dt:
                bars_by_dt[dt_s] = {}
                spot_by_dt[dt_s] = spt
            bars_by_dt[dt_s][stk] = (cls, spt, iv)

        # Iterate through the bars for this weekly cycle
        current_bar_idx = 0
        while current_bar_idx < len(all_times):
            entry_dt_str = all_times[current_bar_idx]
            entry_spt = spot_by_dt[entry_dt_str]
            entry_dt = datetime.strptime(entry_dt_str, "%Y-%m-%d %H:%M:%S")

            # Check if this bar is within trading hours (>= 09:20)
            if entry_dt.strftime("%H:%M") < "09:20":
                current_bar_idx += 1
                continue

            # Remaining DTE for this weekly contract
            dte_weekly = max(0.001, (expiry_date - entry_dt.date()).days + (15.5 - entry_dt.hour - entry_dt.minute / 60.0) / 24.0)
            if dte_weekly <= 0.1:  # expiry day after 15:00
                break

            # Overnight gap & late afternoon near-expiry protection
            # Avoids entering fresh short positions late afternoon on expiring options (< 1.5 DTE)
            if dte_weekly <= 1.5 and entry_dt.strftime("%H:%M") >= "14:00":
                current_bar_idx += 1
                continue

            # Check regime: Free Long Call active?
            is_free = (cumulative_net_short_premium / initial_long_debit) >= 1.0 if initial_long_debit > 0 else False
            if is_free and not free_long_call_reached:
                free_long_call_reached = True
                free_long_call_date = entry_dt_str
                free_long_call_cycle = len(trades) + 1

            if is_free:
                target_d = 0.12
                effective_max_ratio = 0.60
            else:
                target_d = short_target_delta
                effective_max_ratio = max_short_ratio

            # Candidate scoring among available strikes
            candidates = []
            for stk, (cls, spt, iv) in bars_by_dt[entry_dt_str].items():
                if stk <= entry_spt:  # only OTM calls
                    continue
                g = greeks_from_days("CE", spt, stk, dte_weekly, iv)
                d = g.delta
                score = score_short_call(g.theta, g.gamma)
                diff = abs(d - target_d)
                candidates.append({
                    "strike": stk,
                    "price": cls,
                    "delta": d,
                    "gamma": g.gamma,
                    "theta_day": g.theta,
                    "score": score,
                    "diff": diff,
                })

            if not candidates:
                current_bar_idx += 1
                continue

            # Filter candidates within acceptable delta window (0.10 to 0.28, or best diff)
            filtered = [c for c in candidates if 0.08 <= c["delta"] <= 0.30]
            if filtered:
                # Maximize score = Theta / |Gamma|
                filtered.sort(key=lambda x: x["score"], reverse=True)
                best_cand = filtered[0]
            else:
                candidates.sort(key=lambda x: x["diff"])
                best_cand = candidates[0]

            short_strike = best_cand["strike"]
            short_entry_price = best_cand["price"]
            short_delta = best_cand["delta"]
            short_score = best_cand["score"]

            if short_entry_price <= 1.0:
                current_bar_idx += 1
                continue

            # Size short lots from Delta
            # Long delta approximation at this spot
            cur_long_greeks = greeks_from_days("CE", entry_spt, long_strike, 60.0, 0.14)
            cur_long_delta_shares = long_qty * cur_long_greeks.delta

            short_lots = calculate_required_short_lots(
                long_delta_shares=cur_long_delta_shares,
                target_net_delta_shares=target_net_delta,
                short_call_delta=short_delta,
                lot_size=lot_size,
                max_short_ratio=effective_max_ratio,
                max_short_lots=max_short_lots,
            )
            short_qty = short_lots * lot_size

            # Entry friction: SELL order
            entry_friction = calc_dhan_cost("SELL", short_qty, short_entry_price)

            # Monitor the short leg forward through subsequent bars
            exit_price = short_entry_price
            exit_dt_str = entry_dt_str
            exit_reason = "EXPIRY_SETTLEMENT"
            exit_bar_idx = current_bar_idx + 1

            while exit_bar_idx < len(all_times):
                bar_dt_str = all_times[exit_bar_idx]
                bar_dt = datetime.strptime(bar_dt_str, "%Y-%m-%d %H:%M:%S")
                bar_spt = spot_by_dt[bar_dt_str]
                dte_now = max(0.001, (expiry_date - bar_dt.date()).days + (15.5 - bar_dt.hour - bar_dt.minute / 60.0) / 24.0)

                # Check if short strike price is present
                if short_strike in bars_by_dt[bar_dt_str]:
                    cur_cls, _, cur_iv = bars_by_dt[bar_dt_str][short_strike]
                    cur_greeks = greeks_from_days("CE", bar_spt, short_strike, dte_now, cur_iv)
                    cur_delta = cur_greeks.delta
                else:
                    cur_cls = bs_price_floor(bar_spt, short_strike, dte_now, 0.14)
                    cur_delta = greeks_from_days("CE", bar_spt, short_strike, dte_now, 0.14).delta

                # 1. Profit Target Check: captured >= 65% decay
                decay_pct = ((short_entry_price - cur_cls) / short_entry_price) * 100.0
                if decay_pct >= short_profit_pct:
                    exit_price = cur_cls
                    exit_dt_str = bar_dt_str
                    exit_reason = f"PROFIT_TARGET ({decay_pct:.1f}% >= {short_profit_pct}%)"
                    break

                # 2. Strong Rally / Short Delta Expansion (Delta >= 0.35)
                if cur_delta >= short_roll_delta:
                    exit_price = cur_cls
                    exit_dt_str = bar_dt_str
                    exit_reason = f"SHORT_DELTA_EXPANSION ({cur_delta:.2f} >= {short_roll_delta:.2f})"
                    break

                # 3. Expiry day close (at or after 15:20)
                if bar_dt.date() == expiry_date and bar_dt.strftime("%H:%M") >= "15:20":
                    exit_price = max(0.05, bar_spt - short_strike) if bar_spt > short_strike else 0.05
                    exit_dt_str = bar_dt_str
                    exit_reason = "EXPIRY_EOD_SETTLEMENT"
                    break

                exit_bar_idx += 1

            if exit_bar_idx >= len(all_times):
                # Fallback to final bar
                last_dt = all_times[-1]
                last_spt = spot_by_dt[last_dt]
                exit_price = max(0.05, last_spt - short_strike) if last_spt > short_strike else 0.05
                exit_dt_str = last_dt
                exit_reason = "CYCLE_END"

            # Exit friction: BUY order (no STT on option buy)
            exit_friction = calc_dhan_cost("BUY", short_qty, exit_price)
            cycle_friction = entry_friction + exit_friction

            gross_pnl = (short_entry_price - exit_price) * short_qty
            net_pnl = gross_pnl - cycle_friction

            cumulative_gross_premium += gross_pnl
            cumulative_friction += cycle_friction
            cumulative_net_short_premium += net_pnl

            current_lcr = (cumulative_net_short_premium / initial_long_debit) * 100.0 if initial_long_debit > 0 else 0.0
            is_free_now = current_lcr >= 100.0

            trade = CycleTrade(
                cycle_num=len(trades) + 1,
                expiry=expiry_str,
                strike=short_strike,
                entry_datetime=entry_dt_str,
                entry_price=round(short_entry_price, 2),
                exit_datetime=exit_dt_str,
                exit_price=round(exit_price, 2),
                lots=short_lots,
                qty=short_qty,
                exit_reason=exit_reason,
                entry_delta=round(short_delta, 2),
                score=round(short_score, 1),
                gross_pnl=round(gross_pnl, 2),
                friction=round(cycle_friction, 2),
                net_pnl=round(net_pnl, 2),
                cumulative_net_premium=round(cumulative_net_short_premium, 2),
                lcr_pct=round(current_lcr, 1),
                is_free_long_call=is_free_now,
            )
            trades.append(trade)

            # Record point in equity curve
            equity_curve.append({
                "timestamp": exit_dt_str,
                "cycle": trade.cycle_num,
                "spot": round(spot_by_dt.get(exit_dt_str, entry_spt), 2),
                "cycle_net_pnl": trade.net_pnl,
                "cumulative_short_premium": trade.cumulative_net_premium,
                "lcr_pct": trade.lcr_pct,
                "is_free_long_call": is_free_now,
            })

            # Advance current bar index to after this trade's exit
            current_bar_idx = exit_bar_idx + 1

    # End of backtest period analysis
    total_cycles = len(trades)
    winning_trades = [t for t in trades if t.net_pnl > 0]
    losing_trades = [t for t in trades if t.net_pnl < 0]
    win_rate = (len(winning_trades) / total_cycles * 100.0) if total_cycles > 0 else 0.0

    total_gross = cumulative_gross_premium
    total_friction = cumulative_friction
    total_net_short = cumulative_net_short_premium
    final_lcr = (total_net_short / initial_long_debit * 100.0) if initial_long_debit > 0 else 0.0

    # Drawdown calculations on the cumulative short premium curve
    cum_pnls = [e["cumulative_short_premium"] for e in equity_curve]
    peak = 0.0
    max_dd_rs = 0.0
    for pnl in cum_pnls:
        if pnl > peak:
            peak = pnl
        dd = peak - pnl
        if dd > max_dd_rs:
            max_dd_rs = dd

    max_dd_pct = (max_dd_rs / capital * 100.0) if capital > 0 else 0.0

    # ── LONG CALL SCENARIOS EVALUATION ────────────────────────────────────────
    # Final spot on 2026-09-29
    final_spot = equity_curve[-1]["spot"] if equity_curve else 22716.0

    # Scenario B: Zero Recovery (User's Core Question)
    # The long call purchased at Rs initial_long_price drops to Rs 0.0 (100% loss)
    zero_recovery_long_loss = -initial_long_debit
    zero_recovery_strategy_net_pnl = total_net_short + zero_recovery_long_loss
    zero_recovery_roi_pct = (zero_recovery_strategy_net_pnl / capital) * 100.0

    # Summary dictionary
    summary = {
        "period": f"{start_date} to {end_date}",
        "total_expiries": len(expiries),
        "total_short_cycles": total_cycles,
        "winning_cycles": len(winning_trades),
        "losing_cycles": len(losing_trades),
        "win_rate_pct": round(win_rate, 1),
        "total_gross_short_premium": round(total_gross, 2),
        "total_dhan_friction": round(total_friction, 2),
        "total_net_short_premium": round(total_net_short, 2),
        "max_drawdown_rs": round(max_dd_rs, 2),
        "max_drawdown_pct": round(max_dd_pct, 2),
        "initial_long_strike": long_strike,
        "initial_long_debit": round(initial_long_debit, 2),
        "final_lcr_pct": round(final_lcr, 1),
        "free_long_call_reached": free_long_call_reached,
        "free_long_call_date": free_long_call_date,
        "free_long_call_cycle": free_long_call_cycle,
        "zero_recovery_long_loss": round(zero_recovery_long_loss, 2),
        "zero_recovery_strategy_net_pnl": round(zero_recovery_strategy_net_pnl, 2),
        "zero_recovery_roi_pct": round(zero_recovery_roi_pct, 1),
    }

    # Save to disk
    if output_dir is None:
        output_dir = os.path.join(BACKTESTS_DIR, "diagonal_call_2026")
    os.makedirs(output_dir, exist_ok=True)

    with open(os.path.join(output_dir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)

    df_trades = pd.DataFrame([t.__dict__ for t in trades])
    df_trades.to_csv(os.path.join(output_dir, "trades.csv"), index=False)

    df_equity = pd.DataFrame(equity_curve)
    df_equity.to_csv(os.path.join(output_dir, "equity_curve.csv"), index=False)

    # ── PRINT DETAILED REPORT ─────────────────────────────────────────────────
    print("\n" + "=" * 80)
    print("  DIAGONAL COVERED CALL BACKTEST PERFORMANCE SUMMARY (2026)")
    print("=" * 80)
    print(f"  Total Expiries Tested:        {len(expiries)} expiries (Jan to Sep 2026)")
    print(f"  Total Short Call Cycles:      {total_cycles}")
    print(f"  Win Rate:                     {win_rate:.1f}% ({len(winning_trades)} wins / {len(losing_trades)} losses)")
    print(f"  Gross Short Premium:          Rs {total_gross:,.2f}")
    print(f"  Dhan Friction & Taxes:        Rs {total_friction:,.2f}")
    print(f"  Net Short Premium Collected:  Rs {total_net_short:,.2f}")
    print(f"  Max Drawdown on Shorts:       Rs {max_dd_rs:,.2f} ({max_dd_pct:.1f}% of capital)")
    print("-" * 80)
    print(f"  Initial Long Call Debit:      Rs {initial_long_debit:,.2f} ({long_lots} lots @ strike {long_strike:.0f} CE)")
    print(f"  Final Long Cost Recovery:     {final_lcr:.1f}%")
    print(f"  'Free Long Call' Reached:     {'YES (Milestone Achieved!)' if free_long_call_reached else 'NO'}")
    if free_long_call_reached:
        print(f"  -> Milestone Achieved At:     Cycle #{free_long_call_cycle} on {free_long_call_date}")
    print("=" * 80)
    print("  STRESS TEST: ZERO-RECOVERY WORST-CASE EVALUATION")
    print("  (Scenario: Long call is never rolled and expires completely worthless at Rs 0)")
    print("-" * 80)
    print(f"  Long Option 100% Loss:        Rs {zero_recovery_long_loss:,.2f}")
    print(f"  Net Short Premium Income:    +Rs {total_net_short:,.2f}")
    print(f"  NET STRATEGY PROFIT / LOSS:   Rs {zero_recovery_strategy_net_pnl:+,.2f} (ROI: {zero_recovery_roi_pct:+.1f}%)")
    print("=" * 80 + "\n")

    # Print First 10 and Last 5 Cycles Sample
    print("Sample Cycle Execution Log:")
    print("-" * 80)
    for t in trades[:8]:
        free_tag = "[FREE CALL]" if t.is_free_long_call else ""
        print(f"Cycle #{t.cycle_num:02d} | Exp: {t.expiry} | Strike: {t.strike:5.0f} CE x {t.lots}L | In: Rs {t.entry_price:5.1f} -> Out: Rs {t.exit_price:5.1f} | Net: Rs {t.net_pnl:+8.0f} | LCR: {t.lcr_pct:5.1f}% {free_tag}")
    if len(trades) > 12:
        print("... [Intermediate cycles omitted] ...")
        for t in trades[-4:]:
            free_tag = "[FREE CALL]" if t.is_free_long_call else ""
            print(f"Cycle #{t.cycle_num:02d} | Exp: {t.expiry} | Strike: {t.strike:5.0f} CE x {t.lots}L | In: Rs {t.entry_price:5.1f} -> Out: Rs {t.exit_price:5.1f} | Net: Rs {t.net_pnl:+8.0f} | LCR: {t.lcr_pct:5.1f}% {free_tag}")
    print("-" * 80 + "\n")

    return summary


def parse_args():
    parser = argparse.ArgumentParser(description="Backtest Engine for Nifty Diagonal Covered Call Strategy.")
    parser.add_argument("--start-date", type=str, default="2026-01-01", help="Start date (YYYY-MM-DD).")
    parser.add_argument("--end-date", type=str, default="2026-09-30", help="End date (YYYY-MM-DD).")
    parser.add_argument("--long-lots", type=int, default=3, help="Core long lots (default: 3).")
    parser.add_argument("--long-strike", type=float, default=None, help="Explicit long strike (default: auto ATM).")
    parser.add_argument("--target-net-delta", type=float, default=13.0, help="Target net delta shares (default: 13.0).")
    parser.add_argument("--short-target-delta", type=float, default=0.18, help="Target short delta (default: 0.18).")
    parser.add_argument("--short-profit-pct", type=float, default=65.0, help="Short profit target % decay (default: 65.0).")
    parser.add_argument("--max-short-lots", type=int, default=6, help="Hard ceiling on short call lots for margin safety (default: 6).")
    parser.add_argument("--capital", type=float, default=500000.0, help="Capital allocation (default: 500000).")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    run_diagonal_call_backtest(
        start_date=args.start_date,
        end_date=args.end_date,
        long_lots=args.long_lots,
        long_strike=args.long_strike,
        target_net_delta=args.target_net_delta,
        short_target_delta=args.short_target_delta,
        short_profit_pct=args.short_profit_pct,
        max_short_lots=args.max_short_lots,
        capital=args.capital,
    )
