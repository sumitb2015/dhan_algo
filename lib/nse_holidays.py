"""NSE equity trading holidays and special sessions — Python reader for the shared list.

The data lives in rs_dashboard/lib/nseHolidays.json, the single source also read by the
dashboard (rs_dashboard/lib/nseHolidays.ts). Edit the JSON, never a copy of the list. See
docs/NSE_HOLIDAYS_2026.md. A year the JSON lacks degrades to weekdays-only. MCX keeps its
own calendar and is not covered.
"""
import json
import os
from datetime import date, datetime, timedelta
from typing import Iterable, List, Optional, Union

_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "rs_dashboard", "lib", "nseHolidays.json")

with open(_PATH, encoding="utf-8") as _f:
    _DATA = json.load(_f)

NSE_HOLIDAYS = frozenset(d for year in _DATA["holidays"].values() for d in year)
# Diwali Muhurat sessions: one hour, not a regular 09:15-15:30 day.
NSE_MUHURAT_SESSIONS = frozenset(_DATA["special_sessions"]["muhurat"])

_DateLike = Union[date, datetime, str]


def _as_date(d: _DateLike) -> date:
    if isinstance(d, str):
        return date.fromisoformat(d[:10])
    if isinstance(d, datetime):
        return d.date()
    return d


def is_nse_trading_day(d: _DateLike) -> bool:
    """A weekday that is not an NSE holiday. Accepts a date, datetime or 'YYYY-MM-DD[ ...]'."""
    d = _as_date(d)
    return d.weekday() < 5 and d.isoformat() not in NSE_HOLIDAYS


def is_regular_session(d: _DateLike) -> bool:
    """A trading day with the full 09:15-15:30 session: not a holiday, not a Muhurat session."""
    d = _as_date(d)
    return is_nse_trading_day(d) and d.isoformat() not in NSE_MUHURAT_SESSIONS


def effective_expiry_date(d: _DateLike) -> date:
    """The session a contract actually expires on: the labelled expiry date, or the last trading day
    before it when that date is an NSE holiday (the options DB still labels 2023-06-29 and 2024-04-11,
    though those contracts expired on the 28th and the 10th). Compare against THIS, not the label,
    when asking "is it expiry day?" or counting days to expiry."""
    d = _as_date(d)
    while not is_nse_trading_day(d):
        d -= timedelta(days=1)
    return d


def regular_session_days(days: Iterable[_DateLike]) -> List:
    """Keep only the regular-session days of an iterable, preserving each item as given."""
    return [x for x in days if is_regular_session(x)]


def drop_non_regular_sessions(df, col: Optional[str] = None):
    """Drop rows of a DataFrame that fall on weekends, NSE holidays or Muhurat sessions.

    `col` names a date/datetime column; None uses the index. Returns the filtered frame
    (same type, original order) — a no-op for an empty frame.
    """
    import pandas as pd
    if len(df) == 0:
        return df
    s = pd.to_datetime(df[col] if col is not None else df.index, errors="coerce")
    days = pd.Series(s).dt.strftime("%Y-%m-%d").values
    keep = [is_regular_session(x) if x == x and x != "NaT" else True for x in days]
    return df[keep]
