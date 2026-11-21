"""
EMA & Supertrend Trend Following rules — shared by live execution,
comparative backtesting, and the historical replay simulator.

Core premise:
  Textbook multi-timeframe moving average ribbon trend-following combined with
  volatility-adaptive ATR trailing bands (Supertrend).
  Enters confirmed Stage 2 uptrends where short-term momentum aligns above medium
  and long-term trend, filtered by a bullish Supertrend to ensure volatility expansion.

Entry Rules (scanned DAILY on the signal day's close):
  * Trend Ribbon: Close > EMA 20 > EMA 50 > EMA 200
  * Volatility Filter: Supertrend (10, 3.0) is Green (st_dir == +1, Close > Supertrend line)
  * Volume Confirmation: Volume >= 80% of 20-day average volume
  * Relative Strength: Composite RS percentile >= 60 (market leader)
  * Market Regime: Benchmark (Nifty 50) > 200 SMA (preserves capital in bear markets)

Exit Rules:
  * Supertrend Reversal: Close < Supertrend line or Supertrend turns Red (st_dir == -1)
  * Trend Breakdown: Close < EMA 50
  * Disaster / Trailing Stop: Initial stop_pct (default 12.0%) below entry.
    Once position is up >= 15%, trails running peak by stop_pct (never loosens).
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple
import numpy as np
import pandas as pd
from lib.intraday_signals import supertrend

DEFAULT_STOP_PCT = 12.0
TRAIL_ARM_GAIN_PCT = 15.0
MIN_RS_PCT = 60.0


def add_tables(price_map: Dict[str, "object"], tables: Dict[str, dict]) -> None:
    """Add indicator lookups for EMA & Supertrend strategy.

    Everything is date -> value. Precomputes EMA 20, 50, 200 and Supertrend (10, 3.0).
    """
    for sym, df in price_map.items():
        if sym not in tables:
            continue
        close, d_list = df["close"], list(df["date"])
        t = tables[sym]

        # EMAs
        t["ema20"] = dict(zip(d_list, close.ewm(span=20, adjust=False).mean()))
        t["ema50"] = dict(zip(d_list, close.ewm(span=50, adjust=False).mean()))
        t["ema200"] = dict(zip(d_list, close.ewm(span=200, adjust=False).mean()))

        # Supertrend (10, 3.0)
        df_st = df.copy()
        df_st["High"] = df["high"]
        df_st["Low"] = df["low"]
        df_st["Close"] = df["close"]
        st = supertrend(df_st, period=10, multiplier=3.0)
        t["st_dir"] = dict(zip(d_list, st["st_dir"]))
        t["st_line"] = dict(zip(d_list, st["st_line"]))


def _missing(v) -> bool:
    return v is None or (isinstance(v, float) and np.isnan(v))


def entry_check(sym: str, tables: dict, d, rs_pct: Optional[Dict[str, float]] = None) -> Tuple[bool, str]:
    """(ok, reason). On rejection `reason` lists EVERY failed rule joined by ' · '."""
    t = tables.get(sym)
    if not t:
        return False, "no data"
    row = t["px"].get(d)
    if not row:
        return False, "no bar today"
    close = float(row.close)
    vol = float(row.volume) if row.volume and not np.isnan(row.volume) else 0.0
    vol20 = float(t["vol20"].get(d, 0.0) or 0.0)

    ema20 = t["ema20"].get(d)
    ema50 = t["ema50"].get(d)
    ema200 = t["ema200"].get(d)
    st_dir = t["st_dir"].get(d)
    st_line = t["st_line"].get(d)

    if any(_missing(v) for v in (ema20, ema50, ema200, st_dir, st_line)):
        return False, "insufficient history (<200d)"

    fails: List[str] = []

    # 1. EMA alignment: Close > EMA 20 > EMA 50 > EMA 200
    if not (close > ema20 > ema50 > ema200):
        fails.append("EMAs not stacked (Close > 20 > 50 > 200 EMA)")

    # 2. Supertrend is Green (st_dir == +1)
    if st_dir != 1 or close < st_line:
        fails.append("Supertrend is Red (Bearish)")

    # 3. Volume confirmation
    if vol20 > 0 and vol < vol20 * 0.8:
        fails.append("Volume < 80% of 20d avg")

    # 4. Relative strength percentile
    if rs_pct is not None:
        pct = rs_pct.get(sym, 0.0)
        if pct < MIN_RS_PCT:
            fails.append(f"RS percentile {pct:.1f} < {MIN_RS_PCT:.0f}")

    if fails:
        return False, " · ".join(fails)
    return True, "pass"


def exit_check(pos: "Position", close: float, tables: dict, d, stop_pct: float = DEFAULT_STOP_PCT) -> Optional[str]:
    """Exit check for EMA & Supertrend strategy."""
    # 1. Trailing or disaster stop (highest priority capital protection)
    hard_stop = pos.entry_price * (1.0 - stop_pct / 100.0)
    peak = getattr(pos, "peak_close", getattr(pos, "peak_price", pos.entry_price))
    peak = max(peak, close)
    if hasattr(pos, "peak_close"):
        try:
            pos.peak_close = peak
        except Exception:
            pass
    elif hasattr(pos, "peak_price"):
        try:
            pos.peak_price = peak
        except Exception:
            pass

    if peak >= pos.entry_price * (1.0 + TRAIL_ARM_GAIN_PCT / 100.0):
        trailing_stop = peak * (1.0 - stop_pct / 100.0)
        eff_stop = max(hard_stop, trailing_stop)
    else:
        eff_stop = hard_stop

    if hasattr(pos, "stop_price"):
        try:
            pos.stop_price = max(pos.stop_price, eff_stop)
        except Exception:
            pass

    if close < eff_stop:
        return "stop"

    t = tables.get(pos.symbol)
    if not t:
        return None

    st_dir = t["st_dir"].get(d)
    st_line = t["st_line"].get(d)
    ema50 = t["ema50"].get(d)

    # 2. Supertrend reversal
    if st_dir == -1 or (st_line is not None and close < st_line):
        return "Supertrend Bearish (Red)"

    # 3. Close below EMA 50
    if ema50 is not None and close < ema50:
        return "Close < EMA 50 (Trend Broken)"

    return None
