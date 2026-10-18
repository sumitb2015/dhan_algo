"""Modular Straddle Management Engine.

Provides reusable data structures, risk evaluators, and broker execution helpers
for selling and dynamically managing short option straddles and strangles.
Can be composed into any live strategy, backtest, or multi-underlying desk.
"""

from dataclasses import asdict, dataclass, field
from enum import Enum
import time
from typing import Any, Dict, Optional, Tuple
import pandas as pd

from lib.algo_kit import confirmed_fill_price, extract_quote_fields, is_quote_invalid
from lib.managed_straddle_rules import (
    atm_imbalance_pct,
    combined_sl_hit,
    find_match_strike,
    is_atm_balanced,
    is_inverted,
    leg_sl_hit,
    leg_target_hit,
)
from lib.strategy_risk import detect_phantom_leg_broker, resolve_exit_qty_broker


class StraddleSignal(str, Enum):
    """Signals produced when evaluating live straddle prices against risk rules."""
    NONE = "NONE"
    COMBINED_SL_HIT = "COMBINED_SL_HIT"
    CE_SL_HIT = "CE_SL_HIT"
    PE_SL_HIT = "PE_SL_HIT"
    CE_TARGET_HIT = "CE_TARGET_HIT"
    PE_TARGET_HIT = "PE_TARGET_HIT"


@dataclass
class StraddleRiskConfig:
    """Configurable thresholds for straddle entry and risk management."""
    combined_sl_pct: float = 20.0
    leg_sl_pct: float = 20.0
    leg_target_pct: float = 30.0
    entry_diff_pct: float = 10.0
    max_adjustments: int = 10
    adjustment_cooldown: int = 30

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "StraddleRiskConfig":
        return cls(
            combined_sl_pct=float(d.get("combined_sl_pct", 20.0)),
            leg_sl_pct=float(d.get("leg_sl_pct", 20.0)),
            leg_target_pct=float(d.get("leg_target_pct", 30.0)),
            entry_diff_pct=float(d.get("entry_diff_pct", 10.0)),
            max_adjustments=int(d.get("max_adjustments", 10)),
            adjustment_cooldown=int(d.get("adjustment_cooldown", 30)),
        )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class StraddleLeg:
    """Represents a single active leg of a short straddle."""
    opt_type: str  # "CE" or "PE"
    strike: int
    id: Optional[str]
    entry_price: float
    qty: int
    sl: float
    target: float

    def compute_unrealized_pnl(self, ltp: float) -> float:
        """Short option P&L: (entry - ltp) * qty."""
        if ltp <= 0 or self.entry_price <= 0:
            return 0.0
        return (self.entry_price - ltp) * self.qty

    def is_sl_hit(self, ltp: float, sl_pct: float) -> bool:
        return leg_sl_hit(ltp, self.entry_price, sl_pct)

    def is_target_hit(self, ltp: float, target_pct: float) -> bool:
        return leg_target_hit(ltp, self.entry_price, target_pct)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Optional[Dict[str, Any]]) -> Optional["StraddleLeg"]:
        if not d:
            return None
        return cls(
            opt_type=str(d.get("opt_type", "")),
            strike=int(d.get("strike", 0)),
            id=str(d.get("id")) if d.get("id") else None,
            entry_price=float(d.get("entry_price", 0.0)),
            qty=int(d.get("qty", 0)),
            sl=float(d.get("sl", 0.0)),
            target=float(d.get("target", 0.0)),
        )


@dataclass
class StraddlePosition:
    """Holds complete state for a 2-leg short straddle."""
    atm_strike: int = 0
    combined_p0: float = 0.0
    ce_leg: Optional[StraddleLeg] = None
    pe_leg: Optional[StraddleLeg] = None
    realized_pnl: float = 0.0
    adjustment_count: int = 0
    last_adjustment_ts: float = 0.0

    @property
    def is_open(self) -> bool:
        return bool(self.ce_leg and self.pe_leg)

    def total_pnl(self, ce_ltp: float, pe_ltp: float) -> float:
        """Total strategy P&L (realized + unrealized on both legs)."""
        unrealized_ce = self.ce_leg.compute_unrealized_pnl(ce_ltp) if self.ce_leg else 0.0
        unrealized_pe = self.pe_leg.compute_unrealized_pnl(pe_ltp) if self.pe_leg else 0.0
        return self.realized_pnl + unrealized_ce + unrealized_pe

    def evaluate_risk(self, ce_ltp: float, pe_ltp: float, config: StraddleRiskConfig) -> StraddleSignal:
        """Evaluate market prices against all straddle risk rules."""
        if not self.is_open or ce_ltp <= 0 or pe_ltp <= 0:
            return StraddleSignal.NONE

        # 1. Global Combined Premium SL
        if combined_sl_hit(ce_ltp, pe_ltp, self.combined_p0, config.combined_sl_pct):
            return StraddleSignal.COMBINED_SL_HIT

        # 2. Leg SL triggers (20% rise above entry)
        if self.ce_leg and self.ce_leg.is_sl_hit(ce_ltp, config.leg_sl_pct):
            return StraddleSignal.CE_SL_HIT
        if self.pe_leg and self.pe_leg.is_sl_hit(pe_ltp, config.leg_sl_pct):
            return StraddleSignal.PE_SL_HIT

        # 3. Leg Target triggers (30% decay below entry)
        if self.ce_leg and self.ce_leg.is_target_hit(ce_ltp, config.leg_target_pct):
            return StraddleSignal.CE_TARGET_HIT
        if self.pe_leg and self.pe_leg.is_target_hit(pe_ltp, config.leg_target_pct):
            return StraddleSignal.PE_TARGET_HIT

        return StraddleSignal.NONE

    def to_dict(self) -> Dict[str, Any]:
        return {
            "atm_strike": self.atm_strike,
            "combined_p0": self.combined_p0,
            "ce_leg": self.ce_leg.to_dict() if self.ce_leg else None,
            "pe_leg": self.pe_leg.to_dict() if self.pe_leg else None,
            "realized_pnl": self.realized_pnl,
            "adjustment_count": self.adjustment_count,
            "last_adjustment_ts": self.last_adjustment_ts,
        }

    @classmethod
    def from_dict(cls, d: Optional[Dict[str, Any]]) -> "StraddlePosition":
        if not d:
            return cls()
        return cls(
            atm_strike=int(d.get("atm_strike", 0)),
            combined_p0=float(d.get("combined_p0", 0.0)),
            ce_leg=StraddleLeg.from_dict(d.get("ce_leg")),
            pe_leg=StraddleLeg.from_dict(d.get("pe_leg")),
            realized_pnl=float(d.get("realized_pnl", 0.0)),
            adjustment_count=int(d.get("adjustment_count", 0)),
            last_adjustment_ts=float(d.get("last_adjustment_ts", 0.0)),
        )


class StraddleExecutor:
    """Reusable operator for broker execution, leg adjustments, and risk management."""

    def __init__(self, broker: Any, helper: Any, underlying: str = "NIFTY", product: str = "INTRADAY", log: Any = None):
        self.broker = broker
        self.helper = helper
        self.underlying = underlying
        self.product = product
        self.logger = log

    def _log_info(self, msg: str):
        if self.logger:
            self.logger.info(msg)

    def _log_warning(self, msg: str):
        if self.logger:
            self.logger.warning(msg)

    def _log_error(self, msg: str):
        if self.logger:
            self.logger.error(msg)

    def _get_quote(self, strike: int, opt_type: str) -> Tuple[Optional[str], float]:
        q = self.helper.option(self.underlying, strike, opt_type)
        if is_quote_invalid(q):
            return None, 0.0
        sec_id, price, _, _, _ = extract_quote_fields(q, strike, opt_type)
        return (str(sec_id), float(price)) if sec_id and price > 0 else (None, 0.0)

    def _get_ltp(self, sec_id: Optional[str]) -> float:
        if not sec_id:
            return 0.0
        return float(self.helper.get_ltp(str(sec_id), exchange="NSE_FNO", instrument="OPTIDX"))

    def enter_straddle(
        self,
        atm_strike_val: int,
        expiry: str,
        qty: int,
        lot_size: int,
        config: StraddleRiskConfig,
        dry_run: bool = True,
    ) -> Tuple[Optional[StraddlePosition], Optional[str]]:
        """Enter a balanced ATM straddle by selling ATM CE and PE.
        
        Returns:
            (position, error_message)
        """
        ce_id, ce_px = self._get_quote(atm_strike_val, "CE")
        pe_id, pe_px = self._get_quote(atm_strike_val, "PE")

        if not ce_id or not pe_id or ce_px <= 0 or pe_px <= 0:
            return None, f"Quotes unavailable for ATM {atm_strike_val}"

        diff_pct = atm_imbalance_pct(ce_px, pe_px)
        if not is_atm_balanced(ce_px, pe_px, config.entry_diff_pct):
            return None, f"ATM unbalanced (Diff: {diff_pct:.2f}% >= {config.entry_diff_pct}%)"

        self._log_info(
            f"Entering ATM {atm_strike_val} straddle: CE={ce_px:.2f}, PE={pe_px:.2f} (Diff: {diff_pct:.2f}%)"
        )

        # Place CE sell order
        ce_oid = None
        if not dry_run:
            ce_oid = self.broker.sell(atm_strike_val, expiry, "CE", qty)
            if not ce_oid:
                return None, "Failed to place CE sell order"
            self._log_info(f"CE sell order placed: {ce_oid}")

        ce_fill = confirmed_fill_price(
            self.broker, ce_oid, fallback_price=ce_px, lot_size=lot_size, log=self.logger, dry_run=dry_run
        )

        # Place PE sell order
        pe_oid = None
        if not dry_run:
            pe_oid = self.broker.sell(atm_strike_val, expiry, "PE", qty)
            if not pe_oid:
                self._log_error(f"Failed to place PE sell order after CE filled! Unwinding CE {atm_strike_val}...")
                buy_qty, _ = resolve_exit_qty_broker(self.broker, atm_strike_val, expiry, "CE", qty, "BUY", self.logger)
                if buy_qty > 0:
                    self.broker.buy(atm_strike_val, expiry, "CE", buy_qty)
                return None, "PE sell failed, CE unwound"
            self._log_info(f"PE sell order placed: {pe_oid}")

        pe_fill = confirmed_fill_price(
            self.broker, pe_oid, fallback_price=pe_px, lot_size=lot_size, log=self.logger, dry_run=dry_run
        )

        # Subscribe WebSocket feeds
        try:
            self.helper.subscribe_instruments([
                ("NSE_FNO", str(ce_id), 15),
                ("NSE_FNO", str(pe_id), 15),
            ])
        except Exception as e:
            self._log_warning(f"WebSocket subscribe warning: {e}")

        ce_leg = StraddleLeg(
            opt_type="CE",
            strike=atm_strike_val,
            id=ce_id,
            entry_price=ce_fill,
            qty=qty,
            sl=ce_fill * (1.0 + config.leg_sl_pct / 100.0),
            target=ce_fill * (1.0 - config.leg_target_pct / 100.0),
        )
        pe_leg = StraddleLeg(
            opt_type="PE",
            strike=atm_strike_val,
            id=pe_id,
            entry_price=pe_fill,
            qty=qty,
            sl=pe_fill * (1.0 + config.leg_sl_pct / 100.0),
            target=pe_fill * (1.0 - config.leg_target_pct / 100.0),
        )

        position = StraddlePosition(
            atm_strike=atm_strike_val,
            combined_p0=ce_fill + pe_fill,
            ce_leg=ce_leg,
            pe_leg=pe_leg,
            realized_pnl=0.0,
            adjustment_count=0,
            last_adjustment_ts=time.time(),
        )
        return position, None

    def roll_leg(
        self,
        position: StraddlePosition,
        leg_type: str,
        reason: str,
        surviving_ltp: float,
        chain_df: pd.DataFrame,
        expiry: str,
        lot_size: int,
        config: StraddleRiskConfig,
        dry_run: bool = True,
    ) -> Tuple[bool, Optional[str]]:
        """Close losing/target leg and roll to replacement strike matching opposite leg's LTP.
        
        Returns:
            (success, error_or_summary_message)
        """
        old_leg = position.ce_leg if leg_type == "CE" else position.pe_leg
        opposite_leg = position.pe_leg if leg_type == "CE" else position.ce_leg

        if not old_leg or not opposite_leg:
            return False, "Cannot roll: missing active legs"

        old_strike = old_leg.strike
        old_id = old_leg.id
        old_entry = old_leg.entry_price
        qty = old_leg.qty

        # Inversion constraint
        opp_strike = opposite_leg.strike
        non_inverted_with = ("PE", opp_strike) if leg_type == "CE" else ("CE", opp_strike)

        # Find replacement strike matching surviving opposite leg LTP
        new_strike, new_price, new_id = find_match_strike(
            chain_df,
            leg_type,
            target_premium=surviving_ltp,
            avoid_strike=old_strike,
            non_inverted_with=non_inverted_with,
        )

        if not new_strike:
            # Fallback search without strict inversion filter
            new_strike, new_price, new_id = find_match_strike(
                chain_df, leg_type, target_premium=surviving_ltp, avoid_strike=old_strike
            )

        if not new_strike:
            return False, f"No suitable replacement {leg_type} strike found in chain"

        # Close old leg
        exit_ltp = self._get_ltp(old_id)
        buy_oid = None
        if not dry_run:
            buy_qty, _ = resolve_exit_qty_broker(self.broker, old_strike, expiry, leg_type, qty, "BUY", self.logger)
            if buy_qty <= 0:
                return False, f"resolve_exit_qty_broker returned 0 for {leg_type} {old_strike}"
            buy_oid = self.broker.buy(old_strike, expiry, leg_type, buy_qty)
            if not buy_oid:
                return False, f"Failed to place buy-to-close for {leg_type} {old_strike}"

        exit_fill = confirmed_fill_price(
            self.broker, buy_oid, fallback_price=exit_ltp, lot_size=lot_size, log=self.logger, dry_run=dry_run
        )

        # Realize P&L on closed leg
        leg_pnl = (old_entry - exit_fill) * qty
        position.realized_pnl += leg_pnl

        # Unsubscribe old leg
        if old_id:
            try:
                self.helper.unsubscribe_instruments([("NSE_FNO", str(old_id), 15)])
            except Exception:
                pass

        # Sell replacement leg
        sell_oid = None
        if not dry_run:
            sell_oid = self.broker.sell(new_strike, expiry, leg_type, qty)
            if not sell_oid:
                self._log_error(f"Replacement {leg_type} sell order failed!")
                if leg_type == "CE":
                    position.ce_leg = None
                else:
                    position.pe_leg = None
                return False, "Replacement sell order failed; position left unhedged"

        new_fill = confirmed_fill_price(
            self.broker, sell_oid, fallback_price=new_price, lot_size=lot_size, log=self.logger, dry_run=dry_run
        )

        if not new_id:
            resolved_id, _ = self._get_quote(new_strike, leg_type)
            new_id = resolved_id

        # Subscribe new leg
        if new_id:
            try:
                self.helper.subscribe_instruments([("NSE_FNO", str(new_id), 15)])
            except Exception:
                pass

        # Update position with replacement leg and new SL/Target
        new_leg = StraddleLeg(
            opt_type=leg_type,
            strike=new_strike,
            id=new_id,
            entry_price=new_fill,
            qty=qty,
            sl=new_fill * (1.0 + config.leg_sl_pct / 100.0),
            target=new_fill * (1.0 - config.leg_target_pct / 100.0),
        )

        if leg_type == "CE":
            position.ce_leg = new_leg
        else:
            position.pe_leg = new_leg

        # Update combined premium baseline & counters
        position.combined_p0 = new_fill + surviving_ltp
        position.adjustment_count += 1
        position.last_adjustment_ts = time.time()

        summary = (
            f"Rolled {leg_type} {old_strike} -> {new_strike} @ {new_fill:.2f} ({reason}). "
            f"Leg P&L: ₹{leg_pnl:+.2f} | Matched opposite LTP: {surviving_ltp:.2f}"
        )
        self._log_info(summary)
        return True, summary

    def square_off_all(
        self,
        position: StraddlePosition,
        expiry: str,
        lot_size: int,
        dry_run: bool = True,
        reason: str = "Exit",
    ) -> float:
        """Square off both legs cleanly and return total realized P&L."""
        self._log_info(f"Squaring off all open positions ({reason})...")

        for opt_type, leg in (("CE", position.ce_leg), ("PE", position.pe_leg)):
            if not leg or not leg.strike:
                continue
            strike = leg.strike
            qty = leg.qty
            ltp = self._get_ltp(leg.id)

            buy_oid = None
            if not dry_run:
                buy_qty, _ = resolve_exit_qty_broker(self.broker, strike, expiry, opt_type, qty, "BUY", self.logger)
                if buy_qty > 0:
                    buy_oid = self.broker.buy(strike, expiry, opt_type, buy_qty)

            fill = confirmed_fill_price(
                self.broker, buy_oid, fallback_price=ltp, lot_size=lot_size, log=self.logger, dry_run=dry_run
            )

            pnl = (leg.entry_price - fill) * qty
            position.realized_pnl += pnl
            self._log_info(f"Closed {opt_type} {strike} @ {fill:.2f}. Leg P&L: ₹{pnl:+.2f}")

            if leg.id:
                try:
                    self.helper.unsubscribe_instruments([("NSE_FNO", str(leg.id), 15)])
                except Exception:
                    pass

        position.ce_leg = None
        position.pe_leg = None
        return position.realized_pnl

    def check_phantoms(self, position: StraddlePosition, expiry: str, dry_run: bool = True) -> Optional[str]:
        """Detect if broker has squared off any tracked leg externally."""
        for opt_type, leg in (("CE", position.ce_leg), ("PE", position.pe_leg)):
            if leg and detect_phantom_leg_broker(
                self.broker, leg.strike, expiry, opt_type, leg.qty, "BUY", self.logger, dry_run=dry_run
            ):
                return f"Phantom {opt_type} leg detected at {leg.strike}"
        return None

