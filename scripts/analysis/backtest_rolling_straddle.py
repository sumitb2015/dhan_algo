"""
Backtest Engine for Intraday Rolling Short Straddle Strategy on NIFTY Index Options.

Queries 1-minute historical option prices from `Options Data/nifty_options.db`
and simulates the buffer-based rolling ATM straddle strategy across custom test ranges.
"""

import sys
import os
import json
import math
import sqlite3
import argparse
from datetime import datetime, timedelta
import pandas as pd
import numpy as np

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB_PATH = os.path.join(PROJECT_ROOT, "Options Data", "nifty_options.db")

def floor_to_50(val):
    return math.floor(float(val) / 50.0) * 50.0

def ceil_to_50(val):
    return math.ceil(float(val) / 50.0) * 50.0

def run_backtest(start_date="2023-01-01", end_date="2026-06-30", roll_buffer=35.0,
                 max_rolls=5, profit_target=4000.0, stop_loss=4000.0, lot_size=65,
                 entry_time="09:20", eod_time="15:15", slippage_pct=0.001):
    
    if not os.path.exists(DB_PATH):
        print(f"Error: Options database not found at {DB_PATH}")
        return None

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Generate trading dates instantly in memory
    print(f"Generating trading dates from {start_date} to {end_date}...")
    dt_range = pd.date_range(start=start_date, end=end_date, freq='B')
    dates = [d.strftime('%Y-%m-%d') for d in dt_range]
    print(f"Generated {len(dates)} business days to process.")

    daily_results = []

    for d_idx, day_str in enumerate(dates):
        # Load day's option ticks using indexed range query
        start_ts = f"{day_str} 09:15:00"
        end_ts = f"{day_str} 15:30:00"
        
        # Get open spot price instantly to filter relevant strikes (+-350 pts)
        cursor.execute("SELECT spot FROM option_prices WHERE datetime >= ? AND spot > 0 LIMIT 1", (start_ts,))
        row_spot = cursor.fetchone()
        if not row_spot or not row_spot[0]:
            continue

        spot_open = float(row_spot[0])
        min_strike = floor_to_50(spot_open - 350)
        max_strike = ceil_to_50(spot_open + 350)

        query = """
        SELECT datetime, strike, option_type, close, spot
        FROM option_prices
        WHERE datetime >= ? AND datetime <= ? AND strike >= ? AND strike <= ?
        """
        df_day = pd.read_sql_query(query, conn, params=(start_ts, end_ts, min_strike, max_strike))
        if df_day.empty:
            continue

        # Pre-index day ticks into dictionary lookups for ultra-fast execution
        prices = {(str(r.datetime), float(r.strike), str(r.option_type)): float(r.close) for r in df_day.itertuples()}
        spots = {str(r.datetime): float(r.spot) for r in df_day.itertuples()}

        times = sorted(spots.keys())
        entry_dt_candidates = [t for t in times if t.endswith(f" {entry_time}:00")]
        if not entry_dt_candidates:
            continue

        start_dt = entry_dt_candidates[0]
        spot_at_entry = spots[start_dt]
        if pd.isna(spot_at_entry) or spot_at_entry <= 0:
            continue

        initial_atm = round(spot_at_entry / 50.0) * 50.0

        ce_entry_price = prices.get((start_dt, initial_atm, 'CE'))
        pe_entry_price = prices.get((start_dt, initial_atm, 'PE'))

        if ce_entry_price is None or pe_entry_price is None:
            continue

        ce_entry_price *= (1.0 - slippage_pct)
        pe_entry_price *= (1.0 - slippage_pct)

        current_atm = initial_atm
        upper_bound = current_atm + roll_buffer
        lower_bound = current_atm - roll_buffer

        active_ce_entry = ce_entry_price
        active_pe_entry = pe_entry_price

        realized_pnl = 0.0
        rolls_today = 0

        day_times = [t for t in times if t >= start_dt and t[11:16] <= eod_time]

        final_pnl = 0.0
        exit_reason = "EOD Exit"

        for t in day_times:
            current_spot = spots[t]
            ce_curr_price = prices.get((t, current_atm, 'CE'))
            pe_curr_price = prices.get((t, current_atm, 'PE'))

            if ce_curr_price is None or pe_curr_price is None:
                continue

            unrealized_pnl = ((active_ce_entry - ce_curr_price) + (active_pe_entry - pe_curr_price)) * lot_size
            total_pnl = realized_pnl + unrealized_pnl

            # Target Check
            if profit_target > 0 and total_pnl >= profit_target:
                final_pnl = profit_target
                exit_reason = "Profit Target"
                break

            # Stop Loss Check
            if stop_loss > 0 and total_pnl <= -stop_loss:
                final_pnl = -stop_loss
                exit_reason = "Stop Loss"
                break

            # EOD Check
            if t.endswith(f" {eod_time}:00"):
                final_pnl = total_pnl
                exit_reason = "EOD"
                break

            # Roll Check
            if rolls_today < max_rolls:
                if current_spot >= upper_bound or current_spot <= lower_bound:
                    ce_close_price = ce_curr_price * (1.0 + slippage_pct)
                    pe_close_price = pe_curr_price * (1.0 + slippage_pct)

                    leg_pnl = ((active_ce_entry - ce_close_price) + (active_pe_entry - pe_close_price)) * lot_size
                    realized_pnl += leg_pnl

                    new_atm = round(current_spot / 50.0) * 50.0
                    new_ce_price = prices.get((t, new_atm, 'CE'))
                    new_pe_price = prices.get((t, new_atm, 'PE'))

                    if new_ce_price is not None and new_pe_price is not None:
                        active_ce_entry = new_ce_price * (1.0 - slippage_pct)
                        active_pe_entry = new_pe_price * (1.0 - slippage_pct)

                        current_atm = new_atm
                        upper_bound = current_atm + roll_buffer
                        lower_bound = current_atm - roll_buffer
                        rolls_today += 1
                    else:
                        # Couldn't get quote for new ATM, abort rolls
                        pass
        else:
            final_pnl = total_pnl

        daily_results.append({
            "date": day_str,
            "initial_atm": initial_atm,
            "final_atm": current_atm,
            "rolls": rolls_today,
            "pnl": final_pnl,
            "exit_reason": exit_reason
        })

    conn.close()

    if not daily_results:
        print("No backtest results produced.")
        return None

    df_res = pd.DataFrame(daily_results)
    total_trades = len(df_res)
    win_trades = (df_res['pnl'] > 0).sum()
    loss_trades = (df_res['pnl'] < 0).sum()
    win_rate = (win_trades / total_trades) * 100.0 if total_trades > 0 else 0.0

    total_pnl = df_res['pnl'].sum()
    avg_pnl = df_res['pnl'].mean()
    max_drawdown = (df_res['pnl'].cumsum().cummax() - df_res['pnl'].cumsum()).max()

    gross_profit = df_res[df_res['pnl'] > 0]['pnl'].sum()
    gross_loss = abs(df_res[df_res['pnl'] < 0]['pnl'].sum())
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else np.nan

    avg_rolls = df_res['rolls'].mean()

    summary = {
        "start_date": start_date,
        "end_date": end_date,
        "roll_buffer": roll_buffer,
        "max_rolls": max_rolls,
        "total_sessions": total_trades,
        "win_rate_pct": round(win_rate, 2),
        "total_pnl_inr": round(total_pnl, 2),
        "avg_pnl_per_day": round(avg_pnl, 2),
        "max_drawdown_inr": round(max_drawdown, 2),
        "profit_factor": round(profit_factor, 2) if not np.isnan(profit_factor) else None,
        "avg_rolls_per_day": round(avg_rolls, 2),
    }

    return summary, df_res

def main():
    parser = argparse.ArgumentParser(description="Backtest NIFTY Rolling Short Straddle Strategy")
    parser.add_argument("--start-date", type=str, default="2023-01-01")
    parser.add_argument("--end-date", type=str, default="2026-06-30")
    parser.add_argument("--buffer", type=float, default=35.0, help="Roll buffer in points")
    parser.add_argument("--max-rolls", type=int, default=5)
    parser.add_argument("--profit-target", type=float, default=4000.0)
    parser.add_argument("--stop-loss", type=float, default=4000.0)
    parser.add_argument("--compare-buffers", action="store_true", help="Run comparative benchmark across buffers [25, 30, 35, 40, 45]")

    args = parser.parse_args()

    if args.compare_buffers:
        print("\n=======================================================================")
        print("    COMPREHENSIVE BACKTEST BENCHMARK: NIFTY ROLLING SHORT STRADDLE")
        print("=======================================================================")
        buffers = [25.0, 30.0, 35.0, 40.0, 45.0, 999.0] # 999 = Fixed Straddle (No Rolling)
        benchmarks = []

        for buf in buffers:
            buf_name = f"Fixed (No Roll)" if buf == 999.0 else f"Buffer ±{buf:.0f} pts"
            print(f"\nRunning simulation for {buf_name}...")
            summary, _ = run_backtest(
                start_date=args.start_date,
                end_date=args.end_date,
                roll_buffer=buf,
                max_rolls=0 if buf == 999.0 else args.max_rolls,
                profit_target=args.profit_target,
                stop_loss=args.stop_loss
            )
            if summary:
                summary["buffer_name"] = buf_name
                benchmarks.append(summary)

        print("\n" + "="*85)
        print(f"{'Strategy Variant':<20} | {'Win Rate':<10} | {'Total P&L (₹)':<14} | {'Max DD (₹)':<12} | {'Prof Factor':<11} | {'Avg Rolls'}")
        print("="*85)
        for b in benchmarks:
            pf_str = f"{b['profit_factor']:.2f}" if b['profit_factor'] else "N/A"
            print(f"{b['buffer_name']:<20} | {b['win_rate_pct']:>8.1f}% | ₹{b['total_pnl_inr']:>12,.0f} | ₹{b['max_drawdown_inr']:>10,.0f} | {pf_str:>11} | {b['avg_rolls_per_day']:>8.1f}")
        print("="*85)

    else:
        summary, df_res = run_backtest(
            start_date=args.start_date,
            end_date=args.end_date,
            roll_buffer=args.buffer,
            max_rolls=args.max_rolls,
            profit_target=args.profit_target,
            stop_loss=args.stop_loss
        )
        if summary:
            print("\n=== BACKTEST SUMMARY ===")
            print(json.dumps(summary, indent=2))

if __name__ == "__main__":
    main()
