"""
Nifty Bi-Weekly Adaptive Strangle Strategy — Conditional Greek Hedging & Directional Conversion.

Sells far-OTM Nifty strangles on the 2nd weekly expiry (~8–15 DTE) with zero upfront hedge drag.
Dynamically buys conditional protective wings on Greek threat triggers (Delta or Vega/IV surge)
and optionally transitions into a directional strategy upon confirmed Nifty index trends.

Standard Feature Kit (dhan-new-strategy):
  - Dry run default (--live required for real execution).
  - Multi-broker support (Dhan, Zerodha, Kotak) via ExecutionBroker.
  - Atomic position persistence (debug/<key>_position.json) and startup broker reconciliation.
  - Dashboard state bridge (debug/<key>_state.json) and graceful shutdown trigger.
  - Safe exit sizing using resolve_exit_qty_broker().
  - Continuous P&L accounting across rolls, trailing stop loss, and bi-weekly expiry management.
"""

import argparse
import json
import math
import os
import sys
import time
from datetime import date, datetime
from typing import Dict, Optional, Tuple


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
if project_root not in sys.path:
    sys.path.insert(0, project_root)

# Pure stdlib (no broker SDK): imported outside the guarded block so the pure functions work even when the SDK imports below fail.
from lib.options_pricing import greeks_from_days  # noqa: E402
from lib.algo_kit import setup_strategy_logging  # noqa: E402

try:
    import pandas as pd
except ImportError:
    pd = None

try:
    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper
    from lib.strategy_state_helper import (
        check_shutdown_trigger, exit_if_market_closed, flush_state,
        instance_log_suffix, parse_target_spec, save_strategy_state,
    )
    from lib.strategy_risk import resolve_exit_qty_broker
    from lib.execution_broker import ExecutionBroker, ExecutionBrokerError
    from lib.telegram_alert import notify
except ImportError:
    get_dhan_client = None
    DhanHelper = None
    check_shutdown_trigger = lambda *a, **k: False
    exit_if_market_closed = lambda *a, **k: None
    flush_state = lambda *a, **k: None
    instance_log_suffix = lambda *a, **k: ""
    parse_target_spec = lambda spec, base: float(spec) if isinstance(spec, (int, float)) else 5000.0
    save_strategy_state = lambda *a, **k: None
    resolve_exit_qty_broker = lambda *a, **k: 0
    ExecutionBroker = None
    ExecutionBrokerError = Exception
    notify = lambda *a, **k: None

STRATEGY_KEY_DEFAULT = "nifty_adaptive_strangle"
LOG_FOLDER = "adaptive_strangle"
UNDERLYING = "NIFTY"
INDEX_ID = "13"
STRIKE_STEP_DEFAULT = 50

# Stages
STAGE_FLAT = "FLAT"
STAGE_STRANGLE = "STRANGLE"
STAGE_HEDGED = "HEDGED_STRANGLE"
STAGE_DIRECTIONAL = "DIRECTIONAL"

debug_dir = os.path.join(project_root, "debug")
logger = setup_strategy_logging(project_root, LOG_FOLDER, instance_log_suffix(), name=__name__, force=True)


# ── PURE CALCULATION & GREEK FUNCTIONS ───────────────────────────────────────

# Greeks come from lib/options_pricing.py (parity-tested port of the dashboard's optionsPricing.ts); this strategy only picks its own
# expiry floor and the IV used when a chain row carries none.
MIN_DTE_DAYS = 0.5
DEFAULT_IV = 0.15


def pick_leg_by_delta(chain_df: Optional[pd.DataFrame], spot: float, dte_days: float, opt_type: str,
                       target_delta: float, strike_step: int = STRIKE_STEP_DEFAULT) -> Tuple[int, float, float, float]:
    """Finds strike with delta magnitude closest to target_delta.
    Priority 1: live chain_df delta columns ('ce_delta' / 'pe_delta').
    Priority 2: Black-Scholes fallback delta.
    Returns (strike: int, quote_price: float, delta: float, vega: float)."""
    prefix = opt_type.lower()
    delta_col = f"{prefix}_delta"
    price_col = f"{prefix}_last_price"
    vega_col = f"{prefix}_vega"

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
                vg = float(best.get(vega_col, greeks_from_days("CE", spot, k, dte_days, DEFAULT_IV, min_days=MIN_DTE_DAYS).vega))
                return k, px, d, vg
            except Exception:
                pass

    # Black-Scholes strike ladder fallback
    atm = int(round(spot / strike_step) * strike_step)
    candidate_strikes = [atm + i * strike_step for i in range(-50, 51)]
    best_strike = atm
    best_diff = 999.0
    best_delta = 0.5
    best_vega = 0.0

    for k in candidate_strikes:
        if k <= 0:
            continue
        d = greeks_from_days(opt_type, spot, k, dte_days, DEFAULT_IV, min_days=MIN_DTE_DAYS).delta
        diff = abs(abs(d) - target_delta)
        if diff < best_diff:
            best_diff = diff
            best_strike = k
            best_delta = d
            best_vega = greeks_from_days("CE", spot, k, dte_days, DEFAULT_IV, min_days=MIN_DTE_DAYS).vega

    px = 0.0
    if chain_df is not None and not chain_df.empty and price_col in chain_df.columns:
        if best_strike in chain_df.index:
            try:
                px = float(chain_df.loc[best_strike, price_col])
            except Exception:
                pass
    if px <= 0:
        intrinsic = max(0.0, spot - best_strike) if opt_type.upper() == "CE" else max(0.0, best_strike - spot)
        px = max(intrinsic, 15.0)

    return best_strike, px, best_delta, best_vega


def choose_strangle_strikes(chain_df: Optional[pd.DataFrame], spot: float, dte_days: float,
                            entry_delta: float = 0.10, strike_step: int = STRIKE_STEP_DEFAULT) -> dict:
    """Selects strikes for a 2-leg far-OTM Short Strangle:
    Sell ~0.10 Delta Call and ~0.10 Delta Put.
    Guarantees strict monotonic order: pe_strike < ce_strike."""
    ce_strike, ce_px, ce_d, ce_vg = pick_leg_by_delta(chain_df, spot, dte_days, "CE", entry_delta, strike_step)
    pe_strike, pe_px, pe_d, pe_vg = pick_leg_by_delta(chain_df, spot, dte_days, "PE", entry_delta, strike_step)

    # Inversion prevention
    if pe_strike >= ce_strike:
        atm = int(round(spot / strike_step) * strike_step)
        pe_strike = atm - 4 * strike_step
        ce_strike = atm + 4 * strike_step

    return {
        "ce_short": {"strike": ce_strike, "price": ce_px, "delta": ce_d, "vega": ce_vg},
        "pe_short": {"strike": pe_strike, "price": pe_px, "delta": pe_d, "vega": pe_vg},
    }


def evaluate_threat_and_hedging(ce_delta: float, pe_delta: float, iv_change_pct: float,
                                hedge_delta_trigger: float = 0.22, vega_surge_pct: float = 20.0,
                                has_ce_hedge: bool = False, has_pe_hedge: bool = False) -> dict:
    """Evaluates whether market movement or IV expansion triggers conditional hedge purchases.
    Returns flags indicating which wings must be bought."""
    delta_threat_ce = (ce_delta >= hedge_delta_trigger) and not has_ce_hedge
    delta_threat_pe = (abs(pe_delta) >= hedge_delta_trigger) and not has_pe_hedge
    vega_surge = (iv_change_pct >= vega_surge_pct)

    need_ce_hedge = (delta_threat_ce or vega_surge) and not has_ce_hedge
    need_pe_hedge = (delta_threat_pe or vega_surge) and not has_pe_hedge

    reasons = []
    if delta_threat_ce:
        reasons.append(f"CE delta threat ({ce_delta:.2f} >= {hedge_delta_trigger:.2f})")
    if delta_threat_pe:
        reasons.append(f"PE delta threat ({abs(pe_delta):.2f} >= {hedge_delta_trigger:.2f})")
    if vega_surge:
        reasons.append(f"Vega/IV surge ({iv_change_pct:.1f}% >= {vega_surge_pct:.1f}%)")

    return {
        "need_ce_hedge": need_ce_hedge,
        "need_pe_hedge": need_pe_hedge,
        "reason": "; ".join(reasons) if reasons else "Normal",
    }


def evaluate_directional_conversion(ce_delta: float, pe_delta: float, spot: float,
                                    trend_ema: Optional[float],
                                    conversion_delta_trigger: float = 0.30) -> Optional[str]:
    """Evaluates whether to convert the strangle/condor into a directional strategy.
    Returns 'BULLISH', 'BEARISH', or None."""
    # Bullish Trend: CE short challenged (delta expanded to >= 0.30) and index confirmed bullish
    if ce_delta >= conversion_delta_trigger:
        if trend_ema is None or spot >= trend_ema:
            return "BULLISH"

    # Bearish Trend: PE short challenged (|delta| expanded to >= 0.30) and index confirmed bearish
    if abs(pe_delta) >= conversion_delta_trigger:
        if trend_ema is None or spot <= trend_ema:
            return "BEARISH"

    return None


def resolve_target_rs(spec_raw, base_margin: float) -> float:
    """Parses a target/stop spec and resolves it to a rupee amount against base_margin."""
    try:
        val, is_pct = parse_target_spec(spec_raw)
        return (val / 100.0) * base_margin if is_pct else float(val)
    except Exception:
        return float(spec_raw) if isinstance(spec_raw, (int, float)) else 5000.0


# ── STRATEGY EXECUTION CLASS ────────────────────────────────────────────────

class NiftyAdaptiveStrangle:
    def __init__(
        self,
        helper: DhanHelper,
        broker: ExecutionBroker,
        dry_run: bool = True,
        lots: int = 1,
        entry_delta: float = 0.10,
        hedge_delta_trigger: float = 0.22,
        hedge_target_delta: float = 0.08,
        vega_surge_pct: float = 20.0,
        enable_directional_conversion: bool = False,
        conversion_delta_trigger: float = 0.30,
        conversion_style: str = "spread",
        target_profit: str = "5%",
        stop_loss: str = "4%",
        trail_start_rs: float = 0.0,
        trail_gap_rs: float = 0.0,
        entry_time_str: str = "09:20",
        entry_end_str: str = "15:00",
        eod_exit_time_str: str = "15:15",
        poll_interval: int = 2,
        instance_id: str = "",
        product: str = "MARGIN",
    ):
        self.helper = helper
        self.broker = broker
        self.dry_run = dry_run
        self.lots = lots
        self.entry_delta = entry_delta
        self.hedge_delta_trigger = hedge_delta_trigger
        self.hedge_target_delta = hedge_target_delta
        self.vega_surge_pct = vega_surge_pct
        self.enable_directional_conversion = enable_directional_conversion
        self.conversion_delta_trigger = conversion_delta_trigger
        self.conversion_style = conversion_style
        self.target_profit_raw = target_profit
        self.stop_loss_raw = stop_loss
        self.trail_start_rs = trail_start_rs
        self.trail_gap_rs = trail_gap_rs
        self.entry_time_str = entry_time_str
        self.entry_end_str = entry_end_str
        self.eod_exit_time_str = eod_exit_time_str
        self.poll_interval = poll_interval
        self.instance_id = instance_id
        self.product = product

        self.state_key = f"{STRATEGY_KEY_DEFAULT}_{instance_id}" if instance_id else STRATEGY_KEY_DEFAULT
        self.position_file = os.path.join(debug_dir, f"{self.state_key}_position.json")

        self.lot_size = self.helper.get_lot_size(UNDERLYING) or 65
        self.stage = STAGE_FLAT
        self.position_open = False
        self.active_expiry: Optional[str] = None
        self.entry_spot: float = 0.0
        self.entry_iv: float = 0.15
        self.deployed_margin: float = 0.0
        self.target_profit_rs: Optional[float] = None
        self.stop_loss_rs: Optional[float] = None

        self.realized_pnl: float = 0.0
        self.unrealized_pnl: float = 0.0
        self.total_pnl: float = 0.0
        self.peak_pnl: float = 0.0

        # Leg tracking: leg_name -> {id, strike, opt_type, side, qty, avg_price, delta, vega}
        self.legs: Dict[str, dict] = {}
        self.directional_direction: Optional[str] = None

        logger.info(
            f"Initialized NiftyAdaptiveStrangle | Key: {self.state_key} | "
            f"Lots: {self.lots} (Qty {self.lots * self.lot_size}) | Mode: {'DRY RUN' if self.dry_run else 'LIVE'} | "
            f"Broker: {getattr(self.broker, 'broker', 'dhan')} | Product: {self.product}"
        )

    # ── PERSISTENCE & RECONCILIATION ─────────────────────────────────────────

    def save_persisted_position(self):
        """Atomically saves live position data to disk."""
        data = {
            "strategy": STRATEGY_KEY_DEFAULT,
            "state_key": self.state_key,
            "dry_run": self.dry_run,
            "stage": self.stage,
            "position_open": self.position_open,
            "active_expiry": self.active_expiry,
            "entry_spot": self.entry_spot,
            "entry_iv": self.entry_iv,
            "deployed_margin": self.deployed_margin,
            "target_profit_rs": self.target_profit_rs,
            "stop_loss_rs": self.stop_loss_rs,
            "realized_pnl": self.realized_pnl,
            "peak_pnl": self.peak_pnl,
            "directional_direction": self.directional_direction,
            "legs": self.legs,
            "last_saved": datetime.now().isoformat(),
        }
        tmp_file = f"{self.position_file}.tmp"
        with open(tmp_file, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_file, self.position_file)

    def load_persisted_position(self) -> bool:
        """Loads open position state after process crash or restart."""
        if not os.path.exists(self.position_file):
            return False
        try:
            with open(self.position_file, "r") as f:
                data = json.load(f)

            if data.get("dry_run") != self.dry_run:
                logger.warning(f"Persisted dry_run={data.get('dry_run')} does not match current={self.dry_run}. Ignoring file.")
                return False

            if not data.get("position_open"):
                return False

            self.stage = data.get("stage", STAGE_FLAT)
            self.position_open = data.get("position_open", False)
            self.active_expiry = data.get("active_expiry")
            self.entry_spot = data.get("entry_spot", 0.0)
            self.entry_iv = data.get("entry_iv", 0.15)
            self.deployed_margin = data.get("deployed_margin", 0.0)
            self.target_profit_rs = data.get("target_profit_rs")
            self.stop_loss_rs = data.get("stop_loss_rs")
            self.realized_pnl = data.get("realized_pnl", 0.0)
            self.peak_pnl = data.get("peak_pnl", 0.0)
            self.directional_direction = data.get("directional_direction")
            self.legs = data.get("legs", {})
            for leg_name, leg in self.legs.items():
                sid = str(leg.get("id", ""))
                if not sid.isdigit() and self.active_expiry and leg.get("strike") and leg.get("opt_type"):
                    sec = self.helper.find_option(UNDERLYING, self.active_expiry, leg["strike"], leg["opt_type"])
                    if sec:
                        leg["id"] = str(sec.get("SECURITY_ID", ""))

            logger.info(f"Restored open position from {self.position_file} | Stage: {self.stage} | Legs: {list(self.legs.keys())}")
            return True
        except Exception as e:
            logger.error(f"Failed to load persisted position: {e}", exc_info=True)
            return False

    def reconcile_with_broker(self) -> bool:
        """Reconciles persisted legs against broker's net positions."""
        if self.dry_run or not self.position_open:
            return True

        logger.info("Reconciling tracked legs against broker net positions...")
        discrepancy = False
        for leg_name, leg in self.legs.items():
            sec_id = leg.get("id")
            expected_qty = leg.get("qty", 0)
            side = leg.get("side", "SELL")
            net_broker = self.broker.get_owned_net_qty(sec_id)
            exp_signed = expected_qty if side == "BUY" else -expected_qty

            if net_broker != exp_signed:
                logger.error(
                    f"RECONCILIATION MISMATCH for {leg_name} (ID: {sec_id})! "
                    f"Expected: {exp_signed}, Broker reports: {net_broker}"
                )
                discrepancy = True

        if discrepancy:
            logger.critical("Aborting startup due to broker position mismatch!")
            return False
        logger.info("Broker reconciliation successful.")
        return True

    # ── EXPIRY SELECTION ─────────────────────────────────────────────────────

    def get_biweekly_expiry(self) -> Optional[str]:
        """Resolves the 2nd weekly expiry (~8 to 15 DTE)."""
        expiries = self.helper.get_expiries(UNDERLYING)
        if not expiries:
            expiries = self.helper.get_expiry_list(13, "IDX_I")

        if not expiries or len(expiries) < 2:
            logger.warning(f"Could not find at least 2 expiries for {UNDERLYING}. Available: {expiries}")
            return expiries[0] if expiries else None

        # Return the 2nd expiry in the list (bi-weekly)
        biweekly = expiries[1]
        logger.info(f"Targeting Bi-Weekly Expiry: {biweekly} (Nearest was: {expiries[0]})")
        return biweekly

    # ── ORDER EXECUTION HELPERS ──────────────────────────────────────────────

    def _sell_to_open(self, strike: int, opt_type: str, qty: int, leg_name: str) -> Optional[dict]:
        """Sells an option leg to open short position."""
        sym_desc = f"{UNDERLYING} {self.active_expiry} {strike} {opt_type}"
        sec = self.helper.find_option(UNDERLYING, self.active_expiry, strike, opt_type)
        if not sec:
            logger.error(f"Could not resolve security ID for {sym_desc}")
            return None
        sec_id = str(sec.get("SECURITY_ID", ""))

        ltp = self.helper.get_ltp(sec_id, exchange="NSE_FNO", instrument="OPTIDX")
        if ltp <= 0:
            ltp = 25.0

        if self.dry_run:
            logger.info(f"[DRY RUN] SOLD {qty}x {sym_desc} @ {ltp:.2f}")
            fill_price = ltp
        else:
            logger.info(f"Placing SELL order: {qty}x {sym_desc}...")
            order_id = self.broker.sell(strike, self.active_expiry, opt_type, qty, product=self.product)
            if not order_id:
                logger.error(f"SELL order failed for {sym_desc}")
                return None
            filled = self.helper.wait_for_fill(order_id, timeout=10)
            if not filled:
                logger.error(f"Order {order_id} fill unconfirmed!")
                return None
            fill_price = self.helper.get_order_avg_price(order_id) or ltp

        return {
            "id": sec_id,
            "strike": strike,
            "opt_type": opt_type,
            "side": "SELL",
            "qty": qty,
            "avg_price": fill_price,
            "delta": 0.0,
            "vega": 0.0,
        }

    def _buy_to_open(self, strike: int, opt_type: str, qty: int, leg_name: str) -> Optional[dict]:
        """Buys an option leg (protective hedge or directional wing)."""
        sym_desc = f"{UNDERLYING} {self.active_expiry} {strike} {opt_type}"
        sec = self.helper.find_option(UNDERLYING, self.active_expiry, strike, opt_type)
        if not sec:
            logger.error(f"Could not resolve security ID for {sym_desc}")
            return None
        sec_id = str(sec.get("SECURITY_ID", ""))

        ltp = self.helper.get_ltp(sec_id, exchange="NSE_FNO", instrument="OPTIDX")
        if ltp <= 0:
            ltp = 10.0

        if self.dry_run:
            logger.info(f"[DRY RUN] BOUGHT {qty}x {sym_desc} @ {ltp:.2f}")
            fill_price = ltp
        else:
            logger.info(f"Placing BUY order: {qty}x {sym_desc}...")
            order_id = self.broker.buy(strike, self.active_expiry, opt_type, qty, product=self.product)
            if not order_id:
                logger.error(f"BUY order failed for {sym_desc}")
                return None
            filled = self.helper.wait_for_fill(order_id, timeout=10)
            if not filled:
                logger.error(f"Order {order_id} fill unconfirmed!")
                return None
            fill_price = self.helper.get_order_avg_price(order_id) or ltp

        return {
            "id": sec_id,
            "strike": strike,
            "opt_type": opt_type,
            "side": "BUY",
            "qty": qty,
            "avg_price": fill_price,
            "delta": 0.0,
            "vega": 0.0,
        }

    def _close_leg(self, leg_name: str) -> bool:
        """Closes a single tracked leg cleanly with safe exit sizing."""
        leg = self.legs.get(leg_name)
        if not leg:
            return True

        sec_id = leg["id"]
        qty = leg["qty"]
        side = leg["side"]
        strike = leg["strike"]
        opt_type = leg["opt_type"]
        sym_desc = f"{UNDERLYING} {self.active_expiry} {strike} {opt_type}"

        ltp = self.helper.get_ltp(str(sec_id), exchange="NSE_FNO", instrument="OPTIDX")
        if ltp <= 0:
            ltp = leg["avg_price"]

        if self.dry_run:
            exit_px = ltp
            logger.info(f"[DRY RUN] Closed {leg_name} ({sym_desc}) @ {exit_px:.2f}")
        else:
            close_side = "BUY" if side == "SELL" else "SELL"
            exit_qty, _ = resolve_exit_qty_broker(
                self.broker, strike, self.active_expiry, opt_type, qty, close_side, log=logger
            )
            if exit_qty <= 0:
                logger.warning(f"No broker position to close for {sym_desc}. Clearing tracked leg.")
                exit_px = ltp
            else:
                logger.info(f"Closing {exit_qty}x {leg_name} ({sym_desc}) via {close_side}...")
                fn = self.broker.buy if close_side == "BUY" else self.broker.sell
                order_id = fn(strike, self.active_expiry, opt_type, exit_qty, product=self.product)
                if not order_id or not self.helper.wait_for_fill(order_id, timeout=10):
                    logger.error(f"Close failed or unconfirmed for {sym_desc}")
                    return False
                exit_px = self.helper.get_order_avg_price(order_id) or ltp

        # Compute leg realized P&L
        if side == "SELL":
            leg_pnl = (leg["avg_price"] - exit_px) * qty
        else:
            leg_pnl = (exit_px - leg["avg_price"]) * qty

        self.realized_pnl += leg_pnl
        logger.info(f"Closed {leg_name}: Leg P&L: Rs {leg_pnl:+,.2f} | Realized Total: Rs {self.realized_pnl:+,.2f}")
        del self.legs[leg_name]
        self.save_persisted_position()
        return True

    def exit_all(self, reason: str = "Exit") -> bool:
        """Squares off all active legs (shorts first, then longs)."""
        logger.info(f"EXIT ALL TRIGGERED ({reason}) | Active legs: {list(self.legs.keys())}")
        notify(f"[{self.state_key}] Exiting all legs: {reason}")

        # Close short legs first to avoid unhedged spikes
        short_legs = [k for k, v in self.legs.items() if v["side"] == "SELL"]
        for k in short_legs:
            if not self._close_leg(k):
                logger.error(f"Failed to close short leg {k} during exit_all!")

        # Close long legs
        long_legs = [k for k, v in self.legs.items() if v["side"] == "BUY"]
        for k in long_legs:
            if not self._close_leg(k):
                logger.error(f"Failed to close long leg {k} during exit_all!")

        if not self.legs:
            self.position_open = False
            self.stage = STAGE_FLAT
            self.save_persisted_position()
            logger.info(f"Successfully closed all legs. Final Realized P&L: Rs {self.realized_pnl:+,.2f}")
            return True
        return False

    # ── ENTRY LOGIC ──────────────────────────────────────────────────────────

    def attempt_entry(self, spot: float, chain_df: Optional[pd.DataFrame], dte_days: float) -> bool:
        """Enters the Phase 1 Bi-Weekly Far-OTM Strangle."""
        self.active_expiry = self.get_biweekly_expiry()
        if not self.active_expiry:
            return False

        strikes = choose_strangle_strikes(chain_df, spot, dte_days, entry_delta=self.entry_delta)
        ce_info = strikes["ce_short"]
        pe_info = strikes["pe_short"]

        # Premium symmetry check (within 60% balance)
        ratio = min(ce_info["price"], pe_info["price"]) / max(ce_info["price"], pe_info["price"]) if max(ce_info["price"], pe_info["price"]) > 0 else 0
        if ratio < 0.50:
            logger.warning(f"Skipping entry: Premium imbalance too high (CE: {ce_info['price']}, PE: {pe_info['price']}, ratio: {ratio:.2f})")
            return False

        qty = self.lots * self.lot_size
        logger.info(
            f"ENTERING STRANGLE: CE {ce_info['strike']} (Delta {ce_info['delta']:.2f}, Px {ce_info['price']:.2f}) | "
            f"PE {pe_info['strike']} (Delta {pe_info['delta']:.2f}, Px {pe_info['price']:.2f}) | Qty: {qty}"
        )

        # Place shorts
        ce_leg = self._sell_to_open(ce_info["strike"], "CE", qty, "ce_short")
        if not ce_leg:
            return False

        pe_leg = self._sell_to_open(pe_info["strike"], "PE", qty, "pe_short")
        if not pe_leg:
            # Rollback CE leg
            logger.error("PE leg entry failed. Unwinding filled CE leg!")
            self._close_leg("ce_short")
            return False

        self.legs["ce_short"] = ce_leg
        self.legs["pe_short"] = pe_leg
        self.entry_spot = spot
        self.entry_iv = 0.15  # Baseline
        self.position_open = True
        self.stage = STAGE_STRANGLE

        # Capital estimation (~Rs 1,50,000 per lot for Nifty strangle)
        self.deployed_margin = 150000.0 * self.lots
        self.target_profit_rs = resolve_target_rs(self.target_profit_raw, self.deployed_margin)
        self.stop_loss_rs = resolve_target_rs(self.stop_loss_raw, self.deployed_margin)

        logger.info(
            f"STRANGLE ACTIVE | Target: Rs {self.target_profit_rs:,.2f} | "
            f"Stop Loss: -Rs {abs(self.stop_loss_rs):,.2f} | Hedges: 0"
        )
        self.save_persisted_position()
        return True

    # ── CONDITIONAL HEDGING & DIRECTIONAL CONVERSION ─────────────────────────

    def execute_conditional_hedging(self, chain_df: Optional[pd.DataFrame], spot: float, dte_days: float, threat_info: dict):
        """Buys protective OTM hedge on threatened side or both sides."""
        qty = self.lots * self.lot_size

        if threat_info["need_ce_hedge"] and "ce_hedge" not in self.legs:
            logger.info(f"TRIGGER: Buying Call Hedge ({threat_info['reason']})...")
            ce_hedge_k, ce_hedge_px, ce_h_d, ce_h_vg = pick_leg_by_delta(
                chain_df, spot, dte_days, "CE", self.hedge_target_delta
            )
            ce_hedge_leg = self._buy_to_open(ce_hedge_k, "CE", qty, "ce_hedge")
            if ce_hedge_leg:
                self.legs["ce_hedge"] = ce_hedge_leg
                self.stage = STAGE_HEDGED
                self.save_persisted_position()

        if threat_info["need_pe_hedge"] and "pe_hedge" not in self.legs:
            logger.info(f"TRIGGER: Buying Put Hedge ({threat_info['reason']})...")
            pe_hedge_k, pe_hedge_px, pe_h_d, pe_h_vg = pick_leg_by_delta(
                chain_df, spot, dte_days, "PE", self.hedge_target_delta
            )
            pe_hedge_leg = self._buy_to_open(pe_hedge_k, "PE", qty, "pe_hedge")
            if pe_hedge_leg:
                self.legs["pe_hedge"] = pe_hedge_leg
                self.stage = STAGE_HEDGED
                self.save_persisted_position()

    def execute_directional_conversion(self, chain_df: Optional[pd.DataFrame], spot: float, dte_days: float, direction: str):
        """Transitions into a directional strategy upon sustained trend."""
        logger.info(f"DIRECTIONAL CONVERSION TRIGGERED: {direction} Trend confirmed!")
        notify(f"[{self.state_key}] Transitioning from Strangle to {direction} Directional Strategy!")

        qty = self.lots * self.lot_size

        if direction == "BULLISH":
            # 1. Harvest winning Put side (decayed)
            if "pe_short" in self.legs:
                self._close_leg("pe_short")
            if "pe_hedge" in self.legs:
                self._close_leg("pe_hedge")

            # 2. Manage Call side
            if self.conversion_style == "spread":
                # Close losing short call, deploy Bull Call Spread
                if "ce_short" in self.legs:
                    self._close_leg("ce_short")
                if "ce_hedge" in self.legs:
                    self._close_leg("ce_hedge")

                long_k, _, _, _ = pick_leg_by_delta(chain_df, spot, dte_days, "CE", 0.45)
                short_k, _, _, _ = pick_leg_by_delta(chain_df, spot, dte_days, "CE", 0.20)
                if short_k <= long_k:
                    short_k = long_k + 150

                long_leg = self._buy_to_open(long_k, "CE", qty, "dir_long_ce")
                short_leg = self._sell_to_open(short_k, "CE", qty, "dir_short_ce")
                if long_leg:
                    self.legs["dir_long_ce"] = long_leg
                if short_leg:
                    self.legs["dir_short_ce"] = short_leg

            self.stage = STAGE_DIRECTIONAL
            self.directional_direction = "BULLISH"
            self.save_persisted_position()

        elif direction == "BEARISH":
            # 1. Harvest winning Call side (decayed)
            if "ce_short" in self.legs:
                self._close_leg("ce_short")
            if "ce_hedge" in self.legs:
                self._close_leg("ce_hedge")

            # 2. Manage Put side
            if self.conversion_style == "spread":
                if "pe_short" in self.legs:
                    self._close_leg("pe_short")
                if "pe_hedge" in self.legs:
                    self._close_leg("pe_hedge")

                long_k, _, _, _ = pick_leg_by_delta(chain_df, spot, dte_days, "PE", 0.45)
                short_k, _, _, _ = pick_leg_by_delta(chain_df, spot, dte_days, "PE", 0.20)
                if short_k >= long_k:
                    short_k = long_k - 150

                long_leg = self._buy_to_open(long_k, "PE", qty, "dir_long_pe")
                short_leg = self._sell_to_open(short_k, "PE", qty, "dir_short_pe")
                if long_leg:
                    self.legs["dir_long_pe"] = long_leg
                if short_leg:
                    self.legs["dir_short_pe"] = short_leg

            self.stage = STAGE_DIRECTIONAL
            self.directional_direction = "BEARISH"
            self.save_persisted_position()

    # ── P&L & DASHBOARD STATE ────────────────────────────────────────────────

    def update_pnl_and_state(self, spot: float, chain_df: Optional[pd.DataFrame], dte_days: float):
        """Computes live P&L across all legs and updates dashboard bridge file."""
        unrealized = 0.0

        for leg_name, leg in self.legs.items():
            sec_id = leg["id"]
            ltp = self.helper.get_ltp(sec_id, exchange="NSE_FNO", instrument="OPTIDX")
            if ltp <= 0:
                ltp = leg["avg_price"]
            leg["ltp"] = ltp

            # Compute current delta and vega
            opt_type = leg["opt_type"]
            k = leg["strike"]
            d = greeks_from_days(opt_type, spot, k, dte_days, DEFAULT_IV, min_days=MIN_DTE_DAYS).delta
            vg = greeks_from_days("CE", spot, k, dte_days, DEFAULT_IV, min_days=MIN_DTE_DAYS).vega
            leg["delta"] = d
            leg["vega"] = vg

            # P&L
            qty = leg["qty"]
            if leg["side"] == "SELL":
                leg_pnl = (leg["avg_price"] - ltp) * qty
            else:
                leg_pnl = (ltp - leg["avg_price"]) * qty
            unrealized += leg_pnl

        self.unrealized_pnl = unrealized
        self.total_pnl = self.realized_pnl + self.unrealized_pnl
        if self.total_pnl > self.peak_pnl:
            self.peak_pnl = self.total_pnl

        # Publish dashboard state
        state_payload = {
            "strategy": STRATEGY_KEY_DEFAULT,
            "status": "RUNNING" if self.position_open else "WAITING",
            "stage": self.stage,
            "dry_run": self.dry_run,
            "broker": getattr(self.broker, "broker", "dhan"),
            "lots": self.lots,
            "spot": spot,
            "active_expiry": self.active_expiry,
            "realized_pnl": round(self.realized_pnl, 2),
            "unrealized_pnl": round(self.unrealized_pnl, 2),
            "total_pnl": round(self.total_pnl, 2),
            "peak_pnl": round(self.peak_pnl, 2),
            "target_profit_rs": self.target_profit_rs,
            "stop_loss_rs": self.stop_loss_rs,
            "directional_direction": self.directional_direction,
            "legs": self.legs,
        }
        save_strategy_state(self.state_key, state_payload)

    # ── MAIN LOOP ────────────────────────────────────────────────────────────

    def run(self):
        """Main lifecycle execution loop."""
        logger.info(f"Starting main execution loop for {self.state_key}...")

        # 1. Attempt restoring open position from disk
        restored = self.load_persisted_position()
        if restored:
            if not self.reconcile_with_broker():
                logger.critical("Broker reconciliation mismatch. Halting execution.")
                sys.exit(1)

        while True:
            # A. Check dashboard stop / shutdown trigger
            if check_shutdown_trigger(self.state_key):
                logger.info("Shutdown trigger received from dashboard.")
                if self.position_open:
                    self.exit_all(reason="Dashboard Stop Button")
                save_strategy_state(self.state_key, {"status": "STOPPED", "total_pnl": self.total_pnl})
                break

            # B. Market hours check
            now_dt = datetime.now()
            exit_if_market_closed(self.helper, self.dry_run)

            # C. Fetch spot price
            spot = self.helper.get_ltp(UNDERLYING, exchange="IDX_I", instrument="INDEX")
            if spot <= 0:
                logger.warning(f"Invalid spot price: {spot}. Waiting for tick...")
                time.sleep(self.poll_interval)
                continue

            # D. Compute DTE
            target_exp = self.active_expiry or self.get_biweekly_expiry()
            if target_exp:
                exp_date = datetime.strptime(target_exp, "%Y-%m-%d").date()
                dte_days = max(0.5, (exp_date - now_dt.date()).days)
            else:
                dte_days = 10.0

            # E. Fetch option chain
            chain_df = None
            if target_exp:
                try:
                    chain_df = self.helper.get_option_chain_df(UNDERLYING, target_exp)
                except Exception as e:
                    logger.debug(f"Option chain fetch: {e}")

            # F. Position Management
            if not self.position_open:
                now_str = now_dt.strftime("%H:%M")
                if self.entry_time_str <= now_str <= self.entry_end_str:
                    logger.info(f"Within entry window ({now_str}). Attempting strangle entry...")
                    self.attempt_entry(spot, chain_df, dte_days)
                else:
                    save_strategy_state(self.state_key, {
                        "status": "WAITING",
                        "spot": spot,
                        "stage": STAGE_FLAT,
                        "total_pnl": self.total_pnl,
                        "broker": getattr(self.broker, "broker", "dhan"),
                        "dry_run": self.dry_run,
                    })
            else:
                # Update P&L and Greeks
                self.update_pnl_and_state(spot, chain_df, dte_days)

                # 1. Target Profit Check
                if self.target_profit_rs and self.total_pnl >= self.target_profit_rs:
                    self.exit_all(reason=f"Target Profit Reached (+Rs {self.total_pnl:,.2f})")
                    continue

                # 2. Stop Loss Check
                if self.stop_loss_rs and self.total_pnl <= -abs(self.stop_loss_rs):
                    self.exit_all(reason=f"Stop Loss Hit (-Rs {abs(self.total_pnl):,.2f})")
                    continue

                # 3. Trailing Stop Check
                if self.trail_start_rs > 0 and self.trail_gap_rs > 0:
                    if self.peak_pnl >= self.trail_start_rs:
                        if self.total_pnl <= (self.peak_pnl - self.trail_gap_rs):
                            self.exit_all(reason=f"Trailing Stop Triggered (Peak: Rs {self.peak_pnl:,.2f}, Current: Rs {self.total_pnl:,.2f})")
                            continue

                # 4. Expiry Day EOD Exit
                if target_exp:
                    exp_date = datetime.strptime(target_exp, "%Y-%m-%d").date()
                    if now_dt.date() == exp_date and now_dt.strftime("%H:%M") >= self.eod_exit_time_str:
                        self.exit_all(reason="Expiry Day EOD Square-Off")
                        continue

                # 5. Greek Evaluation & Conditional Hedging
                ce_d = self.legs.get("ce_short", {}).get("delta", 0.0)
                pe_d = self.legs.get("pe_short", {}).get("delta", 0.0)
                iv_change = 0.0  # Optional live IV delta

                has_ce_h = "ce_hedge" in self.legs
                has_pe_h = "pe_hedge" in self.legs

                threat = evaluate_threat_and_hedging(
                    ce_d, pe_d, iv_change,
                    hedge_delta_trigger=self.hedge_delta_trigger,
                    vega_surge_pct=self.vega_surge_pct,
                    has_ce_hedge=has_ce_h,
                    has_pe_hedge=has_pe_h,
                )
                if threat["need_ce_hedge"] or threat["need_pe_hedge"]:
                    self.execute_conditional_hedging(chain_df, spot, dte_days, threat)

                # 6. Directional Conversion (Optional)
                if self.enable_directional_conversion and self.stage in (STAGE_STRANGLE, STAGE_HEDGED):
                    dir_trend = evaluate_directional_conversion(
                        ce_d, pe_d, spot, trend_ema=None,
                        conversion_delta_trigger=self.conversion_delta_trigger
                    )
                    if dir_trend:
                        self.execute_directional_conversion(chain_df, spot, dte_days, dir_trend)

            time.sleep(self.poll_interval)


# ── CLI & PARSER ─────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(
        description="Nifty Bi-Weekly Adaptive Strangle with Conditional Greeks-based Hedging.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run after-hours:
  python strategies/adaptive_strangle/nifty_adaptive_strangle.py

  # Dry run with directional conversion enabled:
  python strategies/adaptive_strangle/nifty_adaptive_strangle.py --enable-directional-conversion --lots 2

  # Live run on Dhan:
  python strategies/adaptive_strangle/nifty_adaptive_strangle.py --live --lots 1 --broker dhan --target-profit 5% --stop-loss 4%
        """,
    )
    p.add_argument("--live", action="store_true", default=False, help="Place real orders (default: dry run).")
    p.add_argument("--lots", type=int, default=1, help="Number of lots (default: 1).")
    p.add_argument("--entry-delta", type=float, default=0.10, help="Initial far-OTM strangle delta target (default: 0.10).")
    p.add_argument("--hedge-delta-trigger", type=float, default=0.22, help="Short delta threshold to buy protective wing (default: 0.22).")
    p.add_argument("--hedge-target-delta", type=float, default=0.08, help="Delta target for protective wing (default: 0.08).")
    p.add_argument("--vega-surge-pct", type=float, default=20.0, help="IV surge percentage to buy wings (default: 20.0%%).")
    p.add_argument("--enable-directional-conversion", action="store_true", default=False, help="Convert to directional spread on sustained trend.")
    p.add_argument("--conversion-delta-trigger", type=float, default=0.30, help="Delta threshold for directional conversion (default: 0.30).")
    p.add_argument("--conversion-style", choices=["spread", "ratio"], default="spread", help="Directional structure style (default: spread).")
    p.add_argument("--target-profit", type=str, default="5%", help="Target profit in rupees or %% of margin (default: 5%%).")
    p.add_argument("--stop-loss", type=str, default="4%", help="Stop loss in rupees or %% of margin (default: 4%%).")
    p.add_argument("--trail-start-rs", type=float, default=0.0, help="Trailing stop arming threshold in Rs (default: 0.0).")
    p.add_argument("--trail-gap-rs", type=float, default=0.0, help="Trailing stop giveback gap in Rs (default: 0.0).")
    p.add_argument("--entry-time", type=str, default="09:20", help="Entry start time HH:MM (default: 09:20).")
    p.add_argument("--entry-end", type=str, default="15:00", help="Entry end time HH:MM (default: 15:00).")
    p.add_argument("--eod-exit-time", type=str, default="15:15", help="Expiry day exit time HH:MM (default: 15:15).")
    p.add_argument("--poll-interval", type=int, default=2, help="Poll interval in seconds (default: 2).")
    p.add_argument("--instance-id", type=str, default="", help="Unique instance ID for multi-instance isolation.")
    p.add_argument("--broker", choices=["dhan", "zerodha", "kotak"], default="dhan", help="Execution broker (default: dhan).")
    p.add_argument("--product", choices=["MARGIN", "INTRADAY"], default="MARGIN", help="Broker product type (default: MARGIN).")

    args = p.parse_args()

    # Validate arguments
    errors = []
    if args.lots < 1:
        errors.append(f"--lots must be >= 1, got {args.lots}")
    if not (0.02 <= args.entry_delta <= 0.30):
        errors.append(f"--entry-delta must be between 0.02 and 0.30, got {args.entry_delta}")
    if not (0.15 <= args.hedge_delta_trigger <= 0.45):
        errors.append(f"--hedge-delta-trigger must be between 0.15 and 0.45, got {args.hedge_delta_trigger}")
    if args.hedge_delta_trigger <= args.entry_delta:
        errors.append(f"--hedge-delta-trigger ({args.hedge_delta_trigger}) must be greater than --entry-delta ({args.entry_delta})")
    if args.conversion_delta_trigger <= args.hedge_delta_trigger:
        errors.append(f"--conversion-delta-trigger ({args.conversion_delta_trigger}) must be greater than --hedge-delta-trigger ({args.hedge_delta_trigger})")

    if errors:
        for err in errors:
            logger.error(f"[CONFIG ERROR] {err}")
        sys.exit(1)

    return args


def main():
    args = parse_args()
    dhan = get_dhan_client()
    if not dhan:
        logger.error("Failed to initialize Dhan client. Exiting.")
        sys.exit(1)

    helper = DhanHelper(dhan)
    try:
        broker = ExecutionBroker.create(args.broker, helper=helper, underlying=UNDERLYING, log=logger.info)
    except ExecutionBrokerError as e:
        logger.error(f"Failed to initialize broker {args.broker}: {e}")
        sys.exit(1)

    strategy = NiftyAdaptiveStrangle(
        helper=helper,
        broker=broker,
        dry_run=not args.live,
        lots=args.lots,
        entry_delta=args.entry_delta,
        hedge_delta_trigger=args.hedge_delta_trigger,
        hedge_target_delta=args.hedge_target_delta,
        vega_surge_pct=args.vega_surge_pct,
        enable_directional_conversion=args.enable_directional_conversion,
        conversion_delta_trigger=args.conversion_delta_trigger,
        conversion_style=args.conversion_style,
        target_profit=args.target_profit,
        stop_loss=args.stop_loss,
        trail_start_rs=args.trail_start_rs,
        trail_gap_rs=args.trail_gap_rs,
        entry_time_str=args.entry_time,
        entry_end_str=args.entry_end,
        eod_exit_time_str=args.eod_exit_time,
        poll_interval=args.poll_interval,
        instance_id=args.instance_id,
        product=args.product,
    )

    try:
        strategy.run()
    except KeyboardInterrupt:
        logger.info("KeyboardInterrupt received. Exiting safely...")
        if strategy.position_open:
            strategy.exit_all(reason="KeyboardInterrupt")
        save_strategy_state(strategy.state_key, {"status": "STOPPED", "total_pnl": strategy.total_pnl})


if __name__ == "__main__":
    main()
