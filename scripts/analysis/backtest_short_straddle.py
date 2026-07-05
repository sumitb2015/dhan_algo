"""
Multi-Leg Options Backtest — reads Options Data/NIFTY/<strike_folder>/ CSVs,
simulates configurable legs per expiry cycle, outputs JSON to stdout.

Usage:
  python scripts/analysis/backtest_short_straddle.py \
    --start-date 2021-01-01 --end-date 2026-06-30 \
    --lot-size 65 --entry-time 09:20 --eod-time 15:15 \
    --strategy-type intraday \
    --profit-target-pct 50 \
    --commission-per-lot 40 --slippage-pct 0.0 \
    --legs '[{"option_type":"CE","position":"sell","lots":1,"strike":"ATM","leg_sl_pct":0},
             {"option_type":"PE","position":"sell","lots":1,"strike":"ATM","leg_sl_pct":0}]'
"""

import sys
import os
import json
import math
import argparse
from datetime import datetime, date, timedelta
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Tuple
from collections import defaultdict

import pandas as pd

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_ROOT = os.path.join(PROJECT_ROOT, "Options Data", "NIFTY")
VIX_PATH = os.path.join(PROJECT_ROOT, "Historical Data", "Indices", "INDIA_VIX.csv")

MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclass
class LegConfig:
    option_type: str        # "CE" or "PE"
    position: str           # "sell" or "buy"
    lots: int
    strike: str             # "ATM", "ATM+1", "ATM-2", etc. or target value
    leg_sl_pct: float       # 0 = disabled
    leg_target_pct: float = 0.0  # 0 = disabled
    strike_type: str = "offset"  # "offset", "closest_premium", or "closest_delta"


# ---------------------------------------------------------------------------
# Data layer
# ---------------------------------------------------------------------------

@dataclass
class LegBar:
    open_: float
    high: float
    low: float
    close: float
    strike: float


@dataclass
class MultiLegBar:
    dt: datetime
    spot: float
    legs: List[LegBar]


@dataclass
class ExpiryCycle:
    expiry_date: str
    bars: List[MultiLegBar]
    is_complete: bool
    gap_reason: Optional[str]
    strike_lookup: Dict[Tuple[datetime, str, float], Tuple[float, float, float, float]] = field(default_factory=dict)


def _parse_date(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def _load_vix() -> Dict[str, float]:
    vix = {}
    try:
        df = pd.read_csv(VIX_PATH, parse_dates=["Datetime"])
        for _, row in df.iterrows():
            d = str(row["Datetime"])[:10]
            vix[d] = float(row["Close"])
    except Exception:
        pass
    return vix


def fetch_multi_leg_cycles(start_date: str, end_date: str,
                           leg_configs: List[LegConfig],
                           db_conn = None) -> List[ExpiryCycle]:
    import sqlite3
    start = _parse_date(start_date)
    end   = _parse_date(end_date)

    if db_conn:
        cursor = db_conn.cursor()
        end_dt_limit = (end + timedelta(days=40)).isoformat()
        cursor.execute(
            "SELECT DISTINCT expiry FROM option_prices WHERE expiry >= ? AND expiry <= ? ORDER BY expiry",
            (start_date, end_dt_limit)
        )
        expiries = [row[0] for row in cursor.fetchall()]
        
        cycles: List[ExpiryCycle] = []
        for expiry in expiries:
            try:
                expiry_dt = _parse_date(expiry)
            except ValueError:
                continue
                
            leg_series: List[pd.DataFrame] = []
            all_ok = True
            for i, leg in enumerate(leg_configs):
                strike_ref = leg.strike
                if getattr(leg, "strike_type", "offset") != "offset":
                    strike_ref = "ATM"
                df = pd.read_sql_query(
                    "SELECT datetime, open, high, low, close, strike, spot FROM option_prices "
                    "WHERE expiry = ? AND strike_relative = ? AND option_type = ? "
                    "ORDER BY datetime",
                    db_conn,
                    params=(expiry, strike_ref, leg.option_type),
                    parse_dates=["datetime"]
                )
                if df.empty:
                    all_ok = False
                    break
                df = df.set_index("datetime")[
                    ["open", "high", "low", "close", "strike", "spot"]
                ].add_suffix(f"_{i}")
                leg_series.append(df)
                
            if not all_ok:
                cycles.append(ExpiryCycle(expiry, [], False, "missing CE or PE rows"))
                continue
                
            merged = leg_series[0]
            for ls in leg_series[1:]:
                merged = merged.join(ls, how="inner")
            merged = merged.sort_index()
            
            bars: List[MultiLegBar] = []
            for ts, row in merged.iterrows():
                spot = float(row[f"spot_0"])
                legs_bars = [
                    LegBar(
                        open_=float(row[f"open_{i}"]),
                        high=float(row[f"high_{i}"]),
                        low=float(row[f"low_{i}"]),
                        close=float(row[f"close_{i}"]),
                        strike=float(row[f"strike_{i}"]),
                    )
                    for i in range(len(leg_configs))
                ]
                bars.append(MultiLegBar(dt=ts.to_pydatetime(), spot=spot, legs=legs_bars))
                
            # Build strike_lookup for this cycle from SQLite
            strike_lookup = {}
            cursor.execute(
                "SELECT datetime, option_type, strike, open, high, low, close FROM option_prices "
                "WHERE expiry = ?",
                (expiry,)
            )
            for dt_str, opt, stk, o, h, l, c in cursor.fetchall():
                try:
                    dt_obj = datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S")
                except ValueError:
                    continue
                strike_lookup[(dt_obj, opt, float(stk))] = (float(o), float(h), float(l), float(c))
                
            is_complete = any(b.dt.date() == expiry_dt for b in bars)
            gap_reason = f"only {len(bars)} bars" if len(bars) < 10 else None
            cycles.append(ExpiryCycle(expiry, bars, is_complete, gap_reason, strike_lookup))
            
        return cycles

    # Otherwise fallback to CSV loading
    unique_folders = {
        (leg.strike if getattr(leg, "strike_type", "offset") == "offset" else "ATM")
        for leg in leg_configs
    }

    first_strike_ref = (
        leg_configs[0].strike
        if leg_configs and getattr(leg_configs[0], "strike_type", "offset") == "offset"
        else "ATM"
    )
    first_folder = os.path.join(DATA_ROOT, first_strike_ref)
    if not os.path.isdir(first_folder):
        return []

    csv_files = sorted(
        f for f in os.listdir(first_folder)
        if f.endswith(".csv") and len(f) == 14
    )

    all_offset_folders = []
    if os.path.exists(DATA_ROOT):
        all_offset_folders = sorted([
            d for d in os.listdir(DATA_ROOT)
            if os.path.isdir(os.path.join(DATA_ROOT, d)) and d.startswith("ATM")
        ])

    cycles: List[ExpiryCycle] = []

    for fname in csv_files:
        expiry = fname[:-4]
        try:
            expiry_dt = _parse_date(expiry)
        except ValueError:
            continue
        # Weekly contracts trade within 7-10 days of expiry; monthly contracts within ~35 days.
        # So we load cycles where start <= expiry_dt <= end + timedelta(days=40).
        if not (start <= expiry_dt <= end + timedelta(days=40)):
            continue

        folder_dfs: Dict[str, pd.DataFrame] = {}
        missing = False
        for sf in unique_folders:
            fpath = os.path.join(DATA_ROOT, sf, fname)
            if not os.path.exists(fpath):
                missing = True
                break
            try:
                df = pd.read_csv(fpath, parse_dates=["datetime"])
                folder_dfs[sf] = df
            except Exception:
                missing = True
                break

        if missing:
            cycles.append(ExpiryCycle(expiry, [], False, "missing data file"))
            continue

        # Load option price lookup data from all offset folders for this cycle
        strike_lookup = {}
        for sf in all_offset_folders:
            fpath = os.path.join(DATA_ROOT, sf, fname)
            if not os.path.exists(fpath):
                continue
            try:
                df_offset = pd.read_csv(
                    fpath,
                    usecols=["datetime", "option_type", "strike", "open", "high", "low", "close"],
                    parse_dates=["datetime"]
                )
                dts = df_offset["datetime"].dt.to_pydatetime()
                opts = df_offset["option_type"].values
                stks = df_offset["strike"].values
                opens = df_offset["open"].values
                highs = df_offset["high"].values
                lows = df_offset["low"].values
                closes = df_offset["close"].values
                for dt, opt, stk, o, h, l, c in zip(dts, opts, stks, opens, highs, lows, closes):
                    strike_lookup[(dt, opt, float(stk))] = (float(o), float(h), float(l), float(c))
            except Exception:
                continue

        leg_series: List[pd.DataFrame] = []
        all_ok = True
        for i, leg in enumerate(leg_configs):
            df = folder_dfs[leg.strike]
            leg_df = df[df["option_type"] == leg.option_type].copy()
            if leg_df.empty:
                all_ok = False
                break
            leg_df = leg_df.set_index("datetime")[
                ["open", "high", "low", "close", "strike", "spot"]
            ].add_suffix(f"_{i}")
            leg_series.append(leg_df)

        if not all_ok:
            cycles.append(ExpiryCycle(expiry, [], False, "missing CE or PE rows"))
            continue

        merged = leg_series[0]
        for ls in leg_series[1:]:
            merged = merged.join(ls, how="inner")
        merged = merged.sort_index()

        bars: List[MultiLegBar] = []
        for ts, row in merged.iterrows():
            spot = float(row[f"spot_0"])
            legs_bars = [
                LegBar(
                    open_=float(row[f"open_{i}"]),
                    high=float(row[f"high_{i}"]),
                    low=float(row[f"low_{i}"]),
                    close=float(row[f"close_{i}"]),
                    strike=float(row[f"strike_{i}"]),
                )
                for i in range(len(leg_configs))
            ]
            bars.append(MultiLegBar(dt=ts.to_pydatetime(), spot=spot, legs=legs_bars))

        is_complete = any(b.dt.date() == expiry_dt for b in bars)
        gap_reason = f"only {len(bars)} bars" if len(bars) < 10 else None
        cycles.append(ExpiryCycle(expiry, bars, is_complete, gap_reason, strike_lookup))

    return cycles


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

@dataclass
class LegState:
    entry_price: float = 0.0
    exit_price: float = 0.0
    exit_reason: str = ""
    struck_sl: bool = False
    struck_target: bool = False
    strike: float = 0.0

    @property
    def is_open(self) -> bool:
        return not self.struck_sl and not self.struck_target


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _bs_price(S: float, K: float, T: float, r: float, sigma: float, option_type: str) -> float:
    """Black-Scholes European option price."""
    if T <= 0 or S <= 0 or K <= 0:
        return max(S - K, 0.0) if option_type == 'CE' else max(K - S, 0.0)
    try:
        sqrt_T = math.sqrt(T)
        d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * sqrt_T)
        d2 = d1 - sigma * sqrt_T
        if option_type == 'CE':
            return S * _norm_cdf(d1) - K * math.exp(-r * T) * _norm_cdf(d2)
        else:
            return K * math.exp(-r * T) * _norm_cdf(-d2) - S * _norm_cdf(-d1)
    except (ValueError, ZeroDivisionError):
        return max(S - K, 0.0) if option_type == 'CE' else max(K - S, 0.0)


def _implied_vol(market_price: float, S: float, K: float, T: float,
                 r: float, option_type: str) -> float:
    """Bisection IV solver. Returns annualised volatility as a decimal."""
    if T <= 0 or market_price <= 0:
        return 0.15  # fallback
    lo, hi = 0.001, 10.0
    if _bs_price(S, K, T, r, hi, option_type) < market_price:
        return hi
    for _ in range(80):
        mid = (lo + hi) / 2.0
        price = _bs_price(S, K, T, r, mid, option_type)
        if abs(price - market_price) < 0.001:
            return mid
        if price > market_price:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2.0


def _price_at_strike(atm_close: float, atm_strike: float,
                     entry_strike: float, option_type: str,
                     spot: float, days_to_expiry: float,
                     r: float = 0.06) -> float:
    """
    Price the entry_strike option given the current ATM option's close.
    - No drift: return atm_close directly.
    - Drift present: back-calculate IV from the ATM price via Black-Scholes,
      then reprice the original entry strike with that IV.
      For 0DTE (days_to_expiry ≤ 0) use intrinsic only.
    """
    if atm_strike == entry_strike:
        return atm_close
    T = max(days_to_expiry, 0.0) / 365.0
    if T <= 0 or atm_close < 0.5:
        # Near expiry or negligible premium: intrinsic only
        return max(spot - entry_strike, 0.0) if option_type == 'CE' else max(entry_strike - spot, 0.0)
    iv = _implied_vol(atm_close, spot, atm_strike, T, r, option_type)
    return max(_bs_price(spot, entry_strike, T, r, iv, option_type), 0.0)


def _calculate_delta(spot: float, K: float, T: float, r: float, sigma: float, option_type: str) -> float:
    """Calculate option Delta (0 to 100) using Black-Scholes model."""
    if T <= 0 or sigma <= 0:
        if option_type == 'CE':
            return 100.0 if spot > K else 0.0
        else:
            return -100.0 if spot < K else 0.0
    try:
        sqrt_T = math.sqrt(T)
        d1 = (math.log(spot / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * sqrt_T)
        n_d1 = _norm_cdf(d1)
        if option_type == 'CE':
            return n_d1 * 100.0
        else:
            return (n_d1 - 1.0) * 100.0
    except Exception:
        return 50.0 if option_type == 'CE' else -50.0


def _get_leg_prices(
    dt: datetime,
    option_type: str,
    entry_strike: float,
    current_bar_leg: LegBar,
    spot: float,
    days_to_expiry: float,
    strike_lookup: Optional[Dict] = None,
) -> Tuple[float, float, float, float]:
    """
    Get (open, high, low, close) for the entry_strike option at datetime dt.
    First tries strike_lookup. If not found, falls back to Black-Scholes repricing.
    """
    if strike_lookup:
        prices = strike_lookup.get((dt, option_type, entry_strike))
        if prices is not None:
            return prices
    # Fallback to Black-Scholes repricing using current ATM price info
    o = _price_at_strike(current_bar_leg.open_, current_bar_leg.strike, entry_strike, option_type, spot, days_to_expiry)
    h = _price_at_strike(current_bar_leg.high, current_bar_leg.strike, entry_strike, option_type, spot, days_to_expiry)
    l = _price_at_strike(current_bar_leg.low, current_bar_leg.strike, entry_strike, option_type, spot, days_to_expiry)
    c = _price_at_strike(current_bar_leg.close, current_bar_leg.strike, entry_strike, option_type, spot, days_to_expiry)
    return (o, h, l, c)


def _simulate_one_day(
    day_bars: List[MultiLegBar],
    leg_configs: List[LegConfig],
    entry_time,
    eod_time,
    slip_sell_entry: float,
    slip_buy_entry: float,
    slip_sell_exit: float,
    slip_buy_exit: float,
    profit_target_pct: float,
    overall_sl_pct: float,
    days_to_expiry: float = 0.0,
    strike_lookup: Optional[Dict] = None,
) -> dict:
    """Simulate one intraday trade over day_bars. Returns state dict."""
    leg_states: List[LegState] = [LegState() for _ in leg_configs]
    entered = False
    entry_dt = None
    exit_dt = None
    exit_reason = "NO_ENTRY"
    entry_spot = 0.0

    def _resolve_strike(strike_str: str, atm_strike: float) -> float:
        if strike_str == "ATM":
            return atm_strike
        try:
            if "+" in strike_str:
                offset = int(strike_str.split("+")[1])
                return atm_strike + offset * 50.0
            elif "-" in strike_str:
                offset = int(strike_str.split("-")[1])
                return atm_strike - offset * 50.0
        except Exception:
            pass
        return atm_strike

    for idx, bar in enumerate(day_bars):
        t = bar.dt.time()
        prev_bar = day_bars[idx - 1] if idx > 0 else None

        # --- Entry ---
        # Use open_ price: AlgoTest enters at the first available price of the entry bar
        if not entered and t >= entry_time:
            entry_spot_ref = prev_bar.spot if prev_bar else bar.spot
            atm_strike = round(entry_spot_ref / 50.0) * 50.0
            ref_bar = prev_bar if prev_bar else bar
            
            # Fetch all available option prices for the entry time boundary
            available_strikes_and_prices = []
            if strike_lookup:
                for (dt_key, opt, stk), (o, h, l, c) in strike_lookup.items():
                    if dt_key == ref_bar.dt:
                        price = c if prev_bar else o
                        available_strikes_and_prices.append((opt, stk, price))
                        
            for i, (leg, state) in enumerate(zip(leg_configs, leg_states)):
                slip = slip_sell_entry if leg.position == "sell" else slip_buy_entry
                
                # Filter candidates for this option type
                leg_candidates = [
                    (stk, price) for (opt, stk, price) in available_strikes_and_prices
                    if opt == leg.option_type
                ]
                
                strike_type_val = getattr(leg, "strike_type", "offset")
                
                # 1. Closest Premium Strike Selection
                if strike_type_val == "closest_premium":
                    try:
                        target_premium = float(leg.strike)
                        leg_candidates.sort(key=lambda x: (abs(x[1] - target_premium), x[1]))
                        state.strike = leg_candidates[0][0] if leg_candidates else atm_strike
                    except Exception:
                        state.strike = atm_strike
                
                # 2. Closest Delta Strike Selection
                elif strike_type_val == "closest_delta":
                    try:
                        target_delta = float(leg.strike)
                        T = max(days_to_expiry, 0.0) / 365.0
                        r = 0.06
                        
                        # Calculate ATM IV for delta reference
                        atm_price = 0.0
                        for opt, stk, price in available_strikes_and_prices:
                            if opt == leg.option_type and stk == atm_strike:
                                atm_price = price
                                break
                        if atm_price == 0.0 and leg_candidates:
                            atm_price = leg_candidates[0][1]
                            
                        sigma = _implied_vol(atm_price, ref_bar.spot, atm_strike, T, r, leg.option_type)
                        
                        # Calculate delta for each candidate
                        delta_candidates = []
                        for stk, price in leg_candidates:
                            delta = _calculate_delta(ref_bar.spot, stk, T, r, sigma, leg.option_type)
                            delta_candidates.append((stk, abs(delta)))
                            
                        delta_candidates.sort(key=lambda x: (abs(x[1] - target_delta), x[1]))
                        state.strike = delta_candidates[0][0] if delta_candidates else atm_strike
                    except Exception:
                        state.strike = atm_strike
                        
                # 3. Standard ATM Offset Strike Selection
                else:
                    state.strike = _resolve_strike(leg.strike, atm_strike)
                
                # Fetch final entry price for resolved strike
                if prev_bar:
                    _, _, _, leg_close = _get_leg_prices(
                        prev_bar.dt, leg.option_type, state.strike, prev_bar.legs[i],
                        prev_bar.spot, days_to_expiry, strike_lookup
                    )
                    state.entry_price = leg_close * slip
                else:
                    leg_open, _, _, _ = _get_leg_prices(
                        bar.dt, leg.option_type, state.strike, bar.legs[i],
                        bar.spot, days_to_expiry, strike_lookup
                    )
                    state.entry_price = leg_open * slip
                    
            entered = True
            entry_dt = bar.dt
            entry_spot = bar.spot
            continue

        if not entered:
            continue

        # Get exact (open, high, low, close) for the entry strike of each leg
        leg_prices = [
            _get_leg_prices(
                bar.dt, leg.option_type, state.strike, bar.legs[i],
                bar.spot, days_to_expiry, strike_lookup
            )
            for i, (leg, state) in enumerate(zip(leg_configs, leg_states))
        ]

        # --- Per-leg SL and Target ---
        for i, (leg, state) in enumerate(zip(leg_configs, leg_states)):
            if not state.is_open:
                continue
            leg_open, leg_high, leg_low, leg_close = leg_prices[i]

            if leg.leg_sl_pct > 0:
                if leg.position == "sell" and leg_high >= state.entry_price * (1 + leg.leg_sl_pct / 100):
                    state.exit_price = state.entry_price * (1 + leg.leg_sl_pct / 100)
                    state.exit_reason = "LEG_SL"
                    state.struck_sl = True
                elif leg.position == "buy" and leg_low <= state.entry_price * (1 - leg.leg_sl_pct / 100):
                    state.exit_price = state.entry_price * (1 - leg.leg_sl_pct / 100)
                    state.exit_reason = "LEG_SL"
                    state.struck_sl = True
            if state.is_open and leg.leg_target_pct > 0:
                if leg.position == "sell" and leg_low <= state.entry_price * (1 - leg.leg_target_pct / 100):
                    state.exit_price = state.entry_price * (1 - leg.leg_target_pct / 100)
                    state.exit_reason = "LEG_TARGET"
                    state.struck_target = True
                elif leg.position == "buy" and leg_high >= state.entry_price * (1 + leg.leg_target_pct / 100):
                    state.exit_price = state.entry_price * (1 + leg.leg_target_pct / 100)
                    state.exit_reason = "LEG_TARGET"
                    state.struck_target = True

        if all(not s.is_open for s in leg_states):
            exit_reason = "ALL_LEGS_DONE"
            exit_dt = bar.dt
            break

        def _current_net() -> float:
            return sum(
                (s.exit_price if not s.is_open else leg_prices[i][3])
                * (1 if leg.position == "sell" else -1) * leg.lots
                for i, (leg, s) in enumerate(zip(leg_configs, leg_states))
            )

        net_credit_now = sum(
            s.entry_price * (1 if leg.position == "sell" else -1) * leg.lots
            for leg, s in zip(leg_configs, leg_states)
        )

        # --- Overall SL ---
        if overall_sl_pct > 0 and abs(net_credit_now) > 0:
            cur_net = _current_net()
            loss_pct = (cur_net - net_credit_now) / abs(net_credit_now) * 100
            if loss_pct >= overall_sl_pct:
                for i, (leg, state) in enumerate(zip(leg_configs, leg_states)):
                    if state.is_open:
                        slip = slip_sell_exit if leg.position == "sell" else slip_buy_exit
                        state.exit_price = leg_prices[i][3] * slip
                        state.exit_reason = "OVERALL_SL"
                exit_reason = "OVERALL_SL"
                exit_dt = bar.dt
                break

        # --- Overall Target ---
        if profit_target_pct > 0 and abs(net_credit_now) > 0:
            cur_net = _current_net()
            profit_pct = (net_credit_now - cur_net) / abs(net_credit_now) * 100
            if profit_pct >= profit_target_pct:
                for i, (leg, state) in enumerate(zip(leg_configs, leg_states)):
                    if state.is_open:
                        slip = slip_sell_exit if leg.position == "sell" else slip_buy_exit
                        state.exit_price = leg_prices[i][3] * slip
                        state.exit_reason = "TARGET"
                exit_reason = "TARGET"
                exit_dt = bar.dt
                break

        # --- EOD ---
        if t >= eod_time:
            for i, (leg, state) in enumerate(zip(leg_configs, leg_states)):
                if state.is_open:
                    slip = slip_sell_exit if leg.position == "sell" else slip_buy_exit
                    if prev_bar:
                        prev_leg_prices = _get_leg_prices(
                            prev_bar.dt, leg.option_type, state.strike, prev_bar.legs[i],
                            prev_bar.spot, days_to_expiry, strike_lookup
                        )
                        state.exit_price = prev_leg_prices[3] * slip
                    else:
                        state.exit_price = leg_prices[i][0] * slip
                    state.exit_reason = "EOD"
            exit_reason = "EOD"
            exit_dt = bar.dt
            break

    # Open at end of bars
    if entered and exit_dt is None and day_bars:
        last_bar = day_bars[-1]
        last_leg_prices = [
            _get_leg_prices(
                last_bar.dt, leg.option_type, state.strike, last_bar.legs[i],
                last_bar.spot, days_to_expiry, strike_lookup
            )
            for i, (leg, state) in enumerate(zip(leg_configs, leg_states))
        ]
        for i, (leg, state) in enumerate(zip(leg_configs, leg_states)):
            if state.is_open:
                slip = slip_sell_exit if leg.position == "sell" else slip_buy_exit
                state.exit_price = last_leg_prices[i][3] * slip
                state.exit_reason = "INCOMPLETE"
        exit_reason = "INCOMPLETE"
        exit_dt = last_bar.dt

    return {
        "entered": entered,
        "entry_dt": entry_dt,
        "exit_dt": exit_dt,
        "entry_spot": entry_spot,
        "exit_reason": exit_reason,
        "leg_states": leg_states,
    }


def run_backtest(leg_configs: List[LegConfig], cycles: List[ExpiryCycle],
                 lot_size: int, commission_per_lot: float, slippage_pct: float,
                 entry_time_str: str, eod_time_str: str, profit_target_pct: float,
                 overall_sl_pct: float,
                 vix_map: Dict[str, float],
                 strategy_type: str = "intraday",
                 start_date: str = "2021-01-01",
                 end_date: str = "2026-06-30"):
    """
    strategy_type:
      "intraday"   — one trade per trading day (AlgoTest Intraday mode)
      "expiry_day" — one trade per cycle, enter only on expiry date (0DTE)
      "first_day"  — one trade per cycle, enter on first day of cycle
    """
    start = _parse_date(start_date)
    end   = _parse_date(end_date)
    entry_time = datetime.strptime(entry_time_str, "%H:%M").time()
    eod_time   = datetime.strptime(eod_time_str,   "%H:%M").time()
    # Adverse slippage: sell at lower price, buy at higher price
    slip_sell_entry = 1 - slippage_pct / 100
    slip_buy_entry  = 1 + slippage_pct / 100
    slip_sell_exit  = 1 + slippage_pct / 100  # buying back a short = higher price
    slip_buy_exit   = 1 - slippage_pct / 100  # selling back a long = lower price

    sim_kwargs = dict(
        leg_configs=leg_configs,
        entry_time=entry_time,
        eod_time=eod_time,
        slip_sell_entry=slip_sell_entry,
        slip_buy_entry=slip_buy_entry,
        slip_sell_exit=slip_sell_exit,
        slip_buy_exit=slip_buy_exit,
        profit_target_pct=profit_target_pct,
        overall_sl_pct=overall_sl_pct,
    )

    trade_results = []
    equity_curve  = []
    cumulative_pnl = 0.0
    total_commission = 0.0
    peak_equity    = 0.0
    max_drawdown   = 0.0
    max_dd_start   = ""
    max_dd_end     = ""
    max_trades_in_dd = 0
    current_dd_trades = 0
    # Prevent trading the same calendar date twice (expiry day appears in two cycle files)
    seen_dates: set = set()

    for cycle in cycles:
        expiry_dt = _parse_date(cycle.expiry_date)

        if len(cycle.bars) < 5:
            trade_results.append(_no_entry_result(cycle.expiry_date, cycle.expiry_date, cumulative_pnl))
            equity_curve.append({"date": cycle.expiry_date, "cumulative_pnl": round(cumulative_pnl, 2)})
            continue

        # Group bars by calendar date
        day_groups: Dict[date, List[MultiLegBar]] = {}
        for bar in cycle.bars:
            d = bar.dt.date()
            day_groups.setdefault(d, []).append(bar)

        # Decide which dates to trade
        sorted_dates = sorted(day_groups.keys())
        if strategy_type == "expiry_day":
            trade_dates = [expiry_dt] if expiry_dt in day_groups else []
        elif strategy_type == "first_day":
            trade_dates = [sorted_dates[0]] if sorted_dates else []
        else:  # intraday — every day
            trade_dates = sorted_dates

        # Filter trade_dates to only include trading dates within start and end limits
        trade_dates = [d for d in trade_dates if start <= d <= end]

        any_traded_this_cycle = False

        for trade_date in trade_dates:
            if trade_date in seen_dates:
                continue
            seen_dates.add(trade_date)
            day_bars = day_groups.get(trade_date, [])
            if len(day_bars) < 3:
                continue

            # Calendar days to expiry from this trade date (used for BS repricing)
            dte = max(0, (expiry_dt - trade_date).days)
            sim = _simulate_one_day(
                day_bars, **sim_kwargs,
                days_to_expiry=float(dte),
                strike_lookup=cycle.strike_lookup
            )

            entry_date_str = trade_date.isoformat()
            vix = vix_map.get(entry_date_str)

            if not sim["entered"]:
                trade_results.append(_no_entry_result(cycle.expiry_date, entry_date_str, cumulative_pnl))
                day_spot = day_bars[0].spot if day_bars else 0.0
                dd = cumulative_pnl - peak_equity
                equity_curve.append({
                    "date": entry_date_str,
                    "cumulative_pnl": round(cumulative_pnl, 2),
                    "spot": round(day_spot, 2),
                    "drawdown": round(dd, 2)
                })
                continue

            any_traded_this_cycle = True
            entry_dt  = sim["entry_dt"]
            exit_dt   = sim["exit_dt"]
            leg_states = sim["leg_states"]
            exit_reason = sim["exit_reason"]

            total_lots = sum(leg.lots for leg in leg_configs)
            commission = commission_per_lot * total_lots * 2  # entry + exit
            total_commission += commission

            net_pnl = 0.0
            leg_results = []
            for leg, state in zip(leg_configs, leg_states):
                if leg.position == "sell":
                    leg_pnl = (state.entry_price - state.exit_price) * leg.lots * lot_size
                else:
                    leg_pnl = (state.exit_price - state.entry_price) * leg.lots * lot_size
                net_pnl += leg_pnl
                leg_results.append({
                    "option_type": leg.option_type,
                    "position": leg.position,
                    "strike": state.strike,
                    "entry_price": round(state.entry_price, 2),
                    "exit_price": round(state.exit_price, 2),
                    "pnl": round(leg_pnl, 2),
                    "exit_reason": state.exit_reason,
                })

            net_pnl -= commission
            cumulative_pnl += net_pnl
            peak_equity = max(peak_equity, cumulative_pnl)
            drawdown = peak_equity - cumulative_pnl
            if drawdown > max_drawdown:
                max_drawdown = drawdown
                max_dd_end = entry_date_str

            if drawdown > 0:
                current_dd_trades += 1
                max_trades_in_dd = max(max_trades_in_dd, current_dd_trades)
            else:
                current_dd_trades = 0

            net_credit = sum(
                s.entry_price * (1 if leg.position == "sell" else -1) * leg.lots
                for leg, s in zip(leg_configs, leg_states)
            )
            exit_combined = sum(
                s.exit_price * (1 if leg.position == "sell" else -1) * leg.lots
                for leg, s in zip(leg_configs, leg_states)
            )

            trade_results.append({
                "expiry_date":   cycle.expiry_date,
                "entry_dt":      entry_dt.isoformat() if entry_dt else None,
                "exit_dt":       exit_dt.isoformat() if exit_dt else None,
                "entry_spot":    round(sim["entry_spot"], 2),
                "vix":           round(vix, 2) if vix is not None else None,
                "net_credit":    round(net_credit, 2),
                "exit_combined": round(exit_combined, 2),
                "pnl":           round(net_pnl, 2),
                "exit_reason":   exit_reason,
                "is_complete":   cycle.is_complete,
                "legs":          leg_results,
            })
            dd = cumulative_pnl - peak_equity
            equity_curve.append({
                "date": entry_date_str,
                "cumulative_pnl": round(cumulative_pnl, 2),
                "spot": round(sim["entry_spot"], 2),
                "drawdown": round(dd, 2)
            })

        if not any_traded_this_cycle and not trade_dates:
            trade_results.append(_no_entry_result(cycle.expiry_date, cycle.expiry_date, cumulative_pnl))
            equity_curve.append({"date": cycle.expiry_date, "cumulative_pnl": round(cumulative_pnl, 2)})

    # --- Summary stats ---
    traded = [c for c in trade_results if c["exit_reason"] != "NO_ENTRY"]
    wins   = [c for c in traded if c["pnl"] > 0]
    losses = [c for c in traded if c["pnl"] <= 0]
    win_rate = len(wins) / len(traded) * 100 if traded else 0.0
    avg_win  = sum(c["pnl"] for c in wins)   / len(wins)   if wins   else 0.0
    avg_loss = abs(sum(c["pnl"] for c in losses) / len(losses)) if losses else 0.0

    max_win_streak, max_loss_streak = _compute_streaks(traded)
    return_maxdd_ratio = round(cumulative_pnl / max_drawdown, 2) if max_drawdown > 0 else None
    reward_risk_ratio  = round(avg_win / avg_loss, 2) if avg_loss > 0 else None
    expectancy = (avg_win * (win_rate / 100)) - (avg_loss * (1 - win_rate / 100))
    expectancy_ratio = round(expectancy / avg_loss, 2) if avg_loss > 0 else None

    max_dd_days = None
    if max_dd_start and max_dd_end:
        try:
            d1 = datetime.strptime(max_dd_start, "%Y-%m-%d")
            d2 = datetime.strptime(max_dd_end, "%Y-%m-%d")
            max_dd_days = (d2 - d1).days
        except Exception:
            pass

    monthly_pnl = _compute_monthly_pnl(trade_results)

    return {
        "summary": {
            "total_cycles":           len(trade_results),
            "traded_cycles":          len(traded),
            "wins":                   len(wins),
            "losses":                 len(losses),
            "win_rate":               round(win_rate, 1),
            "total_pnl":              round(cumulative_pnl, 2),
            "avg_pnl":                round(cumulative_pnl / len(traded), 2) if traded else 0.0,
            "max_win":                round(max((c["pnl"] for c in wins), default=0.0), 2),
            "max_loss":               round(min((c["pnl"] for c in losses), default=0.0), 2),
            "avg_win":                round(avg_win, 2),
            "avg_loss":               round(avg_loss, 2),
            "max_drawdown":           round(max_drawdown, 2),
            "max_drawdown_start":     max_dd_start,
            "max_drawdown_end":       max_dd_end,
            "max_drawdown_days":      max_dd_days,
            "max_trades_in_drawdown": max_trades_in_dd,
            "max_win_streak":         max_win_streak,
            "max_loss_streak":        max_loss_streak,
            "return_maxdd_ratio":     return_maxdd_ratio,
            "reward_risk_ratio":      reward_risk_ratio,
            "expectancy":             round(expectancy, 2),
            "expectancy_ratio":       expectancy_ratio,
            "commission_paid":        round(total_commission, 2),
        },
        "cycles":       trade_results,
        "equity_curve": equity_curve,
        "monthly_pnl":  monthly_pnl,
    }


def _no_entry_result(expiry_date: str, entry_date_str: str, cumulative_pnl: float) -> dict:
    return {
        "expiry_date":   expiry_date,
        "entry_dt":      None,
        "exit_dt":       None,
        "entry_spot":    None,
        "vix":           None,
        "net_credit":    None,
        "exit_combined": None,
        "pnl":           0.0,
        "exit_reason":   "NO_ENTRY",
        "is_complete":   False,
        "legs":          [],
    }


def _compute_streaks(traded: list) -> Tuple[int, int]:
    max_win = max_loss = cur_win = cur_loss = 0
    for c in traded:
        if c["pnl"] > 0:
            cur_win += 1; cur_loss = 0
        else:
            cur_loss += 1; cur_win = 0
        max_win  = max(max_win, cur_win)
        max_loss = max(max_loss, cur_loss)
    return max_win, max_loss


def _compute_monthly_pnl(trade_results: list) -> dict:
    data: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for c in trade_results:
        if not c["entry_dt"] or c["exit_reason"] == "NO_ENTRY":
            continue
        year  = c["entry_dt"][:4]
        month = int(c["entry_dt"][5:7])
        mon_name = MONTH_NAMES[month - 1]
        data[year][mon_name] += c["pnl"]
        data[year]["Total"]  += c["pnl"]
    return {yr: {k: round(v, 2) for k, v in months.items()} for yr, months in sorted(data.items())}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

DEFAULT_LEGS = [
    {"option_type": "CE", "position": "sell", "lots": 1, "strike": "ATM", "leg_sl_pct": 0, "leg_target_pct": 0},
    {"option_type": "PE", "position": "sell", "lots": 1, "strike": "ATM", "leg_sl_pct": 0, "leg_target_pct": 0},
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start-date",         default="2021-01-01")
    parser.add_argument("--end-date",           default="2026-06-30")
    parser.add_argument("--lot-size",           type=int,   default=65)
    parser.add_argument("--entry-time",         default="09:20")
    parser.add_argument("--eod-time",           default="15:15")
    parser.add_argument("--profit-target-pct",  type=float, default=50.0)
    parser.add_argument("--overall-sl-pct",     type=float, default=0.0)
    parser.add_argument("--commission-per-lot", type=float, default=40.0)
    parser.add_argument("--slippage-pct",       type=float, default=0.0)
    parser.add_argument("--strategy-type",      default="intraday",
                        choices=["intraday", "expiry_day", "first_day"])
    parser.add_argument("--legs",               default=json.dumps(DEFAULT_LEGS))
    parser.add_argument("--use-db",             action="store_true", help="Use SQLite database for option price lookups")
    args = parser.parse_args()

    try:
        legs_raw = json.loads(args.legs)
        leg_configs = [LegConfig(**l) for l in legs_raw]
    except Exception as e:
        sys.stdout.write(json.dumps({"error": f"Invalid --legs JSON: {e}"}))
        sys.exit(1)

    db_conn = None
    if args.use_db:
        import sqlite3
        db_path = os.path.join(PROJECT_ROOT, "Options Data", "nifty_options.db")
        if not os.path.exists(db_path):
            sys.stdout.write(json.dumps({"error": f"Database not found at {db_path}. Please run scripts/analysis/convert_options_to_sqlite.py first."}))
            sys.exit(1)
        db_conn = sqlite3.connect(db_path, check_same_thread=False)

    vix_map = _load_vix()
    cycles  = fetch_multi_leg_cycles(args.start_date, args.end_date, leg_configs, db_conn=db_conn)
    result  = run_backtest(
        leg_configs=leg_configs,
        cycles=cycles,
        lot_size=args.lot_size,
        commission_per_lot=args.commission_per_lot,
        slippage_pct=args.slippage_pct,
        entry_time_str=args.entry_time,
        eod_time_str=args.eod_time,
        profit_target_pct=args.profit_target_pct,
        overall_sl_pct=args.overall_sl_pct,
        vix_map=vix_map,
        strategy_type=args.strategy_type,
        start_date=args.start_date,
        end_date=args.end_date,
    )
    result["params"] = {
        "start_date":         args.start_date,
        "end_date":           args.end_date,
        "lot_size":           args.lot_size,
        "entry_time":         args.entry_time,
        "eod_time":           args.eod_time,
        "profit_target_pct":  args.profit_target_pct,
        "overall_sl_pct":     args.overall_sl_pct,
        "commission_per_lot": args.commission_per_lot,
        "slippage_pct":       args.slippage_pct,
        "strategy_type":      args.strategy_type,
        "legs":               legs_raw,
    }
    if db_conn:
        db_conn.close()
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
