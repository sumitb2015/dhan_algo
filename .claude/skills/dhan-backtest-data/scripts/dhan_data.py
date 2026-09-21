"""
Repo-data loader for VectorBT-style backtests in dhan_algo.

Replaces the OpenAlgo `client.history()` / yfinance fetch that the installed vectorbt skills assume. Every
file it reads was downloaded from Dhan (see scripts/downloader), which keeps the repo's Dhan-only data rule.
No network, no new dependencies.

    import sys; sys.path.insert(0, "<repo>/.claude/skills/dhan-backtest-data/scripts")
    from dhan_data import load_ohlcv, benchmark, describe

    df = load_ohlcv("RELIANCE", "D", start="2024-01-01")     # daily stock
    df = load_ohlcv("NIFTY", "5m")                            # 5-min index, 09:15-aligned
    bench = benchmark("D")                                    # NIFTY 50 daily close series source

Returns lower-case `open high low close volume` on a tz-naive DatetimeIndex (IST wall-clock, as stored),
sorted and de-duplicated: the shape the vendor templates expect from OpenAlgo. A promoted backtest that lives
in the repo should import the equivalent from lib/ instead of from this skill folder.
"""
import os
import re
import sys
from typing import Optional

import pandas as pd


def _root(start: str = os.path.dirname(os.path.abspath(__file__))) -> str:
    d = start
    while not os.path.exists(os.path.join(d, "login.py")):
        parent = os.path.dirname(d)
        if parent == d:
            raise RuntimeError("dhan_data: run inside the dhan_algo repo (login.py not found above this file)")
        d = parent
    return d


ROOT = _root()
HIST = os.path.join(ROOT, "Historical Data")
INDICES = os.path.join(HIST, "Indices")
STOCK_DAILY = os.path.join(ROOT, "Daily_Historical_Data_Fresh")
STOCK_1M = os.path.join(ROOT, "Intraday_Historical_Data", "1min")

# Named series that do not follow the <SYMBOL> file convention.
DAILY_FILES = {
    "NIFTY": "NIFTY_50_Daily_5Y.csv",
    "NIFTY500": "NIFTY_500_Daily.csv",
    "NIFTYFUT": "NIFTY_Futures_Daily.csv",
    "BANKNIFTYFUT": "BANKNIFTY_Futures_Daily.csv",
}
MINUTE_FILES = {
    "NIFTY": "NIFTY_50_1Min_5Y.csv",
    "NIFTYFUT": "NIFTY_Futures_1min_Manual.csv",
    "BANKNIFTYFUT": "BANKNIFTY_Futures_1min_Manual.csv",
}
_OHLCV = ["Open", "High", "Low", "Close", "Volume"]


def _interval_minutes(interval: str) -> Optional[int]:
    """'D' -> None (daily). '1', '5m', '15min', '1h' -> minutes."""
    s = str(interval).strip().lower()
    if s in ("d", "1d", "day", "daily"):
        return None
    m = re.fullmatch(r"(\d+)\s*(m|min|minute|minutes|h|hr|hour)?", s)
    if not m:
        raise ValueError(f"unrecognised interval {interval!r}; use 'D', '1m', '5m', '15m', '60m', ...")
    n = int(m.group(1))
    return n * 60 if (m.group(2) or "").startswith("h") else n


def _read(path: str) -> pd.DataFrame:
    if path.endswith(".parquet"):
        df = pd.read_parquet(path)
        if not isinstance(df.index, pd.DatetimeIndex):
            df.index = pd.to_datetime(df.index)
    else:
        df = pd.read_csv(path, parse_dates=["Datetime"], index_col="Datetime")
    return df[_OHLCV]


def _daily_path(symbol: str) -> str:
    s = symbol.upper()
    for cand in (
        os.path.join(HIST, DAILY_FILES[s]) if s in DAILY_FILES else None,
        os.path.join(INDICES, f"{s}.csv"),
        os.path.join(STOCK_DAILY, f"{s}_Daily_2Y.csv"),
    ):
        if cand and os.path.exists(cand):
            return cand
    raise FileNotFoundError(f"no daily file for {symbol!r}. Named: {sorted(DAILY_FILES)}; indices in "
                            f"{INDICES}; stocks in {STOCK_DAILY} as <SYMBOL>_Daily_2Y.csv")


def _minute_path(symbol: str) -> str:
    s = symbol.upper()
    for cand in (
        os.path.join(HIST, MINUTE_FILES[s]) if s in MINUTE_FILES else None,
        os.path.join(STOCK_1M, f"{s}.parquet"),
    ):
        if cand and os.path.exists(cand):
            return cand
    raise FileNotFoundError(f"no 1-minute data for {symbol!r}. Named: {sorted(MINUTE_FILES)}; stocks in "
                            f"{STOCK_1M} (Nifty 50 members only, ~4 months; see manifest.json for windows)")


# Regular NSE cash/F&O session for 1-minute bars stamped by bar open: 09:15 .. 15:29 (375 bars). The stored
# NIFTY 1-minute file also holds pre-open bars (09:00-09:14, ~26k) and post-close bars (15:30-23:59, ~37k,
# almost all zero-volume, mostly 2021-22). Left in, they add partial 09:00/09:05/09:10 bins to every
# resample and pollute session logic (VWAP, opening range, EOD exits).
SESSION = ("09:15", "15:29")


def load_ohlcv(symbol: str, interval: str = "D", start: Optional[str] = None,
               end: Optional[str] = None, session: Optional[tuple] = SESSION) -> pd.DataFrame:
    """Load OHLCV for `symbol` at `interval`, lower-case columns, sorted, de-duplicated, optionally sliced.

    `session=("09:15","15:29")` drops out-of-session 1-minute bars BEFORE resampling; pass `session=None` for the
    raw file. It does nothing for daily data.

    Intraday bars above 1 minute are built with lib.intraday_signals.resample_tf so a backtest sees the same
    09:15-aligned bars the live strategies do. 60-minute bars inherit that function's documented caveat: the
    first bar of each session covers only 09:15-09:59.
    """
    minutes = _interval_minutes(interval)
    if minutes is None:
        df = _read(_daily_path(symbol))
    else:
        df = _read(_minute_path(symbol))
        if session:
            df = df.between_time(*session)
        if minutes > 1:
            if ROOT not in sys.path:
                sys.path.insert(0, ROOT)
            from lib.intraday_signals import resample_tf
            df = resample_tf(df, minutes)
    df = df[~df.index.duplicated(keep="last")].sort_index()
    if start:
        df = df.loc[pd.Timestamp(start):]
    if end:
        df = df.loc[:pd.Timestamp(end)]
    out = df.rename(columns=str.lower)
    out.index.name = "datetime"
    return out.dropna(subset=["open", "high", "low", "close"])


def benchmark(interval: str = "D", start: Optional[str] = None, end: Optional[str] = None) -> pd.DataFrame:
    """NIFTY 50 (the default benchmark), same shape as load_ohlcv."""
    return load_ohlcv("NIFTY", interval, start, end)


def describe(symbol: str, interval: str = "D") -> dict:
    """First/last bar, row count and sessions. Put this in every backtest report: results are only as long as
    the data, and a 4-month intraday window is not evidence of a robust edge."""
    df = load_ohlcv(symbol, interval)
    return {"symbol": symbol.upper(), "interval": interval, "rows": len(df),
            "sessions": int(df.index.normalize().nunique()),
            "first": str(df.index[0]), "last": str(df.index[-1])}


if __name__ == "__main__":
    for sym, iv in (("NIFTY", "D"), ("RELIANCE", "D"), ("NIFTY", "5m"), ("INFY", "15m")):
        try:
            print(describe(sym, iv))
        except FileNotFoundError as e:
            print("MISSING", sym, iv, "-", str(e)[:90])
