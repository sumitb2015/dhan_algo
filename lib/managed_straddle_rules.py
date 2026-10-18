"""Pure decision rules for Nifty Managed Straddle.

Shared between live execution and backtests. No broker, clock, or I/O.
Every function is pure and unit-testable.
"""
from typing import Any, Dict, List, Optional, Tuple, Union
import pandas as pd


def atm_strike(spot: float, step: int = 50) -> int:
    """Calculate the nearest ATM strike for a given spot price and strike step."""
    if spot <= 0 or step <= 0:
        return 0
    return int(round(spot / step) * step)


def atm_imbalance_pct(ce_price: float, pe_price: float) -> float:
    """Calculate percentage difference between ATM CE and PE premiums.
    
    Returns:
        abs(CE - PE) / max(CE, PE) * 100.0
    """
    if ce_price <= 0 or pe_price <= 0:
        return 100.0
    hi = max(ce_price, pe_price)
    return abs(ce_price - pe_price) / hi * 100.0


def is_atm_balanced(ce_price: float, pe_price: float, threshold_pct: float = 10.0) -> bool:
    """Check if the difference between ATM CE and PE prices is strictly less than threshold_pct."""
    if ce_price <= 0 or pe_price <= 0:
        return False
    return atm_imbalance_pct(ce_price, pe_price) < threshold_pct


def combined_sl_hit(ce_ltp: float, pe_ltp: float, combined_p0: float, sl_pct: float = 20.0) -> bool:
    """Check if the combined straddle premium has expanded by sl_pct (default 20%)."""
    if combined_p0 <= 0 or ce_ltp <= 0 or pe_ltp <= 0:
        return False
    threshold = combined_p0 * (1.0 + sl_pct / 100.0)
    return (ce_ltp + pe_ltp) >= threshold


def leg_sl_hit(ltp: float, entry_price: float, sl_pct: float = 20.0) -> bool:
    """Check if a short leg price has risen by sl_pct (default 20%) above its entry price."""
    if entry_price <= 0 or ltp <= 0:
        return False
    sl_level = entry_price * (1.0 + sl_pct / 100.0)
    return ltp >= sl_level


def leg_target_hit(ltp: float, entry_price: float, target_pct: float = 30.0) -> bool:
    """Check if a short leg price has decayed by target_pct (default 30%) from its entry price."""
    if entry_price <= 0 or ltp <= 0:
        return False
    target_level = entry_price * (1.0 - target_pct / 100.0)
    return ltp <= target_level


def is_inverted(ce_strike: int, pe_strike: int) -> bool:
    """Check if strikes have crossed/inverted (CE strike <= PE strike)."""
    return ce_strike <= pe_strike


def find_match_strike(
    chain_data: Union[pd.DataFrame, List[Dict[str, Any]]],
    opt_type: str,
    target_premium: float,
    avoid_strike: Optional[int] = None,
    non_inverted_with: Optional[Tuple[str, int]] = None,
) -> Tuple[Optional[int], float, Optional[str]]:
    """Find the strike for opt_type whose current premium is closest to target_premium.
    
    Args:
        chain_data: DataFrame with strike index or list of dicts.
        opt_type: "CE" or "PE".
        target_premium: The premium level to match (from the opposite surviving leg).
        avoid_strike: Optional strike to exclude (e.g. current strike if rolling).
        non_inverted_with: Optional tuple (other_type, other_strike). If specified,
                           filters strikes to prevent inversion:
                           if opt_type == 'CE', new strike > other_strike
                           if opt_type == 'PE', new strike < other_strike
                           
    Returns:
        (best_strike, best_price, security_id) or (None, 0.0, None)
    """
    if target_premium <= 0:
        return None, 0.0, None

    prefix = opt_type.lower()
    price_col = f"{prefix}_last_price"
    sec_id_col = f"{prefix}_security_id"

    candidates: List[Tuple[int, float, Optional[str], float]] = []

    if isinstance(chain_data, pd.DataFrame):
        if chain_data.empty or price_col not in chain_data.columns:
            return None, 0.0, None
        
        for strike_val, row in chain_data.iterrows():
            strike = int(round(float(strike_val)))
            price = float(row.get(price_col, 0.0) or 0.0)
            sec_id = str(row.get(sec_id_col, "")) if sec_id_col in row else None
            
            if price <= 0:
                continue
            if avoid_strike is not None and strike == avoid_strike:
                continue
            if non_inverted_with is not None:
                other_type, other_strike = non_inverted_with
                if opt_type == "CE" and strike <= other_strike:
                    continue
                if opt_type == "PE" and strike >= other_strike:
                    continue
            diff = abs(price - target_premium)
            candidates.append((strike, price, sec_id, diff))
    else:
        for rec in chain_data:
            strike = int(round(float(rec.get("strike", 0))))
            row_type = str(rec.get("option_type", rec.get("opt_type", ""))).upper()
            if row_type and row_type != opt_type:
                continue
            price = float(rec.get("price", rec.get("last_price", rec.get("ltp", 0.0))) or 0.0)
            sec_id = str(rec.get("security_id", rec.get("id", ""))) if rec.get("security_id") or rec.get("id") else None

            if price <= 0:
                continue
            if avoid_strike is not None and strike == avoid_strike:
                continue
            if non_inverted_with is not None:
                other_type, other_strike = non_inverted_with
                if opt_type == "CE" and strike <= other_strike:
                    continue
                if opt_type == "PE" and strike >= other_strike:
                    continue
            diff = abs(price - target_premium)
            candidates.append((strike, price, sec_id, diff))

    if not candidates:
        return None, 0.0, None

    # Sort by smallest absolute premium difference
    candidates.sort(key=lambda x: x[3])
    best = candidates[0]
    return best[0], best[1], best[2]
