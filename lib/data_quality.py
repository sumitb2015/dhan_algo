"""
Detect price-basis breaks (unadjusted splits / bonuses / demergers, or a series stitched from two adjustment
bases) in the daily CSVs the momentum code reads raw.

A genuine one-day move almost never lands on a clean ratio, while a corporate action does (1:2 bonus = 2/3,
1:1 bonus or 1:2 split = 1/2, ...). So a close-to-close change of >30% whose ratio sits within 1.5% of such a
fraction is flagged. Upward seams (a series that switches to a back-adjusted basis) land on the inverse fractions.
This is a WARNING tool: it cannot tell a real crash on a round number from a split, so a human confirms.
Fix a confirmed one by re-downloading the symbol from Dhan: scripts/downloader/repair_symbol_history.py.
"""

from __future__ import annotations

from typing import Dict, List, Optional

import pandas as pd

# new_close / prev_close values typical of corporate actions (drops) and their inverses (seams).
# 3/4 and 4/5 are left out on purpose: real 20-25% crashes and rallies land on them far too often.
_DROPS = (1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 10, 2 / 3, 3 / 5)
RATIOS = tuple(sorted(set(_DROPS + tuple(1 / r for r in _DROPS))))


def clean_fraction(ratio: float, tol: float = 0.015) -> bool:
    return any(abs(ratio / r - 1.0) <= tol for r in RATIOS)


def find_suspect_breaks(price_map: Dict[str, pd.DataFrame], min_move: float = 0.30,
                        tol: float = 0.015, bench: Optional[pd.DataFrame] = None,
                        market_move: float = 0.04) -> List[dict]:
    """[{symbol, date, prev_close, close, ratio}] for every >min_move close-to-close change on a clean fraction.

    With `bench` (the Nifty frame), days on which the index itself moved more than `market_move` are skipped:
    a market-wide crash is not a corporate action.
    """
    wide_days = set()
    if bench is not None:
        br = bench["close"].pct_change().abs()
        wide_days = {d for d, r in zip(bench["date"], br) if r > market_move}
    out: List[dict] = []
    for sym, df in price_map.items():
        close = df["close"].to_numpy(dtype=float)
        dates = list(df["date"])
        for i in range(1, len(close)):
            if close[i - 1] <= 0:
                continue
            ratio = close[i] / close[i - 1]
            if abs(ratio - 1.0) > min_move and dates[i] not in wide_days and clean_fraction(ratio, tol):
                out.append({"symbol": sym, "date": dates[i].isoformat(), "prev_close": round(float(close[i - 1]), 2),
                            "close": round(float(close[i]), 2), "ratio": round(float(ratio), 4)})
    return out
