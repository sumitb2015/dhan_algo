"""
Indian market transaction cost models for the VectorBT backtest engine.

Ported verbatim from the vectorbt-backtesting-skills package's
rules/indian-market-costs.md (installed under .claude/skills/vectorbt-expert/) —
that rule has no OpenAlgo dependency, it is pure fee arithmetic, so it needed no
adaptation for this repo's Dhan-only data policy.

VectorBT's `fees` is a percentage of turnover applied per side; `fixed_fees` is a
flat amount per order. Every constant below is the pre-computed "statutory %  +
flat brokerage" pair for one segment — pass a `CostProfile` straight into
`vbt.Portfolio.from_signals(..., fees=profile.fees, fixed_fees=profile.fixed_fees)`.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CostProfile:
    name: str
    fees: float          # percentage of turnover, per side (e.g. 0.00111 = 0.111%)
    fixed_fees: float     # flat Rs per order (brokerage)
    default_init_cash: float
    default_freq: str


# Intraday Equity: ~0.0225% statutory + Rs 20/order brokerage
INTRADAY_EQUITY = CostProfile("Intraday Equity", fees=0.000225, fixed_fees=20,
                               default_init_cash=1_000_000, default_freq="5min")

# Delivery Equity (CNC): ~0.111% statutory (STT dominates) + Rs 20/order
DELIVERY_EQUITY = CostProfile("Delivery Equity", fees=0.00111, fixed_fees=20,
                               default_init_cash=1_000_000, default_freq="1D")

# F&O Futures: ~0.018% statutory + Rs 20/order — cheapest segment, best for
# high-frequency systems
FNO_FUTURES = CostProfile("F&O Futures", fees=0.00018, fixed_fees=20,
                           default_init_cash=3_000_000, default_freq="1D")

# F&O Options: ~0.098% statutory (sell-side STT dominates) + Rs 20/order
FNO_OPTIONS = CostProfile("F&O Options", fees=0.00098, fixed_fees=20,
                           default_init_cash=500_000, default_freq="1D")

PROFILES = {
    "intraday_equity": INTRADAY_EQUITY,
    "delivery_equity": DELIVERY_EQUITY,
    "fno_futures": FNO_FUTURES,
    "fno_options": FNO_OPTIONS,
}


def get_profile(name: str) -> CostProfile:
    """Look up a CostProfile by key (see PROFILES for valid names)."""
    try:
        return PROFILES[name]
    except KeyError:
        raise ValueError(f"Unknown cost profile {name!r}; choose from {sorted(PROFILES)}") from None


# ─────────────────────────────────────────────────────────────────────────────
# Exact per-trade breakdowns, for users who want the precise Rupee figure rather
# than the simplified percentage VectorBT consumes. Not used by engine.py itself.
# ─────────────────────────────────────────────────────────────────────────────

def calculate_charges_intraday_eq(buy_value: float, sell_value: float) -> float:
    turnover = buy_value + sell_value
    brokerage = min(20, 0.0003 * buy_value) + min(20, 0.0003 * sell_value)
    stt = 0.00025 * sell_value
    exchange_txn = 0.0000307 * turnover
    gst = 0.18 * (brokerage + exchange_txn)
    sebi = 0.000001 * turnover
    stamp = 0.00003 * buy_value
    return brokerage + stt + exchange_txn + gst + sebi + stamp


def calculate_charges_delivery_eq(buy_value: float, sell_value: float) -> float:
    turnover = buy_value + sell_value
    brokerage = 0.0
    stt = 0.001 * turnover
    exchange_txn = 0.0000307 * turnover
    gst = 0.18 * (brokerage + exchange_txn)
    sebi = 0.000001 * turnover
    stamp = 0.00015 * buy_value
    return brokerage + stt + exchange_txn + gst + sebi + stamp


def calculate_charges_futures(buy_value: float, sell_value: float) -> float:
    turnover = buy_value + sell_value
    brokerage = 20 + 20
    stt = 0.0002 * sell_value
    exchange_txn = 0.0000183 * turnover
    gst = 0.18 * (brokerage + exchange_txn)
    sebi = 0.000001 * turnover
    stamp = 0.00002 * buy_value
    return brokerage + stt + exchange_txn + gst + sebi + stamp


def calculate_charges_options(buy_value: float, sell_value: float) -> float:
    turnover = buy_value + sell_value
    brokerage = 20 + 20
    stt = 0.001 * sell_value
    exchange_txn = 0.0003553 * turnover
    gst = 0.18 * (brokerage + exchange_txn)
    sebi = 0.000001 * turnover
    stamp = 0.00003 * buy_value
    return brokerage + stt + exchange_txn + gst + sebi + stamp
