"""Pure risk and timing rules. No broker, no clock reads except hhmm_now(): unit-testable."""
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Optional, Tuple


# ── time windows ────────────────────────────────────────────────────────────────────────────────

def hhmm_now() -> str:
    return datetime.now().strftime("%H:%M")


def in_window(now_hhmm: str, start: str, end: str) -> bool:
    """Entry allowed in [start, end). Zero-padded HH:MM strings compare correctly as text."""
    return start <= now_hhmm < end


def past_time(now_hhmm: str, hhmm: str) -> bool:
    """True from `hhmm` onward, e.g. the EOD square-off (intraday NSE: 15:17, MCX: 23:30)."""
    return now_hhmm >= hhmm


# ── target / stop spec ──────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class TargetSpec:
    """A --target-profit / --stop-loss value: absolute rupees or a percent of entry value."""
    value: float
    is_percent: bool = False

    @classmethod
    def from_parsed(cls, parsed: Tuple[float, bool]) -> "TargetSpec":
        """Wrap the tuple lib.strategy_state_helper.parse_target_spec() returns."""
        return cls(float(parsed[0]), bool(parsed[1]))

    def resolve(self, entry_value: Optional[float]) -> Optional[float]:
        """Rupees. A percent resolves against the day's FIRST entry value, once, not each roll's
        premium. Returns None while the base is unknown, so callers must guard before comparing
        (a None compare crashed the first flat tick, 466e225)."""
        if not self.is_percent:
            return self.value
        if not entry_value:
            return None
        return abs(entry_value) * self.value / 100.0


# ── trailing stop ───────────────────────────────────────────────────────────────────────────────

def update_trail(total_pnl: float, best_pnl: float, active: bool, start_rs: float,
                 gap_rs: float) -> Tuple[bool, float, bool]:
    """Rupee-MTM trailing stop. Returns (active, best_pnl, exit_now).

    Arms at `start_rs` profit, then exits on a `gap_rs` giveback from the best. Feed it total_pnl
    (realized + unrealized), which is continuous across rolls; a trail on a per-position baseline
    went dead after the first roll (2c874d5).
    """
    if not active and total_pnl >= start_rs:
        active, best_pnl = True, total_pnl
    if active:
        best_pnl = max(best_pnl, total_pnl)
        if total_pnl < best_pnl - gap_rs:
            return active, best_pnl, True
    return active, best_pnl, False


class TrailingStop:
    """Stateful wrapper over update_trail with persistence helpers."""

    def __init__(self, start_rs: float, gap_rs: float, active: bool = False, best_pnl: float = 0.0):
        if gap_rs <= 0:
            raise ValueError(f"trail gap must be > 0, got {gap_rs}")
        if start_rs < 0:
            raise ValueError(f"trail start must be >= 0, got {start_rs}")
        self.start_rs, self.gap_rs, self.active, self.best_pnl = start_rs, gap_rs, active, best_pnl

    def update(self, total_pnl: float) -> bool:
        """Feed the latest total P&L; True means exit now."""
        self.active, self.best_pnl, hit = update_trail(
            total_pnl, self.best_pnl, self.active, self.start_rs, self.gap_rs)
        return hit

    def reset(self) -> None:
        self.active, self.best_pnl = False, 0.0

    def to_dict(self) -> dict:
        return {"trail_active": self.active, "best_pnl": self.best_pnl}

    def restore(self, data: dict) -> None:
        self.active = bool(data.get("trail_active"))
        self.best_pnl = float(data.get("best_pnl", 0.0))


# ── cooldown ────────────────────────────────────────────────────────────────────────────────────

class Cooldown:
    """Blocks new entries for N minutes after an emergency or stop-loss exit."""

    def __init__(self, minutes: float = 0.0, clock=time.time):
        self.minutes, self._clock, self._until = minutes, clock, 0.0

    def start(self, minutes: Optional[float] = None) -> None:
        self._until = self._clock() + 60.0 * (self.minutes if minutes is None else minutes)

    @property
    def active(self) -> bool:
        return self._clock() < self._until

    @property
    def remaining_s(self) -> int:
        return max(0, int(self._until - self._clock()))
