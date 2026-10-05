"""Pure rule logic for `nifty_rolling_straddle.py --roll-type rules`.

Shared by the live strategy and `scripts/analysis/backtest_rolling_straddle_rules.py` so the two
cannot drift apart. No broker, clock or file access: everything is a function of its arguments.
"""
from typing import Optional, Tuple


def trail_lock_pct(peak_pct: float, start: float = 0.20, step: float = 0.10,
                   lock_step: float = 0.08) -> Optional[float]:
    """Profit-lock ladder as a fraction of the first straddle's premium.

    peak_pct = best day P&L / first-straddle premium. None until `start` is reached, then
    +start -> 0, +start+step -> 0.10, +start+2*step -> 0.20, each further +step adds lock_step.
    """
    if peak_pct < start - 1e-9:
        return None
    steps = int((peak_pct - start) / step + 1e-9)
    if steps <= 2:
        return 0.10 * steps
    return 0.20 + lock_step * (steps - 2)


def is_balanced(ce: float, pe: float, ratio: float) -> bool:
    """True when both premiums are positive and the higher is below ratio x the lower."""
    if ce <= 0 or pe <= 0:
        return False
    lo, hi = min(ce, pe), max(ce, pe)
    return hi < ratio * lo


def straddle_sl_hit(ce: float, pe: float, p0: float, mult: float) -> bool:
    return p0 > 0 and (ce + pe) >= mult * p0


def leg_sl_hit(ltp: float, entry: float, mult: float) -> bool:
    return entry > 0 and ltp >= mult * entry


def spot_move_pct(spot: float, ref_spot: float) -> float:
    return abs(spot - ref_spot) / ref_spot * 100.0 if ref_spot > 0 else 0.0


def roll_reason(*, ce: float, pe: float, spot: float, ref_spot: float, armed: bool,
                trigger: str, spot_pct: float, max_delta: Optional[float], delta_limit: float,
                imbalance_ratio: float) -> Tuple[Optional[str], bool]:
    """Decide whether to roll. Returns (reason or None, new `armed` flag).

    Imbalance is always on but arm-on-balance: a straddle sold already skewed must not roll
    straight back into the same skew, so it only counts once that straddle has been seen
    balanced. Then exactly one primary trigger: "spot_pct" or "delta".
    """
    if is_balanced(ce, pe, imbalance_ratio):
        armed = True
    if armed and ce > 0 and pe > 0 and not is_balanced(ce, pe, imbalance_ratio):
        lo, hi = min(ce, pe), max(ce, pe)
        return f"premium imbalance {hi / lo:.2f}x >= {imbalance_ratio}x", armed
    if trigger == "spot_pct":
        mv = spot_move_pct(spot, ref_spot)
        if ref_spot > 0 and mv >= spot_pct:
            return f"spot moved {mv:.2f}% >= {spot_pct}% from ref {ref_spot:.1f}", armed
    elif trigger == "delta":
        if max_delta is not None and max_delta >= delta_limit:
            return f"leg delta {max_delta:.2f} >= {delta_limit}", armed
    return None, armed
