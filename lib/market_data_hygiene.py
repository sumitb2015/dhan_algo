"""Shared clean-up rules for the daily stock CSVs and the Nifty 500 constituent list.

Used by every script that writes Daily_Historical_Data_Fresh/*.csv, so the
rules can't drift between writers. The dashboard's reader
(rs_dashboard/lib/dataLoader.ts) applies the same no-trade-bar rule when it
reads, which covers files written before this module existed.
"""
import os

import pandas as pd

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# NSE's official constituent file (archives.nseindia.com/content/indices/ind_nifty500list.csv),
# refreshed by scripts/download_nifty500_symbols.py.
NIFTY500_LIST = os.path.join(PROJECT_ROOT, "ind_nifty500list.csv")


def drop_no_trade_bars(df: pd.DataFrame) -> pd.DataFrame:
    """Drop rows with zero volume and a flat OHLC (open = high = low = close).

    yfinance returns one of these for every NSE holiday (all 500 stocks on
    2026-05-28, for example), and a suspended stock produces the same shape.
    Neither is a trading session. Kept, they average a zero into the 20-day
    volume baseline and add a zero-range day to NR4/NR7.

    Works on either a Datetime index or a Datetime column, and on numeric or
    string cells (the Yahoo sync re-reads existing CSV rows as strings).
    """
    if df is None or df.empty or not {"Open", "High", "Low", "Close", "Volume"}.issubset(df.columns):
        return df
    o, h, l, c, v = (pd.to_numeric(df[k], errors="coerce") for k in ("Open", "High", "Low", "Close", "Volume"))
    no_trade = (v.fillna(0) == 0) & (o == h) & (h == l) & (l == c)
    return df[~no_trade]


def is_constituent_symbol(symbol: str) -> bool:
    """False for blanks, header junk, and NSE's DUMMY<parent> placeholders.

    During a demerger NSE adds a placeholder such as DUMMYHEG to the index file
    to hold the spun-off business until it lists. It has no security ID and no
    price history, so every downloader would otherwise count it as a failure.
    """
    s = (symbol or "").strip()
    return bool(s) and s not in ("NIFTY 500", "nan") and not s.startswith("Note") and not s.upper().startswith("DUMMY")
