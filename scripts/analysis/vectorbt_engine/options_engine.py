"""
VectorBT wrapper around the multi-leg options simulation in
backtest_short_straddle.py.

Deliberately does NOT reimplement the leg simulation (entry/exit timing,
per-leg SL/target/trailing-SL, rolls) — that decision logic is inherently
path-dependent (whether a roll fires on bar N depends on bar N-1's state) and
stays exactly as /backtest already runs it. This module only takes the
resulting per-cycle, per-leg entry/exit prices and feeds them into a single
grouped, cash-shared vbt.Portfolio, so VectorBT computes its own Sharpe/
Sortino/drawdown/tearsheet from the SAME trades — isolating whether two
numbers differ because of decision-making (they won't, by construction) or
stats methodology (they might).

Two known simplifications, both inherited from what /backtest's own JSON
output already exposes (its LegResult has no per-leg timestamp either):
  - A leg's true exit can happen earlier than the cycle's overall exit_dt
    (its own LEG_SL/LEG_TARGET fired mid-day) — every leg in a cycle is
    booked here at that cycle's single entry_dt/exit_dt.
  - Rolls are netted into one synthetic trade per leg-slot per cycle: entry
    price from the first sub-trade, and a solved exit price such that the
    reconstructed trade's gross P&L equals the sum of that leg-slot's actual
    sub-trade P&Ls (vbt needs exactly one entry/exit pair per column per
    timestamp).
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

import pandas as pd
import vectorbt as vbt

from .costs import CostProfile


def _leg_column_name(leg_cfg: dict, index: int) -> str:
    side = "S" if leg_cfg.get("position") == "sell" else "B"
    return f"L{index + 1}_{side}{leg_cfg.get('option_type', '?')}"


def build_leg_frames(
    cycles: List[dict], leg_configs: List[dict], lot_size: int
) -> Optional[Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, List[str], List[float], List[str]]]:
    """Turn /backtest's cycle/leg output into per-leg-column close/entries/exits
    frames for vbt.Portfolio.from_signals. Returns None if no cycle traded."""
    n = len(leg_configs)
    if n == 0:
        return None
    col_names = [_leg_column_name(lc, i) for i, lc in enumerate(leg_configs)]

    events: Dict[str, List[Tuple[pd.Timestamp, float, bool]]] = {c: [] for c in col_names}

    for cyc in cycles:
        if cyc.get("exit_reason") == "NO_ENTRY" or not cyc.get("entry_dt"):
            continue
        legs = cyc.get("legs") or []
        if not legs:
            continue
        entry_dt = pd.Timestamp(cyc["entry_dt"])
        exit_dt = pd.Timestamp(cyc["exit_dt"]) if cyc.get("exit_dt") else entry_dt
        if exit_dt <= entry_dt:
            exit_dt = entry_dt + pd.Timedelta(minutes=1)

        # leg_results is closed_legs (rolls, chunked in leg_configs order per
        # roll) followed by the final active legs, also in leg_configs order —
        # so index % n recovers which configured leg slot each entry belongs to.
        slots: Dict[int, List[dict]] = {i: [] for i in range(n)}
        for j, leg_result in enumerate(legs):
            slots[j % n].append(leg_result)

        for i, sub_trades in slots.items():
            if not sub_trades:
                continue
            leg_cfg = leg_configs[i]
            lots = leg_cfg.get("lots", 1)
            sign = 1 if leg_cfg.get("position") == "sell" else -1
            entry_price = sub_trades[0]["entry_price"]
            total_pnl = sum(st["pnl"] for st in sub_trades)
            denom = lots * lot_size
            exit_price = entry_price - sign * total_pnl / denom if denom else entry_price

            col = col_names[i]
            events[col].append((entry_dt, float(entry_price), True))
            events[col].append((exit_dt, float(exit_price), False))

    if not any(events[c] for c in col_names):
        return None

    all_ts = sorted({ts for c in col_names for ts, _, _ in events[c]})
    idx = pd.DatetimeIndex(all_ts)

    close = pd.DataFrame(index=idx, columns=col_names, dtype=float)
    entries = pd.DataFrame(False, index=idx, columns=col_names)
    exits = pd.DataFrame(False, index=idx, columns=col_names)

    for c in col_names:
        for ts, price, is_entry in events[c]:
            close.loc[ts, c] = price
            if is_entry:
                entries.loc[ts, c] = True
            else:
                exits.loc[ts, c] = True

    close = close.ffill().bfill()

    directions = ["shortonly" if lc.get("position") == "sell" else "longonly" for lc in leg_configs]
    sizes = [float(lc.get("lots", 1)) * lot_size for lc in leg_configs]

    return close, entries, exits, directions, sizes, col_names


def run_vbt_options_portfolio(
    cycles: List[dict],
    leg_configs: List[dict],
    lot_size: int,
    commission_per_lot: float,
    cost_profile: CostProfile,
) -> Optional["vbt.Portfolio"]:
    """Build the combined (grouped, cash-shared) multi-leg vbt.Portfolio, or
    None if nothing traded."""
    built = build_leg_frames(cycles, leg_configs, lot_size)
    if built is None:
        return None
    close, entries, exits, directions, sizes, col_names = built

    # Our engine charges commission_per_lot once per traded leg (a round trip);
    # vbt's fixed_fees is charged per order (entry AND exit), so halve it to
    # land on the same total round-trip cost per leg. `fees` (the cost
    # profile's %-of-turnover statutory charge) is deliberately left at 0 here
    # — our engine has no such charge, so applying it would make the two P&L
    # totals diverge for a cost-model reason, not a decision-engine or
    # stats-methodology one, defeating the point of this comparison.
    fixed_fees = [commission_per_lot / 2.0] * len(col_names)

    return vbt.Portfolio.from_signals(
        close, entries, exits,
        direction=directions,
        size=sizes,
        fixed_fees=fixed_fees,
        fees=0.0,
        init_cash=cost_profile.default_init_cash,
        freq="1D",
        group_by=True,
        cash_sharing=True,
    )


def daily_returns(pf: "vbt.Portfolio") -> pd.Series:
    """Compound the portfolio's irregular event-timestamp returns into one
    return per calendar day (0.0 on days with no event) — the granularity
    OpenStatz's tearsheet and a Dhan daily-close benchmark both expect."""
    raw = pf.returns()
    daily = raw.resample("1D").apply(lambda s: (1.0 + s).prod() - 1.0 if len(s) else 0.0)
    return daily.fillna(0.0)
