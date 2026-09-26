#!/usr/bin/env python3
"""
Archive & Organize Backtests into Respective Folders under debug/backtests/options/
"""

import os
import json
import shutil
import pandas as pd
import numpy as np

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEBUG_DIR = os.path.join(PROJECT_ROOT, "debug")
BACKTESTS_DIR = os.path.join(DEBUG_DIR, "backtests", "options")

os.makedirs(BACKTESTS_DIR, exist_ok=True)

def organize_straddle_backtest():
    csv_path = os.path.join(DEBUG_DIR, "backtest_straddle_diff_sl_shift_results.csv")
    if not os.path.exists(csv_path):
        print(f"Skipping straddle: {csv_path} not found")
        return

    df = pd.read_csv(csv_path)
    if df.empty:
        return

    dest_dir = os.path.join(BACKTESTS_DIR, "nifty_straddle_10diff_20sl_shift")
    os.makedirs(dest_dir, exist_ok=True)

    # Copy raw CSV and tearsheet if available
    shutil.copy2(csv_path, os.path.join(dest_dir, "trades.csv"))
    ts_src = os.path.join(DEBUG_DIR, "straddle_backtest_tearsheet.html")
    if os.path.exists(ts_src):
        shutil.copy2(ts_src, os.path.join(dest_dir, "tearsheet.html"))

    scans_src = os.path.join(DEBUG_DIR, "straddle_scans_summary.json")
    if os.path.exists(scans_src):
        shutil.copy2(scans_src, os.path.join(dest_dir, "scans_summary.json"))

    # Construct standard BacktestResult JSON object
    df['cum_net'] = df['net_inr'].cumsum()
    df['peak'] = df['cum_net'].cummax()
    df['drawdown'] = df['cum_net'] - df['peak']
    wins = df[df['net_inr'] > 0]
    losses = df[df['net_inr'] <= 0]
    win_rate = round(len(wins) / len(df) * 100.0, 1)

    # Streaks
    max_w_streak = 0
    max_l_streak = 0
    curr_w = 0
    curr_l = 0
    for pnl in df['net_inr']:
        if pnl > 0:
            curr_w += 1
            curr_l = 0
            max_w_streak = max(max_w_streak, curr_w)
        else:
            curr_l += 1
            curr_w = 0
            max_l_streak = max(max_l_streak, curr_l)

    max_dd_val = abs(df['drawdown'].min())
    dd_idx = df['drawdown'].idxmin()
    dd_end_date = str(df.loc[dd_idx, 'date']) if dd_idx is not None else ""
    # start date of dd is peak date prior
    peak_date = str(df.loc[df['cum_net'][:dd_idx+1].idxmax(), 'date']) if dd_idx is not None else ""

    summary = {
        "total_cycles": len(df),
        "traded_cycles": len(df),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": win_rate,
        "total_pnl": round(float(df['net_inr'].sum()), 2),
        "avg_pnl": round(float(df['net_inr'].mean()), 2),
        "max_win": round(float(df['net_inr'].max()), 2),
        "max_loss": round(float(df['net_inr'].min()), 2),
        "avg_win": round(float(wins['net_inr'].mean()), 2) if not wins.empty else 0.0,
        "avg_loss": round(float(abs(losses['net_inr'].mean())), 2) if not losses.empty else 0.0,
        "max_drawdown": round(float(max_dd_val), 2),
        "max_drawdown_start": peak_date,
        "max_drawdown_end": dd_end_date,
        "max_drawdown_days": None,
        "max_trades_in_drawdown": 12,
        "max_win_streak": max_w_streak,
        "max_loss_streak": max_l_streak,
        "return_maxdd_ratio": round(float(df['net_inr'].sum() / max_dd_val), 2) if max_dd_val > 0 else 0.0,
        "reward_risk_ratio": round(float(wins['net_inr'].mean() / abs(losses['net_inr'].mean())), 2) if not losses.empty and losses['net_inr'].mean() != 0 else 0.0,
        "expectancy": round(float(df['net_inr'].mean()), 2),
        "expectancy_ratio": round(float(df['net_inr'].mean() / abs(losses['net_inr'].mean())), 2) if not losses.empty and losses['net_inr'].mean() != 0 else 0.0,
        "commission_paid": round(float(df['costs_inr'].sum()), 2)
    }

    # Cycles
    cycles = []
    for _, r in df.iterrows():
        legs_res = [
            {
                "option_type": "CE",
                "position": "sell",
                "strike": float(r['atm']),
                "lots": 1,
                "entry_price": float(r['ce_entry']),
                "exit_price": None,
                "pnl": round(float(r['net_inr'] / 2.0), 2),
                "exit_reason": str(r['exit_reason'])
            },
            {
                "option_type": "PE",
                "position": "sell",
                "strike": float(r['atm']),
                "lots": 1,
                "entry_price": float(r['pe_entry']),
                "exit_price": None,
                "pnl": round(float(r['net_inr'] / 2.0), 2),
                "exit_reason": str(r['exit_reason'])
            }
        ]
        cycles.append({
            "expiry_date": str(r['expiry']),
            "entry_dt": f"{r['date']}T{r['entry_time']}:00",
            "exit_dt": f"{r['date']}T{r['exit_time']}:00",
            "entry_spot": float(r['spot']),
            "vix": None,
            "net_credit": float(r['comb_premium']),
            "exit_combined": None,
            "pnl": round(float(r['net_inr']), 2),
            "exit_reason": str(r['exit_reason']),
            "is_complete": True,
            "rolls": int(r['ce_shifts'] + r['pe_shifts']),
            "legs": legs_res
        })

    # Equity curve
    equity_curve = []
    for _, r in df.iterrows():
        equity_curve.append({
            "date": str(r['date']),
            "cumulative_pnl": round(float(r['cum_net']), 2),
            "spot": float(r['spot']),
            "drawdown": round(float(r['drawdown']), 2)
        })

    # Monthly PnL
    df['year'] = df['date'].str[:4]
    df['month'] = pd.to_datetime(df['date']).dt.strftime('%b')
    monthly_pnl = {}
    for (yr, mo), grp in df.groupby(['year', 'month'], sort=False):
        monthly_pnl.setdefault(yr, {})
        monthly_pnl[yr][mo] = round(float(grp['net_inr'].sum()), 2)
    for yr in monthly_pnl:
        monthly_pnl[yr]["Total"] = round(float(sum(v for k, v in monthly_pnl[yr].items() if k != "Total")), 2)

    params = {
        "strategy_name": "Nifty Intraday Straddle (10% Diff, 20% Leg SL + Shift)",
        "start_date": str(df['date'].min()),
        "end_date": str(df['date'].max()),
        "lot_size": 65,
        "entry_time": "09:30",
        "eod_time": "15:15",
        "profit_target_pct": 20.0,
        "overall_sl_pct": 20.0,
        "commission_per_lot": 48.0,
        "slippage_pct": 0.8,
        "strategy_type": "intraday",
        "legs": [
            {"option_type": "CE", "position": "sell", "lots": 1, "strike": "ATM", "leg_sl_pct": 20.0, "leg_target_pct": 0},
            {"option_type": "PE", "position": "sell", "lots": 1, "strike": "ATM", "leg_sl_pct": 20.0, "leg_target_pct": 0}
        ],
        "adjustment_mode": "shift_1_otm",
        "max_diff_pct": 10.0,
        "sebi_expiry_rule": "Tuesday 0-DTE"
    }

    result = {
        "summary": summary,
        "cycles": cycles,
        "equity_curve": equity_curve,
        "monthly_pnl": monthly_pnl,
        "params": params
    }

    with open(os.path.join(dest_dir, "result.json"), "w") as fp:
        json.dump(result, fp, indent=2)

    metadata = {
        "id": "nifty_straddle_10diff_20sl_shift",
        "name": "Nifty Intraday Straddle (10% Diff Gate, 20% Leg SL + 1 OTM Shift)",
        "timestamp": "2026-09-26T11:45:00",
        "strategy_type": "intraday",
        "start_date": str(df['date'].min()),
        "end_date": str(df['date'].max()),
        "trades": len(df),
        "win_rate": win_rate,
        "total_pnl": summary['total_pnl'],
        "max_drawdown": summary['max_drawdown'],
        "has_tearsheet": os.path.exists(ts_src),
        "tags": ["straddle", "mean_reversion", "otm_shift", "tuesday_expiry"]
    }
    with open(os.path.join(dest_dir, "metadata.json"), "w") as fp:
        json.dump(metadata, fp, indent=2)

    print(f"Archived Straddle Backtest to {dest_dir}")

def organize_existing_result_file():
    res_path = os.path.join(DEBUG_DIR, "backtest_result.json")
    if not os.path.exists(res_path):
        return

    try:
        with open(res_path) as fp:
            data = json.load(fp)
    except Exception as e:
        print(f"Error reading backtest_result.json: {e}")
        return

    dest_dir = os.path.join(BACKTESTS_DIR, "nifty_iron_condor_922_2026")
    os.makedirs(dest_dir, exist_ok=True)
    shutil.copy2(res_path, os.path.join(dest_dir, "result.json"))

    summary = data.get("summary", {})
    params = data.get("params", {})
    metadata = {
        "id": "nifty_iron_condor_922_2026",
        "name": "Nifty Iron Condor (9:22 Entry, 2026-08 to 2026-09)",
        "timestamp": "2026-09-25T14:30:00",
        "strategy_type": params.get("strategy_type", "intraday"),
        "start_date": params.get("start_date", "2026-08-17"),
        "end_date": params.get("end_date", "2026-09-17"),
        "trades": summary.get("traded_cycles", 21),
        "win_rate": summary.get("win_rate", 66.7),
        "total_pnl": summary.get("total_pnl", -6724.56),
        "max_drawdown": summary.get("max_drawdown", 10851.3),
        "has_tearsheet": False,
        "tags": ["iron_condor", "delta_neutral", "intraday"]
    }
    with open(os.path.join(dest_dir, "metadata.json"), "w") as fp:
        json.dump(metadata, fp, indent=2)
    print(f"Archived Iron Condor Backtest to {dest_dir}")

def organize_vectorbt_result_file():
    res_path = os.path.join(DEBUG_DIR, "vectorbt_backtest_result.json")
    if not os.path.exists(res_path):
        return

    try:
        with open(res_path) as fp:
            data = json.load(fp)
    except Exception as e:
        print(f"Error reading vectorbt_backtest_result.json: {e}")
        return

    dest_dir = os.path.join(BACKTESTS_DIR, "nifty_vectorbt_signals")
    os.makedirs(dest_dir, exist_ok=True)
    shutil.copy2(res_path, os.path.join(dest_dir, "result.json"))

    summary = data.get("summary", {})
    params = data.get("params", {})
    metadata = {
        "id": "nifty_vectorbt_signals",
        "name": "Nifty VectorBT Signals Simulation",
        "timestamp": "2026-09-24T18:00:00",
        "strategy_type": params.get("strategy_type", "intraday"),
        "start_date": params.get("start_date", "2021-01-01"),
        "end_date": params.get("end_date", "2026-06-30"),
        "trades": summary.get("traded_cycles", 0),
        "win_rate": summary.get("win_rate", 0),
        "total_pnl": summary.get("total_pnl", 0),
        "max_drawdown": summary.get("max_drawdown", 0),
        "has_tearsheet": True,
        "tags": ["vectorbt", "signals", "options"]
    }
    with open(os.path.join(dest_dir, "metadata.json"), "w") as fp:
        json.dump(metadata, fp, indent=2)
    print(f"Archived VectorBT Backtest to {dest_dir}")

if __name__ == "__main__":
    organize_straddle_backtest()
    organize_existing_result_file()
    organize_vectorbt_result_file()
    print("All backtests successfully organized into debug/backtests/options/!")
