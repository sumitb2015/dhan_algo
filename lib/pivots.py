"""
Pivot High / Pivot Low (swing point) detection.

Pure data-in, decisions-out -- nothing here touches Dhan, places orders, or writes
files. Keep it that way; it is what lets a backtest and a live strategy share one
definition of a swing.

A Pivot High at bar ``i`` requires ``High[i]`` to be strictly greater than the ``n``
highs before it AND the ``n`` highs after it. A Pivot Low is the mirror image on
``Low``. Because the "after" side must exist, a pivot is only *confirmable* once
bar ``i+n`` has closed -- detection lags price by ``n`` candles (``n+1`` if you also
discard the in-progress candle, which :class:`PivotTracker` does by default).

Typical use in a live loop::

    from lib.pivots import PivotTracker

    tracker = PivotTracker(n=3, maxlen=5)          # on strategy init
    ...
    df = helper.get_latest_candles("NIFTY", interval="5", days=5)
    for p in tracker.update(df):                   # only NEWLY confirmed pivots
        print("new pivot", p.type, p.price, p.timestamp)
    last_swing_high = tracker.latest_high()

Typical use in a backtest / screener::

    from lib.pivots import find_pivots
    pivots = find_pivots(df, n=3)                  # every confirmed pivot, oldest first
"""

from __future__ import annotations

import logging
import threading
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Dict, List, Optional

import pandas as pd

logger = logging.getLogger(__name__)

PIVOT_HIGH = "HIGH"
PIVOT_LOW = "LOW"

# tz-naive IST, matching the index of DhanHelper.get_latest_candles()
_TS_FMT = "%Y-%m-%d %H:%M:%S"


@dataclass(frozen=True)
class Pivot:
    """One confirmed swing point.

    Attributes:
        timestamp: Candle open time. This is the *canonical identity* of a pivot.
        index:     Positional row offset within the DataFrame it was found in.
                   INFORMATIONAL ONLY -- it shifts as a live rolling window slides,
                   so never use it to dedup or to key persisted state. It is excluded
                   from ``__eq__``/``__hash__`` for exactly that reason: the same swing
                   seen before and after the window slides must compare equal, or a
                   set-based dedup would re-fire on an already-traded pivot.
        price:     ``High[i]`` for a HIGH, ``Low[i]`` for a LOW.
        type:      :data:`PIVOT_HIGH` or :data:`PIVOT_LOW`.
    """

    timestamp: pd.Timestamp
    index: int = field(compare=False)
    price: float
    type: str

    @property
    def is_high(self) -> bool:
        return self.type == PIVOT_HIGH

    @property
    def is_low(self) -> bool:
        return self.type == PIVOT_LOW

    def to_dict(self) -> Dict:
        """JSON-safe dict -- drops straight into a ``save_strategy_state()`` payload."""
        return {
            "timestamp": pd.Timestamp(self.timestamp).strftime(_TS_FMT),
            "index": int(self.index),
            "price": float(self.price),
            "type": self.type,
        }

    @classmethod
    def from_dict(cls, d: Dict) -> "Pivot":
        return cls(
            timestamp=pd.Timestamp(d["timestamp"]),
            index=int(d.get("index", -1)),
            price=float(d["price"]),
            type=str(d["type"]),
        )


def find_pivots(
    df: Optional[pd.DataFrame],
    n: int = 3,
    *,
    kind: str = "both",
    strict: bool = True,
    high_col: str = "High",
    low_col: str = "Low",
) -> List[Pivot]:
    """Every CONFIRMED pivot in ``df``, oldest first.

    Only bars ``n .. len(df)-n-1`` are examined: the first ``n`` bars have no left
    window and the last ``n`` bars have no right window, so a pivot inside the last
    ``n`` bars is *unknowable*, not absent. Feed more candles and it will appear.

    Args:
        df:       OHLC DataFrame. Column case is configurable because frames that
                  went through ``calculate_ta_indicators()`` carry lowercase
                  duplicates alongside the Title-Case originals.
        n:        Bars required on each side. ``n=3`` needs 3 higher-lows on the
                  left and 3 on the right.
        kind:     ``"both"`` (default), ``"high"``, or ``"low"``. Case-insensitive, so
                  the exported :data:`PIVOT_HIGH` / :data:`PIVOT_LOW` constants work
                  here too. Anything else raises ``ValueError`` -- a typo must fail
                  loudly rather than read as "this instrument never makes swing highs".
        strict:   ``True`` (default, per spec) -- equal highs are NOT pivots, so a
                  flat double top yields nothing until one side breaks.
                  ``False`` uses ``>=`` / ``<=`` and will report both bars of a
                  flat top.
        high_col: Column to scan for pivot highs.
        low_col:  Column to scan for pivot lows.

    Returns:
        Pivots sorted by time, HIGHs and LOWs interleaved. Returns ``[]`` -- never
        raises -- for ``None``, an empty frame, ``n < 1``, fewer than ``2n+1`` rows,
        or missing columns. ``get_latest_candles()`` returns an empty DataFrame on
        API error, and callers should not need a ``try/except`` around this.

    Raises:
        ValueError: if ``kind`` is not one of both/high/low. Bad *data* degrades to
            ``[]``; a bad *argument* is a caller bug and must surface.
    """
    kind = str(kind).lower()
    if kind not in ("both", "high", "low"):
        raise ValueError(f"kind must be 'both', 'high' or 'low', got {kind!r}")

    if df is None or n < 1:
        return []
    if not isinstance(df, pd.DataFrame) or df.empty:
        return []
    if len(df) < 2 * n + 1:
        return []

    want_high = kind in ("both", "high") and high_col in df.columns
    want_low = kind in ("both", "low") and low_col in df.columns
    if not want_high and not want_low:
        return []

    idx = df.index
    highs = df[high_col].to_numpy(dtype=float) if want_high else None
    lows = df[low_col].to_numpy(dtype=float) if want_low else None

    out: List[Pivot] = []
    for i in range(n, len(df) - n):
        # NOTE on NaN: a gap anywhere in a window makes max()/min() NaN, and every
        # comparison against NaN is False -- so under strict=True the bar is simply
        # skipped rather than producing a bogus pivot. That is the safe behaviour.
        if want_high:
            v = highs[i]
            left = highs[i - n:i].max()
            right = highs[i + 1:i + n + 1].max()
            hit = (v > left and v > right) if strict else (v >= left and v >= right)
            if hit:
                out.append(Pivot(idx[i], i, float(v), PIVOT_HIGH))
        if want_low:
            v = lows[i]
            left = lows[i - n:i].min()
            right = lows[i + 1:i + n + 1].min()
            hit = (v < left and v < right) if strict else (v <= left and v <= right)
            if hit:
                out.append(Pivot(idx[i], i, float(v), PIVOT_LOW))
    return out


def find_pivot_highs(df, n: int = 3, **kwargs) -> List[Pivot]:
    """Confirmed pivot highs only. See :func:`find_pivots`."""
    kwargs.pop("kind", None)
    return find_pivots(df, n, kind="high", **kwargs)


def find_pivot_lows(df, n: int = 3, **kwargs) -> List[Pivot]:
    """Confirmed pivot lows only. See :func:`find_pivots`."""
    kwargs.pop("kind", None)
    return find_pivots(df, n, kind="low", **kwargs)


class PivotTracker:
    """Stateful wrapper for live loops.

    Feed it the latest candle DataFrame every poll; it returns only the pivots it
    has never emitted before, and keeps the last ``maxlen`` of each type in a ring
    buffer (oldest evicted automatically).

    Dedup is by TIMESTAMP via a per-type high-water mark, never by row index -- a
    rolling window renumbers every row each time it slides. One consequence: a pivot
    *older* than the watermark is ignored even if it is genuinely new to this
    tracker (e.g. a later ``update()`` supplies deeper history than the first one
    did). That is intentional -- backfilling history mid-session must not fire stale
    signals.

    On a cold start the first ``update()`` reports *every* pivot in the lookback
    window as new, which for a strategy launched mid-session means acting on
    hours-old swings. Call :meth:`prime` once with the opening frame to absorb that
    history silently and only trade pivots formed from then on.

    Thread-safe: all mutation and every accessor take an internal lock, so a
    ``crudeoilm_supertrend.py``-style background refresh thread can call
    :meth:`update` while the main loop reads :meth:`latest_low`.
    """

    def __init__(
        self,
        n: int = 3,
        maxlen: int = 5,
        *,
        drop_forming: bool = True,
        strict: bool = True,
        high_col: str = "High",
        low_col: str = "Low",
    ) -> None:
        """
        Args:
            n:            Bars required on each side of a pivot.
            maxlen:       How many pivots of each type to retain (default 5).
            drop_forming: Discard the last row before scanning, on the assumption
                          that it is the in-progress candle. This matches the
                          repo-wide ``df.iloc[-2]`` convention and makes the total
                          confirmation lag ``n+1`` closed candles. A
                          ``crudeoilm_supertrend.py``-style refresh thread that only
                          recomputes on a candle-bucket change still receives a frame
                          whose last row is forming, so ``True`` stays correct there.
                          Set ``False`` only when the caller has already sliced
                          (``df.iloc[:-1]``) or is replaying closed historical bars --
                          otherwise you silently lose one real bar per call.
            strict:       See :func:`find_pivots`.

        Raises:
            ValueError: if ``n < 1`` or ``maxlen < 1``. Both silently disable the
                tracker otherwise (``deque(maxlen=0)`` discards every append), which
                would look like "this instrument has no swings" at runtime.
        """
        if int(n) < 1:
            raise ValueError(f"n must be >= 1, got {n!r}")
        if int(maxlen) < 1:
            raise ValueError(f"maxlen must be >= 1, got {maxlen!r}")
        self.n = int(n)
        self.maxlen = int(maxlen)
        self.drop_forming = bool(drop_forming)
        self.strict = bool(strict)
        self.high_col = high_col
        self.low_col = low_col
        self.highs: Deque[Pivot] = deque(maxlen=self.maxlen)
        self.lows: Deque[Pivot] = deque(maxlen=self.maxlen)
        self._last_high_ts: Optional[pd.Timestamp] = None
        self._last_low_ts: Optional[pd.Timestamp] = None
        self._lock = threading.Lock()

    def _scan(self, df: Optional[pd.DataFrame]) -> List[Pivot]:
        """Prepare the frame and run detection. No state touched, no lock needed."""
        if df is None or not isinstance(df, pd.DataFrame) or df.empty:
            return []
        # Rare API repeats of the same timestamp would confuse the watermark.
        if df.index.has_duplicates:
            df = df[~df.index.duplicated(keep="last")]
        if self.drop_forming:
            df = df.iloc[:-1]
        return find_pivots(
            df,
            self.n,
            strict=self.strict,
            high_col=self.high_col,
            low_col=self.low_col,
        )

    def update(self, df: Optional[pd.DataFrame]) -> List[Pivot]:
        """Newly confirmed pivots, oldest first. Safe (and cheap) to call every poll."""
        found = self._scan(df)
        if not found:
            return []

        fresh: List[Pivot] = []
        with self._lock:
            for p in found:
                ts = pd.Timestamp(p.timestamp)
                if p.type == PIVOT_HIGH:
                    if self._last_high_ts is not None and ts <= self._last_high_ts:
                        continue
                    self._last_high_ts = ts
                    self.highs.append(p)
                else:
                    if self._last_low_ts is not None and ts <= self._last_low_ts:
                        continue
                    self._last_low_ts = ts
                    self.lows.append(p)
                fresh.append(p)
        return fresh

    def prime(self, df: Optional[pd.DataFrame]) -> int:
        """Absorb existing history without emitting it. Call once at startup.

        Populates the ring buffers and advances the watermarks exactly as
        :meth:`update` would, but returns a count instead of the pivots -- so a
        strategy launched mid-session starts with real swing levels available via
        :meth:`latest_high` / :meth:`latest_low` yet does not fire entry signals on
        swings that formed hours ago.

        Returns:
            How many pivots were absorbed.
        """
        return len(self.update(df))

    # ---- accessors -------------------------------------------------------

    def latest_high(self) -> Optional[Pivot]:
        """Most recent confirmed pivot high, or ``None``."""
        with self._lock:
            return self.highs[-1] if self.highs else None

    def latest_low(self) -> Optional[Pivot]:
        """Most recent confirmed pivot low, or ``None``."""
        with self._lock:
            return self.lows[-1] if self.lows else None

    def high_prices(self) -> List[float]:
        """Retained pivot high prices, oldest first (e.g. for breakout checks)."""
        with self._lock:
            return [p.price for p in self.highs]

    def low_prices(self) -> List[float]:
        """Retained pivot low prices, oldest first (e.g. for stop placement)."""
        with self._lock:
            return [p.price for p in self.lows]

    def reset(self) -> None:
        """Clear buffers and watermarks (e.g. at the start of a new session)."""
        with self._lock:
            self.highs.clear()
            self.lows.clear()
            self._last_high_ts = None
            self._last_low_ts = None

    # ---- serialization ---------------------------------------------------

    def to_dict(self) -> Dict:
        """JSON-safe snapshot -- include it in a ``save_strategy_state()`` payload."""
        with self._lock:
            return self._to_dict_locked()

    def _to_dict_locked(self) -> Dict:
        return {
            "n": self.n,
            "maxlen": self.maxlen,
            "drop_forming": self.drop_forming,
            "strict": self.strict,
            "high_col": self.high_col,
            "low_col": self.low_col,
            "highs": [p.to_dict() for p in self.highs],
            "lows": [p.to_dict() for p in self.lows],
            "last_high_ts": (
                self._last_high_ts.strftime(_TS_FMT) if self._last_high_ts is not None else None
            ),
            "last_low_ts": (
                self._last_low_ts.strftime(_TS_FMT) if self._last_low_ts is not None else None
            ),
        }

    @classmethod
    def from_dict(cls, state: Dict) -> "PivotTracker":
        """Rebuild after a restart so the tracker does not re-emit pivots already traded."""
        t = cls(
            n=int(state.get("n", 3)),
            maxlen=int(state.get("maxlen", 5)),
            drop_forming=bool(state.get("drop_forming", True)),
            strict=bool(state.get("strict", True)),
            high_col=state.get("high_col", "High"),
            low_col=state.get("low_col", "Low"),
        )
        for d in state.get("highs", []):
            t.highs.append(Pivot.from_dict(d))
        for d in state.get("lows", []):
            t.lows.append(Pivot.from_dict(d))
        lh = state.get("last_high_ts")
        ll = state.get("last_low_ts")
        t._last_high_ts = pd.Timestamp(lh) if lh else None
        t._last_low_ts = pd.Timestamp(ll) if ll else None
        return t


def get_pivots(
    helper,
    symbol: str,
    interval: str = "5",
    n: int = 3,
    days: int = 5,
    **kwargs,
) -> List[Pivot]:
    """Fetch candles and return confirmed pivots -- one-shot convenience.

    ``helper`` is duck-typed on purpose (anything exposing ``get_latest_candles``);
    this module must never import ``DhanHelper``, so it stays importable in unit
    tests and backtests without OAuth.

    The last row is dropped before scanning, since ``get_latest_candles()`` includes
    the in-progress candle during market hours.

    An empty ``[]`` here can mean "no swings formed" OR "the data API failed" -- Dhan's
    historical endpoints return empty on error rather than raising. This logs a warning
    when ``helper.last_api_error`` is set, but a caller that acts on the result should
    check that attribute itself before concluding there are no pivots.
    """
    df = helper.get_latest_candles(symbol, interval=interval, days=days)
    if df is None or df.empty:
        api_error = getattr(helper, "last_api_error", None)
        if api_error:
            logger.warning(
                "get_pivots(%s): no candles returned, data API reported: %s",
                symbol,
                api_error,
            )
        return []
    return find_pivots(df.iloc[:-1], n, **kwargs)
