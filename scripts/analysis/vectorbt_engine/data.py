"""
Dhan-sourced OHLCV data provider for the VectorBT backtest engine.

The OpenAlgo vectorbt-backtesting-skills package (installed under .claude/skills/,
see rules/data-fetching.md) defaults to OpenAlgo's own SDK for Indian market data.
This project's data source is Dhan only (CLAUDE.md, and never Zerodha/Kite either) —
so this module is the "Custom Data Provider" extension point the skill's own docs
describe, wired to the repo's existing CSV caches instead of a network call:

  - Historical Data/           — index/futures daily+intraday CSVs (NIFTY, BANKNIFTY, ...)
  - Daily_Historical_Data_Fresh/ — one <SYMBOL>_Daily_2Y.csv per Nifty 500 constituent

Both are populated by scripts/downloader/refresh_dashboard_data.py against the Dhan
historical-data API — this module only reads what is already on disk, it does not
call any broker API itself, so it works after-hours with no token needed.

Every function returns a DataFrame with a tz-naive DatetimeIndex and lowercase
["open", "high", "low", "close", "volume"] columns, sorted ascending — the shape
VectorBT and the rest of this engine expect.
"""

from __future__ import annotations

import os
from typing import Optional

import numpy as np
import pandas as pd

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
INDEX_DIR = os.path.join(ROOT, "Historical Data")
STOCK_DIR = os.path.join(ROOT, "Daily_Historical_Data_Fresh")

# Index/futures daily CSVs live directly under Historical Data/ with these filenames.
_INDEX_DAILY_FILES = {
    "NIFTY": "NIFTY_50_Daily_5Y.csv",
    "NIFTY50": "NIFTY_50_Daily_5Y.csv",
    "NIFTY500": "NIFTY_500_Daily.csv",
    "BANKNIFTY_FUT": "BANKNIFTY_Futures_Daily.csv",
}

_OHLCV_COLS = ["open", "high", "low", "close", "volume"]


def _read_ohlcv_csv(path: str) -> Optional[pd.DataFrame]:
    """Read one of the repo's Dhan-sourced OHLCV CSVs defensively.

    Same defensive shape as lib/momentum.py's private _read_ohlcv (weekend rows
    dropped, duplicate dates collapsed, zero volume -> NaN since the intraday
    quote patcher writes 0 for today's still-open row) but keyed to a
    DatetimeIndex instead of a plain "date" column, since VectorBT indexes by
    DatetimeIndex directly.
    """
    if not os.path.exists(path):
        return None
    try:
        df = pd.read_csv(path)
    except Exception:
        return None
    if df.empty:
        return None

    # Both CSV families in this repo use a "Datetime" header (see
    # scripts/downloader/refresh_dashboard_data.py); tolerate a bare "Date" too.
    dt_col = "Datetime" if "Datetime" in df.columns else "Date" if "Date" in df.columns else None
    if dt_col is None:
        return None

    df.columns = [str(c).strip().lower() if c != dt_col else "datetime" for c in df.columns]
    df["datetime"] = pd.to_datetime(df["datetime"], errors="coerce")
    df = df.dropna(subset=["datetime"])
    for col in _OHLCV_COLS:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
        else:
            df[col] = np.nan
    df = df.dropna(subset=["close"])
    if df.empty:
        return None

    df = df.drop_duplicates(subset=["datetime"], keep="last")
    df = df.sort_values("datetime")
    df = df.set_index("datetime")
    if df.index.tz is not None:
        df.index = df.index.tz_convert(None)

    df.loc[df["volume"] <= 0, "volume"] = np.nan
    return df[_OHLCV_COLS]


def load_index_daily(symbol: str = "NIFTY") -> pd.DataFrame:
    """Daily OHLCV for an index/futures series cached directly under Historical Data/.

    `symbol` is looked up in `_INDEX_DAILY_FILES` (case-insensitive); raises
    FileNotFoundError if neither the mapped file nor the raw filename exists, so a
    typo fails loudly instead of silently returning an empty frame.
    """
    key = symbol.upper().replace(" ", "")
    filename = _INDEX_DAILY_FILES.get(key, symbol)
    path = os.path.join(INDEX_DIR, filename)
    df = _read_ohlcv_csv(path)
    if df is None:
        raise FileNotFoundError(
            f"No index/futures daily CSV for {symbol!r} under {INDEX_DIR} "
            f"(looked for {filename!r}); run scripts/downloader/refresh_dashboard_data.py first."
        )
    return df


def load_equity_daily(symbol: str) -> pd.DataFrame:
    """Daily OHLCV for one Nifty 500 equity from Daily_Historical_Data_Fresh/."""
    path = os.path.join(STOCK_DIR, f"{symbol.upper()}_Daily_2Y.csv")
    df = _read_ohlcv_csv(path)
    if df is None:
        raise FileNotFoundError(
            f"No daily CSV for equity {symbol!r} at {path}; "
            f"run scripts/downloader/refresh_dashboard_data.py --target stocks first."
        )
    return df


def load_benchmark_returns(index: pd.DatetimeIndex, symbol: str = "NIFTY") -> pd.Series:
    """NIFTY 50 daily return series aligned to `index`, for tearsheet.py's benchmark arg.

    Sourced from the same Dhan CSV as load_index_daily — no yfinance/network call,
    keeping the benchmark on the same Dhan-only footing as the strategy data itself.
    """
    bench = load_index_daily(symbol)
    returns = bench["close"].pct_change().dropna()
    returns = returns.reindex(index).fillna(0.0)
    return returns


def clip_date_range(
    df: pd.DataFrame, start: Optional[str] = None, end: Optional[str] = None
) -> pd.DataFrame:
    """Slice a loaded OHLCV frame to [start, end] (either bound optional, inclusive)."""
    if start is not None:
        df = df[df.index >= pd.Timestamp(start)]
    if end is not None:
        df = df[df.index <= pd.Timestamp(end)]
    return df
