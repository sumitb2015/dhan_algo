"""
Weinstein Stage 2 breakout — rules-based version, shared by the historical replay (and any live bot that adopts it).

Source of the rule set: "The Long & The Short" Ep. 56 (Sandeep Rao), a Nifty 500 weekly backtest Oct 2013 - Sep 2026 with
historical index membership. Their result: 2,111 trades, 53% win rate, +70.7% avg win / -17.5% avg loss, median trade
only +3.1%, best 10% of trades = 79% of gains, and it did NOT beat buy and hold. Losses ran to -50..-63% because the
only exit is a moving-average cross, not a fixed stop. This module therefore adds an OPTIONAL hard stop (HARD_STOP).

Everything is evaluated on the WEEKLY close (last trading day of each ISO week) and filled by the replay at the next open.

Entry - all six must hold on the weekly close:
  1. In the previous 52 weeks the 30-week MA was falling at least once (MA below its value 4 weeks earlier): a prior downtrend.
  2. In the previous 26 weeks the stock closed below its 30-week MA at least once: it built a base.
  3. Weekly close above the highest weekly high of the previous 26 weeks: the breakout.
  4. Weekly close above the 30-week MA, and that MA is not falling (>= its value 4 weeks earlier).
  5. Breakout-week volume >= 2x the average of the previous 4 weeks.
  6. Relative strength: price / benchmark ratio above its own average of the previous 52 weeks.
Exit (weekly close): close below the 30-week MA AND that MA no higher than 4 weeks ago (the uptrend has stopped).
Optional: a hard stop at stop_pct below entry, checked on every daily close (HARD_STOP).
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

MA_WEEKS = 30
MA_SLOPE_WEEKS = 4
BASE_WEEKS = 26
DOWNTREND_LOOKBACK_WEEKS = 52
VOLUME_MULT = 2.0
RS_AVG_WEEKS = 52
HARD_STOP = True            # also exit if a daily close is stop_pct below entry (the video's rule set has none)
DEFAULT_STOP_PCT = 12.0


def _weekly(df: pd.DataFrame) -> pd.DataFrame:
    """Weekly bars keyed by the last trading date of each week (Mon-Fri weeks)."""
    d = pd.to_datetime(df["date"])
    wk = d.dt.to_period("W-FRI")
    g = df.assign(_wk=wk.values).groupby("_wk", sort=True)
    out = pd.DataFrame({
        "date": g["date"].last(),
        "close": g["close"].last(),
        "high": g["high"].max(),
        "volume": g["volume"].sum(min_count=1).fillna(0.0),
    })
    out.index = out["date"]
    return out


def add_tables(price_map: Dict[str, pd.DataFrame], tables: Dict[str, dict], bench: Optional[pd.DataFrame] = None) -> None:
    """Per symbol: wk_entry / wk_exit {week-end date: bool}, wk_fails {week-end date: [reasons]}, wk_end {dates}."""
    bw = None
    if bench is not None:
        bw = _weekly(bench[["date", "close"]].assign(high=bench["close"], volume=0.0))["close"]
    for sym, df in price_map.items():
        if sym not in tables:
            continue
        w = _weekly(df)
        t = tables[sym]
        if len(w) < MA_WEEKS + DOWNTREND_LOOKBACK_WEEKS:
            t["wk_end"], t["wk_entry"], t["wk_exit"], t["wk_fails"] = set(), {}, {}, {}
            continue
        close = w["close"]
        ma = close.rolling(MA_WEEKS, min_periods=MA_WEEKS).mean()
        ma_prev = ma.shift(MA_SLOPE_WEEKS)
        falling = (ma < ma_prev).astype(float)
        had_downtrend = falling.rolling(DOWNTREND_LOOKBACK_WEEKS, min_periods=DOWNTREND_LOOKBACK_WEEKS).max().shift(1)
        was_below = (close < ma).astype(float).rolling(BASE_WEEKS, min_periods=BASE_WEEKS).max().shift(1)
        high_prior = w["high"].rolling(BASE_WEEKS, min_periods=BASE_WEEKS).max().shift(1)
        vol_avg4 = w["volume"].shift(1).rolling(4, min_periods=4).mean()
        if bw is not None:
            ratio = close / bw.reindex(w.index).ffill()
            ratio_avg = ratio.shift(1).rolling(RS_AVG_WEEKS, min_periods=RS_AVG_WEEKS).mean()
        else:
            ratio = ratio_avg = pd.Series(np.nan, index=w.index)

        c1 = had_downtrend == 1.0
        c2 = was_below == 1.0
        c3 = close > high_prior
        c4 = (close > ma) & (ma >= ma_prev)
        c5 = (vol_avg4 > 0) & (w["volume"] >= VOLUME_MULT * vol_avg4)
        c6 = ratio > ratio_avg if bw is not None else pd.Series(True, index=w.index)
        valid = ma.notna() & ma_prev.notna() & high_prior.notna() & had_downtrend.notna() & was_below.notna() \
            & vol_avg4.notna() & (ratio_avg.notna() if bw is not None else True)
        entry = valid & c1 & c2 & c3 & c4 & c5 & c6
        exit_ = valid & (close < ma) & (ma <= ma_prev)

        fails: Dict = {}
        for dt, ok in entry.items():
            if ok or not valid[dt]:
                continue
            f = []
            if not c1[dt]: f.append("no prior downtrend (52w)")
            if not c2[dt]: f.append("no base (26w)")
            if not c3[dt]: f.append("below 26w high")
            if not c4[dt]: f.append("30w MA not rising / price below")
            if not c5[dt]: f.append("weekly volume < 2x avg")
            if not c6[dt]: f.append("RS ratio below its 52w avg")
            fails[dt] = f
        t["wk_end"] = set(w.index)
        t["wk_entry"] = {dt: bool(v) for dt, v in entry.items()}
        t["wk_exit"] = {dt: bool(v) for dt, v in exit_.items()}
        t["wk_fails"] = fails


def entry_check(sym: str, tables: dict, d, rs_pct: Optional[Dict[str, float]] = None) -> Tuple[bool, str]:
    t = tables.get(sym)
    if not t or "wk_end" not in t:
        return False, "no data"
    if not t["px"].get(d):
        return False, "no bar today"
    if d not in t["wk_end"]:
        return False, "weekly close only"
    if t["wk_entry"].get(d):
        return True, "QUALIFIED"
    f = t["wk_fails"].get(d)
    return False, " · ".join(f) if f else "insufficient history"


def exit_check(pos, close: float, tables: dict, d, stop_pct: float = DEFAULT_STOP_PCT) -> Optional[str]:
    pos.peak_close = max(getattr(pos, "peak_close", pos.entry_price), close)
    pos.last_close = close
    if HARD_STOP and close < pos.entry_price * (1.0 - stop_pct / 100.0):
        pos.stop_price = pos.entry_price * (1.0 - stop_pct / 100.0)
        return "stop"
    t = tables.get(pos.symbol)
    if t and t.get("wk_exit", {}).get(d):
        return "Weekly close < 30w MA (uptrend over)"
    return None
