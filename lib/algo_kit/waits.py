"""Shutdown-aware waiting."""
import time
from typing import Callable, Optional


def interruptible_sleep(seconds: float, shutdown_check: Callable[[], bool],
                        on_tick: Optional[Callable[[int], None]] = None, step: float = 1.0) -> bool:
    """Sleep `seconds` in `step` slices, polling `shutdown_check()` before each.

    Returns True when the wait completed, False as soon as a shutdown was requested; the caller
    then runs its own exit-and-save. A plain time.sleep(300) cooldown would make the dashboard's
    Stop button hang for five minutes, which is why every wait goes through here.
    `on_tick(remaining_seconds)` lets the caller publish a COOLDOWN status for the dashboard.
    """
    remaining = float(seconds)
    while remaining > 0:
        if shutdown_check():
            return False
        if on_tick:
            on_tick(int(remaining))
        nap = min(step, remaining)
        time.sleep(nap)
        remaining -= nap
    return True
