"""
Andreas Clenow "Stocks on the Move" (2015) Momentum Strategy — shared by
live execution, comparative backtesting, and the historical replay simulator.

Reference:
  Clenow, A. F. (2015). "Stocks on the Move: Beating the Market with Hedge Fund
  Momentum Strategies."

Core premise:
  Systematic trend following in equities using smooth, low-volatility exponential
  momentum rather than erratic price spikes. Ranks the universe by 90-day annualized
  exponential regression slope adjusted by goodness of fit (R²).

Entry Rules (evaluated on weekly review days):
  * Benchmark Index (Nifty 50) > 200 SMA (market regime filter; 100% cash defensive posture if below)
  * Trend Gate: Close > 100 SMA and Close > 200 SMA
  * 15% Gap Filter: No single-day absolute price move > 15% in the prior 90 trading days.
    Disqualifies takeover rumors, pump-and-dump spikes, and erratic binary events.
  * Score: Annualized exponential regression slope * R² must be > 0.
  * Ranking: Top scores are selected for portfolio entry.

Exit Rules:
  * Trend Exit: Close < 100 SMA (evaluated on daily close)
  * Rank Rotation: At weekly review, if a held position drops below the top momentum
    percentile (default: drops out of the top 20% / top 100 of the universe), it is
    rotated out for a higher-ranked leader.
  * Optional Safety Stop: user-configured stop_pct (default: 15% disaster stop).
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple
import numpy as np

MAX_SINGLE_DAY_GAP = 0.15   # 15% max 1-day absolute return in 90 days
MOMENTUM_WINDOW = 90        # 90 trading days for regression slope
ROTATION_PERCENTILE = 80.0  # Must stay in top 20% (percentile >= 80) to avoid rotation
DEFAULT_STOP_PCT = 15.0     # tail-risk stop (Clenow relies primarily on 100 SMA & rank exit)


def add_tables(price_map: Dict[str, "object"], tables: Dict[str, dict]) -> None:
    """Add indicator lookups for Clenow Momentum strategy.

    Fast vectorized precomputation for 100 SMA, 200 SMA, 90d max absolute daily gap,
    and 90d log-linear annualized slope * R².
    """
    dx = np.arange(MOMENTUM_WINDOW) - (MOMENTUM_WINDOW - 1) / 2.0
    sxx = float(np.dot(dx, dx))  # 60742.5 for window 90

    for sym, df in price_map.items():
        if sym not in tables:
            continue
        c_ser = df["close"]
        d_list = list(df["date"])
        t = tables[sym]

        # Moving averages
        t["sma100"] = dict(zip(d_list, c_ser.rolling(100, min_periods=100).mean()))
        t["sma200"] = dict(zip(d_list, c_ser.rolling(200, min_periods=200).mean()))

        # 15% 1-day gap filter: max |Close_t / Close_{t-1} - 1| over past 90 days
        daily_ret = c_ser.pct_change().abs()
        max_gap_90 = daily_ret.rolling(MOMENTUM_WINDOW, min_periods=MOMENTUM_WINDOW).max()
        t["max_gap_90"] = dict(zip(d_list, max_gap_90))

        # Vectorized 90-day annualized exponential slope * R²
        c_arr = c_ser.values
        n_len = len(c_arr)
        clen_vals = np.zeros(n_len)
        for b_i in range(MOMENTUM_WINDOW, n_len):
            sub_y = c_arr[b_i - MOMENTUM_WINDOW:b_i]
            if np.all(sub_y > 0):
                y = np.log(sub_y)
                sxy = float(np.dot(dx, y))
                slope = sxy / sxx
                dy = y - np.mean(y)
                syy = float(np.dot(dy, dy))
                r2 = (sxy * sxy) / (sxx * syy) if syy > 0 else 0.0
                # Annualize 250 trading days
                ann_slope = (math.exp(slope * 250.0) - 1.0) * 100.0
                clen_vals[b_i] = ann_slope * r2

        t["clenow"] = dict(zip(d_list, clen_vals))


def _missing(v) -> bool:
    return v is None or (isinstance(v, float) and np.isnan(v))


def entry_check(sym: str, tables: dict, d) -> Tuple[bool, str]:
    """(ok, reason). On rejection, `reason` lists EVERY failed rule joined by ' · '."""
    t = tables.get(sym)
    if not t:
        return False, "no data"
    row = t["px"].get(d)
    if not row:
        return False, "no bar today"
    close = float(row.close)

    score = t["clenow"].get(d, 0.0)
    sma100 = t["sma100"].get(d)
    sma200 = t["sma200"].get(d)
    max_gap = t["max_gap_90"].get(d)

    if any(_missing(v) for v in (sma100, sma200, max_gap)):
        return False, "insufficient history (<200d)"

    fails: List[str] = []

    # Trend gate
    if not (close > sma100 and close > sma200):
        fails.append("Close not > 100 SMA and > 200 SMA")

    # Gap filter
    if max_gap > MAX_SINGLE_DAY_GAP:
        fails.append(f"gap filter breached (max 1d move {max_gap * 100.0:.1f}% > {MAX_SINGLE_DAY_GAP * 100.0:.0f}%)")

    # Momentum score
    if score <= 0:
        fails.append(f"non-positive momentum score ({score:.2f})")

    if fails:
        return False, " · ".join(fails)
    return True, "QUALIFIED"


def exit_check(pos, close: float, tables: dict, d, stop_pct: float = DEFAULT_STOP_PCT) -> Optional[str]:
    """Clenow exit logic:

    1. Trend Exit: Close falls below 100-day SMA -> "sma100_exit"
    2. Disaster Stop: Close falls below entry by stop_pct% -> "stop"
    """
    pos.peak_close = max(pos.peak_close, close)
    pos.last_close = close

    t = tables.get(pos.symbol)
    sma100 = t["sma100"].get(d) if t else None

    # Primary exit: 100 SMA break
    if sma100 and not np.isnan(sma100) and close < float(sma100):
        return "sma100_exit"

    # Tail-risk stop
    pos.stop_price = pos.entry_price * (1.0 - stop_pct / 100.0)
    if close < pos.stop_price:
        return "stop"

    return None


def rank_rotation_exits(portfolio: dict, ranking: List[Tuple[str, float]],
                        min_percentile: float = ROTATION_PERCENTILE) -> List[Tuple[str, str]]:
    """Identify holdings that have fallen out of the top momentum percentile.

    `ranking` is a list of (symbol, score) sorted descending by score.
    Returns [(symbol, 'rotation')] for positions that drop below `min_percentile`.
    """
    n = len(ranking)
    if n <= 1:
        return []

    # Map symbol to percentile (100 = highest rank, 0 = lowest)
    pct_map = {s: 100.0 * (n - 1 - i) / (n - 1) for i, (s, _) in enumerate(ranking)}

    exits = []
    for sym in portfolio:
        pct = pct_map.get(sym, 0.0)
        if pct < min_percentile:
            exits.append((sym, f"rotation (rank dropped to {pct:.1f}pct)"))
    return exits
