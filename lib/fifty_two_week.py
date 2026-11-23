"""
George & Hwang (2004) 52-Week High Breakout rules — shared by live execution,
comparative backtesting, and the historical replay simulator.

Reference:
  George, T. J., & Hwang, C. Y. (2004). "The 52-Week High and Momentum Investing."
  The Journal of Finance, 59(5), 2145-2176.

Core premise:
  Traders anchor on the 52-week high as a psychological ceiling, creating an informational
  underreaction. Once the price breaks out to a genuine new 52-week high, price discovery
  accelerates.

Entry (scanned DAILY on the signal day's close):
  * Close >= 52-week high (rolling 250-day closing/high shifted by 1; today is never part of its own benchmark)
  * Close <= 52-week high * 1.05 (do not chase if extended >5% past the breakout point)
  * Trend alignment: Close > 50 SMA > 200 SMA (primary Stage 2 uptrend)
  * Volume >= 20-day average volume (liquidity/breakout confirmation)
  * Broad market regime: Benchmark (Nifty 50) > 200 SMA (avoids bear market bull-traps)

Exit:
  * Trailing stop: Exit if close falls below (peak_close * (1.0 - stop_pct / 100.0)).
    Default stop_pct is 12.0%.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple
import numpy as np

MAX_EXTENSION = 0.05     # reject entries extended >5% above 52W high
DEFAULT_STOP_PCT = 12.0  # default trailing stop from peak


def add_tables(price_map: Dict[str, "object"], tables: Dict[str, dict]) -> None:
    """Add indicator lookups for 52-Week High strategy.

    Everything is date -> value. Highs use shift(1) so a bar is never part of its own benchmark.
    """
    for sym, df in price_map.items():
        if sym not in tables:
            continue
        close, d_list = df["close"], list(df["date"])
        t = tables[sym]
        t["sma50"] = dict(zip(d_list, close.rolling(50, min_periods=50).mean()))
        t["sma200"] = dict(zip(d_list, close.rolling(200, min_periods=200).mean()))
        # 52-week high uses 250 trading days, shifted by 1
        t["high250"] = dict(zip(d_list, df["high"].rolling(250, min_periods=200).max().shift(1)))


def _missing(v) -> bool:
    return v is None or (isinstance(v, float) and np.isnan(v))


def entry_check(sym: str, tables: dict, d, strict_breakout: bool = True,
                max_proximity_pct: float = 5.0) -> Tuple[bool, str]:
    """(ok, reason). On rejection, `reason` lists EVERY failed rule joined by ' · '."""
    t = tables.get(sym)
    if not t:
        return False, "no data"
    row = t["px"].get(d)
    if not row:
        return False, "no bar today"
    close = float(row.close)
    vol = float(row.volume) if row.volume and not np.isnan(row.volume) else 0.0
    vol20 = float(t["vol20"].get(d, 0.0) or 0.0)

    sma50 = t["sma50"].get(d)
    sma200 = t["sma200"].get(d)
    h250 = t["high250"].get(d)
    if any(_missing(v) for v in (sma50, sma200, h250)):
        return False, "insufficient history (<250d)"

    fails: List[str] = []

    # Trend structure
    if not (close > sma50 > sma200):
        fails.append("Close not > 50 SMA > 200 SMA")

    # 52W High Breakout or Proximity gate
    if strict_breakout:
        if close < h250:
            fails.append(f"below 52w high (₹{close:.2f} < ₹{h250:.2f})")
        elif close > h250 * (1.0 + MAX_EXTENSION):
            fails.append(f"extended {100.0 * (close / h250 - 1.0):.1f}% above 52w high (max {MAX_EXTENSION*100:.0f}%)")
    else:
        # Proximity mode (within X% of 52W high)
        min_prox = 1.0 - (max_proximity_pct / 100.0)
        proximity = close / h250
        if proximity < min_prox:
            fails.append(f"proximity <{min_prox*100:.0f}% ({proximity*100:.1f}%)")

    # Volume confirmation
    if vol < vol20:
        fails.append("volume < 20d average")

    if fails:
        return False, " · ".join(fails)
    return True, "QUALIFIED"


def exit_check(pos, close: float, stop_pct: float = DEFAULT_STOP_PCT) -> Optional[str]:
    """Advance the position's stop for today's close; return "stop" if breached.

    Trailing stop trails peak close by stop_pct%. Never loosens.
    """
    pos.peak_close = max(pos.peak_close, close)
    pos.last_close = close
    pos.stop_price = max(pos.stop_price, pos.peak_close * (1.0 - stop_pct / 100.0))
    if hasattr(pos, "stage") and pos.peak_close > pos.entry_price:
        pos.stage = 2                       # lib.momentum.STAGE_TRAIL: the stop has started to trail
    return "stop" if close < pos.stop_price else None
