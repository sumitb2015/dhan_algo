#!/usr/bin/env python
"""Nifty Managed Straddle Strategy.

Intraday Nifty short ATM straddle that enters at or after 09:20 IST once the difference
between ATM CE and PE prices is less than 10%. Manages risk with a 20% stop-loss on the
combined premium, and 20% stop-loss + 30% profit target on individual legs.

When a leg's 20% SL is hit:
    1. Close the losing leg immediately.
    2. Match the current premium of the surviving (opposite) leg by selling a replacement
       strike on the same side whose market price is closest to the opposite leg's LTP.
    3. Reset the 20% SL and 30% target on the new replacement leg.

When a leg's 30% profit target is hit:
    1. Close the winning leg to lock in the theta decay.
    2. Match the current premium of the surviving (opposite) leg by selling a replacement
       strike whose price is closest to the opposite leg's LTP.
    3. Reset risk parameters on the new leg.

Global exit at 15:15 IST or if the combined straddle premium expands by 20%.

Modular architecture: Composes reusable primitives from `lib.straddle_manager` and
`lib.managed_straddle_rules`.

Validation status: UNVALIDATED. Dry-run by default; --live places real orders.
"""

import argparse
import os
import sys
import time
from datetime import datetime
from typing import Optional, Tuple


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

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib.execution_broker import ExecutionBroker, ExecutionBrokerError
from lib.strategy_state_helper import (
    save_strategy_state,
    check_shutdown_trigger,
    exit_if_market_closed,
    parse_target_spec,
    instance_log_suffix,
    reset_pnl_on_new_day,
)
from lib.strategy_risk import PHANTOM_CHECK_INTERVAL_SEC
from lib.telegram_alert import notify
from lib.algo_kit import (
    PositionStore,
    interruptible_sleep,
    setup_strategy_logging,
)
from lib.managed_straddle_rules import atm_strike
from lib.straddle_manager import (
    StraddleExecutor,
    StraddlePosition,
    StraddleRiskConfig,
    StraddleSignal,
)

STRATEGY_KEY_DEFAULT = "nifty_managed_straddle"
LOG_FOLDER = "managed_straddle"
UNDERLYING = "NIFTY"
PRODUCT = "INTRADAY"
STRIKE_STEP = 50
INDEX_ID = "13"

debug_dir = os.path.join(project_root, "debug")
logger = setup_strategy_logging(project_root, LOG_FOLDER, instance_log_suffix(), name=__name__, force=True)


class ManagedStraddleStrategy:
    """Strategy orchestrator coupling modular straddle engine with dashboard state bridge."""

    def __init__(
        self,
        dry_run: bool = True,
        lots: int = 1,
        risk_config: Optional[StraddleRiskConfig] = None,
        start_time: str = "09:20",
        eod_time: str = "15:15",
        profit_target: float = 4000.0,
        profit_target_is_pct: bool = False,
        stop_loss: float = 4000.0,
        stop_loss_is_pct: bool = False,
        trail_start_rs: float = 2000.0,
        trail_gap_rs: float = 1000.0,
        state_key: str = STRATEGY_KEY_DEFAULT,
        broker: str = "dhan",
    ):
        self.state_key = state_key
        self.broker_name = broker
        self.dry_run = dry_run
        self.lots = lots
        self.config = risk_config or StraddleRiskConfig()
        self.start_time = start_time
        self.eod_time = eod_time

        # Global MTM target / SL / trailing
        self.profit_target = profit_target if not profit_target_is_pct else None
        self.stop_loss = -abs(stop_loss) if not stop_loss_is_pct else None
        self.trail_start_rs = float(trail_start_rs)
        self.trail_gap_rs = float(trail_gap_rs)
        self.trail_active = False
        self.best_pnl = 0.0

        # Connect DhanHelper
        self.dhan = get_dhan_client()
        if not self.dhan:
            raise RuntimeError("Failed to connect to Dhan API.")
        self.helper = DhanHelper(self.dhan)

        # Broker interface
        try:
            self.broker = ExecutionBroker.create(broker, self.helper, underlying=UNDERLYING, log=logger.info)
        except ExecutionBrokerError as e:
            logger.error(f"Could not start {broker} execution: {e}")
            raise

        logger.info(f"Starting WebSocket feed for {UNDERLYING} Index...")
        self.helper.start_websocket([("IDX_I", INDEX_ID, 15)])
        time.sleep(2)

        _levels = self.helper.get_prev_day_levels(UNDERLYING)
        self.prev_day_close = _levels["close"] if _levels else None
        self.lot_size = self.helper.get_lot_size(UNDERLYING)

        # Initialize modular executor and state
        self.executor = StraddleExecutor(
            self.broker, self.helper, underlying=UNDERLYING, product=PRODUCT, log=logger
        )
        self.position = StraddlePosition()
        self.status = "WAITING"
        self.expiry: Optional[str] = None

        self.load_position()

    @property
    def position_path(self) -> str:
        return os.path.join(debug_dir, f"{self.state_key}_position.json")

    def _position_store(self) -> PositionStore:
        return PositionStore(self.position_path, self.dry_run, log=logger)

    def save_position(self):
        """Atomically persist open position for crash recovery."""
        payload = self.position.to_dict()
        payload.update({
            "status": self.status,
            "expiry": self.expiry,
            "lots": self.lots,
            "lot_size": self.lot_size,
            "trail_active": self.trail_active,
            "best_pnl": self.best_pnl,
        })
        self._position_store().save(payload)

    def load_position(self):
        """Restore position state from disk after process restart."""
        data = self._position_store().load(expiry_field="expiry")
        if data is None:
            return
        self.position = StraddlePosition.from_dict(data)
        self.status = data.get("status", "WAITING")
        self.expiry = data.get("expiry")
        self.lot_size = int(data.get("lot_size", self.lot_size))
        self.trail_active = bool(data.get("trail_active", False))
        self.best_pnl = float(data.get("best_pnl", 0.0))

        if self.position.is_open:
            logger.info(
                f"Restored open position: expiry={self.expiry} atm={self.position.atm_strike} "
                f"CE={self.position.ce_leg.strike if self.position.ce_leg else None} "
                f"PE={self.position.pe_leg.strike if self.position.pe_leg else None} "
                f"realized_pnl=₹{self.position.realized_pnl:+.2f}"
            )
            # Resubscribe live legs to WebSocket
            for leg in (self.position.ce_leg, self.position.pe_leg):
                if leg and leg.id:
                    try:
                        self.helper.subscribe_instruments([("NSE_FNO", str(leg.id), 15)])
                    except Exception as e:
                        logger.error(f"Resubscribe error for leg {leg.id}: {e}")

    def save_state(self, spot: float, ce_ltp: float, pe_ltp: float, total_pnl: float, status: Optional[str] = None):
        """Publish runtime state to debug/<key>_state.json for dashboard polling."""
        if status:
            self.status = status

        combined_ltp = (ce_ltp + pe_ltp) if (ce_ltp > 0 and pe_ltp > 0) else 0.0
        combined_sl_level = (
            self.position.combined_p0 * (1.0 + self.config.combined_sl_pct / 100.0)
            if self.position.combined_p0 > 0
            else 0.0
        )

        legs_dict = {}
        if self.position.ce_leg:
            legs_dict["CE"] = {
                "id": self.position.ce_leg.id,
                "strike": self.position.ce_leg.strike,
                "entry_price": self.position.ce_leg.entry_price,
                "ltp": ce_ltp,
                "qty": self.position.ce_leg.qty,
                "sl": self.position.ce_leg.sl,
                "target": self.position.ce_leg.target,
            }
        if self.position.pe_leg:
            legs_dict["PE"] = {
                "id": self.position.pe_leg.id,
                "strike": self.position.pe_leg.strike,
                "entry_price": self.position.pe_leg.entry_price,
                "ltp": pe_ltp,
                "qty": self.position.pe_leg.qty,
                "sl": self.position.pe_leg.sl,
                "target": self.position.pe_leg.target,
            }

        state = {
            "strategy": "Nifty Managed Straddle",
            "status": self.status,
            "dry_run": self.dry_run,
            "broker": self.broker_name,
            "underlying": UNDERLYING,
            "expiry": self.expiry,
            "lots": self.lots,
            "lot_size": self.lot_size,
            "spot": spot,
            "atm_strike": self.position.atm_strike,
            "combined_p0": self.position.combined_p0,
            "combined_ltp": combined_ltp,
            "combined_sl_level": combined_sl_level,
            "combined_sl_pct": self.config.combined_sl_pct,
            "leg_sl_pct": self.config.leg_sl_pct,
            "leg_target_pct": self.config.leg_target_pct,
            "entry_diff_pct": self.config.entry_diff_pct,
            "adjustment_count": self.position.adjustment_count,
            "max_adjustments": self.config.max_adjustments,
            "realized_pnl": self.position.realized_pnl,
            "total_pnl": total_pnl,
            "trail_active": self.trail_active,
            "best_pnl": self.best_pnl,
            "legs": legs_dict,
        }
        save_strategy_state(self.state_key, state)

    def fetch_live_ltps(self, spot: float) -> Tuple[float, float, float]:
        ce_id = self.position.ce_leg.id if self.position.ce_leg else None
        pe_id = self.position.pe_leg.id if self.position.pe_leg else None
        ce_ltp = float(self.helper.get_ltp(str(ce_id), exchange="NSE_FNO", instrument="OPTIDX")) if ce_id else 0.0
        pe_ltp = float(self.helper.get_ltp(str(pe_id), exchange="NSE_FNO", instrument="OPTIDX")) if pe_id else 0.0
        curr_spot = self.helper.get_ltp(UNDERLYING, exchange="IDX_I", instrument="INDEX")
        if curr_spot <= 0:
            curr_spot = spot
        return ce_ltp, pe_ltp, curr_spot

    def exit_all(self, reason: str = "Exit"):
        """Square off all legs and update state."""
        if self.position.is_open:
            self.executor.square_off_straddle(
                self.position, self.expiry, self.lot_size, dry_run=self.dry_run, reason=reason
            )
            self.status = "STOPPED"
            self.save_position()
            msg = f"[{self.state_key}] Straddle squared off: {reason} | Final P&L: ₹{self.position.realized_pnl:+.2f}"
            logger.info(msg)
            notify(msg)

    def run(self):
        """Main strategy loop."""
        exit_if_market_closed(self.helper, self.dry_run)
        logger.info(
            f"Starting {self.state_key} (Mode: {'LIVE' if not self.dry_run else 'DRY'} | "
            f"Start: {self.start_time} | EOD: {self.eod_time} | Broker: {self.broker_name})"
        )

        last_phantom_check = time.time()
        last_log_ts = 0.0

        while True:
            # 1. Shutdown Trigger Check
            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request detected.")
                self.exit_all("UI Shutdown Request")
                self.save_state(0, 0, 0, self.position.realized_pnl, status="STOPPED")
                sys.exit(0)

            # 2. Market Open & New Day Reset
            self.helper.wait_for_market_open(
                self.dry_run,
                start_time=self.start_time,
                eod_time=self.eod_time,
                shutdown_check=lambda: check_shutdown_trigger(self.state_key),
            )
            reset_pnl_on_new_day(self, logger)

            if not self.expiry:
                self.expiry = self.helper.get_nearest_expiry(UNDERLYING)
                if not self.expiry:
                    logger.error("Could not resolve nearest expiry. Retrying...")
                    time.sleep(10)
                    continue

            # 3. EOD Cutoff (15:15 IST)
            now_str = datetime.now().strftime("%H:%M")
            if now_str >= self.eod_time:
                if self.position.is_open:
                    self.exit_all(f"Mandatory EOD Cutoff reached at {now_str}")
                self.save_state(0, 0, 0, self.position.realized_pnl, status="STOPPED")
                time.sleep(30)
                continue

            spot = self.helper.get_ltp(UNDERLYING, exchange="IDX_I", instrument="INDEX")
            if spot <= 0 and self.prev_day_close:
                spot = self.prev_day_close

            # ── FLAT: Wait for 09:20 and 10% balanced ATM premiums ──────────────
            if not self.position.is_open:
                if now_str < self.start_time:
                    self.save_state(spot, 0, 0, self.position.realized_pnl, status="WAITING")
                    interruptible_sleep(2, lambda: check_shutdown_trigger(self.state_key))
                    continue

                atm = atm_strike(spot, STRIKE_STEP)
                qty = self.lots * self.lot_size
                new_pos, err = self.executor.enter_straddle(
                    atm, self.expiry, qty, self.lot_size, self.config, dry_run=self.dry_run
                )
                if new_pos:
                    self.position = new_pos
                    self.status = "RUNNING"
                    self.save_position()
                    msg = (
                        f"[{self.state_key}] Straddle Entered at ATM {atm}!\n"
                        f"CE: {new_pos.ce_leg.entry_price:.2f} (SL: {new_pos.ce_leg.sl:.2f}, Tgt: {new_pos.ce_leg.target:.2f})\n"
                        f"PE: {new_pos.pe_leg.entry_price:.2f} (SL: {new_pos.pe_leg.sl:.2f}, Tgt: {new_pos.pe_leg.target:.2f})\n"
                        f"Combined P0: {new_pos.combined_p0:.2f} | 20% Combined SL: {new_pos.combined_p0 * (1 + self.config.combined_sl_pct/100):.2f}"
                    )
                    logger.info(msg)
                    notify(msg)
                else:
                    self.save_state(spot, 0, 0, self.position.realized_pnl, status="WAITING")
                    interruptible_sleep(10, lambda: check_shutdown_trigger(self.state_key))
                    continue

            # ── IN POSITION: Real-time monitoring & adjustments ─────────────────
            ce_ltp, pe_ltp, spot = self.fetch_live_ltps(spot)
            if ce_ltp <= 0 or pe_ltp <= 0:
                interruptible_sleep(1, lambda: check_shutdown_trigger(self.state_key))
                continue

            total_pnl = self.position.total_pnl(ce_ltp, pe_ltp)
            combined_ltp = ce_ltp + pe_ltp

            # Periodic log every 5 seconds
            if (time.time() - last_log_ts) >= 5:
                last_log_ts = time.time()
                logger.info(
                    f"[{self.state_key}] Spot: {spot:.1f} | CE {self.position.ce_leg.strike}: {ce_ltp:.2f} "
                    f"(SL: {self.position.ce_leg.sl:.1f}, Tgt: {self.position.ce_leg.target:.1f}) | "
                    f"PE {self.position.pe_leg.strike}: {pe_ltp:.2f} "
                    f"(SL: {self.position.pe_leg.sl:.1f}, Tgt: {self.position.pe_leg.target:.1f}) | "
                    f"Combined: {combined_ltp:.1f} / P0 {self.position.combined_p0:.1f} | "
                    f"P&L: ₹{total_pnl:+.2f} (Realized: ₹{self.position.realized_pnl:+.2f})"
                )

            # Phantom leg detection
            if (time.time() - last_phantom_check) >= PHANTOM_CHECK_INTERVAL_SEC:
                last_phantom_check = time.time()
                phantom_err = self.executor.check_phantoms(self.position, self.expiry, dry_run=self.dry_run)
                if phantom_err:
                    logger.warning(phantom_err)
                    self.exit_all(phantom_err)
                    continue

            self.save_state(spot, ce_ltp, pe_ltp, total_pnl, status="RUNNING")

            # Evaluate modular straddle risk signals
            signal = self.position.evaluate_risk(ce_ltp, pe_ltp, self.config)

            # 1. Combined SL Hit (20% default)
            if signal == StraddleSignal.COMBINED_SL_HIT:
                logger.warning(
                    f"Combined SL Hit! Combined premium {combined_ltp:.2f} >= "
                    f"{self.position.combined_p0 * (1 + self.config.combined_sl_pct/100):.2f}"
                )
                self.exit_all(f"Combined SL Hit (+{self.config.combined_sl_pct}%)")
                continue

            # 2. Rupee Trailing Stop
            if not self.trail_active and total_pnl >= self.trail_start_rs:
                self.trail_active = True
                self.best_pnl = total_pnl
                logger.info(f"Trailing SL armed at ₹{total_pnl:+.2f}")

            if self.trail_active:
                if total_pnl > self.best_pnl:
                    self.best_pnl = total_pnl
                if total_pnl <= (self.best_pnl - self.trail_gap_rs):
                    logger.warning(f"Trailing SL Hit! P&L ₹{total_pnl:+.2f} <= ₹{self.best_pnl - self.trail_gap_rs:+.2f}")
                    self.exit_all("Trailing SL Hit")
                    continue

            # 3. Global MTM Targets / Stops
            if self.profit_target is not None and total_pnl >= self.profit_target:
                self.exit_all(f"MTM Profit Target Reached: ₹{total_pnl:+.2f}")
                continue
            if self.stop_loss is not None and total_pnl <= self.stop_loss:
                self.exit_all(f"MTM Stop Loss Hit: ₹{total_pnl:+.2f}")
                continue

            # 4. Leg-level SL Hit (+20% rise) -> Close leg & match opposite leg's LTP
            if signal == StraddleSignal.CE_SL_HIT:
                logger.info(f"CE Leg SL Hit (+{self.config.leg_sl_pct}%)! Matching PE LTP {pe_ltp:.2f}...")
                chain_df = self.helper.get_option_chain_df(UNDERLYING, self.expiry)
                ok, note = self.executor.roll_leg(
                    self.position, "CE", "SL Hit (+20%)", pe_ltp, chain_df, self.expiry, self.lot_size, self.config, dry_run=self.dry_run
                )
                if ok:
                    self.save_position()
                    notify(f"[{self.state_key}] {note}")
                continue

            if signal == StraddleSignal.PE_SL_HIT:
                logger.info(f"PE Leg SL Hit (+{self.config.leg_sl_pct}%)! Matching CE LTP {ce_ltp:.2f}...")
                chain_df = self.helper.get_option_chain_df(UNDERLYING, self.expiry)
                ok, note = self.executor.roll_leg(
                    self.position, "PE", "SL Hit (+20%)", ce_ltp, chain_df, self.expiry, self.lot_size, self.config, dry_run=self.dry_run
                )
                if ok:
                    self.save_position()
                    notify(f"[{self.state_key}] {note}")
                continue

            # 5. Leg-level Target Hit (-30% decay) -> Close leg & match opposite leg's LTP
            if signal == StraddleSignal.CE_TARGET_HIT:
                logger.info(f"CE Leg Target Hit (-{self.config.leg_target_pct}%)! Matching PE LTP {pe_ltp:.2f}...")
                chain_df = self.helper.get_option_chain_df(UNDERLYING, self.expiry)
                ok, note = self.executor.roll_leg(
                    self.position, "CE", "Target Hit (-30%)", pe_ltp, chain_df, self.expiry, self.lot_size, self.config, dry_run=self.dry_run
                )
                if ok:
                    self.save_position()
                    notify(f"[{self.state_key}] {note}")
                continue

            if signal == StraddleSignal.PE_TARGET_HIT:
                logger.info(f"PE Leg Target Hit (-{self.config.leg_target_pct}%)! Matching CE LTP {ce_ltp:.2f}...")
                chain_df = self.helper.get_option_chain_df(UNDERLYING, self.expiry)
                ok, note = self.executor.roll_leg(
                    self.position, "PE", "Target Hit (-30%)", ce_ltp, chain_df, self.expiry, self.lot_size, self.config, dry_run=self.dry_run
                )
                if ok:
                    self.save_position()
                    notify(f"[{self.state_key}] {note}")
                continue

            # Loop cadence: 1 second
            interruptible_sleep(1, lambda: check_shutdown_trigger(self.state_key))


def main():
    parser = argparse.ArgumentParser(
        description="Nifty Managed Straddle with 20% Combined SL, 20% Leg SL, 30% Target, and Premium-Matching Rolls",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Dry run with default parameters
    venv/bin/python strategies/managed_straddle/nifty_managed_straddle.py

    # Live execution with 2 lots
    venv/bin/python strategies/managed_straddle/nifty_managed_straddle.py --live --lots 2

    # Custom thresholds on Kotak Neo
    venv/bin/python strategies/managed_straddle/nifty_managed_straddle.py --live --broker kotak --combined-sl-pct 25 --leg-sl-pct 25 --leg-target-pct 35
        """,
    )
    parser.add_argument("--live", action="store_true", help="Place real orders at broker (default: False, dry run)")
    parser.add_argument("--lots", type=int, default=1, help="Number of lots to trade (default: 1)")
    parser.add_argument("--combined-sl-pct", type=float, default=20.0, help="Combined premium stop-loss %% (default: 20.0)")
    parser.add_argument("--leg-sl-pct", type=float, default=20.0, help="Individual leg stop-loss %% (default: 20.0)")
    parser.add_argument("--leg-target-pct", type=float, default=30.0, help="Individual leg profit target decay %% (default: 30.0)")
    parser.add_argument("--entry-diff-pct", type=float, default=10.0, help="Max difference %% between ATM CE and PE to enter (default: 10.0)")
    parser.add_argument("--start-time", type=str, default="09:20", help="Entry window start in IST HH:MM (default: 09:20)")
    parser.add_argument("--eod-time", type=str, default="15:15", help="EOD mandatory square-off in IST HH:MM (default: 15:15)")
    parser.add_argument("--max-adjustments", type=int, default=10, help="Max leg adjustments allowed per session (default: 10)")
    parser.add_argument("--adjustment-cooldown", type=int, default=30, help="Cooldown in seconds between adjustments (default: 30)")
    parser.add_argument("--target-profit", type=str, default="4000", help="Global profit target in INR or %% (default: 4000)")
    parser.add_argument("--stop-loss", type=str, default="4000", help="Global stop loss in INR or %% (default: 4000)")
    parser.add_argument("--trail-start-rs", type=float, default=2000.0, help="Rupee MTM profit to arm trail (default: 2000.0)")
    parser.add_argument("--trail-gap-rs", type=float, default=1000.0, help="Rupee MTM trailing giveback gap (default: 1000.0)")
    parser.add_argument("--broker", type=str, choices=["dhan", "zerodha", "kotak"], default="dhan", help="Execution broker (default: dhan)")
    parser.add_argument("--instance-id", type=str, default="", help="Unique instance ID for multi-process isolation")

    args = parser.parse_args()

    state_key = f"{STRATEGY_KEY_DEFAULT}_{args.instance_id}" if args.instance_id else STRATEGY_KEY_DEFAULT
    target_val, target_is_pct = parse_target_spec(args.target_profit)
    stop_val, stop_is_pct = parse_target_spec(args.stop_loss)

    risk_cfg = StraddleRiskConfig(
        combined_sl_pct=args.combined_sl_pct,
        leg_sl_pct=args.leg_sl_pct,
        leg_target_pct=args.leg_target_pct,
        entry_diff_pct=args.entry_diff_pct,
        max_adjustments=args.max_adjustments,
        adjustment_cooldown=args.adjustment_cooldown,
    )

    strat = ManagedStraddleStrategy(
        dry_run=not args.live,
        lots=args.lots,
        risk_config=risk_cfg,
        start_time=args.start_time,
        eod_time=args.eod_time,
        profit_target=target_val,
        profit_target_is_pct=target_is_pct,
        stop_loss=stop_val,
        stop_loss_is_pct=stop_is_pct,
        trail_start_rs=args.trail_start_rs,
        trail_gap_rs=args.trail_gap_rs,
        state_key=state_key,
        broker=args.broker,
    )

    try:
        strat.run()
    except KeyboardInterrupt:
        logger.info("KeyboardInterrupt received. Exiting positions cleanly...")
        strat.exit_all("KeyboardInterrupt")
        strat.save_state(0, 0, 0, strat.position.realized_pnl, status="STOPPED")
        sys.exit(0)


if __name__ == "__main__":
    main()
