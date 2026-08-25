"""Shared per-trade stop primitives for directional futures strategies.

Extracted from ``strategies/crudeoil/crudeoilm_orb.py`` so more than one strategy
can use them without importing that module (importing a strategy module runs its
``logging.basicConfig(force=True)`` and creates its log file as a side effect).

Both functions are pure — no broker, no I/O — so they stay unit-testable.
"""

from typing import Optional

__all__ = ["ratchet_stop", "stop_hit"]


def ratchet_stop(direction: str, current_stop: float, pivot_price: Optional[float]) -> float:
    """Tighten the stop toward a new reference level. Never loosens it.

    For a LONG the stop only moves UP; a reference level that forms below the current
    stop is ignored. Without this a mid-trend pullback would hand back profit already
    locked in. An unset (`<= 0`) stop adopts the reference outright.

    The reference is a confirmed pivot in the ORB strategy and the Supertrend band in
    the VWAP+Supertrend strategy — the ratchet invariant is the same either way.
    """
    if pivot_price is None or pivot_price <= 0:
        return current_stop
    if current_stop <= 0:
        return float(pivot_price)
    if direction == "LONG":
        return max(current_stop, float(pivot_price))
    if direction == "SHORT":
        return min(current_stop, float(pivot_price))
    return current_stop


def stop_hit(direction: str, ltp: float, stop_level: float) -> bool:
    """Has price traded through the stop?

    An unset stop (`<= 0`) or a missing quote (`ltp <= 0`) is never a hit — a 0.0 LTP
    from a failed ``get_ltp()`` would otherwise read as an instant stop-out.
    """
    if stop_level <= 0 or ltp <= 0:
        return False
    if direction == "LONG":
        return ltp < stop_level
    if direction == "SHORT":
        return ltp > stop_level
    return False
