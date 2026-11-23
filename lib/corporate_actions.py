"""
Corporate-action price adjustments for the daily stock CSVs — the Python twin of applyPriceAdjustments() in
rs_dashboard/lib/dataLoader.ts.

The CSVs in Daily_Historical_Data_Fresh/ are stored raw, so a split, bonus or demerger shows up as a one-day
-33% to -64% "crash". scripts/downloader/corporate_actions.json lists the confirmed ones (read its _readme for the
fields). Each entry scales the rows before its break onto the post-event basis, and only while the break is still in
the data, so a re-downloaded, already-adjusted history is never adjusted twice.

Used by lib/scanner_score.py (the Scanner Top-N model trades the dashboard scanner's ranking, which reads adjusted
series). Other momentum models still read raw CSVs; see the vault roadmap note on Python loaders and corporate
actions before switching them, since it changes their results.
"""

from __future__ import annotations

import json
import os
from typing import Dict, List, Optional

import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CORPORATE_ACTIONS_JSON = os.path.join(ROOT, "scripts", "downloader", "corporate_actions.json")

# Every registered break is a 30%+ jump, so a 3% band can't mistake an already-adjusted series (ratio ~1) for a raw one.
JUMP_TOLERANCE = 0.03

_cache: Dict[str, object] = {"mtime": None, "by_symbol": {}}


def adjustments_for(symbol: str, path: str = CORPORATE_ACTIONS_JSON) -> List[dict]:
    """Registered adjustments for `symbol`, re-read whenever the JSON file changes."""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return []
    if _cache["mtime"] != mtime:
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, ValueError):
            return []
        by_symbol: Dict[str, List[dict]] = {}
        for a in raw.get("price_adjustments", []) if isinstance(raw, dict) else []:
            if not isinstance(a, dict) or not isinstance(a.get("symbol"), str) or not isinstance(a.get("break_date"), str):
                continue
            f_ = a.get("factor")
            if not isinstance(f_, (int, float)) or not f_ > 0:
                continue
            by_symbol.setdefault(a["symbol"], []).append(a)
        _cache["mtime"], _cache["by_symbol"] = mtime, by_symbol
    return list(_cache["by_symbol"].get(symbol, []))       # type: ignore[union-attr]


def _opens_at_ratio(prev_close: float, cur_open: float, ratio: float) -> bool:
    return prev_close > 0 and abs(cur_open / prev_close / ratio - 1.0) <= JUMP_TOLERANCE


def adjust_frame(symbol: str, df: pd.DataFrame, adjustments: Optional[List[dict]] = None) -> pd.DataFrame:
    """Return `df` (lowercase open/high/low/close/volume and a `date` column, sorted by date) with every registered
    adjustment for `symbol` applied. `date` may hold date objects or ISO strings. The input is not modified."""
    adj = adjustments_for(symbol) if adjustments is None else adjustments
    if not adj or df is None or len(df) == 0:
        return df
    out = df.copy()
    keys = [str(x)[:10] for x in out["date"]]
    for a in adj:
        try:
            bi = keys.index(a["break_date"])
        except ValueError:
            continue
        closes, opens = out["close"].to_numpy(dtype=float), out["open"].to_numpy(dtype=float)
        if bi <= 0 or not _opens_at_ratio(closes[bi - 1], opens[bi], a["factor"]):
            continue                                     # break not in the data (already adjusted, or wrong entry)
        start = 0
        if a.get("from_date") and a["from_date"] in keys:
            si = keys.index(a["from_date"])
            if 0 < si < bi and _opens_at_ratio(closes[si - 1], opens[si], 1.0 / a["factor"]):
                start = si
        f = float(a["factor"])
        rows = out.index[start:bi]
        for col in ("open", "high", "low", "close"):
            out.loc[rows, col] = out.loc[rows, col].astype(float) * f
        if a.get("adjust_volume"):
            out.loc[rows, "volume"] = out.loc[rows, "volume"].astype(float) / f
    return out
