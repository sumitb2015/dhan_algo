"""
Single-series candle shaping for the Point & Figure page: `to_bars` turns one instrument's 1-min candles (an index, stock, future
or single option) into the page's straddle-shaped bars. Imported by price_pnf_candles.py, which does the fetching; this module
has no script entry point of its own any more (the F&O contracts are resolved by the dashboard, see rs_dashboard/lib/pnfContracts.ts).
The bar shape is the straddle bar's: `straddle` and `ce` carry the close, `pe` is 0, so the P&F model runs unchanged.
"""
import os
import sys
from datetime import datetime, timedelta, timezone

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from straddle_pnf_candles import _leg  # noqa: E402  (same timestamp/close/volume normalisation as the straddle bars)

_IST = timezone(timedelta(hours=5, minutes=30))


def to_bars(df: pd.DataFrame, sessions: int, today=None) -> list:
    """Futures candles -> straddle-shaped bars for the last `sessions` IST dates; rows with a zero close are dropped.

    With `today` (an IST date), `sessions` counts completed sessions only and today's bars are kept on top, so the chart always
    has `sessions` full days of history however early in the day it is opened."""
    leg = _leg(df)
    leg = leg[leg["close"] > 0].sort_values("t")
    if leg.empty:
        return []
    day = leg["t"].map(lambda t: datetime.fromtimestamp(int(t), _IST).date())
    days = sorted(day.unique())
    past = [d for d in days if today is None or d < today]
    keep = past[-sessions:] + [d for d in days if today is not None and d == today]
    leg = leg[day.isin(keep)]
    return [
        {"t": int(r.t), "ce": round(float(r.close), 2), "pe": 0, "straddle": round(float(r.close), 2), "vol": int(r.vol)}
        for r in leg.itertuples(index=False)
    ]
