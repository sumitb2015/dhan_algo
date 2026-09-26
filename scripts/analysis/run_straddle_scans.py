#!/usr/bin/env python3
"""
Parameter Scans & Sensitivity Grid for Nifty Intraday Straddle
Runs multi-dimensional sensitivity scans:
1. Entry Difference Gate Scan (5%, 10%, 15%, 20%, No Gate)
2. Leg Stop Loss Scan (15%, 20%, 25%, 30%, 40%)
3. Adjustment Action Scan (Shift 1 OTM vs Shift 2 OTM vs No Shift vs Close All on 1 Leg SL)
4. Combined Target Scan (10%, 15%, 20%, 25%, 30%, EOD only)
5. Entry Timing Scan (09:20, 09:30, 09:45, 10:00)
"""

import sys
import os
import sqlite3
import pandas as pd
import numpy as np

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB_PATH = os.path.join(PROJECT_ROOT, "Options Data", "nifty_options.db")
LOT_SIZE = 65
BROKERAGE_PER_ORDER = 20.0
STT_TRANSACTION_PCT = 0.0006

def load_data_cache(start_date="2025-09-22", end_date="2026-09-22"):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("""
        SELECT DISTINCT substr(datetime, 1, 10) as dt
        FROM option_prices
        WHERE datetime >= ? AND datetime <= ?
        ORDER BY dt
    """, (f"{start_date} 00:00:00", f"{end_date} 23:59:59"))
    dates = [r[0] for r in cur.fetchall()]

    day_cache = {}
    for day in dates:
        start_ts = f"{day} 09:15:00"
        end_ts = f"{day} 15:30:00"
        cur.execute("""
            SELECT MIN(expiry)
            FROM option_prices
            WHERE datetime >= ? AND datetime <= ? AND expiry >= ?
        """, (start_ts, end_ts, day))
        exp_row = cur.fetchone()
        if not exp_row or not exp_row[0]:
            continue
        expiry = exp_row[0]

        df_day = pd.read_sql_query("""
            SELECT datetime, strike, option_type, open, high, low, close, spot
            FROM option_prices
            WHERE datetime >= ? AND datetime <= ? AND expiry = ?
            ORDER BY datetime
        """, conn, params=(start_ts, end_ts, expiry))
        if df_day.empty:
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
        day_cache[day] = {
            'expiry': expiry,
            'prices': prices,
            'spots': spots,
            'times': unique_times
        }
    conn.close()
    return day_cache

def simulate_engine(day_cache,
                     entry_time_start="09:30",
                     max_diff_pct=10.0,
                     leg_sl_pct=20.0,
                     combined_target_pct=20.0,
                     combined_sl_pct=20.0,
                     shift_mode="shift_1_otm", # 'shift_1_otm', 'no_shift', 'close_all', 'shift_2_otm'
                     slippage_pts=0.2):
    
    trades = []
    eod_time = "15:15"

    for day, data in day_cache.items():
        prices = data['prices']
        spots = data['spots']
        times = data['times']

        entry_window = [t for t in times if entry_time_start <= t[11:16] <= "14:30"]
        entered = False

        for t in entry_window:
            spot = spots[t]
            atm = round(spot / 50.0) * 50.0
            ce_bar = prices.get((t, atm, "CE"))
            pe_bar = prices.get((t, atm, "PE"))
            if not ce_bar or not pe_bar:
                continue

            ce_p = ce_bar[3]
            pe_p = pe_bar[3]
            if ce_p <= 0 or pe_p <= 0:
                continue

            diff = abs(ce_p - pe_p) / max(ce_p, pe_p) * 100.0
            if diff < max_diff_pct:
                entered = True
                entry_t = t
                ce_entry = ce_p - slippage_pts
                pe_entry = pe_p - slippage_pts
                break

        if not entered:
            continue

        comb_prem = ce_entry + pe_entry
        target_pts = comb_prem * (combined_target_pct / 100.0) if combined_target_pct else 9999.0
        max_loss_pts = -comb_prem * (combined_sl_pct / 100.0) if combined_sl_pct else -9999.0

        ce_leg = {'strike': atm, 'entry': ce_entry, 'sl': ce_entry * (1.0 + leg_sl_pct/100.0), 'shifts': 0, 'active': True}
        pe_leg = {'strike': atm, 'entry': pe_entry, 'sl': pe_entry * (1.0 + leg_sl_pct/100.0), 'shifts': 0, 'active': True}

        realized_pnl = 0.0
        orders = 2
        trade_times = [t for t in times if t > entry_t and t[11:16] <= eod_time]
        final_pnl = None

        max_shifts = 1 if shift_mode == "shift_1_otm" else (2 if shift_mode == "shift_2_otm" else 0)

        for t in trade_times:
            # Check CE Leg
            if ce_leg['active']:
                bar = prices.get((t, ce_leg['strike'], 'CE'))
                if bar and bar[1] >= ce_leg['sl']:
                    exit_p = max(ce_leg['sl'], bar[0]) + slippage_pts
                    realized_pnl += (ce_leg['entry'] - exit_p)
                    ce_leg['active'] = False
                    orders += 1

                    if shift_mode == "close_all":
                        # If close_all, exiting 1 leg stops entire straddle
                        if pe_leg['active']:
                            pe_bar = prices.get((t, pe_leg['strike'], 'PE'))
                            pe_exit = (pe_bar[3] if pe_bar else pe_leg['entry']) + slippage_pts
                            realized_pnl += (pe_leg['entry'] - pe_exit)
                            pe_leg['active'] = False
                            orders += 1
                        final_pnl = realized_pnl
                        break

                    elif "shift" in shift_mode and ce_leg['shifts'] < max_shifts:
                        new_s = ce_leg['strike'] + 50.0
                        new_bar = prices.get((t, new_s, 'CE'))
                        if new_bar and new_bar[3] > 0:
                            new_e = new_bar[3] - slippage_pts
                            ce_leg = {'strike': new_s, 'entry': new_e, 'sl': new_e * (1.0 + leg_sl_pct/100.0), 'shifts': ce_leg['shifts'] + 1, 'active': True}
                            orders += 1

            # Check PE Leg
            if pe_leg['active']:
                bar = prices.get((t, pe_leg['strike'], 'PE'))
                if bar and bar[1] >= pe_leg['sl']:
                    exit_p = max(pe_leg['sl'], bar[0]) + slippage_pts
                    realized_pnl += (pe_leg['entry'] - exit_p)
                    pe_leg['active'] = False
                    orders += 1

                    if shift_mode == "close_all":
                        if ce_leg['active']:
                            ce_bar = prices.get((t, ce_leg['strike'], 'CE'))
                            ce_exit = (ce_bar[3] if ce_bar else ce_leg['entry']) + slippage_pts
                            realized_pnl += (ce_leg['entry'] - ce_exit)
                            ce_leg['active'] = False
                            orders += 1
                        final_pnl = realized_pnl
                        break

                    elif "shift" in shift_mode and pe_leg['shifts'] < max_shifts:
                        new_s = pe_leg['strike'] - 50.0
                        new_bar = prices.get((t, new_s, 'PE'))
                        if new_bar and new_bar[3] > 0:
                            new_e = new_bar[3] - slippage_pts
                            pe_leg = {'strike': new_s, 'entry': new_e, 'sl': new_e * (1.0 + leg_sl_pct/100.0), 'shifts': pe_leg['shifts'] + 1, 'active': True}
                            orders += 1

            # MTM check
            unrealized = 0.0
            if ce_leg['active']:
                b = prices.get((t, ce_leg['strike'], 'CE'))
                unrealized += (ce_leg['entry'] - (b[3] if b else ce_leg['entry']))
            if pe_leg['active']:
                b = prices.get((t, pe_leg['strike'], 'PE'))
                unrealized += (pe_leg['entry'] - (b[3] if b else pe_leg['entry']))

            total_pnl = realized_pnl + unrealized

            if total_pnl >= target_pts:
                final_pnl = total_pnl
                if ce_leg['active']: orders += 1
                if pe_leg['active']: orders += 1
                break

            if total_pnl <= max_loss_pts:
                final_pnl = total_pnl
                if ce_leg['active']: orders += 1
                if pe_leg['active']: orders += 1
                break

            if t.endswith(f" {eod_time}:00"):
                final_pnl = total_pnl
                if ce_leg['active']: orders += 1
                if pe_leg['active']: orders += 1
                break

        if final_pnl is None:
            final_pnl = total_pnl
            if ce_leg['active']: orders += 1
            if pe_leg['active']: orders += 1

        gross_inr = final_pnl * LOT_SIZE
        costs = (orders * BROKERAGE_PER_ORDER) + (abs(gross_inr) * STT_TRANSACTION_PCT)
        net_inr = gross_inr - costs

        trades.append({
            'date': day,
            'pnl_pts': final_pnl,
            'gross_inr': gross_inr,
            'costs_inr': costs,
            'net_inr': net_inr
        })

    df = pd.DataFrame(trades)
    if df.empty:
        return {'trades': 0, 'win_pct': 0, 'pts': 0, 'gross': 0, 'net': 0, 'max_dd': 0, 'sharpe': 0, 'profit_factor': 0}

    df['cum_net'] = df['net_inr'].cumsum()
    df['peak'] = df['cum_net'].cummax()
    df['dd'] = df['cum_net'] - df['peak']
    wins = df[df['net_inr'] > 0]
    losses = df[df['net_inr'] <= 0]
    pf = abs(wins['net_inr'].sum() / losses['net_inr'].sum()) if not losses.empty and losses['net_inr'].sum() != 0 else float('inf')
    sharpe = (df['net_inr'].mean() / df['net_inr'].std()) * np.sqrt(252) if df['net_inr'].std() > 0 else 0

    return {
        'trades': len(df),
        'win_pct': round(len(wins)/len(df)*100, 1),
        'pts': round(df['pnl_pts'].sum(), 1),
        'gross': round(df['gross_inr'].sum(), 0),
        'net': round(df['net_inr'].sum(), 0),
        'max_dd': round(df['dd'].min(), 0),
        'sharpe': round(sharpe, 2),
        'profit_factor': round(pf, 2)
    }

if __name__ == "__main__":
    print("Loading data cache...")
    cache = load_data_cache()
    print(f"Data cached for {len(cache)} days. Running scans...")

    # 1. Entry Difference Gate Scan
    print("\n--- 1. Entry Difference Gate Scan ---")
    diff_results = []
    for d in [5.0, 10.0, 15.0, 20.0, 100.0]:
        res = simulate_engine(cache, max_diff_pct=d)
        res['param'] = f"< {d}%" if d < 100 else "No Gate"
        diff_results.append(res)
    print(pd.DataFrame(diff_results)[['param', 'trades', 'win_pct', 'pts', 'net', 'max_dd', 'sharpe', 'profit_factor']].to_string(index=False))

    # 2. Leg SL Scan
    print("\n--- 2. Leg SL % Scan ---")
    sl_results = []
    for sl in [15.0, 20.0, 25.0, 30.0, 40.0]:
        res = simulate_engine(cache, leg_sl_pct=sl)
        res['param'] = f"{sl}%"
        sl_results.append(res)
    print(pd.DataFrame(sl_results)[['param', 'trades', 'win_pct', 'pts', 'net', 'max_dd', 'sharpe', 'profit_factor']].to_string(index=False))

    # 3. Adjustment Action Scan (Shift vs No Shift vs Close All)
    print("\n--- 3. Adjustment Action Scan ---")
    adj_results = []
    for mode in ["shift_1_otm", "no_shift", "close_all", "shift_2_otm"]:
        res = simulate_engine(cache, shift_mode=mode)
        res['param'] = mode
        adj_results.append(res)
    print(pd.DataFrame(adj_results)[['param', 'trades', 'win_pct', 'pts', 'net', 'max_dd', 'sharpe', 'profit_factor']].to_string(index=False))

    # 4. Combined Target Scan
    print("\n--- 4. Combined Target % Scan ---")
    tgt_results = []
    for tgt in [10.0, 15.0, 20.0, 30.0, None]:
        res = simulate_engine(cache, combined_target_pct=tgt)
        res['param'] = f"+{tgt}%" if tgt else "EOD Only"
        tgt_results.append(res)
    print(pd.DataFrame(tgt_results)[['param', 'trades', 'win_pct', 'pts', 'net', 'max_dd', 'sharpe', 'profit_factor']].to_string(index=False))

    # 5. Entry Time Scan
    print("\n--- 5. Entry Timing Scan ---")
    time_results = []
    for tm in ["09:20", "09:30", "09:45", "10:00"]:
        res = simulate_engine(cache, entry_time_start=tm)
        res['param'] = tm
        time_results.append(res)
    print(pd.DataFrame(time_results)[['param', 'trades', 'win_pct', 'pts', 'net', 'max_dd', 'sharpe', 'profit_factor']].to_string(index=False))

    # Save summary dataframe for reporting
    all_scans = {
        'entry_diff': diff_results,
        'leg_sl': sl_results,
        'adjustment_mode': adj_results,
        'combined_target': tgt_results,
        'entry_time': time_results
    }
    import json
    with open("debug/straddle_scans_summary.json", "w") as fp:
        json.dump(all_scans, fp, indent=2)
    print("\nScans saved to debug/straddle_scans_summary.json")
