#!/usr/bin/env python3
"""
Backtest Script: Intraday Nifty Straddle with Balanced Entry & Leg SL OTM Shift
--------------------------------------------------------------------------------
Updated with Realistic Dhan/SEBI F&O Taxation & Dynamic Tuesday Expiry Engine.

Regulatory & Market Invariants:
1. SEBI / NSE Expiry Rule (2025+): NIFTY weekly contracts expire on TUESDAYS (formerly Thursdays).
   Expiry is resolved dynamically per trade: DTE = (expiry_date - trade_date).
2. Precise Dhan Ledger Taxation Model (audited against 4,155 real Dhan F&O trades):
   - Brokerage: Rs 20.00 + 18% GST = Rs 23.60 per order.
   - STT: 0.10% (Finance Act 2024) on Option SELL Premium Turnover. Zero on BUY.
   - Exchange Transaction Fee (NSE): 0.05% on both BUY & SELL Premium Turnover + 18% GST.
   - Stamp Duty: 0.003% on BUY Premium Turnover.
   - SEBI Charges: Rs 10 per crore (0.0001% + 18% GST).
3. Execution Slippage:
   - 0.3 pt entry slippage on limit/market orders.
   - 0.8 pt adverse execution slippage on Stop-Loss Market (SL-M) orders on fast bars.
"""

import sys
import os
import sqlite3
import math
from datetime import datetime
import pandas as pd
import numpy as np

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB_PATH = os.path.join(PROJECT_ROOT, "Options Data", "nifty_options.db")

LOT_SIZE = 65

def calc_dhan_cost(txn_type: str, qty: int, price: float) -> float:
    """Calculate exact Dhan broker and statutory taxes per executed leg."""
    turnover = qty * price
    brokerage = 20.0
    gst_brokerage = brokerage * 0.18  # Rs 3.60
    
    # Exchange turnover charge (NSE: ~0.05% on premium turnover + 18% GST)
    exch_charge = turnover * 0.0005
    gst_exch = exch_charge * 0.18
    
    # STT (0.10% on SELL premium turnover only)
    stt = (turnover * 0.0010) if txn_type == "SELL" else 0.0
    
    # Stamp duty (0.003% on BUY premium turnover only)
    stamp = (turnover * 0.00003) if txn_type == "BUY" else 0.0
    
    # SEBI turnover charge (Rs 10/crore + 18% GST)
    sebi = turnover * 0.000001 * 1.18
    
    return brokerage + gst_brokerage + exch_charge + gst_exch + stt + stamp + sebi

def run_backtest(start_date="2025-09-22", end_date="2026-09-22",
                 entry_start_time="09:30", entry_cutoff_time="14:30",
                 eod_time="15:15", max_diff_pct=10.0,
                 leg_sl_pct=20.0, combined_target_pct=20.0, combined_sl_pct=20.0,
                 max_shifts_per_side=1,
                 entry_slippage_pts=0.3, sl_slippage_pts=0.8):
    
    if not os.path.exists(DB_PATH):
        print(f"Error: DB not found at {DB_PATH}")
        return None, None

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    cur.execute("""
        SELECT DISTINCT substr(datetime, 1, 10) as dt
        FROM option_prices
        WHERE datetime >= ? AND datetime <= ?
        ORDER BY dt
    """, (f"{start_date} 00:00:00", f"{end_date} 23:59:59"))
    
    dates = [r[0] for r in cur.fetchall()]
    print(f"Loaded {len(dates)} trading days between {start_date} and {end_date}.")

    trades = []
    skipped_days = []

    for day in dates:
        start_ts = f"{day} 09:15:00"
        end_ts = f"{day} 15:30:00"

        # Determine nearest expiry for this day
        cur.execute("""
            SELECT MIN(expiry)
            FROM option_prices
            WHERE datetime >= ? AND datetime <= ? AND expiry >= ?
        """, (start_ts, end_ts, day))
        exp_row = cur.fetchone()
        if not exp_row or not exp_row[0]:
            skipped_days.append((day, "No expiry found"))
            continue
        expiry = exp_row[0]

        # Calculate true DTE
        day_date = datetime.strptime(day, "%Y-%m-%d").date()
        exp_date = datetime.strptime(expiry, "%Y-%m-%d").date()
        dte = (exp_date - day_date).days
        is_expiry_day = (dte == 0)

        # Load day ticks for this expiry
        query = """
            SELECT datetime, strike, option_type, open, high, low, close, spot
            FROM option_prices
            WHERE datetime >= ? AND datetime <= ? AND expiry = ?
            ORDER BY datetime
        """
        df_day = pd.read_sql_query(query, conn, params=(start_ts, end_ts, expiry))
        if df_day.empty:
            skipped_days.append((day, "No data for expiry"))
            continue

        prices = {}
        spots = {}
        for r in df_day.itertuples():
            dt_s = str(r.datetime)
            prices[(dt_s, float(r.strike), str(r.option_type))] = (
                float(r.open), float(r.high), float(r.low), float(r.close)
            )
            if not pd.isna(r.spot) and float(r.spot) > 0:
                spots[dt_s] = float(r.spot)

        unique_times = sorted(list(spots.keys()))
        entry_window_times = [t for t in unique_times if entry_start_time <= t[11:16] <= entry_cutoff_time]

        # Phase 1: Search for Entry (diff < max_diff_pct)
        entered = False
        entry_time = None
        entry_spot = None
        initial_atm = None
        ce_entry_price = None
        pe_entry_price = None
        entry_diff = None

        for t in entry_window_times:
            curr_spot = spots[t]
            atm = round(curr_spot / 50.0) * 50.0
            
            ce_bar = prices.get((t, atm, "CE"))
            pe_bar = prices.get((t, atm, "PE"))
            if not ce_bar or not pe_bar:
                continue

            ce_price = ce_bar[3]  # close
            pe_price = pe_bar[3]  # close

            if ce_price <= 0 or pe_price <= 0:
                continue

            max_p = max(ce_price, pe_price)
            diff = abs(ce_price - pe_price) / max_p * 100.0

            if diff < max_diff_pct:
                entered = True
                entry_time = t
                entry_spot = curr_spot
                initial_atm = atm
                ce_entry_price = ce_price - entry_slippage_pts  # short entry
                pe_entry_price = pe_price - entry_slippage_pts  # short entry
                entry_diff = diff
                break

        if not entered:
            skipped_days.append((day, "Price diff never < 10%"))
            continue

        # Trade setup
        combined_premium = ce_entry_price + pe_entry_price
        target_pts = combined_premium * (combined_target_pct / 100.0)
        max_loss_pts = -combined_premium * (combined_sl_pct / 100.0)

        # Track orders for exact Dhan ledger cost computation
        # list of dicts: {'type': 'BUY'|'SELL', 'qty': LOT_SIZE, 'price': p}
        executed_orders = [
            {'type': 'SELL', 'qty': LOT_SIZE, 'price': ce_entry_price},
            {'type': 'SELL', 'qty': LOT_SIZE, 'price': pe_entry_price}
        ]

        ce_leg = {
            'strike': initial_atm,
            'type': 'CE',
            'entry': ce_entry_price,
            'sl': ce_entry_price * (1.0 + leg_sl_pct / 100.0),
            'shifts': 0,
            'active': True
        }
        pe_leg = {
            'strike': initial_atm,
            'type': 'PE',
            'entry': pe_entry_price,
            'sl': pe_entry_price * (1.0 + leg_sl_pct / 100.0),
            'shifts': 0,
            'active': True
        }

        realized_pnl_pts = 0.0
        leg_sl_hits = 0
        ce_shifts = 0
        pe_shifts = 0

        trade_sim_times = [t for t in unique_times if t > entry_time and t[11:16] <= eod_time]
        exit_time = None
        exit_reason = None
        final_pnl_pts = None

        for t in trade_sim_times:
            # 1. Check Leg SL for CE
            if ce_leg['active']:
                ce_bar = prices.get((t, ce_leg['strike'], 'CE'))
                if ce_bar:
                    high_p = ce_bar[1]
                    if high_p >= ce_leg['sl']:
                        leg_sl_hits += 1
                        # Realistic SL fill: adverse slippage of 0.8 pt
                        exit_p = max(ce_leg['sl'], ce_bar[0]) + sl_slippage_pts
                        realized_pnl_pts += (ce_leg['entry'] - exit_p)
                        ce_leg['active'] = False
                        executed_orders.append({'type': 'BUY', 'qty': LOT_SIZE, 'price': exit_p})

                        # Shift CE further OTM by 1 strike (+50)
                        if ce_leg['shifts'] < max_shifts_per_side:
                            new_strike = ce_leg['strike'] + 50.0
                            new_bar = prices.get((t, new_strike, 'CE'))
                            if new_bar and new_bar[3] > 0:
                                new_entry = new_bar[3] - entry_slippage_pts
                                ce_shifts += 1
                                ce_leg = {
                                    'strike': new_strike,
                                    'type': 'CE',
                                    'entry': new_entry,
                                    'sl': new_entry * (1.0 + leg_sl_pct / 100.0),
                                    'shifts': ce_leg['shifts'] + 1,
                                    'active': True
                                }
                                executed_orders.append({'type': 'SELL', 'qty': LOT_SIZE, 'price': new_entry})

            # 2. Check Leg SL for PE
            if pe_leg['active']:
                pe_bar = prices.get((t, pe_leg['strike'], 'PE'))
                if pe_bar:
                    high_p = pe_bar[1]
                    if high_p >= pe_leg['sl']:
                        leg_sl_hits += 1
                        exit_p = max(pe_leg['sl'], pe_bar[0]) + sl_slippage_pts
                        realized_pnl_pts += (pe_leg['entry'] - exit_p)
                        pe_leg['active'] = False
                        executed_orders.append({'type': 'BUY', 'qty': LOT_SIZE, 'price': exit_p})

                        # Shift PE further OTM by 1 strike (-50)
                        if pe_leg['shifts'] < max_shifts_per_side:
                            new_strike = pe_leg['strike'] - 50.0
                            new_bar = prices.get((t, new_strike, 'PE'))
                            if new_bar and new_bar[3] > 0:
                                new_entry = new_bar[3] - entry_slippage_pts
                                pe_shifts += 1
                                pe_leg = {
                                    'strike': new_strike,
                                    'type': 'PE',
                                    'entry': new_entry,
                                    'sl': new_entry * (1.0 + leg_sl_pct / 100.0),
                                    'shifts': pe_leg['shifts'] + 1,
                                    'active': True
                                }
                                executed_orders.append({'type': 'SELL', 'qty': LOT_SIZE, 'price': new_entry})

            # 3. Compute MTM PnL (Realized + Unrealized)
            unrealized_pnl_pts = 0.0
            if ce_leg['active']:
                ce_bar = prices.get((t, ce_leg['strike'], 'CE'))
                curr_ce = ce_bar[3] if ce_bar else ce_leg['entry']
                unrealized_pnl_pts += (ce_leg['entry'] - curr_ce)

            if pe_leg['active']:
                pe_bar = prices.get((t, pe_leg['strike'], 'PE'))
                curr_pe = pe_bar[3] if pe_bar else pe_leg['entry']
                unrealized_pnl_pts += (pe_leg['entry'] - curr_pe)

            curr_total_pnl_pts = realized_pnl_pts + unrealized_pnl_pts

            # 4. Check Combined Target Hit
            if curr_total_pnl_pts >= target_pts:
                exit_time = t
                exit_reason = "Target Hit (+20%)"
                final_pnl_pts = curr_total_pnl_pts
                if ce_leg['active']:
                    ce_b = prices.get((t, ce_leg['strike'], 'CE'))
                    p = (ce_b[3] if ce_b else ce_leg['entry']) + entry_slippage_pts
                    executed_orders.append({'type': 'BUY', 'qty': LOT_SIZE, 'price': p})
                if pe_leg['active']:
                    pe_b = prices.get((t, pe_leg['strike'], 'PE'))
                    p = (pe_b[3] if pe_b else pe_leg['entry']) + entry_slippage_pts
                    executed_orders.append({'type': 'BUY', 'qty': LOT_SIZE, 'price': p})
                break

            # 5. Check Combined SL Hit
            if curr_total_pnl_pts <= max_loss_pts:
                exit_time = t
                exit_reason = "Combined SL Hit (-20%)"
                final_pnl_pts = curr_total_pnl_pts
                if ce_leg['active']:
                    ce_b = prices.get((t, ce_leg['strike'], 'CE'))
                    p = (ce_b[3] if ce_b else ce_leg['entry']) + sl_slippage_pts
                    executed_orders.append({'type': 'BUY', 'qty': LOT_SIZE, 'price': p})
                if pe_leg['active']:
                    pe_b = prices.get((t, pe_leg['strike'], 'PE'))
                    p = (pe_b[3] if pe_b else pe_leg['entry']) + sl_slippage_pts
                    executed_orders.append({'type': 'BUY', 'qty': LOT_SIZE, 'price': p})
                break

            # 6. Check EOD Exit at 15:15
            if t.endswith(f" {eod_time}:00"):
                exit_time = t
                exit_reason = "EOD Exit (15:15)"
                final_pnl_pts = curr_total_pnl_pts
                if ce_leg['active']:
                    ce_b = prices.get((t, ce_leg['strike'], 'CE'))
                    p = (ce_b[3] if ce_b else ce_leg['entry']) + entry_slippage_pts
                    executed_orders.append({'type': 'BUY', 'qty': LOT_SIZE, 'price': p})
                if pe_leg['active']:
                    pe_b = prices.get((t, pe_leg['strike'], 'PE'))
                    p = (pe_b[3] if pe_b else pe_leg['entry']) + entry_slippage_pts
                    executed_orders.append({'type': 'BUY', 'qty': LOT_SIZE, 'price': p})
                break

        if final_pnl_pts is None:
            t_last = trade_sim_times[-1] if trade_sim_times else entry_time
            exit_time = t_last
            exit_reason = "EOD / End of Data"
            final_pnl_pts = curr_total_pnl_pts
            if ce_leg['active']:
                ce_b = prices.get((t_last, ce_leg['strike'], 'CE'))
                p = (ce_b[3] if ce_b else ce_leg['entry']) + entry_slippage_pts
                executed_orders.append({'type': 'BUY', 'qty': LOT_SIZE, 'price': p})
            if pe_leg['active']:
                pe_b = prices.get((t_last, pe_leg['strike'], 'PE'))
                p = (pe_b[3] if pe_b else pe_leg['entry']) + entry_slippage_pts
                executed_orders.append({'type': 'BUY', 'qty': LOT_SIZE, 'price': p})

        # Calculate exact ledger costs across all executed orders
        trade_costs = sum(calc_dhan_cost(o['type'], o['qty'], o['price']) for o in executed_orders)
        gross_pnl_inr = final_pnl_pts * LOT_SIZE
        net_pnl_inr = gross_pnl_inr - trade_costs

        trades.append({
            'date': day,
            'day_name': day_date.strftime('%A'),
            'expiry': expiry,
            'expiry_day_name': exp_date.strftime('%A'),
            'dte': dte,
            'is_expiry_day': is_expiry_day,
            'entry_time': entry_time[11:16],
            'spot': entry_spot,
            'atm': initial_atm,
            'ce_entry': round(ce_entry_price, 2),
            'pe_entry': round(pe_entry_price, 2),
            'diff_pct': round(entry_diff, 2),
            'comb_premium': round(combined_premium, 2),
            'exit_time': exit_time[11:16],
            'exit_reason': exit_reason,
            'pnl_pts': round(final_pnl_pts, 2),
            'gross_inr': round(gross_pnl_inr, 2),
            'costs_inr': round(trade_costs, 2),
            'net_inr': round(net_pnl_inr, 2),
            'leg_sl_hits': leg_sl_hits,
            'ce_shifts': ce_shifts,
            'pe_shifts': pe_shifts,
            'orders': len(executed_orders)
        })

    conn.close()
    return pd.DataFrame(trades), pd.DataFrame(skipped_days, columns=['date', 'reason'])

if __name__ == "__main__":
    df_trades, df_skipped = run_backtest()
    print("\n--- Backtest Run Complete ---")
    print(f"Total trading days evaluated: {len(df_trades) + len(df_skipped)}")
    print(f"Days traded: {len(df_trades)}")
    print(f"Days skipped: {len(df_skipped)}")

    if not df_trades.empty:
        df_trades['cum_gross_inr'] = df_trades['gross_inr'].cumsum()
        df_trades['cum_net_inr'] = df_trades['net_inr'].cumsum()
        df_trades['peak_net'] = df_trades['cum_net_inr'].cummax()
        df_trades['drawdown_net'] = df_trades['cum_net_inr'] - df_trades['peak_net']

        wins = df_trades[df_trades['net_inr'] > 0]
        losses = df_trades[df_trades['net_inr'] <= 0]

        total_net = df_trades['net_inr'].sum()
        total_gross = df_trades['gross_inr'].sum()
        total_costs = df_trades['costs_inr'].sum()
        total_pts = df_trades['pnl_pts'].sum()
        max_dd = df_trades['drawdown_net'].min()
        win_rate = len(wins) / len(df_trades) * 100.0

        profit_factor = abs(wins['net_inr'].sum() / losses['net_inr'].sum()) if not losses.empty and losses['net_inr'].sum() != 0 else float('inf')
        sharpe = (df_trades['net_inr'].mean() / df_trades['net_inr'].std()) * np.sqrt(252) if df_trades['net_inr'].std() > 0 else 0.0

        print(f"\n================ RECALIBRATED PERFORMANCE SUMMARY (DHAN LEDGER MODEL) ================")
        print(f"Period: 2025-09-22 to 2026-09-22 (~1 Year)")
        print(f"Lot Size: {LOT_SIZE} (1 lot NIFTY)")
        print(f"Total Trades: {len(df_trades)}")
        print(f"Win Rate: {win_rate:.2f}% ({len(wins)} Wins, {len(losses)} Losses)")
        print(f"Profit Factor: {profit_factor:.2f}")
        print(f"Total Points Captured: {total_pts:+.2f} pts")
        print(f"Total Gross P&L: Rs {total_gross:+,.2f}")
        print(f"Actual Dhan Ledger Costs (STT+Brokerage+GST): Rs {total_costs:,.2f} (Avg Rs {df_trades['costs_inr'].mean():.2f}/trade)")
        print(f"Actual Net P&L: Rs {total_net:+,.2f}")
        print(f"Average Trade Net: Rs {df_trades['net_inr'].mean():+,.2f} ({df_trades['pnl_pts'].mean():+.2f} pts)")
        print(f"Max Drawdown: Rs {max_dd:,.2f}")
        print(f"Annualized Sharpe Ratio: {sharpe:.2f}")
        
        print(f"\n--- TRUE DTE (Days to Expiry) BREAKDOWN (Tuesdays = 0-DTE Expiry) ---")
        dte_summary = df_trades.groupby('dte').agg(
            trades=('net_inr', 'count'),
            win_pct=('net_inr', lambda x: round((x > 0).mean() * 100, 1)),
            pts=('pnl_pts', 'sum'),
            gross=('gross_inr', 'sum'),
            costs=('costs_inr', 'sum'),
            net=('net_inr', 'sum'),
            avg_net=('net_inr', 'mean'),
            leg_sls=('leg_sl_hits', 'sum')
        )
        print(dte_summary.to_string())

        print(f"\n--- DAY OF WEEK BREAKDOWN ---")
        dow_summary = df_trades.groupby('day_name').agg(
            trades=('net_inr', 'count'),
            win_pct=('net_inr', lambda x: round((x > 0).mean() * 100, 1)),
            pts=('pnl_pts', 'sum'),
            gross=('gross_inr', 'sum'),
            costs=('costs_inr', 'sum'),
            net=('net_inr', 'sum'),
            avg_net=('net_inr', 'mean')
        ).reindex(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])
        print(dow_summary.to_string())

        # Save corrected results CSV
        df_trades.to_csv("debug/backtest_straddle_diff_sl_shift_results.csv", index=False)
        print("\nRecalibrated trade log saved to debug/backtest_straddle_diff_sl_shift_results.csv")
