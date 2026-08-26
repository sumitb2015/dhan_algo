"""
scripts/tools/straddle_live_matrix.py

Computes live / historical ATM short straddle performance matrix across
different entry timestamps (e.g. 09:30, 10:00, ..., 15:40) and leg-wise
Stop Loss percentages (10% to 100%).

Usage:
    python scripts/tools/straddle_live_matrix.py --underlying NIFTY [--expiry 2026-09-01] [--interval 30] [--date 2026-07-28]

Prints a single JSON line to stdout. Logs and debugging go to stderr.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

IST = ZoneInfo("Asia/Kolkata")
DB_PATH = os.path.join(ROOT, "Options Data", "nifty_options.db")

UNDERLYINGS: dict[str, dict] = {
    "NIFTY": {
        "chain_id": 13,
        "chain_seg": "IDX_I",
        "leg_seg": "NSE_FNO",
        "leg_inst": "OPTIDX",
        "spot_id": 13,
        "spot_seg": "IDX_I",
        "spot_inst": "INDEX",
        "strike_step": 50,
        "lot_size": 65,
    },
    "BANKNIFTY": {
        "chain_id": 25,
        "chain_seg": "IDX_I",
        "leg_seg": "NSE_FNO",
        "leg_inst": "OPTIDX",
        "spot_id": 25,
        "spot_seg": "IDX_I",
        "spot_inst": "INDEX",
        "strike_step": 100,
        "lot_size": 15,
    },
    "FINNIFTY": {
        "chain_id": 27,
        "chain_seg": "IDX_I",
        "leg_seg": "NSE_FNO",
        "leg_inst": "OPTIDX",
        "spot_id": 27,
        "spot_seg": "IDX_I",
        "spot_inst": "INDEX",
        "strike_step": 50,
        "lot_size": 40,
    },
    "SENSEX": {
        "chain_id": 1,
        "chain_seg": "BSE_FNO",
        "leg_seg": "BSE_FNO",
        "leg_inst": "OPTIDX",
        "spot_id": 51,
        "spot_seg": "IDX_I",
        "spot_inst": "INDEX",
        "strike_step": 100,
        "lot_size": 10,
    },
}

STANDARD_TIMESTAMPS_30 = [
    "09:30", "10:00", "10:30", "11:00", "11:30", "12:00",
    "12:30", "13:00", "13:30", "14:00", "14:30", "15:00",
    "15:20", "15:30", "15:40"
]

STANDARD_TIMESTAMPS_15 = [
    "09:30", "09:45", "10:00", "10:15", "10:30", "10:45",
    "11:00", "11:15", "11:30", "11:45", "12:00", "12:15",
    "12:30", "12:45", "13:00", "13:15", "13:30", "13:45",
    "14:00", "14:15", "14:30", "14:45", "15:00", "15:15",
    "15:30", "15:40"
]

SL_PERCENTAGES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

_last_intraday_call = 0.0


def _fetch_intraday_paged(
    helper: DhanHelper,
    security_id: int | str,
    exchange_segment: str,
    instrument_type: str,
    to_dt: datetime,
    calendar_days: int = 5,
) -> pd.DataFrame:
    global _last_intraday_call
    elapsed = time.time() - _last_intraday_call
    if elapsed < 0.35:
        time.sleep(0.35 - elapsed)
    _last_intraday_call = time.time()

    from_dt = to_dt - timedelta(days=max(calendar_days, 2))

    df = helper.get_intraday_minute_data(
        security_id=str(security_id),
        exchange_segment=exchange_segment,
        instrument_type=instrument_type,
        interval="1",
        from_date=from_dt.strftime("%Y-%m-%d"),
        to_date=to_dt.strftime("%Y-%m-%d"),
    )

    if df.empty and helper.last_api_error and "904" in str(helper.last_api_error.get("code", "")) + str(helper.last_api_error.get("message", "")):
        time.sleep(1.0)
        _last_intraday_call = time.time()
        df = helper.get_intraday_minute_data(
            security_id=str(security_id),
            exchange_segment=exchange_segment,
            instrument_type=instrument_type,
            interval="1",
            from_date=from_dt.strftime("%Y-%m-%d"),
            to_date=to_dt.strftime("%Y-%m-%d"),
        )

    if df.empty or "timestamp" not in df.columns:
        return pd.DataFrame(columns=["time", "open", "high", "low", "close", "volume"])

    out = pd.DataFrame(
        {
            "time": pd.to_datetime(df["timestamp"], unit="s", utc=True).dt.tz_convert(IST).dt.floor("min"),
            "open": df["open"].astype(float),
            "high": df["high"].astype(float),
            "low": df["low"].astype(float),
            "close": df["close"].astype(float),
            "volume": df["volume"].astype(float) if "volume" in df.columns else 0.0,
        }
    )
    return out.sort_values("time").reset_index(drop=True)


def _compute_from_sqlite(
    target_date: str,
    interval_minutes: int = 30,
) -> dict | None:
    """Fast simulation directly from SQLite nifty_options.db if available for target_date."""
    if not os.path.exists(DB_PATH):
        return None

    try:
        conn = sqlite3.connect(DB_PATH)
        query = (
            "SELECT datetime, option_type, strike_relative, strike, spot, open, high, low, close, expiry "
            "FROM option_prices WHERE datetime >= ? AND datetime <= ? ORDER BY datetime ASC"
        )
        df = pd.read_sql_query(query, conn, params=(f"{target_date} 09:15:00", f"{target_date} 15:30:00"))
        conn.close()

        if df.empty:
            return None

        # Expiry & DTE
        expiries = sorted([str(e) for e in df["expiry"].dropna().unique()])
        expiry_val = expiries[0] if expiries else target_date
        try:
            exp_date = datetime.strptime(expiry_val, "%Y-%m-%d").date()
            t_date = datetime.strptime(target_date, "%Y-%m-%d").date()
            dte = max(0, (exp_date - t_date).days)
        except Exception:
            dte = 0

        # Build spot price lookup by HH:MM
        df["time_str"] = df["datetime"].astype(str).str[11:16]
        spot_series = df.drop_duplicates(subset=["time_str"]).set_index("time_str")["spot"].to_dict()
        current_spot = float(df["spot"].iloc[-1]) if "spot" in df.columns else 0.0

        # Group by (strike, option_type) -> map HH:MM -> candle dict
        leg_candles: dict[tuple[int, str], dict[str, dict]] = {}
        for _, row in df.iterrows():
            stk = int(round(float(row["strike"])))
            otype = str(row["option_type"]).upper()
            t_str = row["time_str"]
            key = (stk, otype)
            if key not in leg_candles:
                leg_candles[key] = {}
            leg_candles[key][t_str] = {
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
            }

        target_timestamps = STANDARD_TIMESTAMPS_15 if interval_minutes == 15 else STANDARD_TIMESTAMPS_30

        timestamp_info = []
        for ts in target_timestamps:
            matched_spot = None
            for cand_t in sorted(spot_series.keys()):
                if cand_t <= ts:
                    matched_spot = spot_series[cand_t]
                else:
                    break
            if matched_spot is None:
                continue

            atm_strike = int(round(matched_spot / 50.0) * 50.0)
            timestamp_info.append({
                "time": ts,
                "spot": round(matched_spot, 2),
                "atm_strike": atm_strike,
            })

        if not timestamp_info:
            return None

        columns_data = []
        matrix_cells: dict[int, list[dict]] = {sl: [] for sl in SL_PERCENTAGES}

        for t_item in timestamp_info:
            ts = t_item["time"]
            strike = t_item["atm_strike"]

            ce_dict = leg_candles.get((strike, "CE"), {})
            pe_dict = leg_candles.get((strike, "PE"), {})

            if not ce_dict or not pe_dict:
                continue

            entry_ce = None
            entry_pe = None
            for cand_t in sorted(ce_dict.keys()):
                if cand_t <= ts:
                    entry_ce = ce_dict[cand_t]
                else:
                    break
            for cand_t in sorted(pe_dict.keys()):
                if cand_t <= ts:
                    entry_pe = pe_dict[cand_t]
                else:
                    break

            if entry_ce is None or entry_pe is None:
                continue

            ce_entry = round(entry_ce["close"], 2)
            pe_entry = round(entry_pe["close"], 2)
            entry_comb = round(ce_entry + pe_entry, 2)

            latest_ce_t = max(ce_dict.keys())
            latest_pe_t = max(pe_dict.keys())
            ce_latest = round(ce_dict[latest_ce_t]["close"], 2)
            pe_latest = round(pe_dict[latest_pe_t]["close"], 2)
            ltp_comb = round(ce_latest + pe_latest, 2)

            active_times = sorted([t for t in set(ce_dict.keys()) & set(pe_dict.keys()) if t >= ts])

            sl_results_for_ts = []
            for sl_pct in SL_PERCENTAGES:
                ce_sl_price = round(ce_entry * (1.0 + sl_pct / 100.0), 2)
                pe_sl_price = round(pe_entry * (1.0 + sl_pct / 100.0), 2)

                ce_out = False
                pe_out = False
                ce_exit_price = 0.0
                pe_exit_price = 0.0
                ce_exit_time = None
                pe_exit_time = None
                min_running_pnl = 0.0

                for t_step in active_times:
                    c_bar = ce_dict[t_step]
                    p_bar = pe_dict[t_step]

                    if not ce_out:
                        if c_bar["high"] >= ce_sl_price:
                            ce_out = True
                            ce_exit_price = ce_sl_price
                            ce_exit_time = t_step

                    if not pe_out:
                        if p_bar["high"] >= pe_sl_price:
                            pe_out = True
                            pe_exit_price = pe_sl_price
                            pe_exit_time = t_step

                    cur_c = ce_exit_price if ce_out else c_bar["close"]
                    cur_p = pe_exit_price if pe_out else p_bar["close"]
                    run_pnl = (ce_entry - cur_c) + (pe_entry - cur_p)
                    if run_pnl < min_running_pnl:
                        min_running_pnl = run_pnl

                final_c = ce_exit_price if ce_out else ce_latest
                final_p = pe_exit_price if pe_out else pe_latest
                pnl_pts = round((ce_entry - final_c) + (pe_entry - final_p), 2)

                if not ce_out and not pe_out:
                    status = "intact+" if pnl_pts >= 0 else "intact-"
                elif ce_out and not pe_out:
                    status = "ce_out"
                elif not ce_out and pe_out:
                    status = "pe_out"
                else:
                    status = "both_out"

                cell_res = {
                    "time": ts,
                    "sl_pct": sl_pct,
                    "pnl_pts": pnl_pts,
                    "status": status,
                    "ce_out": ce_out,
                    "pe_out": pe_out,
                    "ce_entry": ce_entry,
                    "pe_entry": pe_entry,
                    "ce_exit": round(final_c, 2),
                    "pe_exit": round(final_p, 2),
                    "ce_exit_time": ce_exit_time,
                    "pe_exit_time": pe_exit_time,
                    "var_pts": round(min_running_pnl, 2),
                }
                sl_results_for_ts.append(cell_res)
                matrix_cells[sl_pct].append(cell_res)

            if not sl_results_for_ts:
                continue

            best_item = max(sl_results_for_ts, key=lambda x: x["pnl_pts"])
            best_sl_pct = best_item["sl_pct"]
            best_pnl = best_item["pnl_pts"]
            worst_var = min(x["var_pts"] for x in sl_results_for_ts)
            col_total_pnl = round(sum(x["pnl_pts"] for x in sl_results_for_ts), 2)

            columns_data.append({
                "time": ts,
                "strike": strike,
                "entry": entry_comb,
                "ce_entry": ce_entry,
                "pe_entry": pe_entry,
                "ltp": ltp_comb,
                "ce_ltp": ce_latest,
                "pe_ltp": pe_latest,
                "best_sl": f"{best_sl_pct}%",
                "best_sl_pct": best_sl_pct,
                "pnl_pts": best_pnl,
                "var_pts": worst_var,
                "col_total": col_total_pnl,
            })

        if not columns_data:
            return None

        row_totals = {}
        for sl_pct in SL_PERCENTAGES:
            cells = matrix_cells[sl_pct]
            row_totals[f"{sl_pct}%"] = round(sum(c["pnl_pts"] for c in cells), 2)

        total_best_pnl = round(sum(c["pnl_pts"] for c in columns_data), 2)
        total_col_sum = round(sum(c["col_total"] for c in columns_data), 2)
        total_var = round(sum(c["var_pts"] for c in columns_data), 2)
        grand_row_total = round(sum(row_totals.values()), 2)
        best_fixed_sl = max(row_totals.items(), key=lambda x: x[1])

        win_count = sum(1 for c in columns_data if c["pnl_pts"] > 0)
        win_rate = round((win_count / len(columns_data)) * 100.0, 1) if columns_data else 0.0
        lot_size = 65

        return {
            "underlying": "NIFTY",
            "expiry": expiry_val,
            "all_expiries": expiries,
            "dte": dte,
            "data_date": target_date,
            "current_spot": round(current_spot, 2),
            "lot_size": lot_size,
            "is_historical": True,
            "data_source": "nifty_options.db",
            "timestamps": [c["time"] for c in columns_data],
            "columns": columns_data,
            "sl_rows": [
                {
                    "sl_pct": sl,
                    "sl_label": f"{sl}%",
                    "cells": matrix_cells[sl],
                    "row_total": row_totals.get(f"{sl}%", 0.0),
                }
                for sl in SL_PERCENTAGES
            ],
            "summary": {
                "total_best_pnl_pts": total_best_pnl,
                "total_best_pnl_inr": round(total_best_pnl * lot_size, 2),
                "total_col_sum_pts": total_col_sum,
                "total_var_pts": total_var,
                "total_var_inr": round(total_var * lot_size, 2),
                "grand_row_total": grand_row_total,
                "best_fixed_sl": best_fixed_sl[0],
                "best_fixed_sl_pnl": best_fixed_sl[1],
                "win_rate_pct": win_rate,
                "entries_count": len(columns_data),
                "profitable_entries": win_count,
            },
        }
    except Exception as exc:
        sys.stderr.write(f"SQLite simulation error: {exc}\n")
        return None


def _compute_straddle_matrix(
    underlying: str,
    expiry_input: str | None = None,
    target_date_input: str | None = None,
    interval_minutes: int = 30,
) -> dict:
    # 0. If target date is in SQLite nifty_options.db, use fast SQLite simulation
    if target_date_input and underlying.upper() == "NIFTY":
        sqlite_res = _compute_from_sqlite(target_date_input, interval_minutes)
        if sqlite_res is not None:
            return sqlite_res

    dhan = get_dhan_client()
    if not dhan:
        return {"error": "Authentication failed — run login.py to refresh Dhan access token"}

    helper = DhanHelper(dhan, skip_session_validation=True, master_list_cache=True)
    meta = UNDERLYINGS.get(underlying.upper())
    if not meta:
        return {"error": f"Unsupported underlying: {underlying}"}

    # 1. Fetch available expiries
    chain_symbol = meta["chain_id"]
    expiries_list = helper.get_expiry_list(
        under_security_id=int(chain_symbol),
        under_exchange_segment=meta["chain_seg"],
    )
    if not expiries_list:
        # Fallback to master list lookup
        expiries_list = helper.get_expiry_dates(underlying.upper())

    if not expiries_list:
        return {"error": f"No expiries found for {underlying}"}

    # Filter only current and future expiries, sort ascending
    today_str = date.today().strftime("%Y-%m-%d")
    valid_expiries = sorted([exp for exp in expiries_list if exp >= today_str])
    if not valid_expiries:
        valid_expiries = sorted(expiries_list)

    chosen_expiry = expiry_input if expiry_input and expiry_input in expiries_list else valid_expiries[0]

    # Calculate DTE
    try:
        exp_date = datetime.strptime(chosen_expiry, "%Y-%m-%d").date()
        cur_date = datetime.now(IST).date()
        dte = max(0, (exp_date - cur_date).days)
    except Exception:
        dte = 0

    # 2. Fetch Spot Candles for the underlying
    now_ist = datetime.now(IST)
    spot_df = _fetch_intraday_paged(
        helper,
        security_id=meta["spot_id"],
        exchange_segment=meta["spot_seg"],
        instrument_type=meta["spot_inst"],
        to_dt=now_ist,
        calendar_days=10 if target_date_input else 5,
    )

    if spot_df.empty:
        return {"error": f"No intraday spot data available for {underlying}"}

    # Filter for target date
    all_dates = sorted(spot_df["time"].dt.date.unique())
    if target_date_input:
        try:
            target_d = datetime.strptime(target_date_input, "%Y-%m-%d").date()
        except Exception:
            target_d = all_dates[-1]
        if target_d not in all_dates:
            target_d = all_dates[-1]
    else:
        target_d = all_dates[-1]

    data_date_str = target_d.strftime("%Y-%m-%d")
    day_spot_df = spot_df[spot_df["time"].dt.date == target_d].copy().reset_index(drop=True)
    if day_spot_df.empty:
        return {"error": f"No spot data on {data_date_str}"}

    current_spot = float(day_spot_df["close"].iloc[-1])

    # Build spot lookup by HH:MM
    day_spot_df["hhmm"] = day_spot_df["time"].dt.strftime("%H:%M")
    spot_by_time = {row["hhmm"]: float(row["close"]) for _, row in day_spot_df.iterrows()}

    # Select timestamps list
    if interval_minutes == 15:
        target_timestamps = STANDARD_TIMESTAMPS_15
    else:
        target_timestamps = STANDARD_TIMESTAMPS_30

    latest_candle_time = max(spot_by_time.keys()) if spot_by_time else "00:00"

    # Determine ATM strike for each timestamp
    strike_step = meta["strike_step"]
    timestamp_info: list[dict] = []
    required_strikes: set[int] = set()

    for ts in target_timestamps:
        if ts > latest_candle_time:
            # Future timestamp - market hasn't reached this time yet
            continue

        # Find spot at ts or nearest preceding minute
        matched_spot = None
        for cand_ts in sorted(spot_by_time.keys()):
            if cand_ts <= ts:
                matched_spot = spot_by_time[cand_ts]
            else:
                break
        
        if matched_spot is None:
            continue

        atm_strike = int(round(matched_spot / strike_step) * strike_step)
        required_strikes.add(atm_strike)

        timestamp_info.append({
            "time": ts,
            "spot": round(matched_spot, 2),
            "atm_strike": atm_strike,
        })

    if not timestamp_info:
        return {"error": "No trading session timestamps have elapsed yet today"}

    # 3. Fetch Intraday Candles for all required CE and PE strikes
    leg_candles: dict[tuple[int, str], pd.DataFrame] = {}
    
    for strike in sorted(required_strikes):
        ce_opt = helper.find_option(underlying.upper(), chosen_expiry, strike, "CE")
        pe_opt = helper.find_option(underlying.upper(), chosen_expiry, strike, "PE")

        if ce_opt is not None:
            ce_sid = str(int(ce_opt["SECURITY_ID"]))
            ce_raw = _fetch_intraday_paged(
                helper, ce_sid, meta["leg_seg"], meta["leg_inst"], to_dt=now_ist, calendar_days=8 if target_date_input else 4
            )
            if not ce_raw.empty:
                ce_day = ce_raw[ce_raw["time"].dt.date == target_d].copy().reset_index(drop=True)
                ce_day["hhmm"] = ce_day["time"].dt.strftime("%H:%M")
                leg_candles[(strike, "CE")] = ce_day

        if pe_opt is not None:
            pe_sid = str(int(pe_opt["SECURITY_ID"]))
            pe_raw = _fetch_intraday_paged(
                helper, pe_sid, meta["leg_seg"], meta["leg_inst"], to_dt=now_ist, calendar_days=8 if target_date_input else 4
            )
            if not pe_raw.empty:
                pe_day = pe_raw[pe_raw["time"].dt.date == target_d].copy().reset_index(drop=True)
                pe_day["hhmm"] = pe_day["time"].dt.strftime("%H:%M")
                leg_candles[(strike, "PE")] = pe_day

    # 4. Simulate Straddle for each timestamp and SL percentage
    columns_data: list[dict] = []
    matrix_cells: dict[int, list[dict]] = {sl: [] for sl in SL_PERCENTAGES}

    for t_item in timestamp_info:
        ts = t_item["time"]
        strike = t_item["atm_strike"]

        ce_df = leg_candles.get((strike, "CE"))
        pe_df = leg_candles.get((strike, "PE"))

        if ce_df is None or pe_df is None or ce_df.empty or pe_df.empty:
            continue

        # Map candles by minute
        ce_by_time = {row["hhmm"]: row for _, row in ce_df.iterrows()}
        pe_by_time = {row["hhmm"]: row for _, row in pe_df.iterrows()}

        # Find entry candle at or immediately before ts
        entry_ce_cand = None
        entry_pe_cand = None
        for cand_t in sorted(ce_by_time.keys()):
            if cand_t <= ts:
                entry_ce_cand = ce_by_time[cand_t]
            else:
                break
        for cand_t in sorted(pe_by_time.keys()):
            if cand_t <= ts:
                entry_pe_cand = pe_by_time[cand_t]
            else:
                break

        if entry_ce_cand is None or entry_pe_cand is None:
            continue

        ce_entry = round(float(entry_ce_cand["close"]), 2)
        pe_entry = round(float(entry_pe_cand["close"]), 2)
        entry_comb = round(ce_entry + pe_entry, 2)

        # Current latest prices
        ce_latest = round(float(ce_df["close"].iloc[-1]), 2)
        pe_latest = round(float(pe_df["close"].iloc[-1]), 2)
        ltp_comb = round(ce_latest + pe_latest, 2)

        # Future candles from ts onwards
        active_times = sorted([t for t in set(ce_by_time.keys()) & set(pe_by_time.keys()) if t >= ts])

        # Evaluate each SL% for this timestamp
        sl_results_for_ts: list[dict] = []

        for sl_pct in SL_PERCENTAGES:
            ce_sl_price = round(ce_entry * (1.0 + sl_pct / 100.0), 2)
            pe_sl_price = round(pe_entry * (1.0 + sl_pct / 100.0), 2)

            ce_out = False
            pe_out = False
            ce_exit_price = 0.0
            pe_exit_price = 0.0
            ce_exit_time = None
            pe_exit_time = None

            min_running_pnl = 0.0

            for t_step in active_times:
                c_bar = ce_by_time[t_step]
                p_bar = pe_by_time[t_step]

                # Check CE SL trigger
                if not ce_out:
                    if float(c_bar["high"]) >= ce_sl_price:
                        ce_out = True
                        ce_exit_price = ce_sl_price
                        ce_exit_time = t_step

                # Check PE SL trigger
                if not pe_out:
                    if float(p_bar["high"]) >= pe_sl_price:
                        pe_out = True
                        pe_exit_price = pe_sl_price
                        pe_exit_time = t_step

                # Running PnL at this candle
                cur_c = ce_exit_price if ce_out else float(c_bar["close"])
                cur_p = pe_exit_price if pe_out else float(p_bar["close"])
                run_pnl = (ce_entry - cur_c) + (pe_entry - cur_p)
                if run_pnl < min_running_pnl:
                    min_running_pnl = run_pnl

            # Final PnL and classification
            final_c = ce_exit_price if ce_out else ce_latest
            final_p = pe_exit_price if pe_out else pe_latest
            pnl_pts = round((ce_entry - final_c) + (pe_entry - final_p), 2)

            if not ce_out and not pe_out:
                status = "intact+" if pnl_pts >= 0 else "intact-"
            elif ce_out and not pe_out:
                status = "ce_out"
            elif not ce_out and pe_out:
                status = "pe_out"
            else:
                status = "both_out"

            cell_res = {
                "time": ts,
                "sl_pct": sl_pct,
                "pnl_pts": pnl_pts,
                "status": status,
                "ce_out": ce_out,
                "pe_out": pe_out,
                "ce_entry": ce_entry,
                "pe_entry": pe_entry,
                "ce_exit": round(final_c, 2),
                "pe_exit": round(final_p, 2),
                "ce_exit_time": ce_exit_time,
                "pe_exit_time": pe_exit_time,
                "var_pts": round(min_running_pnl, 2),
            }
            sl_results_for_ts.append(cell_res)
            matrix_cells[sl_pct].append(cell_res)

        if not sl_results_for_ts:
            continue

        # Column stats
        best_item = max(sl_results_for_ts, key=lambda x: x["pnl_pts"])
        best_sl_pct = best_item["sl_pct"]
        best_pnl = best_item["pnl_pts"]
        worst_var = min(x["var_pts"] for x in sl_results_for_ts)
        col_total_pnl = round(sum(x["pnl_pts"] for x in sl_results_for_ts), 2)

        columns_data.append({
            "time": ts,
            "strike": strike,
            "entry": entry_comb,
            "ce_entry": ce_entry,
            "pe_entry": pe_entry,
            "ltp": ltp_comb,
            "ce_ltp": ce_latest,
            "pe_ltp": pe_latest,
            "best_sl": f"{best_sl_pct}%",
            "best_sl_pct": best_sl_pct,
            "pnl_pts": best_pnl,
            "var_pts": worst_var,
            "col_total": col_total_pnl,
        })

    if not columns_data:
        return {"error": "Could not calculate straddle data for active timestamps"}

    # 5. Row Totals across timestamps
    row_totals: dict[str, float] = {}
    for sl_pct in SL_PERCENTAGES:
        cells = matrix_cells[sl_pct]
        row_totals[f"{sl_pct}%"] = round(sum(c["pnl_pts"] for c in cells), 2)

    # 6. Overall Grand Totals
    total_best_pnl = round(sum(c["pnl_pts"] for c in columns_data), 2)
    total_col_sum = round(sum(c["col_total"] for c in columns_data), 2)
    total_var = round(sum(c["var_pts"] for c in columns_data), 2)
    grand_row_total = round(sum(row_totals.values()), 2)

    # Best fixed SL overall
    best_fixed_sl = max(row_totals.items(), key=lambda x: x[1])

    # Win rate of best SL picks
    win_count = sum(1 for c in columns_data if c["pnl_pts"] > 0)
    win_rate = round((win_count / len(columns_data)) * 100.0, 1) if columns_data else 0.0

    lot_size = meta.get("lot_size", 65)

    return {
        "underlying": underlying.upper(),
        "expiry": chosen_expiry,
        "all_expiries": valid_expiries,
        "dte": dte,
        "data_date": data_date_str,
        "current_spot": round(current_spot, 2),
        "lot_size": lot_size,
        "is_historical": target_date_input is not None,
        "timestamps": [c["time"] for c in columns_data],
        "columns": columns_data,
        "sl_rows": [
            {
                "sl_pct": sl,
                "sl_label": f"{sl}%",
                "cells": matrix_cells[sl],
                "row_total": row_totals.get(f"{sl}%", 0.0),
            }
            for sl in SL_PERCENTAGES
        ],
        "summary": {
            "total_best_pnl_pts": total_best_pnl,
            "total_best_pnl_inr": round(total_best_pnl * lot_size, 2),
            "total_col_sum_pts": total_col_sum,
            "total_var_pts": total_var,
            "total_var_inr": round(total_var * lot_size, 2),
            "grand_row_total": grand_row_total,
            "best_fixed_sl": best_fixed_sl[0],
            "best_fixed_sl_pnl": best_fixed_sl[1],
            "win_rate_pct": win_rate,
            "entries_count": len(columns_data),
            "profitable_entries": win_count,
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--underlying", default="NIFTY", help="Underlying symbol (NIFTY, BANKNIFTY, FINNIFTY, SENSEX)")
    parser.add_argument("--expiry", default=None, help="Expiry date YYYY-MM-DD")
    parser.add_argument("--date", default=None, help="Historical date YYYY-MM-DD (defaults to latest intraday date)")
    parser.add_argument("--interval", default="30", choices=["15", "30", "60"], help="Timestamp interval in minutes")
    args = parser.parse_args()

    try:
        interval_val = int(args.interval)
    except Exception:
        interval_val = 30

    res = _compute_straddle_matrix(
        underlying=args.underlying,
        expiry_input=args.expiry,
        target_date_input=args.date,
        interval_minutes=interval_val,
    )

    print(json.dumps(res, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
