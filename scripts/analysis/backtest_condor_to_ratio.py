"""
Backtest Engine for Nifty Iron Condor to Ratio Spread Strategy.

Queries 1-minute historical option prices from `Options Data/nifty_options.db`
and simulates the transition from neutral Iron Condor to directional Ratio Spread,
including continuation shifts, reversal flips, realistic Dhan friction, and trailing stop loss.

Usage:
  ./venv/bin/python scripts/analysis/backtest_condor_to_ratio.py --start-date 2026-07-01 --end-date 2026-09-30
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

from lib.options_pricing import compute_bs_greeks_exact, price_option, years_from_days  # noqa: E402
DB_PATH = os.path.join(PROJECT_ROOT, "Options Data", "nifty_options.db")
BACKTESTS_DIR = os.path.join(PROJECT_ROOT, "debug", "backtests", "options")
DEBUG_DIR = os.path.join(PROJECT_ROOT, "debug")  # where the dashboard polls backtest_status.json / backtest_result.json

FALLBACK_MARGIN_PER_LOT = 150000.0  # ~1.5L per lot capital base for 4-leg condor / 3-leg ratio
LOT_SIZE_DEFAULT = 65


def calc_dhan_cost(txn_type: str, qty: int, price: float) -> float:
    """Exact Dhan broker + statutory taxes for one executed F&O leg order."""
    turnover = qty * price
    brokerage = 20.0
    gst_brokerage = brokerage * 0.18  # Rs 3.60
    exch_charge = turnover * 0.0005
    gst_exch = exch_charge * 0.18
    stt = (turnover * 0.0010) if txn_type == "SELL" else 0.0
    stamp = (turnover * 0.00003) if txn_type == "BUY" else 0.0
    sebi = turnover * 0.000001 * 1.18
    return brokerage + gst_brokerage + exch_charge + gst_exch + stt + stamp + sebi


# The maths is lib/options_pricing.py; these two functions only adapt this backtest's inputs (IV in percent with a 14% fallback,
# calendar days to expiry) to it.
def _opt(option_type: str) -> str:
    return "CE" if option_type.upper() in ("CE", "CALL") else "PE"


def calculate_bs_delta(spot: float, strike: float, dte_days: float, iv_pct: float, option_type: str) -> float:
    if spot <= 0 or strike <= 0:
        return 0.5 if _opt(option_type) == "CE" else -0.5
    iv = (iv_pct if iv_pct > 1.0 else 14.0) / 100.0
    return compute_bs_greeks_exact(_opt(option_type), spot, strike, years_from_days(dte_days, 0.001), iv).delta


def calculate_bs_price(spot: float, strike: float, dte_days: float, iv_pct: float, option_type: str) -> float:
    if spot <= 0 or strike <= 0:
        return 0.05
    iv = (iv_pct if iv_pct > 1.0 else 14.0) / 100.0
    return max(0.05, price_option(_opt(option_type), spot, strike, years_from_days(dte_days, 0.0001), iv))


@dataclass
class PositionLeg:
    role: str            # 'short_ce', 'hedge_ce', 'short_pe', 'hedge_pe', 'long_opt', 'short_opt', 'hedge_opt'
    symbol: str
    strike: float
    option_type: str     # 'CE' or 'PE'
    side: str            # 'BUY' or 'SELL'
    lots: int
    qty: int
    entry_price: float
    entry_time: str
    entry_delta: float
    current_ltp: float = 0.0
    current_delta: float = 0.0


@dataclass
class TradeRecord:
    cycle_id: str
    expiry: str
    stage: str
    action: str          # 'ENTRY_CONDOR', 'EXIT_CONDOR', 'ENTRY_RATIO', 'SHIFT_RATIO', 'REVERSE_RATIO', 'EXIT_ALL'
    timestamp: str
    reason: str
    legs_summary: str
    cycle_realized_pnl: float
    cycle_gross_pnl: float
    cycle_net_pnl: float
    friction: float
    spot: float


def run_condor_to_ratio_backtest(
    start_date: str = "2026-07-01",
    end_date: str = "2026-09-30",
    lots: int = 1,
    lot_size: int = LOT_SIZE_DEFAULT,
    target_profit_str: str = "15%",
    stop_loss_str: str = "15%",
    condor_short_delta: float = 0.30,
    condor_hedge_delta: float = 0.10,
    condor_exit_delta: float = 0.10,
    ratio_long_delta: float = 0.50,
    ratio_short_delta: float = 0.40,
    ratio_hedge_delta: float = 0.10,
    ratio_shift_delta: float = 0.10,
    ratio_reversal_delta: float = 0.60,
    shift_long_delta: float = 0.40,
    shift_short_delta: float = 0.30,
    shift_hedge_delta: float = 0.08,
    max_shifts: int = 5,
    max_reversals: int = 3,
    trail_start_rs: float = 5000.0,
    trail_gap_rs: float = 2500.0,
    slippage_pct: float = 0.001,
    archive: bool = True,
    status_file: Optional[str] = None
) -> Dict[str, Any]:

    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"Database not found at {DB_PATH}")

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Find all expiries that fall in [start_date, end_date]
    cursor.execute("""
        SELECT DISTINCT expiry, MIN(datetime), MAX(datetime)
        FROM option_prices
        WHERE expiry >= ? AND expiry <= ?
        GROUP BY expiry
        ORDER BY expiry
    """, (start_date, end_date))
    expiry_rows = cursor.fetchall()

    if not expiry_rows:
        print(f"No expiries found between {start_date} and {end_date}")
        return {}

    capital_base = FALLBACK_MARGIN_PER_LOT * lots
    target_profit_rs = (float(target_profit_str.rstrip("%")) / 100.0 * capital_base) if target_profit_str.endswith("%") else float(target_profit_str)
    stop_loss_rs = (float(stop_loss_str.rstrip("%")) / 100.0 * capital_base) if stop_loss_str.endswith("%") else float(stop_loss_str)

    print(f"\n================================================================================")
    print(f"  NIFTY CONDOR TO RATIO SPREAD BACKTEST (1-MIN OPTIONS DATA)")
    print(f"================================================================================")
    print(f"  Period:             {start_date} to {end_date} ({len(expiry_rows)} Expiry Cycles)")
    print(f"  Sizing:             {lots} Lot(s) ({lots * lot_size} Qty/leg) | Capital Base: ₹{capital_base:,.0f}")
    print(f"  Target Profit:      ₹{target_profit_rs:,.0f} ({target_profit_str})")
    print(f"  Stop Loss:          ₹{stop_loss_rs:,.0f} ({stop_loss_str})")
    print(f"  Trailing SL:        Arm @ ₹{trail_start_rs:,.0f} | Gap ₹{trail_gap_rs:,.0f}")
    print(f"  Initial Condor:     Short Δ {condor_short_delta:.2f} | Hedge Δ {condor_hedge_delta:.2f} | Exit Δ <= {condor_exit_delta:.2f}")
    print(f"  Ratio Spread:       Long Δ {ratio_long_delta:.2f} | Short Δ {ratio_short_delta:.2f} (x2) | Hedge Δ {ratio_hedge_delta:.2f}")
    print(f"  Shifts / Reversals: Shift @ sold Δ <= {ratio_shift_delta:.2f} | Reversal @ sold Δ >= {ratio_reversal_delta:.2f}")
    print(f"  Friction:           Dhan Brokerage (₹20/ord) + STT (0.1% sell) + Exch + GST | Slippage {slippage_pct*100:.2f}%")
    print(f"================================================================================\n")

    all_cycles: List[Dict[str, Any]] = []
    all_trade_log: List[TradeRecord] = []
    equity_curve: List[Dict[str, Any]] = []
    cumulative_net_pnl = 0.0

    total_shifts_count = 0
    total_reversals_count = 0
    condor_only_cycles = 0
    ratio_transition_cycles = 0

    for exp_idx, (expiry_str, min_dt, max_dt) in enumerate(expiry_rows, 1):
        # Load all 1-min data for this expiry
        query = """
            SELECT datetime, strike, option_type, open, high, low, close, spot, iv
            FROM option_prices
            WHERE expiry = ?
            ORDER BY datetime, strike, option_type
        """
        df_exp = pd.read_sql_query(query, conn, params=(expiry_str,))
        if df_exp.empty:
            continue

        expiry_dt = datetime.strptime(expiry_str, "%Y-%m-%d").replace(hour=15, minute=30)

        # Index data by (datetime, strike, option_type)
        # Unique minutes
        all_times = sorted(df_exp['datetime'].unique())
        if not all_times:
            continue

        # Fast lookup map: dt -> dict of (strike, type) -> (close, spot, iv)
        bars_by_dt: Dict[str, Dict[Tuple[float, str], Tuple[float, float, float]]] = {}
        spot_by_dt: Dict[str, float] = {}

        for row in df_exp.itertuples():
            dt_s = str(row.datetime)
            stk = float(row.strike)
            opt = str(row.option_type)
            cls = float(row.close)
            spt = float(row.spot)
            iv = float(row.iv) if (row.iv is not None and not np.isnan(row.iv) and row.iv > 0) else 14.0

            if dt_s not in bars_by_dt:
                bars_by_dt[dt_s] = {}
                spot_by_dt[dt_s] = spt
            bars_by_dt[dt_s][(stk, opt)] = (cls, spt, iv)

        # Find entry bar: first available bar >= 09:20
        entry_candidates = [t for t in all_times if t[11:16] >= "09:20"]
        if not entry_candidates:
            continue
        entry_dt_str = entry_candidates[0]

        # Helper to find strike closest to target delta
        def find_strike_by_delta(dt_str: str, opt_type: str, target_d: float) -> Tuple[Optional[float], Optional[float], Optional[float], float]:
            spt = spot_by_dt.get(dt_str, 0.0)
            if spt <= 0 or dt_str not in bars_by_dt:
                return None, None, None, 0.0
            
            normalized_opt = "CE" if opt_type.upper() in ("CE", "CALL") else "PE"
            cur_dt = datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S")
            dte = max(0.001, (expiry_dt - cur_dt).total_seconds() / 86400.0)

            best_stk = None
            best_diff = 999.0
            best_px = None
            best_d = 0.0

            for (stk, otype), (cls, _, iv) in bars_by_dt[dt_str].items():
                if otype != normalized_opt:
                    continue
                d = calculate_bs_delta(spt, stk, dte, iv, normalized_opt)
                abs_diff = abs(abs(d) - abs(target_d))
                if abs_diff < best_diff:
                    best_diff = abs_diff
                    best_stk = stk
                    best_px = cls
                    best_d = abs(d)

            return best_stk, best_px, spt, best_d

        def get_leg_price_delta(dt_str: str, opt_type: str, stk: float, dte: float) -> Tuple[float, float]:
            spt = spot_by_dt.get(dt_str, 0.0)
            normalized_opt = "CE" if opt_type.upper() in ("CE", "CALL") else "PE"
            if (stk, normalized_opt) in bars_by_dt.get(dt_str, {}):
                cls, _, iv = bars_by_dt[dt_str][(stk, normalized_opt)]
                d = calculate_bs_delta(spt, stk, dte, iv, normalized_opt)
                return cls, abs(d)
            else:
                p = calculate_bs_price(spt, stk, dte, 14.0, normalized_opt)
                d = calculate_bs_delta(spt, stk, dte, 14.0, normalized_opt)
                return p, abs(d)

        def choose_ratio_spread_strikes(
            dt_str: str,
            opt_type: str,
            target_long_d: float,
            target_short_d: float,
            target_hedge_d: float,
            strike_step: float = 50.0
        ) -> Tuple[Optional[float], Optional[float], Optional[float], Optional[float], Optional[float], Optional[float], float, float, float]:
            normalized_opt = "CE" if opt_type.upper() in ("CE", "CALL") else "PE"
            cur_dt = datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S")
            dte = max(0.001, (expiry_dt - cur_dt).total_seconds() / 86400.0)

            long_k, long_px, _, long_d = find_strike_by_delta(dt_str, normalized_opt, target_long_d)
            short_k, short_px, _, short_d = find_strike_by_delta(dt_str, normalized_opt, target_short_d)
            hedge_k, hedge_px, _, hedge_d = find_strike_by_delta(dt_str, normalized_opt, target_hedge_d)

            if not (long_k and short_k and hedge_k):
                return None, None, None, None, None, None, 0.0, 0.0, 0.0

            # Enforce strictly monotonic strike ladder matching live strategy
            # Call Ratio: long_k < short_k < hedge_k
            # Put Ratio:  long_k > short_k > hedge_k
            if normalized_opt == "CE":
                if short_k <= long_k:
                    short_k = long_k + strike_step
                    short_px, short_d = get_leg_price_delta(dt_str, normalized_opt, short_k, dte)
                if hedge_k <= short_k:
                    hedge_k = short_k + 2 * strike_step
                    hedge_px, hedge_d = get_leg_price_delta(dt_str, normalized_opt, hedge_k, dte)
            else:
                if short_k >= long_k:
                    short_k = long_k - strike_step
                    short_px, short_d = get_leg_price_delta(dt_str, normalized_opt, short_k, dte)
                if hedge_k >= short_k:
                    hedge_k = short_k - 2 * strike_step
                    hedge_px, hedge_d = get_leg_price_delta(dt_str, normalized_opt, hedge_k, dte)

            return long_k, short_k, hedge_k, long_px, short_px, hedge_px, long_d, short_d, hedge_d

        # ── INITIALIZE CYCLE ────────────────────────────────────────────────────────
        cycle_id = f"CYCLE-{exp_idx:02d}-{expiry_str}"
        stage = "CONDOR"
        direction = "NEUTRAL"
        shifts_count = 0
        reversals_count = 0
        last_adjustment_dt: Optional[datetime] = None

        legs: Dict[str, PositionLeg] = {}
        cycle_realized_pnl = 0.0
        cycle_friction = 0.0
        cycle_best_pnl = 0.0
        trail_active = False

        # Deploy Iron Condor
        ce_short_stk, ce_short_px, spot_entry, ce_s_d = find_strike_by_delta(entry_dt_str, "CE", condor_short_delta)
        ce_hedge_stk, ce_hedge_px, _, ce_h_d = find_strike_by_delta(entry_dt_str, "CE", condor_hedge_delta)
        pe_short_stk, pe_short_px, _, pe_s_d = find_strike_by_delta(entry_dt_str, "PE", condor_short_delta)
        pe_hedge_stk, pe_hedge_px, _, pe_h_d = find_strike_by_delta(entry_dt_str, "PE", condor_hedge_delta)

        if not (ce_short_stk and ce_hedge_stk and pe_short_stk and pe_hedge_stk):
            print(f"  [!] Skipped {expiry_str}: missing option chain strikes for Condor entry")
            continue

        entry_dte = max(0.001, (expiry_dt - datetime.strptime(entry_dt_str, "%Y-%m-%d %H:%M:%S")).total_seconds() / 86400.0)

        # Enforce monotonic strike ladder: pe_hedge < pe_short < ce_short < ce_hedge
        if pe_short_stk >= ce_short_stk:
            atm = round(spot_entry / 50.0) * 50.0
            pe_short_stk = atm - 50.0
            ce_short_stk = atm + 50.0
            ce_short_px, ce_s_d = get_leg_price_delta(entry_dt_str, "CE", ce_short_stk, entry_dte)
            pe_short_px, pe_s_d = get_leg_price_delta(entry_dt_str, "PE", pe_short_stk, entry_dte)

        if pe_hedge_stk >= pe_short_stk:
            pe_hedge_stk = pe_short_stk - 100.0
            pe_hedge_px, pe_h_d = get_leg_price_delta(entry_dt_str, "PE", pe_hedge_stk, entry_dte)

        if ce_hedge_stk <= ce_short_stk:
            ce_hedge_stk = ce_short_stk + 100.0
            ce_hedge_px, ce_h_d = get_leg_price_delta(entry_dt_str, "CE", ce_hedge_stk, entry_dte)

        # Slippage: buying costs more, selling fetches less
        ce_short_exec = ce_short_px * (1.0 - slippage_pct)
        pe_short_exec = pe_short_px * (1.0 - slippage_pct)
        ce_hedge_exec = ce_hedge_px * (1.0 + slippage_pct)
        pe_hedge_exec = pe_hedge_px * (1.0 + slippage_pct)

        legs["short_ce"] = PositionLeg("short_ce", f"NIFTY {ce_short_stk} CE", ce_short_stk, "CE", "SELL", lots, lots * lot_size, ce_short_exec, entry_dt_str, ce_s_d, ce_short_exec, ce_s_d)
        legs["hedge_ce"] = PositionLeg("hedge_ce", f"NIFTY {ce_hedge_stk} CE", ce_hedge_stk, "CE", "BUY", lots, lots * lot_size, ce_hedge_exec, entry_dt_str, ce_h_d, ce_hedge_exec, ce_h_d)
        legs["short_pe"] = PositionLeg("short_pe", f"NIFTY {pe_short_stk} PE", pe_short_stk, "PE", "SELL", lots, lots * lot_size, pe_short_exec, entry_dt_str, pe_s_d, pe_short_exec, pe_s_d)
        legs["hedge_pe"] = PositionLeg("hedge_pe", f"NIFTY {pe_hedge_stk} PE", pe_hedge_stk, "PE", "BUY", lots, lots * lot_size, pe_hedge_exec, entry_dt_str, pe_h_d, pe_hedge_exec, pe_h_d)

        # Entry friction
        for leg in legs.values():
            cycle_friction += calc_dhan_cost(leg.side, leg.qty, leg.entry_price)

        all_trade_log.append(TradeRecord(
            cycle_id=cycle_id,
            expiry=expiry_str,
            stage="CONDOR",
            action="ENTRY_CONDOR",
            timestamp=entry_dt_str,
            reason="Initial Iron Condor Entry",
            legs_summary=f"Sell {ce_short_stk}CE (Δ{ce_s_d:.2f}) + Buy {ce_hedge_stk}CE | Sell {pe_short_stk}PE (Δ{pe_s_d:.2f}) + Buy {pe_hedge_stk}PE",
            cycle_realized_pnl=0.0,
            cycle_gross_pnl=0.0,
            cycle_net_pnl=-cycle_friction,
            friction=cycle_friction,
            spot=spot_entry
        ))

        # Helper to compute unrealized P&L
        def calc_unrealized_pnl(current_legs: Dict[str, PositionLeg]) -> float:
            unrealized = 0.0
            for l in current_legs.values():
                if l.side == "SELL":
                    unrealized += (l.entry_price - l.current_ltp) * l.qty
                else:
                    unrealized += (l.current_ltp - l.entry_price) * l.qty
            return unrealized

        cycle_legs_records: List[Dict[str, Any]] = []

        # Helper to close all legs
        def close_current_legs(current_legs: Dict[str, PositionLeg], dt_str: str, reason: str, act: str) -> float:
            nonlocal cycle_realized_pnl, cycle_friction
            leg_friction = 0.0
            leg_realized = 0.0
            closed_summaries = []
            for l in current_legs.values():
                exit_side = "BUY" if l.side == "SELL" else "SELL"
                exit_px = l.current_ltp * (1.0 + slippage_pct if exit_side == "BUY" else 1.0 - slippage_pct)
                if l.side == "SELL":
                    leg_pnl = (l.entry_price - exit_px) * l.qty
                else:
                    leg_pnl = (exit_px - l.entry_price) * l.qty
                leg_realized += leg_pnl
                leg_friction += calc_dhan_cost(exit_side, l.qty, exit_px)
                closed_summaries.append(f"{exit_side} {l.qty} {l.symbol} @ ₹{exit_px:.2f} (PnL ₹{leg_pnl:.0f})")
                cycle_legs_records.append({
                    "option_type": l.option_type,
                    "position": l.side.lower(),
                    "strike": float(l.strike),
                    "lots": l.lots,
                    "entry_price": round(l.entry_price, 2),
                    "exit_price": round(exit_px, 2),
                    "pnl": round(leg_pnl, 2),
                    "exit_reason": reason,
                    "entry_time": l.entry_time,
                    "exit_time": dt_str
                })

            cycle_realized_pnl += leg_realized
            cycle_friction += leg_friction

            all_trade_log.append(TradeRecord(
                cycle_id=cycle_id,
                expiry=expiry_str,
                stage=stage,
                action=act,
                timestamp=dt_str,
                reason=reason,
                legs_summary="; ".join(closed_summaries),
                cycle_realized_pnl=cycle_realized_pnl,
                cycle_gross_pnl=cycle_realized_pnl,
                cycle_net_pnl=cycle_realized_pnl - cycle_friction,
                friction=cycle_friction,
                spot=spot_by_dt.get(dt_str, 0.0)
            ))
            return leg_realized

        cycle_closed = False
        exit_reason = ""
        exit_dt_str = ""

        # Minute-by-minute simulation loop
        sim_times = [t for t in all_times if t >= entry_dt_str]

        for cur_time in sim_times:
            bar_map = bars_by_dt[cur_time]
            cur_spot = spot_by_dt[cur_time]
            cur_dt = datetime.strptime(cur_time, "%Y-%m-%d %H:%M:%S")
            dte = max(0.001, (expiry_dt - cur_dt).total_seconds() / 86400.0)

            # Update leg prices and deltas
            for l_key, l in list(legs.items()):
                if (l.strike, l.option_type) in bar_map:
                    px, _, iv = bar_map[(l.strike, l.option_type)]
                    l.current_ltp = px
                    l.current_delta = abs(calculate_bs_delta(cur_spot, l.strike, dte, iv, l.option_type))
                else:
                    # Estimate BS delta and price if strike drifted outside ATM±10 cache window
                    l.current_delta = abs(calculate_bs_delta(cur_spot, l.strike, dte, 14.0, l.option_type))
                    l.current_ltp = calculate_bs_price(cur_spot, l.strike, dte, 14.0, l.option_type)

            # Total current P&L
            unrealized_pnl = calc_unrealized_pnl(legs)
            total_gross = cycle_realized_pnl + unrealized_pnl
            total_net = total_gross - cycle_friction

            if total_gross > cycle_best_pnl:
                cycle_best_pnl = total_gross

            # ── 1. GLOBAL RISK EXITS (Target, Stop, Trail) ──────────────────────────
            if total_gross >= target_profit_rs:
                close_current_legs(legs, cur_time, f"Profit Target ₹{target_profit_rs:,.0f} Reached", "EXIT_ALL")
                cycle_closed = True
                exit_reason = f"TARGET_PROFIT (+₹{total_gross:,.0f})"
                exit_dt_str = cur_time
                break

            if total_gross <= -stop_loss_rs:
                close_current_legs(legs, cur_time, f"Stop Loss -₹{stop_loss_rs:,.0f} Breached", "EXIT_ALL")
                cycle_closed = True
                exit_reason = f"STOP_LOSS (-₹{abs(total_gross):,.0f})"
                exit_dt_str = cur_time
                break

            # Trailing Stop Loss
            if not trail_active and total_gross >= trail_start_rs:
                trail_active = True

            if trail_active and (cycle_best_pnl - total_gross) >= trail_gap_rs:
                close_current_legs(legs, cur_time, f"Trailing SL Hit (Peak ₹{cycle_best_pnl:,.0f} -> Now ₹{total_gross:,.0f})", "EXIT_ALL")
                cycle_closed = True
                exit_reason = f"TRAIL_SL (Peak ₹{cycle_best_pnl:,.0f}, Giveback ₹{trail_gap_rs:,.0f})"
                exit_dt_str = cur_time
                break

            # Expiry Day EOD Exit (15:15 on expiry date)
            if cur_time[:10] == expiry_str and cur_time[11:16] >= "15:15":
                close_current_legs(legs, cur_time, "Expiry Day EOD Square-Off", "EXIT_ALL")
                cycle_closed = True
                exit_reason = "EXPIRY_EOD"
                exit_dt_str = cur_time
                break

            # ── 2. PHASE 1: IRON CONDOR TRANSITION CHECK ──────────────────────────
            if stage == "CONDOR" and "short_ce" in legs and "short_pe" in legs:
                ce_delta = legs["short_ce"].current_delta
                pe_delta = legs["short_pe"].current_delta

                # Trigger transition if either short leg delta decays to <= condor_exit_delta
                if (ce_delta <= condor_exit_delta or pe_delta <= condor_exit_delta) and ce_delta > 0 and pe_delta > 0:
                    # Direction determination:
                    # CE decayed <= 0.10 -> Market dropped -> Bearish -> Deploy Call Ratio Spread (CE)
                    # PE decayed <= 0.10 -> Market rallied -> Bullish -> Deploy Put Ratio Spread (PE)
                    ratio_dir = "CE" if ce_delta <= condor_exit_delta else "PE"
                    trigger_leg = f"Short CE Δ={ce_delta:.2f}" if ce_delta <= condor_exit_delta else f"Short PE Δ={pe_delta:.2f}"

                    # Probe Ratio Spread strikes before closing Condor
                    r_res = choose_ratio_spread_strikes(cur_time, ratio_dir, ratio_long_delta, ratio_short_delta, ratio_hedge_delta)
                    r_long_stk, r_short_stk, r_hedge_stk, r_long_px, r_short_px, r_hedge_px, r_long_d, r_short_d, r_hedge_d = r_res

                    if r_long_stk and r_short_stk and r_hedge_stk and r_long_px and r_short_px and r_hedge_px:
                        # Close Iron Condor
                        close_current_legs(legs, cur_time, f"Condor Exit ({trigger_leg} <= {condor_exit_delta})", "EXIT_CONDOR")
                        legs.clear()

                        stage = "RATIO"
                        direction = ratio_dir
                        ratio_transition_cycles += 1
                        last_adjustment_dt = cur_dt

                        long_exec = r_long_px * (1.0 + slippage_pct)
                        short_exec = r_short_px * (1.0 - slippage_pct)
                        hedge_exec = r_hedge_px * (1.0 + slippage_pct)

                        legs["long_opt"] = PositionLeg("long_opt", f"NIFTY {r_long_stk} {ratio_dir}", r_long_stk, ratio_dir, "BUY", lots, lots * lot_size, long_exec, cur_time, r_long_d, long_exec, r_long_d)
                        legs["short_opt"] = PositionLeg("short_opt", f"NIFTY {r_short_stk} {ratio_dir}", r_short_stk, ratio_dir, "SELL", 2 * lots, 2 * lots * lot_size, short_exec, cur_time, r_short_d, short_exec, r_short_d)
                        legs["hedge_opt"] = PositionLeg("hedge_opt", f"NIFTY {r_hedge_stk} {ratio_dir}", r_hedge_stk, ratio_dir, "BUY", lots, lots * lot_size, hedge_exec, cur_time, r_hedge_d, hedge_exec, r_hedge_d)

                        for l in legs.values():
                            cycle_friction += calc_dhan_cost(l.side, l.qty, l.entry_price)

                        all_trade_log.append(TradeRecord(
                            cycle_id=cycle_id,
                            expiry=expiry_str,
                            stage="RATIO",
                            action="ENTRY_RATIO",
                            timestamp=cur_time,
                            reason=f"Transition from Condor to {ratio_dir} Ratio ({trigger_leg})",
                            legs_summary=f"Buy 1x {r_long_stk}{ratio_dir} (Δ{r_long_d:.2f}) | Sell 2x {r_short_stk}{ratio_dir} (Δ{r_short_d:.2f}) | Buy 1x {r_hedge_stk}{ratio_dir} (Δ{r_hedge_d:.2f})",
                            cycle_realized_pnl=cycle_realized_pnl,
                            cycle_gross_pnl=cycle_realized_pnl,
                            cycle_net_pnl=cycle_realized_pnl - cycle_friction,
                            friction=cycle_friction,
                            spot=cur_spot
                        ))

            # ── 3. PHASE 2: RATIO SPREAD CONTINUATION SHIFT & REVERSAL CHECK ────────
            elif stage == "RATIO" and "short_opt" in legs:
                sold_delta = legs["short_opt"].current_delta

                # Adjustment timing gates:
                # 1. No shifts/reversals on expiry day afternoon (after 13:00) when DTE collapses
                # 2. 15-minute cooldown between adjustments to prevent whipsaw churn
                is_expiry_day = (cur_time[:10] == expiry_str)
                can_adjust = not (is_expiry_day and cur_time[11:16] >= "13:00")
                in_cooldown = (last_adjustment_dt is not None) and ((cur_dt - last_adjustment_dt).total_seconds() < 900)

                # A. Continuation Shift Rule (sold delta decays to <= ratio_shift_delta)
                if can_adjust and not in_cooldown and sold_delta <= ratio_shift_delta and sold_delta > 0 and shifts_count < max_shifts:
                    s_res = choose_ratio_spread_strikes(cur_time, direction, shift_long_delta, shift_short_delta, shift_hedge_delta)
                    s_long_stk, s_short_stk, s_hedge_stk, s_long_px, s_short_px, s_hedge_px, s_long_d, s_short_d, s_hedge_d = s_res

                    if s_long_stk and s_short_stk and s_hedge_stk and s_long_px and s_short_px and s_hedge_px:
                        shifts_count += 1
                        total_shifts_count += 1
                        last_adjustment_dt = cur_dt
                        shift_reason = f"Continuation Shift #{shifts_count} (Sold Δ={sold_delta:.2f} <= {ratio_shift_delta:.2f})"

                        close_current_legs(legs, cur_time, shift_reason, "SHIFT_RATIO")
                        legs.clear()

                        long_exec = s_long_px * (1.0 + slippage_pct)
                        short_exec = s_short_px * (1.0 - slippage_pct)
                        hedge_exec = s_hedge_px * (1.0 + slippage_pct)

                        legs["long_opt"] = PositionLeg("long_opt", f"NIFTY {s_long_stk} {direction}", s_long_stk, direction, "BUY", lots, lots * lot_size, long_exec, cur_time, s_long_d, long_exec, s_long_d)
                        legs["short_opt"] = PositionLeg("short_opt", f"NIFTY {s_short_stk} {direction}", s_short_stk, direction, "SELL", 2 * lots, 2 * lots * lot_size, short_exec, cur_time, s_short_d, short_exec, s_short_d)
                        legs["hedge_opt"] = PositionLeg("hedge_opt", f"NIFTY {s_hedge_stk} {direction}", s_hedge_stk, direction, "BUY", lots, lots * lot_size, hedge_exec, cur_time, s_hedge_d, hedge_exec, s_hedge_d)

                        for l in legs.values():
                            cycle_friction += calc_dhan_cost(l.side, l.qty, l.entry_price)

                        all_trade_log.append(TradeRecord(
                            cycle_id=cycle_id,
                            expiry=expiry_str,
                            stage="RATIO",
                            action="SHIFT_RATIO",
                            timestamp=cur_time,
                            reason=shift_reason,
                            legs_summary=f"Shifted: Buy {s_long_stk}{direction} | Sell 2x {s_short_stk}{direction} | Buy {s_hedge_stk}{direction}",
                            cycle_realized_pnl=cycle_realized_pnl,
                            cycle_gross_pnl=cycle_realized_pnl,
                            cycle_net_pnl=cycle_realized_pnl - cycle_friction,
                            friction=cycle_friction,
                            spot=cur_spot
                        ))

                # B. Reversal Reset Rule (sold delta expands to >= ratio_reversal_delta)
                elif can_adjust and not in_cooldown and sold_delta >= ratio_reversal_delta and reversals_count < max_reversals:
                    rev_dir = "PE" if direction == "CE" else "CE"
                    r_res = choose_ratio_spread_strikes(cur_time, rev_dir, ratio_long_delta, ratio_short_delta, ratio_hedge_delta)
                    r_long_stk, r_short_stk, r_hedge_stk, r_long_px, r_short_px, r_hedge_px, r_long_d, r_short_d, r_hedge_d = r_res

                    if r_long_stk and r_short_stk and r_hedge_stk and r_long_px and r_short_px and r_hedge_px:
                        reversals_count += 1
                        total_reversals_count += 1
                        shifts_count = 0  # reset shift count for new direction
                        last_adjustment_dt = cur_dt
                        rev_reason = f"Reversal Flip #{reversals_count} to {rev_dir} (Sold Δ={sold_delta:.2f} >= {ratio_reversal_delta:.2f})"

                        close_current_legs(legs, cur_time, rev_reason, "REVERSE_RATIO")
                        legs.clear()

                        direction = rev_dir
                        long_exec = r_long_px * (1.0 + slippage_pct)
                        short_exec = r_short_px * (1.0 - slippage_pct)
                        hedge_exec = r_hedge_px * (1.0 + slippage_pct)

                        legs["long_opt"] = PositionLeg("long_opt", f"NIFTY {r_long_stk} {direction}", r_long_stk, direction, "BUY", lots, lots * lot_size, long_exec, cur_time, r_long_d, long_exec, r_long_d)
                        legs["short_opt"] = PositionLeg("short_opt", f"NIFTY {r_short_stk} {direction}", r_short_stk, direction, "SELL", 2 * lots, 2 * lots * lot_size, short_exec, cur_time, r_short_d, short_exec, r_short_d)
                        legs["hedge_opt"] = PositionLeg("hedge_opt", f"NIFTY {r_hedge_stk} {direction}", r_hedge_stk, direction, "BUY", lots, lots * lot_size, hedge_exec, cur_time, r_hedge_d, hedge_exec, r_hedge_d)

                        for l in legs.values():
                            cycle_friction += calc_dhan_cost(l.side, l.qty, l.entry_price)

                        all_trade_log.append(TradeRecord(
                            cycle_id=cycle_id,
                            expiry=expiry_str,
                            stage="RATIO",
                            action="REVERSE_RATIO",
                            timestamp=cur_time,
                            reason=rev_reason,
                            legs_summary=f"Reversed: Buy {r_long_stk}{direction} | Sell 2x {r_short_stk}{direction} | Buy {r_hedge_stk}{direction}",
                            cycle_realized_pnl=cycle_realized_pnl,
                            cycle_gross_pnl=cycle_realized_pnl,
                            cycle_net_pnl=cycle_realized_pnl - cycle_friction,
                            friction=cycle_friction,
                            spot=cur_spot
                        ))

        # End of cycle settlement
        if not cycle_closed and legs:
            close_current_legs(legs, sim_times[-1], "Expiry Period End", "EXIT_ALL")
            exit_reason = "CYCLE_CLOSE"
            exit_dt_str = sim_times[-1]

        if stage == "CONDOR":
            condor_only_cycles += 1

        cycle_net_pnl = cycle_realized_pnl - cycle_friction
        cumulative_net_pnl += cycle_net_pnl

        equity_curve.append({
            "date": exit_dt_str[:10] if exit_dt_str else expiry_str,
            "expiry": expiry_str,
            "cycle_pnl": round(cycle_net_pnl, 2),
            "cumulative_pnl": round(cumulative_net_pnl, 2),
            "stage": stage,
            "exit_reason": exit_reason
        })

        cycle_summary = {
            "cycle_id": cycle_id,
            "expiry_date": expiry_str,
            "expiry": expiry_str,
            "entry_dt": entry_dt_str,
            "exit_dt": exit_dt_str,
            "entry_spot": spot_entry,
            "vix": 13.5,
            "net_credit": round(cycle_realized_pnl, 2),
            "exit_combined": round(cycle_friction, 2),
            "pnl": round(cycle_net_pnl, 2),
            "gross_pnl": round(cycle_realized_pnl, 2),
            "friction": round(cycle_friction, 2),
            "net_pnl": round(cycle_net_pnl, 2),
            "return_pct": round((cycle_net_pnl / capital_base) * 100, 2),
            "exit_reason": exit_reason,
            "final_stage": stage,
            "direction": direction,
            "shifts": shifts_count,
            "reversals": reversals_count,
            "is_complete": True,
            "rolls": shifts_count,
            "legs": cycle_legs_records
        }
        all_cycles.append(cycle_summary)

        status_sign = "+" if cycle_net_pnl >= 0 else ""
        print(f"  [{exp_idx:02d}/{len(expiry_rows):02d}] Expiry {expiry_str} | Stage: {stage:6s} ({direction:7s}) | Shifts: {shifts_count} | Flips: {reversals_count} | Net: {status_sign}₹{cycle_net_pnl:8,.2f} ({status_sign}{cycle_summary['return_pct']}%) | {exit_reason}")

        if status_file:
            try:
                with open(status_file, "w") as sf:
                    json.dump({
                        "running": True,
                        "done": False,
                        "progress_pct": round((exp_idx / len(expiry_rows)) * 100, 1),
                        "msg": f"Simulating expiry {expiry_str} ({exp_idx}/{len(expiry_rows)})",
                        "total_cycles": len(expiry_rows),
                        "completed_cycles": exp_idx,
                        "current_expiry": expiry_str
                    }, sf, indent=2)
            except Exception:
                pass

    # ── METRICS & SUMMARY ───────────────────────────────────────────────────────
    cycle_pnls = [c["net_pnl"] for c in all_cycles]
    wins = [p for p in cycle_pnls if p > 0]
    losses = [p for p in cycle_pnls if p < 0]

    win_count = len(wins)
    loss_count = len(losses)
    total_cycles = len(cycle_pnls)
    win_rate = (win_count / total_cycles * 100) if total_cycles > 0 else 0.0

    total_gross = sum(c["gross_pnl"] for c in all_cycles)
    total_friction = sum(c["friction"] for c in all_cycles)
    total_net = sum(cycle_pnls)
    total_return_pct = (total_net / capital_base) * 100

    profit_factor = (sum(wins) / abs(sum(losses))) if (losses and sum(losses) != 0) else (99.0 if wins else 0.0)
    avg_win = (sum(wins) / win_count) if win_count > 0 else 0.0
    avg_loss = (sum(losses) / loss_count) if loss_count > 0 else 0.0

    # Max Drawdown
    cum_pnls = np.cumsum(cycle_pnls)
    running_max = np.maximum.accumulate(cum_pnls)
    drawdowns = running_max - cum_pnls
    max_drawdown = float(np.max(drawdowns)) if len(drawdowns) > 0 else 0.0
    max_dd_pct = (max_drawdown / capital_base) * 100.0

    # Streaks
    max_win_streak = 0
    max_loss_streak = 0
    curr_win_streak = 0
    curr_loss_streak = 0
    for pnl in cycle_pnls:
        if pnl > 0:
            curr_win_streak += 1
            curr_loss_streak = 0
            if curr_win_streak > max_win_streak:
                max_win_streak = curr_win_streak
        elif pnl < 0:
            curr_loss_streak += 1
            curr_win_streak = 0
            if curr_loss_streak > max_loss_streak:
                max_loss_streak = curr_loss_streak

    # Sharpe Ratio (annualized over ~52 weekly cycles)
    mean_return = np.mean(cycle_pnls) if len(cycle_pnls) > 0 else 0.0
    std_return = np.std(cycle_pnls) if len(cycle_pnls) > 1 else 1.0
    sharpe_ratio = float((mean_return / std_return) * math.sqrt(52)) if std_return > 0 else 0.0

    # Monthly breakdown for UI heatmap
    month_names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    monthly_pnl: Dict[str, Dict[str, float]] = {}
    for c in all_cycles:
        exp_date = c["expiry_date"]
        dt_obj = datetime.strptime(exp_date, "%Y-%m-%d")
        yr_str = str(dt_obj.year)
        m_str = month_names[dt_obj.month - 1]
        if yr_str not in monthly_pnl:
            monthly_pnl[yr_str] = {m: 0.0 for m in month_names}
            monthly_pnl[yr_str]["Total"] = 0.0
        monthly_pnl[yr_str][m_str] = round(monthly_pnl[yr_str][m_str] + c["pnl"], 2)
        monthly_pnl[yr_str]["Total"] = round(monthly_pnl[yr_str]["Total"] + c["pnl"], 2)

    print(f"\n================================================================================")
    print(f"  PERFORMANCE SUMMARY (LAST 3 MONTHS: JUL 2026 – SEP 2026)")
    print(f"================================================================================")
    print(f"  Total Expiry Cycles: {total_cycles}")
    print(f"  Win / Loss Ratio:    {win_count} Wins / {loss_count} Losses ({win_rate:.1f}% Win Rate)")
    print(f"  Total Gross P&L:     ₹{total_gross:,.2f}")
    print(f"  Total Brokerage/Tax: ₹{total_friction:,.2f} (~₹{total_friction/total_cycles:,.0f}/cycle avg)")
    print(f"  Total Net P&L:       ₹{total_net:,.2f} ({total_return_pct:+.2f}% on ₹{capital_base:,.0f})")
    print(f"  Profit Factor:       {profit_factor:.2f}")
    print(f"  Average Win:         ₹{avg_win:,.2f}")
    print(f"  Average Loss:        ₹{avg_loss:,.2f}")
    print(f"  Max Drawdown:        ₹{max_drawdown:,.2f} ({max_dd_pct:.2f}%)")
    print(f"  Sharpe Ratio:        {sharpe_ratio:.2f}")
    print(f"--------------------------------------------------------------------------------")
    print(f"  Stage Analysis:")
    print(f"    - Remained Iron Condor:     {condor_only_cycles}/{total_cycles} cycles ({condor_only_cycles/total_cycles*100:.1f}%)")
    print(f"    - Transitioned to Ratio:    {ratio_transition_cycles}/{total_cycles} cycles ({ratio_transition_cycles/total_cycles*100:.1f}%)")
    print(f"    - Total Trend Shifts:       {total_shifts_count}")
    print(f"    - Total Reversal Flips:     {total_reversals_count}")
    print(f"================================================================================\n")

    summary_payload = {
        "total_cycles": total_cycles,
        "traded_cycles": total_cycles,
        "wins": win_count,
        "losses": loss_count,
        "win_count": win_count,
        "loss_count": loss_count,
        "win_rate": round(win_rate, 2),
        "total_pnl": round(total_net, 2),
        "total_net_pnl": round(total_net, 2),
        "total_gross_pnl": round(total_gross, 2),
        "total_friction": round(total_friction, 2),
        "total_return_pct": round(total_return_pct, 2),
        "profit_factor": round(profit_factor, 2),
        "avg_pnl": round(total_net / total_cycles, 2) if total_cycles > 0 else 0.0,
        "avg_win": round(avg_win, 2),
        "avg_loss": round(avg_loss, 2),
        "max_win": round(max(wins), 2) if wins else 0.0,
        "max_loss": round(min(losses), 2) if losses else 0.0,
        "max_drawdown": round(max_drawdown, 2),
        "max_drawdown_pct": round(max_dd_pct, 2),
        "max_drawdown_start": "",
        "max_drawdown_end": "",
        "max_drawdown_days": None,
        "max_trades_in_drawdown": 0,
        "max_win_streak": max_win_streak,
        "max_loss_streak": max_loss_streak,
        "sharpe_ratio": round(sharpe_ratio, 2),
        "commission_paid": round(total_friction, 2),
        "capital_base": capital_base,
        "condor_only_cycles": condor_only_cycles,
        "ratio_transition_cycles": ratio_transition_cycles,
        "total_shifts_count": total_shifts_count,
        "total_reversals_count": total_reversals_count,
    }

    params_payload = {
        "strategy_name": "Nifty Iron Condor to Ratio Spread",
        "strategy_type": "options_condor_ratio",
        "lots": lots,
        "lot_size": lot_size,
        "start_date": start_date,
        "end_date": end_date,
        "target_profit": target_profit_str,
        "stop_loss": stop_loss_str,
        "condor_short_delta": condor_short_delta,
        "condor_hedge_delta": condor_hedge_delta,
        "condor_exit_delta": condor_exit_delta,
        "ratio_long_delta": ratio_long_delta,
        "ratio_short_delta": ratio_short_delta,
        "ratio_hedge_delta": ratio_hedge_delta,
        "ratio_shift_delta": ratio_shift_delta,
        "ratio_reversal_delta": ratio_reversal_delta,
        "shift_long_delta": shift_long_delta,
        "shift_short_delta": shift_short_delta,
        "shift_hedge_delta": shift_hedge_delta,
        "max_shifts": max_shifts,
        "max_reversals": max_reversals,
        "trail_start_rs": trail_start_rs,
        "trail_gap_rs": trail_gap_rs,
        "slippage_pct": slippage_pct
    }

    formatted_equity_curve = [
        {"date": str(e["date"]), "cumulative_pnl": round(float(e["cumulative_pnl"]), 2)}
        for e in equity_curve
    ]

    result_payload = {
        "summary": summary_payload,
        "parameters": params_payload,
        "params": params_payload,
        "cycles": all_cycles,
        "equity_curve": formatted_equity_curve,
        "monthly_pnl": monthly_pnl
    }

    # ── STRUCTURED ARCHIVAL ─────────────────────────────────────────────────────
    if archive:
        run_id = f"condor_to_ratio_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        archive_dir = os.path.join(BACKTESTS_DIR, run_id)
        os.makedirs(archive_dir, exist_ok=True)

        meta_payload = {
            "id": run_id,
            "name": f"Nifty Condor to Ratio Spread ({start_date} to {end_date})",
            "timestamp": datetime.now().isoformat(),
            "strategy_type": "options_condor_ratio",
            "start_date": start_date,
            "end_date": end_date,
            "trades": total_cycles,
            "win_rate": round(win_rate, 2),
            "total_pnl": round(total_net, 2),
            "max_drawdown": round(max_drawdown, 2),
            "has_tearsheet": False,
            "has_trades_csv": True,
            "has_scans_summary": False,
            "has_report": False,
            "tags": ["condor", "ratio_spread", "dynamic_hedging", "monthly", "weekly"]
        }
        with open(os.path.join(archive_dir, "metadata.json"), "w") as f:
            json.dump(meta_payload, f, indent=2)

        with open(os.path.join(archive_dir, "result.json"), "w") as f:
            json.dump(result_payload, f, indent=2)

        # Also write debug/backtest_result.json and debug/backtest_status.json
        try:
            with open(os.path.join(DEBUG_DIR, "backtest_result.json"), "w") as f:
                json.dump(result_payload, f, indent=2)
            with open(os.path.join(DEBUG_DIR, "backtest_status.json"), "w") as f:
                json.dump({
                    "running": False,
                    "done": True,
                    "progress_pct": 100,
                    "msg": "Backtest completed",
                    "total_cycles": total_cycles,
                    "completed_cycles": total_cycles,
                    "current_expiry": expiry_rows[-1] if expiry_rows else ""
                }, f, indent=2)
        except Exception:
            pass

        # Convert trades to CSV
        trades_df = pd.DataFrame([{
            "cycle_id": t.cycle_id,
            "expiry": t.expiry,
            "stage": t.stage,
            "action": t.action,
            "timestamp": t.timestamp,
            "reason": t.reason,
            "legs_summary": t.legs_summary,
            "cycle_realized_pnl": t.cycle_realized_pnl,
            "cycle_gross_pnl": t.cycle_gross_pnl,
            "cycle_net_pnl": t.cycle_net_pnl,
            "friction": t.friction,
            "spot": t.spot
        } for t in all_trade_log])
        trades_df.to_csv(os.path.join(archive_dir, "trades.csv"), index=False)

        print(f"  [+] Archived backtest simulation to: {archive_dir}")

    return {
        "total_cycles": total_cycles,
        "win_rate": win_rate,
        "total_net_pnl": total_net,
        "total_return_pct": total_return_pct,
        "profit_factor": profit_factor,
        "max_drawdown": max_drawdown,
        "sharpe_ratio": sharpe_ratio,
        "cycles": all_cycles
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backtest Nifty Condor to Ratio Spread Strategy.")
    parser.add_argument("--start-date", type=str, default="2026-07-01", help="Start date (YYYY-MM-DD).")
    parser.add_argument("--end-date", type=str, default="2026-09-30", help="End date (YYYY-MM-DD).")
    parser.add_argument("--lots", type=int, default=1, help="Number of lots.")
    parser.add_argument("--lot-size", type=int, default=LOT_SIZE_DEFAULT, help="Lot size.")
    parser.add_argument("--target-profit", type=str, default="15%", help="Target profit in INR or %.")
    parser.add_argument("--stop-loss", type=str, default="15%", help="Stop loss in INR or %.")
    parser.add_argument("--condor-short-delta", type=float, default=0.30, help="Condor short delta.")
    parser.add_argument("--condor-hedge-delta", type=float, default=0.10, help="Condor hedge delta.")
    parser.add_argument("--condor-exit-delta", type=float, default=0.10, help="Condor short exit delta.")
    parser.add_argument("--ratio-long-delta", type=float, default=0.50, help="Ratio long delta.")
    parser.add_argument("--ratio-short-delta", type=float, default=0.40, help="Ratio short delta.")
    parser.add_argument("--ratio-hedge-delta", type=float, default=0.10, help="Ratio hedge delta.")
    parser.add_argument("--ratio-shift-delta", type=float, default=0.10, help="Ratio shift delta.")
    parser.add_argument("--ratio-reversal-delta", type=float, default=0.60, help="Ratio reversal delta.")
    parser.add_argument("--max-shifts", type=int, default=5, help="Max continuation shifts.")
    parser.add_argument("--max-reversals", type=int, default=3, help="Max reversal flips.")
    parser.add_argument("--trail-start-rs", type=float, default=5000.0, help="Trailing SL activation profit in INR.")
    parser.add_argument("--trail-gap-rs", type=float, default=2500.0, help="Trailing SL giveback gap in INR.")
    parser.add_argument("--slippage-pct", type=float, default=0.001, help="Slippage percentage.")
    parser.add_argument("--no-archive", action="store_true", help="Do not write archive files.")
    parser.add_argument("--status-file", type=str, default=None, help="Path to status JSON file for dashboard polling.")

    args = parser.parse_args()

    run_condor_to_ratio_backtest(
        start_date=args.start_date,
        end_date=args.end_date,
        lots=args.lots,
        lot_size=args.lot_size,
        target_profit_str=args.target_profit,
        stop_loss_str=args.stop_loss,
        condor_short_delta=args.condor_short_delta,
        condor_hedge_delta=args.condor_hedge_delta,
        condor_exit_delta=args.condor_exit_delta,
        ratio_long_delta=args.ratio_long_delta,
        ratio_short_delta=args.ratio_short_delta,
        ratio_hedge_delta=args.ratio_hedge_delta,
        ratio_shift_delta=args.ratio_shift_delta,
        ratio_reversal_delta=args.ratio_reversal_delta,
        max_shifts=args.max_shifts,
        max_reversals=args.max_reversals,
        trail_start_rs=args.trail_start_rs,
        trail_gap_rs=args.trail_gap_rs,
        slippage_pct=args.slippage_pct,
        archive=not args.no_archive,
        status_file=args.status_file
    )
