"""
Minervini Trend Template rules — the ONE implementation, shared by the live bot
(strategies/momentum_investing/nifty500_momentum.py --model minervini) and the historical replay
(scripts/analysis/simulate_momentum_replay.py). Do not copy these rules into either file: the replay
is only evidence for the live bot while both run this same code.

Entry (all must hold on the signal day's close):
  * Close > 50 SMA > 150 SMA > 200 SMA
  * 200 SMA higher than it was ~1 month (22 trading days) ago
  * Close >= 25% above the 52-week low, and within 20% of the 52-week high
  * Close >= the N-day closing high (the pivot; N = 20, or 10 for a tight VCP) and no more than
    5% above it (do not chase)
  * Volume >= its 20-day average
  * Composite relative-strength percentile >= 70 (top 30% of the universe)
Exit: close below the stop. Initial stop is cfg.stop_pct below entry; once the position is up 15% the
stop trails the 50 SMA (never loosens).

Validation (pre-2026-11-23 replay engine with fixed slots; Nifty 500, 10 slots, regime on, 12% stop): 2020-23 +192% PF 3.84; 2024-26 +36% PF 1.87.
Parameters were chosen looking at both windows, so treat the 2024-26 figure as lightly in-sample.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

import numpy as np

MIN_RS_PCT = 70.0        # relative-strength percentile floor (top 30%)
SMA200_RISE_BARS = 22    # 200 SMA must be above its value this many trading days ago
MAX_EXTENSION = 0.05     # reject entries more than 5% above the pivot
TRAIL_ARM_GAIN_PCT = 15.0


def pivot_lookback(breakout_days: int) -> int:
    """Pivot window: 10 (tight VCP) or 20 (standard base). Any other setting means 20."""
    return breakout_days if breakout_days in (10, 20) else 20


def add_tables(price_map: Dict[str, "object"], tables: Dict[str, dict]) -> None:
    """Add the indicator lookups Minervini needs to tables built by lib.momentum.build_tables.

    Everything is date -> value. Highs/lows use shift(1) so a bar is never part of its own pivot.
    """
    for sym, df in price_map.items():
        if sym not in tables:
            continue
        close, d_list = df["close"], list(df["date"])
        sma200 = close.rolling(200, min_periods=200).mean()
        t = tables[sym]
        t["sma50"] = dict(zip(d_list, close.rolling(50, min_periods=50).mean()))
        t["sma150"] = dict(zip(d_list, close.rolling(150, min_periods=150).mean()))
        t["sma200"] = dict(zip(d_list, sma200))
        t["sma200_prev"] = dict(zip(d_list, sma200.shift(SMA200_RISE_BARS)))
        t["high250"] = dict(zip(d_list, df["high"].rolling(250, min_periods=200).max().shift(1)))
        t["low250"] = dict(zip(d_list, df["low"].rolling(250, min_periods=200).min().shift(1)))
        t["high20"] = dict(zip(d_list, close.rolling(20, min_periods=20).max().shift(1)))
        t["high10"] = dict(zip(d_list, close.rolling(10, min_periods=10).max().shift(1)))


def rs_percentiles(ranking: List[Tuple[str, float]]) -> Dict[str, float]:
    """{symbol: RS percentile 0-100} from a strongest-first composite-RS ranking."""
    n = len(ranking)
    if n <= 1:
        return {s: 99.0 for s, _ in ranking}
    return {s: round(100.0 * (n - 1 - i) / (n - 1), 1) for i, (s, _) in enumerate(ranking)}


def _missing(v) -> bool:
    return v is None or (isinstance(v, float) and np.isnan(v))


def entry_check(sym: str, tables: dict, d, breakout_days: int,
                rs_pct: Optional[Dict[str, float]]) -> Tuple[bool, str]:
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

    lookback = pivot_lookback(breakout_days)
    sma50, sma150, sma200 = t["sma50"].get(d), t["sma150"].get(d), t["sma200"].get(d)
    sma200_prev = t["sma200_prev"].get(d)
    h250, l250 = t["high250"].get(d), t["low250"].get(d)
    pivot_h = t[f"high{lookback}"].get(d)
    if any(_missing(v) for v in (sma50, sma150, sma200, sma200_prev, h250, l250, pivot_h)):
        return False, "insufficient history (<250d)"

    fails: List[str] = []
    if not (close > sma50 > sma150 > sma200):
        fails.append("trend not stacked (Close > 50 > 150 > 200 SMA)")
    if not sma200 > sma200_prev:
        fails.append("200 SMA not rising")
    if close < l250 * 1.25:
        fails.append("<25% above 52w low")
    if close < h250 * 0.80:
        fails.append(">20% below 52w high")
    if close < pivot_h:
        fails.append(f"below {lookback}d pivot high")
    elif close > pivot_h * (1.0 + MAX_EXTENSION):
        fails.append(f"extended {100.0 * (close / pivot_h - 1.0):.0f}% above pivot "
                     f"(max {MAX_EXTENSION * 100:.0f}%)")
    if vol < vol20:
        fails.append("volume < 20d average")
    pct = (rs_pct or {}).get(sym)
    if pct is None or pct < MIN_RS_PCT:
        fails.append(f"RS rank <{MIN_RS_PCT:.0f} ({'n/a' if pct is None else f'{pct:.0f}'})")
    if fails:
        return False, " · ".join(fails)
    return True, "QUALIFIED"


def exit_check(pos, close: float, tables: dict, d, stage_trail: int) -> Optional[str]:
    """Advance the position's stop for today's close; return "stop" if it is breached.

    `pos` is a lib.momentum.Position. The stop only ever moves up.
    """
    pos.peak_close = max(pos.peak_close, close)
    pos.last_close = close
    gain_pct = (pos.peak_close / pos.entry_price - 1.0) * 100.0
    t = tables.get(pos.symbol)
    sma50 = t["sma50"].get(d) if t else None
    if (gain_pct >= TRAIL_ARM_GAIN_PCT or pos.stage == stage_trail) and sma50 and not np.isnan(sma50):
        pos.stop_price = max(pos.stop_price, float(sma50))
        pos.stage = stage_trail
    return "stop" if close < pos.stop_price else None
