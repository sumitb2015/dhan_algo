"""
Cyber Scalper Data Feed: 9 & 20 EMA + VWAP Real-Time Bias & Options Engine.

Fetches intraday minute candles from Dhan, resamples to target timeframe (1m, 3m, 5m),
computes EMA 9, EMA 20, EMA difference (spread), session VWAP, calculates multi-tier
bullish/bearish bias scores, resolves nearest ATM option contracts, and fetches live LTPs.

Prints a single JSON line to stdout; logs to stderr.

Usage:
    python cyber_scalper_feed.py --symbol NIFTY --interval 1
    python cyber_scalper_feed.py --symbol BANKNIFTY --interval 3 --expiry 2026-09-15
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, date, time as dtime
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

IST = ZoneInfo("Asia/Kolkata")

# Underlyings and default option strike intervals
UNDERLYINGS_INFO = {
    "NIFTY": {"strike_step": 50, "default_exchange": "NSE", "fno_exchange": "NSE_FNO", "inst_type": "INDEX", "fno_inst": "OPTIDX"},
    "BANKNIFTY": {"strike_step": 100, "default_exchange": "NSE", "fno_exchange": "NSE_FNO", "inst_type": "INDEX", "fno_inst": "OPTIDX"},
    "FINNIFTY": {"strike_step": 50, "default_exchange": "NSE", "fno_exchange": "NSE_FNO", "inst_type": "INDEX", "fno_inst": "OPTIDX"},
    "SENSEX": {"strike_step": 100, "default_exchange": "BSE", "fno_exchange": "BSE_FNO", "inst_type": "INDEX", "fno_inst": "OPTIDX"},
    "CRUDEOIL": {"strike_step": 50, "default_exchange": "MCX", "fno_exchange": "MCX_COMM", "inst_type": "FUTCOM", "fno_inst": "OPTFUT"},
    "CRUDEOILM": {"strike_step": 50, "default_exchange": "MCX", "fno_exchange": "MCX_COMM", "inst_type": "FUTCOM", "fno_inst": "OPTFUT"},
}

def clean_float(val: any, default: float = 0.0) -> float:
    if val is None:
        return default
    try:
        f = float(val)
        return default if (math.isnan(f) or math.isinf(f)) else round(f, 2)
    except (TypeError, ValueError):
        return default


def resolve_symbol(helper: DhanHelper, symbol: str) -> tuple[int, str, str, str]:
    """
    Returns (security_id, exchange_segment, instrument_type, symbol_type)
    """
    sym = symbol.upper()
    if sym in UNDERLYINGS_INFO:
        info = UNDERLYINGS_INFO[sym]
        if sym == "SENSEX":
            sec = helper.find_index("SENSEX", exchange="BSE")
            if not sec:
                raise ValueError("Could not resolve SENSEX index")
            return int(sec["SECURITY_ID"]), "IDX_I", "INDEX", "index"
        elif sym in ("CRUDEOIL", "CRUDEOILM"):
            sec = helper.find_future(sym, exchange="MCX", instrument="FUTCOM")
            if not sec:
                raise ValueError(f"Could not resolve active futures for {sym}")
            return int(sec["SECURITY_ID"]), "MCX_COMM", "FUTCOM", "commodity"
        else:
            sec = helper.find_index(sym, exchange="IDX_I")
            if not sec:
                raise ValueError(f"Could not resolve index for {sym}")
            return int(sec["SECURITY_ID"]), "IDX_I", "INDEX", "index"
    else:
        # Check equity
        sec = helper.find_equity(sym)
        if sec:
            return int(sec["SECURITY_ID"]), "NSE_EQ", "EQUITY", "equity"
        raise ValueError(f"Unknown symbol: {symbol}")


def compute_vwap(df: pd.DataFrame) -> pd.Series:
    """
    Computes session anchored VWAP using High, Low, Close, Volume.
    If volume is 0 or all zeros, falls back to expanding mean of typical price.
    """
    tp = (df["high"] + df["low"] + df["close"]) / 3.0
    vol = df["volume"]
    cum_vol = vol.cumsum()
    cum_pv = (tp * vol).cumsum()

    if (cum_vol > 0).any():
        vwap = np.where(cum_vol > 0, cum_pv / np.maximum(cum_vol, 1e-9), tp.expanding().mean())
        return pd.Series(vwap, index=df.index)
    return tp.expanding().mean()


def evaluate_bias(
    close: float,
    ema9: float,
    ema20: float,
    vwap: float,
    spread_curr: float,
    spread_prev: float,
) -> dict:
    """
    Evaluates 9 & 20 EMA + VWAP trend bias, velocity, and power score.
    """
    price_vs_vwap = close - vwap
    price_vs_vwap_pct = (price_vs_vwap / vwap * 100) if vwap > 0 else 0.0

    spread_diff = spread_curr - spread_prev

    # Momentum status
    if spread_curr > 0:
        spread_status = "EXPANDING_BULLISH" if spread_diff > 0 else "CONTRACTING_BULLISH"
    elif spread_curr < 0:
        spread_status = "EXPANDING_BEARISH" if spread_diff < 0 else "CONTRACTING_BEARISH"
    else:
        spread_status = "NEUTRAL"

    # Core logic
    # 1. Strong Bullish: Price > VWAP and EMA9 > EMA20
    # 2. Bullish Pullback: Price > VWAP but EMA9 is cooling towards EMA20
    # 3. Strong Bearish: Price < VWAP and EMA9 < EMA20
    # 4. Bearish Pullback: Price < VWAP but EMA9 is bouncing towards EMA20
    # 5. Neutral / Conflicted: EMA trend contradicts VWAP

    is_above_vwap = price_vs_vwap > 0
    is_ema_bullish = spread_curr > 0

    if is_above_vwap and is_ema_bullish:
        if spread_diff >= -0.05:
            bias = "STRONG_BULLISH"
            bias_label = "Strong Bullish Momentum"
            recommendation = "FAVOR ATM CALL / LONG SCALPS"
            bull_power = min(100, 65 + min(35, abs(spread_curr) * 2))
            bear_power = max(0, 100 - bull_power)
        else:
            bias = "BULLISH_PULLBACK"
            bias_label = "Bullish Dip / Pullback"
            recommendation = "WAIT FOR SUPPORT BOUNCE / DIP BUY"
            bull_power = 60
            bear_power = 40
    elif not is_above_vwap and not is_ema_bullish:
        if spread_diff <= 0.05:
            bias = "STRONG_BEARISH"
            bias_label = "Strong Bearish Momentum"
            recommendation = "FAVOR ATM PUT / SHORT SCALPS"
            bear_power = min(100, 65 + min(35, abs(spread_curr) * 2))
            bull_power = max(0, 100 - bear_power)
        else:
            bias = "BEARISH_PULLBACK"
            bias_label = "Bearish Rip / Pullback"
            recommendation = "WAIT FOR RESISTANCE FADE / SHORT RIP"
            bear_power = 60
            bull_power = 40
    elif is_above_vwap and not is_ema_bullish:
        bias = "NEUTRAL"
        bias_label = "Conflict: Above VWAP / EMA Bearish"
        recommendation = "CHOPPY ZONE - WAIT FOR CLEAR CROSSOVER"
        bull_power = 50
        bear_power = 50
    else:
        bias = "NEUTRAL"
        bias_label = "Conflict: Below VWAP / EMA Bullish"
        recommendation = "COUNTER-TREND - CAUTION ON LONGS"
        bull_power = 50
        bear_power = 50

    return {
        "bias": bias,
        "bias_label": bias_label,
        "recommendation": recommendation,
        "price_vs_vwap": clean_float(price_vs_vwap),
        "price_vs_vwap_pct": clean_float(price_vs_vwap_pct),
        "spread_status": spread_status,
        "spread_diff": clean_float(spread_diff),
        "bull_power": int(round(bull_power)),
        "bear_power": int(round(bear_power)),
    }


def find_atm_options(
    helper: DhanHelper,
    underlying: str,
    spot_price: float,
    chosen_expiry: str | None = None,
) -> dict:
    """
    Finds nearest ATM strike, security IDs, and latest quotes for CE and PE.
    """
    sym = underlying.upper()
    info = UNDERLYINGS_INFO.get(sym)
    if not info:
        return {}

    step = info["strike_step"]
    atm_strike = round(spot_price / step) * step

    # Get expiries
    expiries = helper.get_expiries(sym)
    if not expiries:
        return {"atm_strike": atm_strike, "expiries": []}

    expiry = chosen_expiry if (chosen_expiry and chosen_expiry in expiries) else expiries[0]

    # Resolve lot size
    lot_size = helper.get_lot_size(sym)

    # Master list lookup for ATM CE and PE
    df_m = helper._load_master_list()
    exch = info["default_exchange"]
    fno_exch = info["fno_exchange"]
    fno_inst = info["fno_inst"]

    mask = (
        (df_m["UNDERLYING_SYMBOL"] == sym)
        & (df_m["SM_EXPIRY_DATE"] == expiry)
        & (df_m["STRIKE_PRICE"] == atm_strike)
    )
    rows = df_m[mask]

    ce_id = None
    pe_id = None
    ce_sym = None
    pe_sym = None
    ce_display = None
    pe_display = None

    for _, r in rows.iterrows():
        opt_type = str(r.get("OPTION_TYPE", "")).upper()
        sid = str(r.get("SECURITY_ID", ""))
        tsym = str(r.get("SYMBOL_NAME", ""))
        dname = str(r.get("DISPLAY_NAME", tsym))
        if opt_type == "CE":
            ce_id = sid
            ce_sym = tsym
            ce_display = dname
        elif opt_type == "PE":
            pe_id = sid
            pe_sym = tsym
            pe_display = dname

    # Get LTPs
    ce_ltp = 0.0
    pe_ltp = 0.0
    if ce_id:
        try:
            ce_ltp = clean_float(helper.get_ltp(ce_id, exchange=fno_exch, instrument=fno_inst))
        except Exception:
            pass

    if pe_id:
        try:
            pe_ltp = clean_float(helper.get_ltp(pe_id, exchange=fno_exch, instrument=fno_inst))
        except Exception:
            pass

    return {
        "atm_strike": atm_strike,
        "expiry": expiry,
        "all_expiries": expiries[:6],
        "lot_size": lot_size,
        "ce": {
            "strike": atm_strike,
            "security_id": ce_id,
            "trading_symbol": ce_sym,
            "display_name": ce_display,
            "ltp": ce_ltp,
        },
        "pe": {
            "strike": atm_strike,
            "security_id": pe_id,
            "trading_symbol": pe_sym,
            "display_name": pe_display,
            "ltp": pe_ltp,
        },
    }


def find_future_contract(helper: DhanHelper, underlying: str, spot_price: float) -> dict | None:
    """
    Resolves the nearest-expiry future contract for a commodity underlying (CRUDEOIL /
    CRUDEOILM). Unlike find_atm_options, there is no strike to pick -- the future IS the
    tradeable instrument, and its own candle series (already fetched for the chart) is
    its live price, so no extra get_ltp() call is needed here.
    """
    sym = underlying.upper()
    row = helper.find_future(sym, exchange="MCX", instrument="FUTCOM")
    if not row:
        return None
    return {
        "security_id": str(row.get("SECURITY_ID", "")),
        "trading_symbol": str(row.get("SYMBOL_NAME", "")),
        "display_name": str(row.get("DISPLAY_NAME", row.get("SYMBOL_NAME", ""))),
        "expiry": str(row.get("SM_EXPIRY_DATE", "")),
        # Same convention as find_atm_options' lot_size: Dhan's MCX order quantity is
        # itself denominated in lots (get_lot_size returns 1), not barrels-per-lot --
        # the frontend applies MCX_LOT_MULTIPLIER separately for notional display.
        "lot_size": helper.get_lot_size(sym),
        "ltp": clean_float(spot_price),
    }


def main():
    parser = argparse.ArgumentParser(description="Cyber Scalper 9/20 EMA & VWAP Data Feed")
    parser.add_argument("--symbol", default="NIFTY", help="Symbol (NIFTY, BANKNIFTY, SENSEX, CRUDEOIL, etc.)")
    parser.add_argument("--interval", default="1", choices=["1", "3", "5"], help="Candle timeframe in minutes")
    parser.add_argument("--expiry", default=None, help="Target options expiry date YYYY-MM-DD")
    args = parser.parse_args()

    symbol = args.symbol.upper()
    interval_str = args.interval

    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({"error": "Auth failed — run login.py to refresh access token"}))
        sys.exit(0)

    helper = DhanHelper(dhan, skip_session_validation=True, master_list_cache=True)

    try:
        sec_id, exch_seg, inst_type, sym_type = resolve_symbol(helper, symbol)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(0)

    # Today's date in IST
    now_ist = datetime.now(IST)
    today_str = now_ist.strftime("%Y-%m-%d")

    # Fetch 1-min raw data for today
    df_raw = helper.get_intraday_minute_data(sec_id, exch_seg, inst_type, "1", today_str, today_str)

    # Fallback to lookback if today has no rows (e.g. weekend or early morning before open)
    if df_raw is None or df_raw.empty or len(df_raw) < 5:
        from_date_str = (now_ist - pd.Timedelta(days=5)).strftime("%Y-%m-%d")
        df_raw = helper.get_intraday_minute_data(sec_id, exch_seg, inst_type, "1", from_date_str, today_str)

    if df_raw is None or df_raw.empty:
        print(json.dumps({"error": f"No intraday candle data returned for {symbol}"}))
        sys.exit(0)

    # Parse timestamps
    if "timestamp" in df_raw.columns:
        df_raw["time"] = pd.to_datetime(df_raw["timestamp"], unit="s", utc=True).dt.tz_convert(IST)
    elif "date" in df_raw.columns:
        df_raw["time"] = pd.to_datetime(df_raw["date"]).dt.tz_localize(IST)
    else:
        df_raw["time"] = pd.to_datetime(df_raw.index).dt.tz_localize(IST)

    df_raw = df_raw.sort_values("time").reset_index(drop=True)

    # Keep only today's session if multiple days returned
    latest_date = df_raw["time"].dt.date.max()
    df_today = df_raw[df_raw["time"].dt.date == latest_date].copy().reset_index(drop=True)
    if df_today.empty:
        df_today = df_raw.tail(200).copy().reset_index(drop=True)

    # Compute VWAP on 1-min today session
    df_today["vwap_1m"] = compute_vwap(df_today)

    # Resample if interval > 1
    if interval_str == "1":
        df_bars = df_today.copy()
        df_bars["vwap"] = df_bars["vwap_1m"]
    else:
        resample_rule = f"{interval_str}min"
        df_resampled = (
            df_today.set_index("time")
            .resample(resample_rule, origin="start", label="left", closed="left")
            .agg({
                "open": "first",
                "high": "max",
                "low": "min",
                "close": "last",
                "volume": "sum",
                "vwap_1m": "last",
            })
            .dropna(subset=["close"])
            .reset_index()
        )
        df_bars = df_resampled.rename(columns={"vwap_1m": "vwap"})

    # Compute 9 EMA and 20 EMA on the selected interval close
    df_bars["ema9"] = df_bars["close"].ewm(span=9, adjust=False).mean()
    df_bars["ema20"] = df_bars["close"].ewm(span=20, adjust=False).mean()
    df_bars["spread"] = df_bars["ema9"] - df_bars["ema20"]
    df_bars["spread_pct"] = (df_bars["spread"] / df_bars["ema20"]) * 100.0

    # Ensure VWAP exists
    if "vwap" not in df_bars.columns or df_bars["vwap"].isna().all():
        df_bars["vwap"] = compute_vwap(df_bars)

    # Format candles list (latest 120 bars for snappy rendering)
    bars_to_send = df_bars.tail(120).copy()

    candles = []
    ema9_series = []
    ema20_series = []
    vwap_series = []
    spread_series = []

    for _, row in bars_to_send.iterrows():
        t_str = row["time"].strftime("%H:%M")
        c_open = clean_float(row["open"])
        c_high = clean_float(row["high"])
        c_low = clean_float(row["low"])
        c_close = clean_float(row["close"])
        c_vol = clean_float(row["volume"])
        c_ema9 = clean_float(row["ema9"])
        c_ema20 = clean_float(row["ema20"])
        c_vwap = clean_float(row["vwap"])
        c_spread = clean_float(row["spread"])
        c_spread_pct = clean_float(row["spread_pct"])

        candles.append({
            "time": t_str,
            "timestamp": int(row["time"].timestamp()),
            "open": c_open,
            "high": c_high,
            "low": c_low,
            "close": c_close,
            "volume": c_vol,
        })
        ema9_series.append({"time": t_str, "value": c_ema9})
        ema20_series.append({"time": t_str, "value": c_ema20})
        vwap_series.append({"time": t_str, "value": c_vwap})
        spread_series.append({
            "time": t_str,
            "value": c_spread,
            "pct": c_spread_pct,
            "positive": c_spread >= 0,
        })

    # Latest live snapshot
    last_row = df_bars.iloc[-1]
    prev_row = df_bars.iloc[-2] if len(df_bars) > 1 else last_row

    latest_close = clean_float(last_row["close"])
    latest_ema9 = clean_float(last_row["ema9"])
    latest_ema20 = clean_float(last_row["ema20"])
    latest_vwap = clean_float(last_row["vwap"])
    latest_spread = clean_float(last_row["spread"])
    latest_spread_pct = clean_float(last_row["spread_pct"])
    prev_spread = clean_float(prev_row["spread"])

    first_bar_open = clean_float(df_bars.iloc[0]["open"])
    change = clean_float(latest_close - first_bar_open)
    change_pct = clean_float((change / first_bar_open * 100) if first_bar_open > 0 else 0.0)

    # Bias analysis
    bias_data = evaluate_bias(
        close=latest_close,
        ema9=latest_ema9,
        ema20=latest_ema20,
        vwap=latest_vwap,
        spread_curr=latest_spread,
        spread_prev=prev_spread,
    )

    # Resolve ATM options
    options_info = {}
    if symbol in UNDERLYINGS_INFO:
        try:
            options_info = find_atm_options(
                helper=helper,
                underlying=symbol,
                spot_price=latest_close,
                chosen_expiry=args.expiry,
            )
        except Exception as e:
            sys.stderr.write(f"Options resolution failed: {e}\n")

    # Resolve the future contract itself -- commodity underlyings only (CRUDEOIL /
    # CRUDEOILM). Lets the frontend offer a Futures/Options trade-mode toggle instead of
    # always routing orders through the ATM option leg.
    future_info = None
    if sym_type == "commodity":
        try:
            future_info = find_future_contract(helper, symbol, latest_close)
        except Exception as e:
            sys.stderr.write(f"Future contract resolution failed: {e}\n")

    response = {
        "success": True,
        "dataDate": str(latest_date),
        "symbol": symbol,
        "interval": interval_str,
        "timestamp": int(now_ist.timestamp()),
        "timeStr": now_ist.strftime("%H:%M:%S"),
        "spot": latest_close,
        "change": change,
        "changePct": change_pct,
        "live": {
            "close": latest_close,
            "ema9": latest_ema9,
            "ema20": latest_ema20,
            "vwap": latest_vwap,
            "spread": latest_spread,
            "spread_pct": latest_spread_pct,
            "prev_spread": prev_spread,
            **bias_data,
        },
        "candles": candles,
        "series": {
            "ema9": ema9_series,
            "ema20": ema20_series,
            "vwap": vwap_series,
            "spread": spread_series,
        },
        "options": options_info,
        "future": future_info,
    }

    print(json.dumps(response, allow_nan=False))


if __name__ == "__main__":
    main()
