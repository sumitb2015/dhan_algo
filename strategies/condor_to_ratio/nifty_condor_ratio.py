"""
Nifty Iron Condor to Ratio Spread Strategy — structural regime transition.

UNVALIDATED — dry-run default. Sourced from YouTube video:
"What If the Iron Condor Starts Trending? | Ratio Spread Strategy" (https://www.youtube.com/watch?v=T4gvTshMEyA&t=1609s).
--live requires --i-understand-this-is-unvalidated, same convention as intraday_equity/volcano_calendar/put_condor.

Starts with a neutral monthly Iron Condor (Sell 0.30 Delta Call & Put, Buy 0.10 Delta Call & Put hedges).
Instead of continuously adjusting the Iron Condor when facing a strong directional trend, the strategy
changes structure and moves from Iron Condor -> Directional Ratio Spread when a short leg decays to <= 0.10 Delta:
  - Downward trend (Call short leg <= 0.10 Delta): Exit Condor -> Call Ratio Spread (Buy 0.50 Delta, Sell 2x 0.40 Delta, Buy 0.10 Delta hedge).
  - Upward trend (Put short leg <= 0.10 Delta): Exit Condor -> Put Ratio Spread (Buy 0.50 Delta, Sell 2x 0.40 Delta, Buy 0.10 Delta hedge).
  - Trend continuation: Combined sold leg delta drops to <= 0.20 -> Shift to less aggressive Ratio Spread (Buy 0.40, Sell 2x 0.30, Buy 0.08 hedge).
  - Trend reversal: Combined sold leg delta rises to >= 1.20 -> Exit and switch direction to opposite Ratio Spread.

Implements the standard kit from the dhan-new-strategy skill:
  - Dry run default, live safety gate.
  - Multi-broker support (Dhan, Zerodha, Kotak).
  - Atomic position persistence (debug/<key>_position.json) and startup broker reconciliation.
  - Dashboard state bridge (debug/<key>_state.json) and graceful shutdown trigger.
  - Longs/hedges placed before shorts on entry; shorts closed before longs on exit.
  - Safe exit sizing using resolve_exit_qty_broker().
  - Continuous P&L accounting across rolls, trailing stop loss, and monthly expiry management.
"""

import argparse
import math
import os
import sys
import time
from collections import defaultdict
from datetime import date, datetime
import pandas as pd


def _find_project_root(start: str) -> str:
    d = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(d, "login.py")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            raise RuntimeError("Could not locate project root (login.py)")
        d = parent


project_root = _find_project_root(os.path.dirname(__file__))
sys.path.insert(0, project_root)

from login import get_dhan_client  # noqa: E402
from lib.dhan_helper import DhanHelper  # noqa: E402
from lib.options_pricing import greeks_from_days  # noqa: E402
from lib.strategy_state_helper import (  # noqa: E402
    check_shutdown_trigger, exit_if_market_closed, flush_state,
    instance_log_suffix, parse_target_spec, save_strategy_state,
)
from lib.strategy_risk import resolve_exit_qty_broker  # noqa: E402
from lib.execution_broker import ExecutionBroker, ExecutionBrokerError  # noqa: E402
from lib.telegram_alert import notify  # noqa: E402
from lib.algo_kit import PositionStore, confirmed_fill_price, setup_strategy_logging, update_trail  # noqa: E402

STRATEGY_KEY_DEFAULT = "nifty_condor_ratio"
LOG_FOLDER = "condor_ratio"
UNDERLYING = "NIFTY"
INDEX_ID = "13"
STRIKE_STEP_DEFAULT = 50

# Stages
STAGE_FLAT = "FLAT"
STAGE_CONDOR = "CONDOR"
STAGE_RATIO = "RATIO"

debug_dir = os.path.join(project_root, "debug")
logger = setup_strategy_logging(project_root, LOG_FOLDER, instance_log_suffix(), name=__name__, force=True)


# ── Pure decision logic: no broker, no clock, no I/O. Unit-test these. ──────────────────────────

# Greeks come from lib/options_pricing.py (parity-tested port of the dashboard's optionsPricing.ts); this strategy only picks its own
# expiry floor and the IV used when a chain row carries none.
MIN_DTE_DAYS = 0.5
DEFAULT_IV = 0.15


def pick_leg_by_delta(chain_df: pd.DataFrame, spot: float, dte_days: float, opt_type: str,
                       target_delta: float, strike_step: int = STRIKE_STEP_DEFAULT) -> tuple:
    """Finds strike with delta magnitude closest to target_delta.
    Priority 1: live chain_df delta columns ('ce_delta' / 'pe_delta').
    Priority 2: Black-Scholes fallback delta.
    Returns (strike: int, quote_price: float, delta: float)."""
    prefix = opt_type.lower()
    delta_col = f"{prefix}_delta"
    price_col = f"{prefix}_last_price"

    has_live_greeks = (
        chain_df is not None and not chain_df.empty
        and delta_col in chain_df.columns
        and price_col in chain_df.columns
    )

    if has_live_greeks:
        valid_df = chain_df[chain_df[delta_col].notna() & (chain_df[delta_col] != 0)].copy()
        if not valid_df.empty:
            valid_df["diff"] = (valid_df[delta_col].abs() - target_delta).abs()
            best = valid_df.sort_values("diff").iloc[0]
            try:
                k = int(float(best.name))
                px = float(best.get(price_col, 0.0))
                d = float(best[delta_col])
                return k, px, d
            except Exception:
                pass

    # Fallback to generated strike ladder with Black-Scholes
    atm = int(round(spot / strike_step) * strike_step)
    candidate_strikes = [atm + i * strike_step for i in range(-40, 41)]
    best_strike = atm
    best_diff = 999.0
    best_delta = 0.5

    for k in candidate_strikes:
        if k <= 0:
            continue
        # For CE, target delta is positive; for PE, magnitude |delta|
        d = greeks_from_days(opt_type, spot, k, dte_days, DEFAULT_IV, min_days=MIN_DTE_DAYS).delta
        diff = abs(abs(d) - target_delta)
        if diff < best_diff:
            best_diff = diff
            best_strike = k
            best_delta = d

    # Estimate price from chain if available, else approximate intrinsic
    px = 0.0
    if chain_df is not None and not chain_df.empty and price_col in chain_df.columns:
        if best_strike in chain_df.index:
            try:
                px = float(chain_df.loc[best_strike, price_col])
            except Exception:
                pass
    if px <= 0:
        intrinsic = max(0.0, spot - best_strike) if opt_type.upper() == "CE" else max(0.0, best_strike - spot)
        px = max(intrinsic, 10.0)

    return best_strike, px, best_delta


def choose_iron_condor_strikes(chain_df: pd.DataFrame, spot: float, dte_days: float,
                                short_delta: float = 0.30, hedge_delta: float = 0.10,
                                strike_step: int = STRIKE_STEP_DEFAULT) -> dict:
    """Selects strikes for a 4-leg Iron Condor:
    Sell 0.30 Delta Call & Put, Buy 0.10 Delta Call & Put hedges.
    Guarantees strict monotonic order: pe_hedge < pe_short < ce_short < ce_hedge."""
    ce_short, ce_short_px, ce_short_d = pick_leg_by_delta(chain_df, spot, dte_days, "CE", short_delta, strike_step)
    pe_short, pe_short_px, pe_short_d = pick_leg_by_delta(chain_df, spot, dte_days, "PE", short_delta, strike_step)
    ce_hedge, ce_hedge_px, ce_hedge_d = pick_leg_by_delta(chain_df, spot, dte_days, "CE", hedge_delta, strike_step)
    pe_hedge, pe_hedge_px, pe_hedge_d = pick_leg_by_delta(chain_df, spot, dte_days, "PE", hedge_delta, strike_step)

    # Enforce strictly monotonic strike ladder
    if pe_short >= ce_short:
        atm = int(round(spot / strike_step) * strike_step)
        pe_short = atm - strike_step
        ce_short = atm + strike_step

    if pe_hedge >= pe_short:
        pe_hedge = pe_short - 2 * strike_step

    if ce_hedge <= ce_short:
        ce_hedge = ce_short + 2 * strike_step

    return {
        "ce_short": {"strike": ce_short, "price": ce_short_px, "delta": ce_short_d},
        "pe_short": {"strike": pe_short, "price": pe_short_px, "delta": pe_short_d},
        "ce_hedge": {"strike": ce_hedge, "price": ce_hedge_px, "delta": ce_hedge_d},
        "pe_hedge": {"strike": pe_hedge, "price": pe_hedge_px, "delta": pe_hedge_d},
    }


def choose_ratio_strikes(chain_df: pd.DataFrame, spot: float, dte_days: float, direction: str,
                         long_delta: float = 0.50, short_delta: float = 0.40, hedge_delta: float = 0.10,
                         strike_step: int = STRIKE_STEP_DEFAULT) -> dict:
    """Selects strikes for a 3-leg Ratio Spread:
    Buy 1x 0.50 Delta (ATM), Sell 2x 0.40 Delta (OTM), Buy 1x 0.10 Delta (Far OTM hedge).
    If direction == 'BEARISH': uses Call options. Order: long_strike < short_strike < hedge_strike.
    If direction == 'BULLISH': uses Put options. Order: long_strike > short_strike > hedge_strike."""
    opt_type = "CE" if direction == "BEARISH" else "PE"

    long_k, long_px, long_d = pick_leg_by_delta(chain_df, spot, dte_days, opt_type, long_delta, strike_step)
    short_k, short_px, short_d = pick_leg_by_delta(chain_df, spot, dte_days, opt_type, short_delta, strike_step)
    hedge_k, hedge_px, hedge_d = pick_leg_by_delta(chain_df, spot, dte_days, opt_type, hedge_delta, strike_step)

    if opt_type == "CE":
        if short_k <= long_k:
            short_k = long_k + strike_step
        if hedge_k <= short_k:
            hedge_k = short_k + 2 * strike_step
    else:
        if short_k >= long_k:
            short_k = long_k - strike_step
        if hedge_k >= short_k:
            hedge_k = short_k - 2 * strike_step

    return {
        "opt_type": opt_type,
        "direction": direction,
        "long_leg": {"strike": long_k, "price": long_px, "delta": long_d},
        "short_leg": {"strike": short_k, "price": short_px, "delta": short_d},
        "hedge_leg": {"strike": hedge_k, "price": hedge_px, "delta": hedge_d},
    }


def choose_ratio_shift_strikes(chain_df: pd.DataFrame, spot: float, dte_days: float, direction: str,
                               long_delta: float = 0.40, short_delta: float = 0.30, hedge_delta: float = 0.08,
                               strike_step: int = STRIKE_STEP_DEFAULT) -> dict:
    """Selects strikes for a continuation shifted Ratio Spread (less aggressive strikes):
    Buy 1x 0.40 Delta, Sell 2x 0.30 Delta, Buy 1x 0.08 Delta hedge."""
    return choose_ratio_strikes(chain_df, spot, dte_days, direction,
                                long_delta=long_delta, short_delta=short_delta,
                                hedge_delta=hedge_delta, strike_step=strike_step)


def get_live_or_bs_delta(chain_df: pd.DataFrame, spot: float, strike: float, dte_days: float, opt_type: str = "CE") -> float:
    """Returns delta from live option chain if available and valid; otherwise computes Black-Scholes delta."""
    prefix = opt_type.lower()
    col = f"{prefix}_delta"
    if chain_df is not None and not chain_df.empty and col in chain_df.columns:
        if strike in chain_df.index:
            try:
                val = chain_df.loc[strike, col]
                if pd.notna(val) and float(val) != 0:
                    return float(val)
            except Exception:
                pass
    return greeks_from_days(opt_type, spot, strike, dte_days, DEFAULT_IV, min_days=MIN_DTE_DAYS).delta


def check_condor_trigger(ce_short_delta: float, pe_short_delta: float, trigger_delta: float = 0.10) -> str:
    """When a short leg of the Iron Condor decays to <= trigger_delta, the market has trended strongly:
    - If CE short decayed to <= 0.10: Market moved DOWN -> returns 'BEARISH'.
    - If PE short decayed to <= 0.10: Market moved UP -> returns 'BULLISH'.
    Otherwise returns None."""
    if abs(ce_short_delta) <= trigger_delta:
        return "BEARISH"
    if abs(pe_short_delta) <= trigger_delta:
        return "BULLISH"
    return None


def check_ratio_shift_trigger(short_delta_per_lot: float, trigger_delta: float = 0.10) -> bool:
    """Trend continuation: if the sold leg delta drops to <= trigger_delta (e.g. 0.10 single leg,
    or 0.20 combined across 2 sold lots), trigger a shift roll in the same direction."""
    return abs(short_delta_per_lot) <= trigger_delta


def check_ratio_reversal_trigger(short_delta_per_lot: float, trigger_delta: float = 0.60) -> bool:
    """Trend reversal: if the sold leg delta rises to >= trigger_delta (e.g. 0.60 single leg,
    or 1.20 combined across 2 sold lots), trigger a reversal flip to the opposite side."""
    return abs(short_delta_per_lot) >= trigger_delta


def monthly_expiries(expiries: list) -> list:
    """Last listed expiry in each calendar month (the monthly contract). No weekday assumed."""
    by_month = defaultdict(list)
    for e in expiries or []:
        try:
            d = datetime.strptime(e, "%Y-%m-%d").date()
        except (ValueError, TypeError):
            continue
        by_month[(d.year, d.month)].append(d)
    return [d.strftime("%Y-%m-%d") for d in sorted(max(v) for v in by_month.values())]


def pick_cycle_expiry(expiries: list, today: date, min_dte: int, max_dte: int,
                      expiry_type: str = "monthly", skip_expiry: str = None) -> str:
    """Picks eligible contract expiry inside [min_dte, max_dte]."""
    candidates = monthly_expiries(expiries) if expiry_type == "monthly" else sorted(expiries or [])
    for e in candidates:
        if e == skip_expiry:
            continue
        try:
            d = datetime.strptime(e, "%Y-%m-%d").date()
            dte = (d - today).days
            if min_dte <= dte <= max_dte:
                return e
        except Exception:
            continue
    # Fallback to first available candidate if within max_dte
    for e in candidates:
        try:
            d = datetime.strptime(e, "%Y-%m-%d").date()
            if (d - today).days >= 1:
                return e
        except Exception:
            continue
    return None


# ── Strategy Implementation ───────────────────────────────────────────────────────────────────

class NiftyCondorToRatioStrategy:
    def __init__(
        self,
        dry_run: bool = True,
        lots: int = 1,
        target: tuple = (15.0, True),     # (value, is_pct)
        stop: tuple = (15.0, True),       # (value, is_pct)
        condor_short_delta: float = 0.30,
        condor_hedge_delta: float = 0.10,
        condor_exit_delta: float = 0.10,
        ratio_long_delta: float = 0.50,
        ratio_short_delta: float = 0.40,
        ratio_hedge_delta: float = 0.10,
        ratio_shift_delta: float = 0.10,   # 0.20 combined (0.10 * 2)
        ratio_reversal_delta: float = 0.60, # 1.20 combined (0.60 * 2)
        shift_long_delta: float = 0.40,
        shift_short_delta: float = 0.30,
        shift_hedge_delta: float = 0.08,
        max_shifts: int = 5,
        max_reversals: int = 3,
        trail_start_rs: float = 5000.0,
        trail_gap_rs: float = 2500.0,
        expiry_type: str = "monthly",
        min_dte: int = 15,
        max_dte: int = 45,
        start_time: str = "09:20",
        entry_end: str = "15:00",
        eod_exit_time: str = "15:15",
        strike_step: int = STRIKE_STEP_DEFAULT,
        state_key: str = STRATEGY_KEY_DEFAULT,
        broker: str = "dhan",
        product: str = "MARGIN",
    ):
        self.state_key = state_key
        self.broker_name = broker
        self.dry_run = dry_run
        self.lots = lots
        self.product = product
        self.strike_step = strike_step

        self.target_val, self.target_is_pct = target
        self.stop_val, self.stop_is_pct = stop
        self.trail_start_rs = trail_start_rs
        self.trail_gap_rs = trail_gap_rs

        self.condor_short_delta = condor_short_delta
        self.condor_hedge_delta = condor_hedge_delta
        self.condor_exit_delta = condor_exit_delta
        self.ratio_long_delta = ratio_long_delta
        self.ratio_short_delta = ratio_short_delta
        self.ratio_hedge_delta = ratio_hedge_delta
        self.ratio_shift_delta = ratio_shift_delta
        self.ratio_reversal_delta = ratio_reversal_delta
        self.shift_long_delta = shift_long_delta
        self.shift_short_delta = shift_short_delta
        self.shift_hedge_delta = shift_hedge_delta
        self.max_shifts = max_shifts
        self.max_reversals = max_reversals

        self.expiry_type = expiry_type
        self.min_dte = min_dte
        self.max_dte = max_dte
        self.start_time = start_time
        self.entry_end = entry_end
        self.eod_exit_time = eod_exit_time

        self.dhan = get_dhan_client()
        if not self.dhan:
            raise RuntimeError("Failed to connect to Dhan API client.")
        self.helper = DhanHelper(self.dhan)

        try:
            self.broker = ExecutionBroker.create(broker, self.helper, underlying=UNDERLYING, log=logger.info)
        except ExecutionBrokerError as e:
            logger.error(f"Could not initialize {broker} execution broker: {e}")
            sys.exit(1)

        self.helper.start_websocket([("IDX_I", INDEX_ID, 15)])
        time.sleep(2)
        self.lot_size = self.helper.get_lot_size(UNDERLYING)

        self._reset_position_state()
        self.load_position()

    def _reset_position_state(self):
        self.position_open = False
        self.stage = STAGE_FLAT
        self.direction = None
        self.status = "WAITING"
        self.expiry = None
        self.legs = {}  # leg_name: {id, strike, opt_type, side, qty, avg_price, delta}
        self.realized_pnl = 0.0
        self.entry_capital_base = 0.0
        self.target_rs = None if self.target_is_pct else self.target_val
        self.stop_rs = None if self.stop_is_pct else -abs(self.stop_val)
        self.trail_active = False
        self.best_pnl = 0.0
        self.shifts_count = 0
        self.reversals_count = 0
        self.last_cycle_expiry = None
        self.pause_until = 0.0

    @property
    def position_path(self) -> str:
        return os.path.join(debug_dir, f"{self.state_key}_position.json")

    def _position_store(self) -> PositionStore:
        return PositionStore(self.position_path, self.dry_run, log=logger)

    def save_position(self):
        """Atomically persist state for crash recovery (PositionStore)."""
        self._position_store().save({
            "position_open": self.position_open,
            "stage": self.stage,
            "direction": self.direction,
            "status": self.status,
            "expiry": self.expiry,
            "lots": self.lots,
            "lot_size": self.lot_size,
            "product": self.product,
            "legs": self.legs,
            "realized_pnl": self.realized_pnl,
            "entry_capital_base": self.entry_capital_base,
            "target_rs": self.target_rs,
            "stop_rs": self.stop_rs,
            "trail_active": self.trail_active,
            "best_pnl": self.best_pnl,
            "shifts_count": self.shifts_count,
            "reversals_count": self.reversals_count,
            "last_cycle_expiry": self.last_cycle_expiry,
        })

    def load_position(self):
        # PositionStore raises PositionFileError (never trade blind) on an unreadable file or an open
        # position saved by the other mode (paper vs live). This strategy has no expiry field to guard on.
        data = self._position_store().load(expiry_field=None)
        if data is None:
            return

        if not data.get("position_open"):
            self.last_cycle_expiry = data.get("last_cycle_expiry")
            return
        self.position_open = True
        self.stage = data.get("stage", STAGE_CONDOR)
        self.direction = data.get("direction")
        self.status = data.get("status", "RUNNING")
        self.expiry = data.get("expiry")
        self.lot_size = int(data.get("lot_size") or self.lot_size)
        self.product = data.get("product", self.product)
        self.legs = data.get("legs", {})
        self.realized_pnl = float(data.get("realized_pnl", 0.0))
        self.entry_capital_base = float(data.get("entry_capital_base", 0.0))
        self.target_rs = data.get("target_rs")
        self.stop_rs = data.get("stop_rs")
        self.trail_active = bool(data.get("trail_active"))
        self.best_pnl = float(data.get("best_pnl", 0.0))
        self.shifts_count = int(data.get("shifts_count", 0))
        self.reversals_count = int(data.get("reversals_count", 0))
        self.last_cycle_expiry = data.get("last_cycle_expiry")

        logger.info(f"Restored open position: stage={self.stage} direction={self.direction} "
                    f"expiry={self.expiry} legs={len(self.legs)} realized={self.realized_pnl:+.2f}")

        # Resubscribe all legs to WebSocket
        sub_list = []
        for leg in self.legs.values():
            if leg and leg.get("id"):
                sub_list.append(("NSE_FNO", str(leg["id"]), 15))
        if sub_list:
            try:
                self.helper.subscribe_instruments(sub_list)
            except Exception as e:
                logger.error(f"Resubscribe instruments error: {e}")

        self._reconcile_against_broker()

    def _reconcile_against_broker(self):
        if self.dry_run:
            return
        mismatch = False
        for leg_name, leg in self.legs.items():
            if not leg:
                continue
            try:
                net = self.broker.get_owned_net_qty(leg["strike"], self.expiry, leg["opt_type"])
                expected = leg["qty"] if leg["side"] == "BUY" else -leg["qty"]
                if net != expected:
                    mismatch = True
                    logger.warning(f"Reconcile MISMATCH for {leg_name} ({leg['opt_type']} {leg['strike']}): "
                                   f"expected {expected}, broker shows {net}")
            except Exception as e:
                logger.warning(f"Reconcile could not check {leg_name}: {e}")
        if mismatch:
            logger.error("Position does not match live broker truth. Reconcile manually before restarting.")
            sys.exit(1)

    # ── Market Data & Fills ────────────────────────────────────────────────────────────────────

    def _get_quote(self, strike: int, opt_type: str) -> tuple:
        """Returns (security_id, last_price). Returns (None, 0.0) on failure."""
        q = self.helper.option(UNDERLYING, strike, opt_type)
        if not q or not isinstance(q, dict) or "CONTRACT_INFO" not in q:
            return None, 0.0
        price = float(q.get("last_price", 0.0) or q.get("LTP", 0.0))
        return (int(q["CONTRACT_INFO"]["SECURITY_ID"]), price) if price > 0 else (None, 0.0)

    def _fill_price(self, order_id: str, fallback: float) -> float:
        return confirmed_fill_price(self.helper, order_id, fallback, timeout=8, log=logger, raise_errors=True)

    def _ltp(self, leg: dict) -> float:
        if not leg or not leg.get("id"):
            return 0.0
        return self.helper.get_ltp(str(leg["id"]), exchange="NSE_FNO", instrument="OPTIDX")

    # ── Orders (Checks every fill, rolls back on partial) ───────────────────────────────────────

    def _place_order(self, side: str, strike: int, opt_type: str, qty: int, quote_price: float):
        """Places Buy or Sell order. Returns fill price on success, None on failure."""
        if self.dry_run:
            return quote_price
        if side == "BUY":
            oid = self.broker.buy(strike, self.expiry, opt_type, qty, product=self.product)
        else:
            oid = self.broker.sell(strike, self.expiry, opt_type, qty, product=self.product)
        return self._fill_price(oid, quote_price) if oid else None

    def _buy_to_close(self, leg: dict) -> tuple:
        """Closes a short leg safely. Returns (closed: bool, exit_price: float)."""
        ltp = self._ltp(leg)
        if self.dry_run:
            return True, ltp
        try:
            qty, _ = resolve_exit_qty_broker(self.broker, leg["strike"], self.expiry, leg["opt_type"],
                                             leg["qty"], "BUY", logger)
            if qty <= 0:
                return True, ltp
            oid = self.broker.buy(leg["strike"], self.expiry, leg["opt_type"], qty, product=self.product)
            if not oid or not self.helper.wait_for_fill(oid, timeout=8):
                logger.critical(f"Close FAILED for short {leg['opt_type']} {leg['strike']}")
                return False, ltp
            return True, self._fill_price(oid, ltp)
        except Exception as e:
            logger.error(f"Error closing short {leg['opt_type']} {leg['strike']}: {e}")
            return False, ltp

    def _sell_to_close(self, leg: dict) -> tuple:
        """Closes a long leg safely. Returns (closed: bool, exit_price: float)."""
        ltp = self._ltp(leg)
        if self.dry_run:
            return True, ltp
        try:
            qty, _ = resolve_exit_qty_broker(self.broker, leg["strike"], self.expiry, leg["opt_type"],
                                             leg["qty"], "SELL", logger)
            if qty <= 0:
                return True, ltp
            oid = self.broker.sell(leg["strike"], self.expiry, leg["opt_type"], qty, product=self.product)
            if not oid or not self.helper.wait_for_fill(oid, timeout=8):
                logger.critical(f"Close FAILED for long {leg['opt_type']} {leg['strike']}")
                return False, ltp
            return True, self._fill_price(oid, ltp)
        except Exception as e:
            logger.error(f"Error closing long {leg['opt_type']} {leg['strike']}: {e}")
            return False, ltp

    def exit_all(self, reason: str) -> bool:
        """Closes all active legs. Shorts are closed first to keep hedges intact until shorts are flat.
        Returns True if all legs confirmed closed."""
        logger.warning(f"!!! EXITING ALL LEGS: {reason} !!!")
        all_closed = True

        # Sort order: close SELL legs first, then BUY legs
        sorted_leg_names = sorted(
            list(self.legs.keys()),
            key=lambda name: 0 if self.legs[name] and self.legs[name].get("side") == "SELL" else 1
        )

        for name in sorted_leg_names:
            leg = self.legs.get(name)
            if not leg:
                continue
            if leg["side"] == "SELL":
                closed, px = self._buy_to_close(leg)
                if closed:
                    self.realized_pnl += (leg["avg_price"] - px) * leg["qty"]
                    self.legs[name] = None
                else:
                    all_closed = False
            else:
                closed, px = self._sell_to_close(leg)
                if closed:
                    self.realized_pnl += (px - leg["avg_price"]) * leg["qty"]
                    self.legs[name] = None
                else:
                    all_closed = False

        if all_closed:
            self.legs = {}
            self.position_open = False
            self.stage = STAGE_FLAT
            self.status = "WAITING"
            self.trail_active = False
            self.best_pnl = 0.0
            notify(f"[{self.state_key}] Exited all: {reason} | Realized P&L: {self.realized_pnl:+.2f}")
        else:
            self.status = "FLATTENING"

        self.save_position()
        return all_closed

    # ── Entry Implementations ──────────────────────────────────────────────────────────────────

    def enter_iron_condor(self, spot: float, chain_df: pd.DataFrame, dte_days: float) -> bool:
        """Enters initial neutral Iron Condor.
        Order: Long hedges first (ce_hedge, pe_hedge), then short legs (ce_short, pe_short)."""
        logger.info(f"Setting up Initial Iron Condor at Spot={spot:.2f}, Expiry={self.expiry}...")
        strikes = choose_iron_condor_strikes(chain_df, spot, dte_days,
                                             short_delta=self.condor_short_delta,
                                             hedge_delta=self.condor_hedge_delta,
                                             strike_step=self.strike_step)

        # Quotes resolution
        legs_to_order = [
            ("ce_hedge", "BUY", strikes["ce_hedge"]["strike"], "CE", 1),
            ("pe_hedge", "BUY", strikes["pe_hedge"]["strike"], "PE", 1),
            ("ce_short", "SELL", strikes["ce_short"]["strike"], "CE", 1),
            ("pe_short", "SELL", strikes["pe_short"]["strike"], "PE", 1),
        ]

        quotes = {}
        for name, side, strike, opt_type, mult in legs_to_order:
            sid, px = self._get_quote(strike, opt_type)
            if not sid or px <= 0:
                logger.warning(f"Could not fetch quote for {opt_type} {strike}. Skipping entry this tick.")
                return False
            quotes[name] = (sid, px)

        qty = self.lots * self.lot_size
        filled_legs = {}

        # Mark unwinding in position file in case process dies mid-entry
        self.status = "UNWINDING"
        self.save_position()

        # Place orders in defined order
        for name, side, strike, opt_type, mult in legs_to_order:
            sid, quote_px = quotes[name]
            fill_px = self._place_order(side, strike, opt_type, qty, quote_px)
            if fill_px is None:
                logger.critical(f"Order FAILED for {side} {opt_type} {strike}! Rolling back entry...")
                remaining_legs = {}
                for fname, fleg in filled_legs.items():
                    if fleg["side"] == "BUY":
                        closed, _ = self._sell_to_close(fleg)
                    else:
                        closed, _ = self._buy_to_close(fleg)
                    if not closed:
                        remaining_legs[fname] = fleg

                if remaining_legs:
                    self.legs = remaining_legs
                    self.position_open = True
                    self.status = "UNWINDING"
                else:
                    self.legs = {}
                    self.position_open = False
                    self.status = "WAITING"
                self.save_position()
                return False

            delta_val = strikes[name]["delta"]
            filled_legs[name] = {
                "id": sid,
                "strike": strike,
                "opt_type": opt_type,
                "side": side,
                "qty": qty,
                "avg_price": fill_px,
                "delta": delta_val,
            }

        # Commit position
        self.legs = filled_legs
        self.position_open = True
        self.stage = STAGE_CONDOR
        self.direction = None
        self.status = "RUNNING"

        # Subscribe WebSocket
        sub_list = [("NSE_FNO", str(l["id"]), 15) for l in self.legs.values()]
        try:
            self.helper.subscribe_instruments(sub_list)
        except Exception:
            pass

        # Calculate capital base for % targets
        # Margin roughly estimated or debit/credit base
        net_credit = (
            self.legs["ce_short"]["avg_price"] + self.legs["pe_short"]["avg_price"]
            - self.legs["ce_hedge"]["avg_price"] - self.legs["pe_hedge"]["avg_price"]
        ) * qty
        self.entry_capital_base = max(abs(net_credit), 50000.0 * self.lots)
        if self.target_is_pct and self.target_rs is None:
            self.target_rs = self.entry_capital_base * self.target_val / 100.0
        if self.stop_is_pct and self.stop_rs is None:
            self.stop_rs = -self.entry_capital_base * self.stop_val / 100.0

        self.save_position()
        logger.info(
            f"ENTERED IRON CONDOR: Short CE {strikes['ce_short']['strike']}@{self.legs['ce_short']['avg_price']:.2f}, "
            f"Short PE {strikes['pe_short']['strike']}@{self.legs['pe_short']['avg_price']:.2f}, "
            f"Hedges CE {strikes['ce_hedge']['strike']} / PE {strikes['pe_hedge']['strike']} (Qty={qty})"
        )
        notify(f"[{self.state_key}] Entered Iron Condor at Spot {spot:.0f} (CE {strikes['ce_short']['strike']} / PE {strikes['pe_short']['strike']})")
        return True

    def enter_ratio_spread(self, spot: float, chain_df: pd.DataFrame, dte_days: float, direction: str, is_shift: bool = False) -> bool:
        """Enters Directional Ratio Spread:
        Buy 1x Long (0.50 or 0.40 shift), Buy 1x Hedge (0.10 or 0.08 shift), Sell 2x Short (0.40 or 0.30 shift).
        Longs and hedges are placed before the 2x shorts."""
        logger.info(f"Setting up Ratio Spread ({direction}) is_shift={is_shift} at Spot={spot:.2f}...")
        if is_shift:
            strikes = choose_ratio_shift_strikes(chain_df, spot, dte_days, direction,
                                                 long_delta=self.shift_long_delta,
                                                 short_delta=self.shift_short_delta,
                                                 hedge_delta=self.shift_hedge_delta,
                                                 strike_step=self.strike_step)
        else:
            strikes = choose_ratio_strikes(chain_df, spot, dte_days, direction,
                                           long_delta=self.ratio_long_delta,
                                           short_delta=self.ratio_short_delta,
                                           hedge_delta=self.ratio_hedge_delta,
                                           strike_step=self.strike_step)

        opt_type = strikes["opt_type"]
        long_k = strikes["long_leg"]["strike"]
        short_k = strikes["short_leg"]["strike"]
        hedge_k = strikes["hedge_leg"]["strike"]

        long_sid, long_px = self._get_quote(long_k, opt_type)
        short_sid, short_px = self._get_quote(short_k, opt_type)
        hedge_sid, hedge_px = self._get_quote(hedge_k, opt_type)

        if not long_sid or not short_sid or not hedge_sid:
            logger.warning("Could not fetch quotes for Ratio Spread legs. Skipping entry.")
            return False

        qty_long = self.lots * self.lot_size
        qty_short = 2 * self.lots * self.lot_size

        filled_legs = {}
        self.status = "UNWINDING"
        self.save_position()

        # 1. Buy Long
        l_fill = self._place_order("BUY", long_k, opt_type, qty_long, long_px)
        if l_fill is None:
            logger.critical("Ratio Spread Long BUY failed! Aborting.")
            self.status = "WAITING"
            self.save_position()
            return False
        filled_legs["ratio_long"] = {
            "id": long_sid, "strike": long_k, "opt_type": opt_type, "side": "BUY",
            "qty": qty_long, "avg_price": l_fill, "delta": strikes["long_leg"]["delta"],
        }

        # 2. Buy Hedge
        h_fill = self._place_order("BUY", hedge_k, opt_type, qty_long, hedge_px)
        if h_fill is None:
            logger.critical("Ratio Spread Hedge BUY failed! Rolling back Long leg.")
            closed, _ = self._sell_to_close(filled_legs["ratio_long"])
            if not closed:
                self.legs = {"ratio_long": filled_legs["ratio_long"]}
                self.position_open = True
                self.status = "UNWINDING"
            else:
                self.legs = {}
                self.position_open = False
                self.status = "WAITING"
            self.save_position()
            return False
        filled_legs["ratio_hedge"] = {
            "id": hedge_sid, "strike": hedge_k, "opt_type": opt_type, "side": "BUY",
            "qty": qty_long, "avg_price": h_fill, "delta": strikes["hedge_leg"]["delta"],
        }

        # 3. Sell 2x Shorts
        s_fill = self._place_order("SELL", short_k, opt_type, qty_short, short_px)
        if s_fill is None:
            logger.critical("Ratio Spread Short SELL failed! Rolling back long and hedge.")
            remaining_legs = {}
            for fname, fleg in filled_legs.items():
                closed, _ = self._sell_to_close(fleg)
                if not closed:
                    remaining_legs[fname] = fleg
            if remaining_legs:
                self.legs = remaining_legs
                self.position_open = True
                self.status = "UNWINDING"
            else:
                self.legs = {}
                self.position_open = False
                self.status = "WAITING"
            self.save_position()
            return False
        filled_legs["ratio_short"] = {
            "id": short_sid, "strike": short_k, "opt_type": opt_type, "side": "SELL",
            "qty": qty_short, "avg_price": s_fill, "delta": strikes["short_leg"]["delta"],
        }

        # Commit position
        self.legs = filled_legs
        self.position_open = True
        self.stage = STAGE_RATIO
        self.direction = direction
        self.status = "RUNNING"

        # WebSocket subscriptions
        try:
            self.helper.subscribe_instruments([("NSE_FNO", str(l["id"]), 15) for l in self.legs.values()])
        except Exception:
            pass

        self.save_position()
        logger.info(
            f"ENTERED RATIO SPREAD ({direction}): Buy 1x {opt_type} {long_k}@{l_fill:.2f}, "
            f"Sell 2x {opt_type} {short_k}@{s_fill:.2f}, Buy 1x Hedge {opt_type} {hedge_k}@{h_fill:.2f}"
        )
        notify(f"[{self.state_key}] Deployed {direction} Ratio Spread ({opt_type} {long_k} / {short_k}x2 / {hedge_k})")
        return True

    # ── P&L and State Calculation ──────────────────────────────────────────────────────────────

    def total_pnl(self) -> float:
        total = self.realized_pnl
        for leg in self.legs.values():
            if leg:
                ltp = self._ltp(leg)
                if ltp > 0:
                    if leg["side"] == "BUY":
                        total += (ltp - leg["avg_price"]) * leg["qty"]
                    else:
                        total += (leg["avg_price"] - ltp) * leg["qty"]
        return total

    def save_state(self, spot: float = 0.0, total_pnl: float = 0.0, status: str = None):
        save_strategy_state(self.state_key, {
            "strategy": STRATEGY_KEY_DEFAULT,
            "status": status or self.status,
            "stage": self.stage,
            "direction": self.direction,
            "dry_run": self.dry_run,
            "broker": self.broker_name,
            "lots": self.lots,
            "lot_size": self.lot_size,
            "expiry": self.expiry,
            "spot": spot,
            "position_open": self.position_open,
            "legs": self.legs,
            "shifts_count": self.shifts_count,
            "reversals_count": self.reversals_count,
            "realized_pnl": round(self.realized_pnl, 2),
            "total_pnl": round(total_pnl, 2),
            "target_rs": round(self.target_rs, 2) if self.target_rs else None,
            "stop_rs": round(self.stop_rs, 2) if self.stop_rs else None,
            "trail_active": self.trail_active,
            "best_pnl": round(self.best_pnl, 2),
        })

    def _shutdown(self, reason: str):
        fully = self.exit_all(reason) if self.position_open else True
        self.save_state(status="STOPPED" if fully else "STOPPED (EXIT INCOMPLETE - VERIFY MANUALLY)")
        if not fully:
            logger.critical("Not all legs confirmed closed during shutdown. Verify broker manually.")
        flush_state()
        sys.exit(0)

    # ── Main Lifecycle Loop ────────────────────────────────────────────────────────────────────

    def run(self):
        logger.info(
            f"Starting {self.state_key} | Mode: {'DRY' if self.dry_run else 'LIVE'} | Lots: {self.lots} | "
            f"Target: {self.target_val}{'%' if self.target_is_pct else ' INR'} | "
            f"Stop: {self.stop_val}{'%' if self.stop_is_pct else ' INR'} | Broker: {self.broker_name}"
        )
        exit_if_market_closed(self.helper, self.dry_run)

        while True:
            # 1. Shutdown Trigger Check
            if check_shutdown_trigger(self.state_key):
                self._shutdown("UI Shutdown Trigger Received")

            # 2. Market Open Check
            if not self.dry_run and not self.helper.is_market_open():
                self.save_state(status="WAITING")
                self.helper.wait_for_market_open(
                    self.dry_run,
                    shutdown_check=lambda: check_shutdown_trigger(self.state_key)
                )
                continue

            spot = self.helper.get_ltp(UNDERLYING, exchange="IDX_I", instrument="INDEX")
            now_dt = datetime.now()
            now_hhmm = now_dt.strftime("%H:%M")
            today = now_dt.date()

            if spot <= 0:
                self.save_state(spot=spot)
                time.sleep(2)
                continue

            # 3. Handle Retry Unwind States
            if self.status in ("FLATTENING", "UNWINDING") and self.position_open:
                if self.exit_all(f"Retrying {self.status}"):
                    self.save_state(spot=spot)
                else:
                    self.save_state(spot=spot, total_pnl=self.total_pnl())
                time.sleep(2)
                continue

            # 4. Resolve Expiry and Option Chain
            if not self.expiry or (self.position_open is False and (datetime.strptime(self.expiry, "%Y-%m-%d").date() <= today)):
                expiries = self.helper.get_expiries(UNDERLYING)
                self.expiry = pick_cycle_expiry(expiries, today, self.min_dte, self.max_dte,
                                                expiry_type=self.expiry_type, skip_expiry=self.last_cycle_expiry)

            dte_days = (datetime.strptime(self.expiry, "%Y-%m-%d").date() - today).days if self.expiry else 30
            chain_df = self.helper.get_option_chain_df(UNDERLYING, self.expiry) if self.expiry else None

            # 5. Flat -> Check Entry Window -> Enter Iron Condor
            if not self.position_open:
                pnl = self.realized_pnl
                self.save_state(spot=spot, total_pnl=pnl, status="WAITING")

                if (self.start_time <= now_hhmm <= self.entry_end
                        and time.time() >= self.pause_until
                        and self.expiry is not None):
                    self.enter_iron_condor(spot, chain_df, dte_days)
                time.sleep(5)
                continue

            # ── In Position Monitoring ─────────────────────────────────────────────────────────
            pnl = self.total_pnl()
            self.save_state(spot=spot, total_pnl=pnl, status="RUNNING")

            # Check Global Target / Stop Loss / Trailing Stop
            if self.target_rs is not None and pnl >= self.target_rs:
                self.exit_all(f"Profit Target Hit (+₹{pnl:.2f} >= +₹{self.target_rs:.2f})")
                self.last_cycle_expiry = self.expiry
                continue

            if self.stop_rs is not None and pnl <= self.stop_rs:
                self.exit_all(f"Stop Loss Hit (₹{pnl:.2f} <= ₹{self.stop_rs:.2f})")
                self.last_cycle_expiry = self.expiry
                self.pause_until = time.time() + 300  # 5 min pause
                continue

            self.trail_active, self.best_pnl, trail_exit = update_trail(
                pnl, self.best_pnl, self.trail_active, self.trail_start_rs, self.trail_gap_rs
            )
            if trail_exit:
                self.exit_all(f"Trailing Stop Hit (+₹{pnl:.2f} dropped from peak +₹{self.best_pnl:.2f})")
                self.last_cycle_expiry = self.expiry
                continue

            # Expiry Day EOD Exit Guard
            if self.expiry and datetime.strptime(self.expiry, "%Y-%m-%d").date() == today:
                if now_hhmm >= self.eod_exit_time:
                    self.exit_all(f"Expiry Day EOD Cutoff reached ({now_hhmm} >= {self.eod_exit_time})")
                    self.last_cycle_expiry = self.expiry
                    continue

            # ── Phase Specific Transition & Adjustment Rules ───────────────────────────────────

            if self.stage == STAGE_CONDOR:
                # Monitor Short Legs' Deltas
                ce_leg = self.legs.get("ce_short")
                pe_leg = self.legs.get("pe_short")

                if ce_leg and pe_leg:
                    # Update current delta from chain or Black-Scholes fallback
                    ce_d = get_live_or_bs_delta(chain_df, spot, ce_leg["strike"], dte_days, opt_type="CE")
                    pe_d = get_live_or_bs_delta(chain_df, spot, pe_leg["strike"], dte_days, opt_type="PE")

                    trigger_dir = check_condor_trigger(ce_d, pe_d, self.condor_exit_delta)
                    if trigger_dir:
                        logger.warning(
                            f"CONDOR TRIGGERED: Short leg reached <= {self.condor_exit_delta} delta! "
                            f"(CE Delta={ce_d:.3f}, PE Delta={pe_d:.3f}). Moving to {trigger_dir} Ratio Spread."
                        )
                        # Exit Iron Condor
                        if self.exit_all(f"Condor -> {trigger_dir} Ratio Spread Transition"):
                            time.sleep(2)
                            # Deploy Directional Ratio Spread
                            self.enter_ratio_spread(spot, chain_df, dte_days, trigger_dir, is_shift=False)
                        continue

            elif self.stage == STAGE_RATIO:
                # Monitor Ratio Spread Sold Leg Delta
                short_leg = self.legs.get("ratio_short")
                if short_leg:
                    opt_type = short_leg["opt_type"]
                    short_k = short_leg["strike"]
                    current_delta = get_live_or_bs_delta(chain_df, spot, short_k, dte_days, opt_type=opt_type)

                    # 1. Trend Continuation Shift Check
                    if check_ratio_shift_trigger(current_delta, self.ratio_shift_delta):
                        if self.shifts_count < self.max_shifts:
                            logger.info(
                                f"RATIO CONTINUATION TRIGGER: Sold leg delta decayed to {current_delta:.3f} "
                                f"(<= {self.ratio_shift_delta:.2f}). Shifting strikes in {self.direction} direction."
                            )
                            cur_dir = self.direction
                            if self.exit_all(f"Ratio Spread Shift #{self.shifts_count + 1}"):
                                self.shifts_count += 1
                                time.sleep(2)
                                self.enter_ratio_spread(spot, chain_df, dte_days, cur_dir, is_shift=True)
                            continue
                        else:
                            logger.info(f"Max shifts reached ({self.shifts_count}/{self.max_shifts}). Holding.")

                    # 2. Trend Reversal Flip Check
                    if check_ratio_reversal_trigger(current_delta, self.ratio_reversal_delta):
                        if self.reversals_count < self.max_reversals:
                            new_dir = "BULLISH" if self.direction == "BEARISH" else "BEARISH"
                            logger.warning(
                                f"RATIO REVERSAL TRIGGER: Sold leg delta expanded to {current_delta:.3f} "
                                f"(>= {self.ratio_reversal_delta:.2f}). Reversing to {new_dir} Ratio Spread!"
                            )
                            if self.exit_all(f"Ratio Spread Reversal #{self.reversals_count + 1}"):
                                self.reversals_count += 1
                                self.shifts_count = 0  # reset shift count for new direction
                                time.sleep(2)
                                self.enter_ratio_spread(spot, chain_df, dte_days, new_dir, is_shift=False)
                            continue
                        else:
                            logger.warning(f"Max reversals reached ({self.reversals_count}/{self.max_reversals}). Exiting.")
                            self.exit_all("Max Reversals Exceeded")
                            self.pause_until = time.time() + 600
                            continue

            time.sleep(3)


# ── CLI & Validation ───────────────────────────────────────────────────────────────────────────

def build_parser():
    p = argparse.ArgumentParser(
        description="Nifty Iron Condor to Ratio Spread Strategy (Dynamic Structure Shift)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run default (simulates fills, monitors delta transitions)
  python strategies/condor_to_ratio/nifty_condor_ratio.py

  # Dry run with custom targets and 2 lots
  python strategies/condor_to_ratio/nifty_condor_ratio.py --lots 2 --target-profit 20000 --stop-loss 15000

  # Live execution (requires acknowledgement flag)
  python strategies/condor_to_ratio/nifty_condor_ratio.py --live --i-understand-this-is-unvalidated --lots 1 --broker dhan
        """
    )
    p.add_argument("--live", action="store_true", default=False,
                   help="Enable live order placement with real money (default: False / dry run).")
    p.add_argument("--i-understand-this-is-unvalidated", action="store_true", default=False,
                   help="Mandatory acknowledgement required to run --live.")
    p.add_argument("--lots", type=int, default=1, metavar="N",
                   help="Number of lots for initial Condor (default: 1). Ratio spread scales 1x/2x/1x accordingly.")
    p.add_argument("--target-profit", type=str, default="15%", metavar="INR|%",
                   help="Cycle profit target in INR or percent of capital base (default: 15%%).")
    p.add_argument("--stop-loss", type=str, default="15%", metavar="INR|%",
                   help="Cycle stop loss in INR or percent of capital base (default: 15%%).")
    p.add_argument("--condor-short-delta", type=float, default=0.30, metavar="D",
                   help="Delta target for Iron Condor sold legs (default: 0.30).")
    p.add_argument("--condor-hedge-delta", type=float, default=0.10, metavar="D",
                   help="Delta target for Iron Condor hedge legs (default: 0.10).")
    p.add_argument("--condor-exit-delta", type=float, default=0.10, metavar="D",
                   help="Delta threshold on short leg to exit Condor and deploy Ratio Spread (default: 0.10).")
    p.add_argument("--ratio-long-delta", type=float, default=0.50, metavar="D",
                   help="Delta target for Ratio Spread long leg (default: 0.50 ATM).")
    p.add_argument("--ratio-short-delta", type=float, default=0.40, metavar="D",
                   help="Delta target for Ratio Spread sold leg (default: 0.40 OTM).")
    p.add_argument("--ratio-hedge-delta", type=float, default=0.10, metavar="D",
                   help="Delta target for Ratio Spread tail hedge leg (default: 0.10).")
    p.add_argument("--ratio-shift-delta", type=float, default=0.10, metavar="D",
                   help="Short leg delta decay threshold to trigger continuation shift (default: 0.10, combined 0.20).")
    p.add_argument("--ratio-reversal-delta", type=float, default=0.60, metavar="D",
                   help="Short leg delta expansion threshold to trigger reversal flip (default: 0.60, combined 1.20).")
    p.add_argument("--shift-long-delta", type=float, default=0.40, metavar="D",
                   help="Delta target for shifted Ratio long leg (default: 0.40).")
    p.add_argument("--shift-short-delta", type=float, default=0.30, metavar="D",
                   help="Delta target for shifted Ratio sold leg (default: 0.30).")
    p.add_argument("--shift-hedge-delta", type=float, default=0.08, metavar="D",
                   help="Delta target for shifted Ratio hedge leg (default: 0.08).")
    p.add_argument("--max-shifts", type=int, default=5, metavar="N",
                   help="Maximum number of continuation shifts in one cycle (default: 5).")
    p.add_argument("--max-reversals", type=int, default=3, metavar="N",
                   help="Maximum number of reversal flips in one cycle (default: 3).")
    p.add_argument("--trail-start-rs", type=float, default=5000.0, metavar="INR",
                   help="Rupee P&L to activate trailing stop loss (default: 5000.0).")
    p.add_argument("--trail-gap-rs", type=float, default=2500.0, metavar="INR",
                   help="Rupee giveback from peak P&L to trigger trailing exit (default: 2500.0).")
    p.add_argument("--expiry-type", choices=["monthly", "nearest"], default="monthly",
                   help="Contract expiry selection mode (default: monthly).")
    p.add_argument("--min-dte", type=int, default=15, metavar="DAYS",
                   help="Minimum days to expiry for cycle entry (default: 15).")
    p.add_argument("--max-dte", type=int, default=45, metavar="DAYS",
                   help="Maximum days to expiry for cycle entry (default: 45).")
    p.add_argument("--start-time", type=str, default="09:20", metavar="HH:MM",
                   help="Earliest time of day for cycle entry (default: 09:20).")
    p.add_argument("--entry-end", type=str, default="15:00", metavar="HH:MM",
                   help="Latest time of day for cycle entry (default: 15:00).")
    p.add_argument("--eod-exit-time", type=str, default="15:15", metavar="HH:MM",
                   help="Square-off time on contract expiry date (default: 15:15).")
    p.add_argument("--product", choices=["MARGIN", "INTRADAY"], default="MARGIN",
                   help="Product type (default: MARGIN for positional hold).")
    p.add_argument("--instance-id", type=str, default="", metavar="ID",
                   help="Suffix for state/log files to isolate concurrent instances.")
    p.add_argument("--broker", choices=["dhan", "zerodha", "kotak"], default="dhan",
                   help="Execution broker (default: dhan).")
    return p


def validate_args(args):
    errors = []
    if args.lots < 1:
        errors.append(f"--lots must be >= 1, got {args.lots}.")
    if not (0.01 <= args.condor_short_delta <= 0.50):
        errors.append(f"--condor-short-delta must be between 0.01 and 0.50, got {args.condor_short_delta}.")
    if not (0.01 <= args.condor_hedge_delta <= 0.30):
        errors.append(f"--condor-hedge-delta must be between 0.01 and 0.30, got {args.condor_hedge_delta}.")
    if args.condor_hedge_delta >= args.condor_short_delta:
        errors.append(f"--condor-hedge-delta ({args.condor_hedge_delta}) must be strictly less than --condor-short-delta ({args.condor_short_delta}).")
    if not (0.01 <= args.condor_exit_delta <= 0.30):
        errors.append(f"--condor-exit-delta must be between 0.01 and 0.30, got {args.condor_exit_delta}.")
    if args.min_dte < 1 or args.max_dte < args.min_dte:
        errors.append(f"Invalid DTE range: {args.min_dte} to {args.max_dte}.")
    if args.live and not args.i_understand_this_is_unvalidated:
        errors.append("--live requires --i-understand-this-is-unvalidated: this strategy is not yet backtest-validated in this repository.")
    return errors


def main():
    p = build_parser()
    args = p.parse_args()
    errors = validate_args(args)
    if errors:
        for err in errors:
            logger.error(f"[CONFIG ERROR] {err}")
        sys.exit(1)

    target_spec = parse_target_spec(args.target_profit)
    stop_spec = parse_target_spec(args.stop_loss)

    state_key = f"{STRATEGY_KEY_DEFAULT}_{args.instance_id}" if args.instance_id else STRATEGY_KEY_DEFAULT

    strat = NiftyCondorToRatioStrategy(
        dry_run=not args.live,
        lots=args.lots,
        target=target_spec,
        stop=stop_spec,
        condor_short_delta=args.condor_short_delta,
        condor_hedge_delta=args.condor_hedge_delta,
        condor_exit_delta=args.condor_exit_delta,
        ratio_long_delta=args.ratio_long_delta,
        ratio_short_delta=args.ratio_short_delta,
        ratio_hedge_delta=args.ratio_hedge_delta,
        ratio_shift_delta=args.ratio_shift_delta,
        ratio_reversal_delta=args.ratio_reversal_delta,
        shift_long_delta=args.shift_long_delta,
        shift_short_delta=args.shift_short_delta,
        shift_hedge_delta=args.shift_hedge_delta,
        max_shifts=args.max_shifts,
        max_reversals=args.max_reversals,
        trail_start_rs=args.trail_start_rs,
        trail_gap_rs=args.trail_gap_rs,
        expiry_type=args.expiry_type,
        min_dte=args.min_dte,
        max_dte=args.max_dte,
        start_time=args.start_time,
        entry_end=args.entry_end,
        eod_exit_time=args.eod_exit_time,
        state_key=state_key,
        broker=args.broker,
        product=args.product,
    )

    try:
        strat.run()
    except KeyboardInterrupt:
        logger.info("KeyboardInterrupt received.")
        strat._shutdown("KeyboardInterrupt")


if __name__ == "__main__":
    main()
