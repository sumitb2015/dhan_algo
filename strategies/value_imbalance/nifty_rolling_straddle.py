import time
import sys
import argparse
import os
import logging
import pandas as pd
from datetime import datetime

# Add parent directory to path to import login and lib
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib.execution_broker import ExecutionBroker, ExecutionBrokerError
from lib.strategy_state_helper import save_strategy_state, check_shutdown_trigger, exit_if_market_closed, parse_target_spec, instance_log_suffix
from lib.rolling_straddle_rules import trail_lock_pct, is_balanced, straddle_sl_hit, leg_sl_hit, roll_reason
from lib.strategy_risk import resolve_exit_qty_broker, detect_phantom_leg_broker, PHANTOM_CHECK_INTERVAL_SEC

# Setup Logging
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
debug_dir = os.path.join(project_root, "debug")
log_dir = os.path.join(debug_dir, "logs", "rolling_straddle")
os.makedirs(log_dir, exist_ok=True)

class FlushingFileHandler(logging.FileHandler):
    def emit(self, record):
        super().emit(record)
        self.flush()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        # encoding: FileHandler otherwise opens with the system ANSI codepage
        # (cp1252 on Windows) and silently DROPS any log line containing a
        # non-ANSI glyph (INR sign, arrows, dashes) while still writing the
        # ASCII lines around it -- the log looks intact but loses those lines.
        FlushingFileHandler(
            os.path.join(log_dir, f"{datetime.now().strftime('%Y%m%d')}{instance_log_suffix()}.log"),
            encoding="utf-8",
        )
    ],
    force=True
)
logger = logging.getLogger(__name__)

class RollingStraddleStrategy:
    def __init__(self, dry_run=True, initial_lots=1, roll_buffer=35.0, max_rolls=5,
                 roll_cooldown=60, profit_target=4000.0, profit_target_is_pct=False,
                 stop_loss=4000.0, stop_loss_is_pct=False, start_time="09:20", eod_time="15:17",
                 trail_start_rs=500.0, trail_gap_rs=300.0, roll_type="points",
                 roll_trigger_pct=0.4, entry_balance_threshold=15.0,
                 entry_balance_timeout=30, exit_on_max_rolls=True,
                 atm_hysteresis=5.0, expiry_day_only=False, state_key="nifty_rolling_straddle", broker="dhan",
                 roll_trigger="spot_pct", roll_delta=0.60, roll_imbalance_ratio=2.0,
                 straddle_sl_mult=1.25, no_roll_after="14:30", expiry_start_time="09:30",
                 capital=0.0, day_stop_pct_capital=1.5, vix_max=0.0, gap_skip_pct=0.0,
                 trail_start=0.20, trail_step=0.10, trail_lock_step=0.08, leg_sl_mult=1.5):
        self.state_key = state_key
        # --- "rules" mode: spot%/delta/imbalance roll, per-straddle SL, capital day stop,
        # %-of-first-premium profit-lock trail. See readmes/nifty_rolling_straddle.md.
        self.rules_mode = isinstance(roll_type, str) and roll_type.lower() == "rules"
        self.roll_trigger = roll_trigger
        self.roll_delta = float(roll_delta)
        self.roll_imbalance_ratio = float(roll_imbalance_ratio)
        self.straddle_sl_mult = float(straddle_sl_mult)
        self.no_roll_after = no_roll_after
        self.expiry_start_time = expiry_start_time
        self.capital = float(capital or 0.0)
        self.day_stop_pct_capital = float(day_stop_pct_capital)
        self.day_stop_inr = self.capital * self.day_stop_pct_capital / 100.0
        self.vix_max = float(vix_max)
        self.gap_skip_pct = float(gap_skip_pct)
        self.trail_start = float(trail_start)
        self.leg_sl_mult = float(leg_sl_mult)
        self.trail_step = float(trail_step)
        self.trail_lock_step = float(trail_lock_step)
        self.p0_first_inr = None      # first straddle premium in INR, set once per day
        self.straddle_p0 = 0.0        # current straddle's combined premium (points)
        self.trail_lock_inr = None
        self._last_delta_poll = 0.0
        self._last_max_delta = None
        self._last_max_delta_ts = 0.0
        self.imbalance_armed = False
        if self.rules_mode and self.capital <= 0:
            raise ValueError("--roll-type rules requires --capital > 0 (the daily stop is a % of capital)")
        self.dry_run = dry_run
        self.initial_lots = initial_lots
        self.roll_buffer = float(roll_buffer)
        self.roll_type = roll_type.lower() if isinstance(roll_type, str) else "points"
        self.roll_trigger_pct = float(roll_trigger_pct)
        # "atm" mode: roll as soon as the true ATM changes. The ATM flips at +/-25 pts
        # (half the 50pt strike step); hysteresis pushes the trigger that far beyond the
        # midpoint so spot dithering around it doesn't churn the straddle back and forth.
        self.atm_hysteresis = max(0.0, float(atm_hysteresis))
        # Only trade on the NIFTY weekly expiry day (0 DTE). Backtest: the straddle's edge
        # sits on expiry day; on 1+ DTE days rolling costs more than theta earns.
        self.expiry_day_only = bool(expiry_day_only)
        self.max_rolls = int(max_rolls)
        self.roll_cooldown = int(roll_cooldown)

        # Risk Management
        self.target_is_pct = profit_target_is_pct
        self.stop_is_pct = stop_loss_is_pct
        self.target_pct = profit_target if profit_target_is_pct else None
        self.stop_pct = stop_loss if stop_loss_is_pct else None
        self.profit_target = None if profit_target_is_pct else profit_target
        self.stop_loss = None if stop_loss_is_pct else -abs(stop_loss)  # Ensure it's negative
        self.start_time = start_time
        self.eod_time = eod_time
        self.trail_start_rs = float(trail_start_rs)
        self.trail_gap_rs = float(trail_gap_rs)
        self.entry_balance_threshold = float(entry_balance_threshold)
        self.entry_balance_timeout = float(entry_balance_timeout)
        self.exit_on_max_rolls = bool(exit_on_max_rolls)

        self.dhan = get_dhan_client()
        if not self.dhan:
            raise Exception("Failed to connect to Dhan API.")
        self.helper = DhanHelper(self.dhan)

        self.broker_name = broker
        try:
            self.broker = ExecutionBroker.create(broker, self.helper, underlying="NIFTY", log=logger.info)
        except ExecutionBrokerError as e:
            raise RuntimeError(f"Could not start {broker} execution: {e}") from e

        # Start WebSocket for NIFTY Index (SID 13, IDX_I)
        logger.info("Starting WebSocket for NIFTY Index spot...")
        self.helper.start_websocket([("IDX_I", "13", 15)])
        time.sleep(2)  # Wait for initial tick

        # Fetch prev day levels
        _levels = self.helper.get_prev_day_levels("NIFTY")
        self.prev_day_high = _levels["high"] if _levels else None
        self.prev_day_low = _levels["low"] if _levels else None
        self.prev_day_close = _levels["close"] if _levels else None

        self.nifty_lot_size = self.helper.get_lot_size("NIFTY")

        # Rolling Straddle State (roll_type / roll_trigger_pct already set above)
        self.ref_spot = 0.0
        self.current_atm_strike = None
        self.upper_bound = None
        self.lower_bound = None
        self.ce_strike = None
        self.pe_strike = None
        self.ce_id = None
        self.pe_id = None
        self.ce_symbol_name = None
        self.pe_symbol_name = None
        self.ce_lots = initial_lots
        self.pe_lots = initial_lots
        self.ce_avg_price = 0.0
        self.pe_avg_price = 0.0
        self.realized_pnl = 0.0
        self.roll_count = 0
        self.last_roll_time = 0.0
        self.expiry = None

        # Trailing SL State
        self.trail_active = False
        self.best_pnl = 0.0

        self.NIFTY_SPOT_SID = 13

    def sleep_cooldown(self, seconds):
        """Shutdown-aware sleep for cooldowns and delays."""
        for _ in range(seconds):
            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request during cooldown sleep. Exiting.")
                self.save_state(0, 0, 0, 0, status="STOPPED")
                sys.exit(0)
            time.sleep(1)

    def _fetch_ltps_for(self, ce_id, pe_id):
        """Batched CE/PE/spot LTP fetch for an explicit pair of contracts.

        Takes the ids as arguments so `enter_straddle()` can poll candidate legs
        before they are committed to `self`.
        """
        if not ce_id or not pe_id:
            spot = self.helper.get_ltp(str(self.NIFTY_SPOT_SID), exchange="IDX_I", instrument="INDEX")
            return 0.0, 0.0, spot

        ltps = self.helper.get_ltps([
            ("NSE_FNO", ce_id),
            ("NSE_FNO", pe_id),
            ("IDX_I", self.NIFTY_SPOT_SID),
        ])
        return (
            ltps.get(str(ce_id), 0.0),
            ltps.get(str(pe_id), 0.0),
            ltps.get(str(self.NIFTY_SPOT_SID), 0.0),
        )

    def fetch_ltps(self):
        """Batched CE/PE/spot LTP fetch for the currently held legs."""
        return self._fetch_ltps_for(self.ce_id, self.pe_id)

    def is_flat(self):
        return not self.ce_id or not self.pe_id

    def go_flat(self):
        """Drop all per-position state. Realized PnL and roll counters survive."""
        self.ce_id = None
        self.pe_id = None
        self.ce_strike = None
        self.pe_strike = None
        self.ce_symbol_name = None
        self.pe_symbol_name = None
        self.ce_avg_price = 0.0
        self.pe_avg_price = 0.0
        self.current_atm_strike = None
        self.upper_bound = None
        self.lower_bound = None

    def unsubscribe_legs(self, ce_id, pe_id):
        for sec_id in (ce_id, pe_id):
            if not sec_id:
                continue
            try:
                self.helper.unsubscribe_instruments([("NSE_FNO", str(sec_id), 15)])
            except Exception:
                pass

    def save_state(self, nifty_spot, ce_ltp, pe_ltp, total_pnl, status="RUNNING"):
        state_dict = {
            "strategy": "nifty_rolling_straddle",
            "status": status,
            "dry_run": self.dry_run,
            "lots": self.initial_lots,
            "roll_type": self.roll_type,
            "roll_buffer": self.roll_buffer,
            "roll_trigger_pct": self.roll_trigger_pct,
            "atm_hysteresis": self.atm_hysteresis,
            "entry_balance_threshold": self.entry_balance_threshold,
            "entry_balance_timeout": self.entry_balance_timeout,
            "exit_on_max_rolls": self.exit_on_max_rolls,
            "ref_spot": self.ref_spot,
            "max_rolls": self.max_rolls,
            "roll_count": self.roll_count,
            "current_atm": self.current_atm_strike,
            "upper_bound": self.upper_bound,
            "lower_bound": self.lower_bound,
            "ce_strike": self.ce_strike,
            "pe_strike": self.pe_strike,
            "ce_lots": self.ce_lots,
            "pe_lots": self.pe_lots,
            "ce_ltp": ce_ltp,
            "pe_ltp": pe_ltp,
            "ce_avg_price": self.ce_avg_price,
            "pe_avg_price": self.pe_avg_price,
            "realized_pnl": self.realized_pnl,
            "total_pnl": total_pnl,
            "spot": nifty_spot,
            "adjustments": self.roll_count,
            "trail_active": self.trail_active,
            "best_pnl": round(self.best_pnl, 2),
            "broker": self.broker_name,
        }
        if not self.rules_mode:
            state_dict.update({
                "profit_target": self.profit_target,
                "stop_loss": self.stop_loss,
                "trail_start_rs": self.trail_start_rs,
                "trail_gap_rs": self.trail_gap_rs,
                "trail_exit_pnl": round(self.best_pnl - self.trail_gap_rs, 2) if self.trail_active else None,
            })
        else:
            state_dict.update({
                "roll_trigger": self.roll_trigger,
                "straddle_p0": round(self.straddle_p0, 2),
                "p0_first_inr": round(self.p0_first_inr, 2) if self.p0_first_inr else None,
                "straddle_sl_mult": self.straddle_sl_mult,
                "day_stop_inr": round(self.day_stop_inr, 2),
                "trail_lock_inr": round(self.trail_lock_inr, 2) if self.trail_lock_inr is not None else None,
                "no_roll_after": self.no_roll_after,
                "leg_sl_mult": self.leg_sl_mult,
            })
        save_strategy_state(self.state_key, state_dict)

    def _calculate_pnl(self, ce_ltp, pe_ltp):
        ce_unrealized = (self.ce_avg_price - ce_ltp) * (self.ce_lots * self.nifty_lot_size)
        pe_unrealized = (self.pe_avg_price - pe_ltp) * (self.pe_lots * self.nifty_lot_size)
        return self.realized_pnl + ce_unrealized + pe_unrealized

    def get_execution_price(self, order_id: str, fallback_price: float) -> float:
        """Wait for fill and return the average execution price, or the fallback.

        NOTE: helper.wait_for_fill() returns a BOOL, not a price — it must never be
        used as the fill price directly.
        """
        if not order_id:
            return fallback_price
        if self.helper.wait_for_fill(order_id, timeout=5):
            order_details = self.helper.get_order_by_id(order_id)
            if order_details:
                fill_price = float(
                    order_details.get('averageTradedPrice', 0.0)
                    or order_details.get('avgFilledPrice', 0.0)
                    or order_details.get('price', 0.0)
                )
                if fill_price > 0:
                    logger.info(f"Order {order_id} execution price confirmed: {fill_price:.2f}")
                    return fill_price
        return fallback_price

    def _extract_quote_fields(self, quote, strike, option_type):
        if not quote:
            return None, None, None, None, None
        if isinstance(quote, dict) and 'CONTRACT_INFO' in quote:
            ci = quote['CONTRACT_INFO']
            return (
                int(ci['SECURITY_ID']),
                float(quote.get('last_price', 0.0) or quote.get('LTP', 0.0)),
                ci.get('SM_EXPIRY_DATE') or self.expiry,
                int(ci.get('LOT_SIZE', self.nifty_lot_size)),
                ci.get('SYMBOL_NAME', f"NIFTY-{self.expiry}-{strike}-{option_type}")
            )
        return None, None, None, None, None

    def exit_all_positions(self, reason):
        """Buys back any live CE/PE legs. Returns True only once every leg that was open
        is CONFIRMED closed (filled, or already flat at the broker) — never on a fired-but-
        unconfirmed order. Callers must not treat the strategy as flat/stopped on a False
        return; see force_exit_all().
        """
        logger.warning(f"!!! EXITING ALL POSITIONS: {reason} !!!")
        closed_ok = True
        if not self.dry_run:
            for label, leg_id, strike, lots in (
                ("CE", self.ce_id, self.ce_strike, self.ce_lots),
                ("PE", self.pe_id, self.pe_strike, self.pe_lots),
            ):
                if not leg_id or not strike or lots <= 0:
                    continue  # no leg, or already closed by its own SL
                try:
                    own_qty = lots * self.nifty_lot_size
                    qty_to_buy, _ = resolve_exit_qty_broker(self.broker, strike, self.expiry, label, own_qty, "BUY", logger)
                    if qty_to_buy <= 0:
                        continue  # broker already flat on this leg
                    order_id = self.broker.buy(strike, self.expiry, label, qty_to_buy)
                    if not order_id or not self.helper.wait_for_fill(order_id, timeout=10):
                        closed_ok = False
                        logger.critical(
                            f"Exit ({reason}): buy-to-close for {label} leg (ID: {leg_id}) "
                            f"did not confirm (order_id={order_id}). Leg may still be OPEN."
                        )
                    else:
                        logger.info(f"{label} Exit Order confirmed ({qty_to_buy} qty): {order_id}")
                except Exception as e:
                    closed_ok = False
                    logger.critical(f"Exit ({reason}): error closing {label} leg {leg_id}: {e}")

        # Update realized PnL from latest market price before exiting
        ce_ltp, pe_ltp, _ = self.fetch_ltps()
        if ce_ltp > 0 and pe_ltp > 0:
            final_pnl = self._calculate_pnl(ce_ltp, pe_ltp)
            self.realized_pnl = final_pnl

        if not closed_ok:
            logger.critical(
                f"Exit ({reason}) did NOT confirm all legs closed — position tracked as still "
                "OPEN (not going flat) so the caller retries rather than terminating the process "
                "with a live position unmonitored."
            )
            return False

        self.go_flat()
        return True

    def force_exit_all(self, reason, retry_interval=5):
        """Retries exit_all_positions until every leg is confirmed closed.

        Must never return while a leg might still be open: the caller terminates the
        process right after this, and a dead process watching a live naked short is
        the exact failure mode exit_all_positions() is built to avoid.
        """
        attempt = 1
        while not self.exit_all_positions(reason):
            logger.critical(f"Exit retry #{attempt} for '{reason}' unconfirmed — retrying in {retry_interval}s.")
            self.save_state(0, 0, 0, self.realized_pnl, status="EXIT_RETRY")
            time.sleep(retry_interval)
            attempt += 1

    def enter_straddle(self, atm_strike, spot=0.0):
        """Finds and sells ATM CE and PE options at the specified strike.

        Nothing on `self` is mutated until the legs are actually short: every
        early return leaves the caller's position state exactly as it was. A
        failed entry therefore always leaves the strategy either flat (if the
        caller went flat first) or holding its previous, still-valid legs —
        never tracking a phantom position at another strike's prices.
        """
        logger.info(f"--- ENTERING SHORT STRADDLE AT ATM STRIKE {atm_strike} ---")

        # Resolve CE contract
        ce_quote = self.helper.option("NIFTY", atm_strike, "CE")
        ce_id, ce_price, expiry, lot_size, ce_symbol = self._extract_quote_fields(ce_quote, atm_strike, "CE")

        # Resolve PE contract
        pe_quote = self.helper.option("NIFTY", atm_strike, "PE")
        pe_id, pe_price, _, _, pe_symbol = self._extract_quote_fields(pe_quote, atm_strike, "PE")

        if not ce_id or not pe_id or not ce_price or not pe_price or ce_price <= 0 or pe_price <= 0:
            logger.error(f"Failed to fetch quotes for ATM {atm_strike}. CE: {ce_price}, PE: {pe_price}")
            return False

        lot_size = int(lot_size or self.nifty_lot_size)
        qty = self.initial_lots * lot_size

        # Subscribe to WebSocket before balance wait so live ticks arrive
        self.helper.start_websocket([
            ("NSE_FNO", str(ce_id), 15),
            ("NSE_FNO", str(pe_id), 15)
        ])

        # --- rules mode: don't sell a skewed straddle ---
        # Wait until the higher leg is below ratio x the lower leg (no timeout other than the
        # no-roll cutoff); at/after --no-roll-after give up so no new position opens late.
        if self.rules_mode:
            logger.info(f"rules: waiting for CE/PE ratio < {self.roll_imbalance_ratio}x before selling (cutoff {self.no_roll_after})...")
            while True:
                ce_ltp_w, pe_ltp_w, spot_w = self._fetch_ltps_for(ce_id, pe_id)

                if check_shutdown_trigger(self.state_key):
                    logger.info("UI Shutdown Request during balance wait. Aborting entry.")
                    self.unsubscribe_legs(ce_id, pe_id)
                    return False

                now_w = datetime.now().strftime("%H:%M")
                if now_w >= self.eod_time or now_w >= self.no_roll_after:
                    logger.warning(f"rules: legs never balanced before {self.no_roll_after} — skipping entry.")
                    self.unsubscribe_legs(ce_id, pe_id)
                    return False

                if spot_w > 0 and round(spot_w / 50.0) * 50 != atm_strike:
                    logger.info(f"ATM drifted from {atm_strike} during balance wait. Aborting entry to re-pick.")
                    self.unsubscribe_legs(ce_id, pe_id)
                    return False

                self.save_state(spot_w or spot, ce_ltp_w, pe_ltp_w, self.realized_pnl, status="BALANCING")

                if ce_ltp_w > 0 and pe_ltp_w > 0:
                    lo_w, hi_w = sorted((ce_ltp_w, pe_ltp_w))
                    if is_balanced(ce_ltp_w, pe_ltp_w, self.roll_imbalance_ratio):
                        logger.info(f"Balanced: CE {ce_ltp_w:.2f} / PE {pe_ltp_w:.2f} ({hi_w / lo_w:.2f}x < {self.roll_imbalance_ratio}x). Selling.")
                        ce_price, pe_price = ce_ltp_w, pe_ltp_w
                        break
                    logger.info(f"Imbalance wait | CE {ce_ltp_w:.2f} PE {pe_ltp_w:.2f} ({hi_w / lo_w:.2f}x >= {self.roll_imbalance_ratio}x)")
                time.sleep(2)

        # --- Entry Balance Wait ---
        if self.entry_balance_threshold > 0:
            logger.info(f"Waiting for CE/PE premium to balance (diff < {self.entry_balance_threshold:.1f}%)...")
            wait_start = time.time()
            while True:
                ce_ltp_w, pe_ltp_w, spot_w = self._fetch_ltps_for(ce_id, pe_id)

                if check_shutdown_trigger(self.state_key):
                    logger.info("UI Shutdown Request during balance wait. Aborting entry.")
                    self.unsubscribe_legs(ce_id, pe_id)
                    return False

                if datetime.now().strftime("%H:%M") >= self.eod_time:
                    logger.info(f"EOD time reached during balance wait. Skipping entry.")
                    self.unsubscribe_legs(ce_id, pe_id)
                    return False

                # ATM drift: if spot has moved to a different 50-pt ATM, abort and let caller re-trigger
                if spot_w > 0:
                    new_atm = round(spot_w / 50.0) * 50
                    if new_atm != atm_strike:
                        logger.info(f"ATM drifted from {atm_strike} to {new_atm} during balance wait. Aborting entry.")
                        self.unsubscribe_legs(ce_id, pe_id)
                        return False

                # Keep publishing while we wait — this loop can run for minutes, and
                # without a heartbeat the dashboard reads a frozen state file and
                # cannot tell a balancing strategy from a hung one.
                self.save_state(spot_w or spot, ce_ltp_w, pe_ltp_w, self.realized_pnl, status="BALANCING")

                diff_pct = None
                if ce_ltp_w > 0 and pe_ltp_w > 0:
                    max_prem = max(ce_ltp_w, pe_ltp_w)
                    diff_pct = abs(ce_ltp_w - pe_ltp_w) / max_prem * 100.0
                    logger.info(f"Balance Wait | CE: {ce_ltp_w:.2f} | PE: {pe_ltp_w:.2f} | Diff: {diff_pct:.1f}% (Target: <{self.entry_balance_threshold:.1f}%)")
                    if diff_pct < self.entry_balance_threshold:
                        logger.info(f"Balanced! Diff {diff_pct:.1f}% < {self.entry_balance_threshold:.1f}%. Proceeding with entry.")
                        # Use live balanced prices as the anchor
                        ce_price = ce_ltp_w
                        pe_price = pe_ltp_w
                        break

                # Timeout: rolls fire on trending moves, exactly when the new ATM's
                # CE/PE premiums are least likely to balance — an unbounded wait here
                # would leave the strategy flat (no position, no risk control active)
                # for an extended stretch right when spot keeps moving away. Enter at
                # the best prices we have rather than staying flat indefinitely.
                if self.entry_balance_timeout > 0 and (time.time() - wait_start) >= self.entry_balance_timeout:
                    diff_desc = f"{diff_pct:.1f}%" if diff_pct is not None else "n/a"
                    logger.warning(
                        f"Balance wait timed out after {self.entry_balance_timeout:.0f}s "
                        f"(diff {diff_desc} >= threshold {self.entry_balance_threshold:.1f}%) — "
                        "entering at current premiums to avoid staying flat mid-move."
                    )
                    if ce_ltp_w > 0 and pe_ltp_w > 0:
                        ce_price = ce_ltp_w
                        pe_price = pe_ltp_w
                    break
                time.sleep(2)

        if self.dry_run:
            ce_avg_price = ce_price
            pe_avg_price = pe_price
            logger.info(f"[DRY-RUN] Shorted {self.initial_lots} lot {ce_symbol} @ {ce_price:.2f}")
            logger.info(f"[DRY-RUN] Shorted {self.initial_lots} lot {pe_symbol} @ {pe_price:.2f}")
        else:
            logger.info(f"Placing live SELL order for {self.initial_lots} lot {ce_symbol}...")
            ce_order_id = self.broker.sell(atm_strike, expiry, "CE", qty)
            if not ce_order_id:
                logger.error("CE sell order failed; aborting entry.")
                self.unsubscribe_legs(ce_id, pe_id)
                return False
            ce_avg_price = self.get_execution_price(ce_order_id, ce_price)

            logger.info(f"Placing live SELL order for {self.initial_lots} lot {pe_symbol}...")
            pe_order_id = self.broker.sell(atm_strike, expiry, "PE", qty)
            if not pe_order_id:
                logger.error("PE sell order failed; rolling back CE leg to avoid a naked short.")
                try:
                    self.broker.buy(atm_strike, expiry, "CE", qty)
                except Exception as rb:
                    logger.critical(f"CE rollback failed — CE leg may remain OPEN: {rb}")
                self.unsubscribe_legs(ce_id, pe_id)
                return False
            pe_avg_price = self.get_execution_price(pe_order_id, pe_price)

        # --- Commit: from here the position is live and `self` is authoritative ---
        self.current_atm_strike = atm_strike
        self.ref_spot = float(spot) if spot > 0 else float(atm_strike)
        if self.roll_type in ("percentage", "rules"):
            self.upper_bound = round(self.ref_spot * (1.0 + self.roll_trigger_pct / 100.0), 2)
            self.lower_bound = round(self.ref_spot * (1.0 - self.roll_trigger_pct / 100.0), 2)
        elif self.roll_type == "atm":
            half_step = 25.0 + self.atm_hysteresis
            self.upper_bound = atm_strike + half_step
            self.lower_bound = atm_strike - half_step
        else:
            self.upper_bound = atm_strike + self.roll_buffer
            self.lower_bound = atm_strike - self.roll_buffer

        self.ce_strike = atm_strike
        self.pe_strike = atm_strike
        self.ce_id = ce_id
        self.pe_id = pe_id
        self.ce_symbol_name = ce_symbol
        self.pe_symbol_name = pe_symbol
        self.expiry = expiry
        self.nifty_lot_size = lot_size
        self.ce_lots = self.initial_lots
        self.pe_lots = self.initial_lots
        self.ce_avg_price = ce_avg_price
        self.pe_avg_price = pe_avg_price
        # New strikes: any delta read from the previous straddle is meaningless.
        self._last_max_delta = None
        self._last_delta_poll = 0.0
        self.imbalance_armed = False
        if self.rules_mode and ce_avg_price > 0 and pe_avg_price > 0:
            _lo, _hi = sorted((ce_avg_price, pe_avg_price))
            if _hi >= self.roll_imbalance_ratio * _lo:
                logger.warning(f"Entered already imbalanced ({_hi / _lo:.2f}x >= {self.roll_imbalance_ratio}x): "
                               "imbalance roll stays disarmed until the legs balance.")

        combined_premium = self.ce_avg_price + self.pe_avg_price
        # rules mode: per-straddle SL anchors on THIS straddle's premium; the trail anchors on
        # the day's FIRST straddle (set once) so its steps scale with VIX, not with later rolls.
        self.straddle_p0 = combined_premium
        if self.p0_first_inr is None:
            self.p0_first_inr = combined_premium * qty
        if self.roll_type == "percentage":
            logger.info(f"Straddle Entered! ATM: {atm_strike} | Ref Spot: {self.ref_spot:.2f} | Upper Bound: {self.upper_bound:.2f} (+{self.roll_trigger_pct}%) | Lower Bound: {self.lower_bound:.2f} (-{self.roll_trigger_pct}%)")
        else:
            logger.info(f"Straddle Entered! ATM: {atm_strike} | Upper Bound: {self.upper_bound:.1f} | Lower Bound: {self.lower_bound:.1f}")
        logger.info(f"CE Avg: {self.ce_avg_price:.2f} | PE Avg: {self.pe_avg_price:.2f} | Total Premium: {combined_premium:.2f} pts")

        # Resolve percentage targets ONCE, against the premium collected on the day's
        # first entry. Re-resolving on every roll would move the goalposts: total_pnl
        # is cumulative (it carries realized P&L from earlier rolls) while the target
        # would be re-anchored to only the newest straddle's premium, so a % target
        # could become unreachable — or a % stop unreachably deep — after a losing roll.
        if self.target_is_pct and self.target_pct and self.profit_target is None:
            total_premium_inr = combined_premium * qty
            self.profit_target = total_premium_inr * (self.target_pct / 100.0)
            logger.info(f"Resolved % Profit Target ({self.target_pct}% of Rs.{total_premium_inr:.0f}) = +Rs.{self.profit_target:.0f}")

        if self.stop_is_pct and self.stop_pct and self.stop_loss is None:
            total_premium_inr = combined_premium * qty
            self.stop_loss = -abs(total_premium_inr * (self.stop_pct / 100.0))
            logger.info(f"Resolved % Stop Loss ({self.stop_pct}% of Rs.{total_premium_inr:.0f}) = -Rs.{abs(self.stop_loss):.0f}")

        return True

    def roll_straddle(self, nifty_spot, direction, allow_same_strike=False):
        """Rolls the short straddle UP or DOWN to the new ATM strike.

        allow_same_strike: rules mode only — a delta/imbalance/SL roll may legitimately
        re-sell the same strike to reset premiums, so the churn guard is bypassed.
        """
        new_atm = round(nifty_spot / 50.0) * 50

        # NIFTY strikes step by 50pts. If roll_buffer/roll_trigger_pct is small enough
        # that a bound breach can fire before spot has drifted a full strike-width away
        # from the current ATM, `new_atm` can round right back to `current_atm_strike` —
        # closing and reopening the identical straddle and paying the bid/ask spread
        # twice for zero net change in position. Skip rather than churn.
        if new_atm == self.current_atm_strike and not allow_same_strike:
            logger.info(
                f"Roll skipped: bound breached (spot {nifty_spot:.2f}) but new ATM {new_atm} "
                f"== current ATM {self.current_atm_strike} — buffer/trigger is smaller than "
                "the 50pt strike step. Waiting for spot to move further."
            )
            return False

        logger.warning(f">>> ROLLING STRADDLE {direction.upper()} <<<")
        logger.warning(f"Spot: {nifty_spot:.2f} | Prev ATM: {self.current_atm_strike} -> New ATM: {new_atm}")

        ce_ltp, pe_ltp, _ = self.fetch_ltps()
        if ce_ltp <= 0 or pe_ltp <= 0:
            logger.error("Failed to fetch LTPs for current straddle leg close during roll!")
            return False

        old_ce_id, old_pe_id = self.ce_id, self.pe_id
        old_ce_strike, old_pe_strike = self.ce_strike, self.pe_strike
        self.last_roll_time = time.time()

        # Close existing CE & PE legs. The close must be CONFIRMED before we go flat:
        # go_flat() makes is_flat() true, and the main loop enters a fresh straddle on
        # a flat strategy — so going flat on an unconfirmed close would leave the old
        # shorts live in the market, untracked, while a second straddle is opened on
        # top of them.
        closed_ok = True
        if not self.dry_run:
            for label, leg_id, strike, lots in (
                ("CE", old_ce_id, old_ce_strike, self.ce_lots),
                ("PE", old_pe_id, old_pe_strike, self.pe_lots),
            ):
                if not leg_id or not strike:
                    continue
                try:
                    own_qty = lots * self.nifty_lot_size
                    qty_to_buy, _ = resolve_exit_qty_broker(self.broker, strike, self.expiry, label, own_qty, "BUY", logger)
                    if qty_to_buy <= 0:
                        continue  # broker already flat on this leg
                    oid = self.broker.buy(strike, self.expiry, label, qty_to_buy)
                    if not oid or not self.helper.wait_for_fill(oid, timeout=10):
                        closed_ok = False
                        logger.critical(
                            f"Roll attempt #{self.roll_count + 1}: buy-to-close for {label} leg (ID: {leg_id}) "
                            f"did not confirm (order_id={oid}). Leg may still be OPEN."
                        )
                except Exception as e:
                    closed_ok = False
                    logger.critical(f"Roll attempt #{self.roll_count + 1}: error closing {label} leg {leg_id}: {e}")

        if not closed_ok:
            logger.critical(
                f"Roll attempt #{self.roll_count + 1} ABORTED: at least one leg did not close. Keeping the "
                "existing position tracked (NOT going flat) so the next tick retries rather than "
                "opening a second straddle on top of live shorts. Not charged against --max-rolls "
                "since no roll actually happened."
            )
            return False

        # Only now that both legs are CONFIRMED closed is the roll actually committed —
        # count it here, not before the close attempt. A close that never completes (broker
        # rejection, network blip) must not burn --max-rolls budget on a position that never
        # moved; but a close that succeeds counts even if the re-entry below then fails, so a
        # failed entry followed by the main loop's flat re-entry can't dodge the roll cap.
        self.roll_count += 1

        # Book the close exactly once, only now that both legs are confirmed closed.
        close_ce_pnl = (self.ce_avg_price - ce_ltp) * (self.ce_lots * self.nifty_lot_size)
        close_pe_pnl = (self.pe_avg_price - pe_ltp) * (self.pe_lots * self.nifty_lot_size)
        self.realized_pnl += (close_ce_pnl + close_pe_pnl)

        logger.info(f"Closed prev legs @ CE: {ce_ltp:.2f}, PE: {pe_ltp:.2f} | Realized PnL so far: Rs.{self.realized_pnl:+.0f}")

        # Now safe to go flat: if the entry below fails, the main loop sees a flat
        # strategy and re-enters, rather than re-running this same close against legs
        # that no longer exist on every 1s tick.
        self.go_flat()
        self.unsubscribe_legs(old_ce_id, old_pe_id)

        # Enter new ATM straddle
        success = self.enter_straddle(new_atm, spot=nifty_spot)
        if success:
            self.last_roll_time = time.time()
            logger.info(f"Roll #{self.roll_count} completed successfully! New bounds: [{self.lower_bound:.1f} - {self.upper_bound:.1f}]")
        else:
            logger.error(
                f"Roll #{self.roll_count}: re-entry at ATM {new_atm} failed after closing the previous "
                "legs — strategy is now FLAT. The main loop will retry entry on the next iteration."
            )
        return success

    def _close_single_leg(self, label, ltp):
        """Buy back one short leg (per-leg SL). Books its P&L and zeroes its lots only once the
        close is CONFIRMED, so an unconfirmed order leaves the leg tracked and retried."""
        strike = self.ce_strike if label == "CE" else self.pe_strike
        lots = self.ce_lots if label == "CE" else self.pe_lots
        avg = self.ce_avg_price if label == "CE" else self.pe_avg_price
        if not self.dry_run:
            try:
                qty, _ = resolve_exit_qty_broker(self.broker, strike, self.expiry, label,
                                                 lots * self.nifty_lot_size, "BUY", logger)
                if qty > 0:
                    oid = self.broker.buy(strike, self.expiry, label, qty)
                    if not oid or not self.helper.wait_for_fill(oid, timeout=10):
                        logger.critical(f"Per-leg SL: buy-to-close for {label} did not confirm (order_id={oid}); will retry.")
                        return False
            except Exception as e:
                logger.critical(f"Per-leg SL: error closing {label}: {e}")
                return False
        self.realized_pnl += (avg - ltp) * lots * self.nifty_lot_size
        if label == "CE":
            self.ce_lots = 0
        else:
            self.pe_lots = 0
        logger.info(f"{label} leg closed by SL @ {ltp:.2f} | Realized PnL so far: Rs.{self.realized_pnl:+.0f}")
        return True

    def _chain_max_delta(self):
        """max(|CE delta|, |PE delta|) of the held strikes from the option chain, polled at most
        every 5s (chain endpoint is rate-limited). Returns the last good value on a miss, or
        None if greeks were never available — a missing delta must not trigger a roll."""
        if time.time() - self._last_delta_poll < 5:
            return self._fresh_delta()
        self._last_delta_poll = time.time()
        try:
            df = self.helper.get_option_chain_df("NIFTY", self.expiry)
            if df.empty or 'ce_delta' not in df.columns or 'pe_delta' not in df.columns:
                return self._fresh_delta()
            ce_d = float(df.loc[float(self.ce_strike), 'ce_delta'])
            pe_d = float(df.loc[float(self.pe_strike), 'pe_delta'])
            if ce_d == 0 and pe_d == 0:
                return self._fresh_delta()  # greeks not populated
            self._last_max_delta = max(abs(ce_d), abs(pe_d))
            self._last_max_delta_ts = time.time()
        except Exception as e:
            logger.warning(f"Delta poll failed: {e}")
        return self._fresh_delta()

    def _fresh_delta(self):
        """Last good delta, or None once it is older than 15s (a stale value must not roll a position)."""
        if self._last_max_delta is not None and time.time() - self._last_max_delta_ts <= 15:
            return self._last_max_delta
        return None

    def _rules_roll_reason(self, spot, ce_ltp, pe_ltp):
        """Returns a reason string if a roll trigger fired (rules shared with the backtest)."""
        max_delta = self._chain_max_delta() if self.roll_trigger == "delta" else None
        reason, self.imbalance_armed = roll_reason(
            ce=ce_ltp, pe=pe_ltp, spot=spot, ref_spot=self.ref_spot, armed=self.imbalance_armed,
            trigger=self.roll_trigger, spot_pct=self.roll_trigger_pct, max_delta=max_delta,
            delta_limit=self.roll_delta, imbalance_ratio=self.roll_imbalance_ratio)
        return reason

    def _rules_step(self, spot, ce_ltp, pe_ltp, total_pnl, now_str):
        """One tick of rules-mode risk + roll logic. Returns True when the day is finished
        (everything exited, caller must return)."""
        def finish(reason):
            self.force_exit_all(reason)
            self.save_state(spot, ce_ltp, pe_ltp, self.realized_pnl, status="STOPPED")
            return True

        # Time exit
        if now_str >= self.eod_time:
            return finish(f"Intraday EOD Time Reached ({self.eod_time})")

        # Daily hard stop (realised + open)
        if total_pnl <= -self.day_stop_inr:
            return finish(f"Daily Stop (Rs.{total_pnl:.0f} <= -Rs.{self.day_stop_inr:.0f})")

        # Trailing profit lock on total day P&L, steps as % of the first straddle's premium
        if total_pnl > self.best_pnl:
            self.best_pnl = total_pnl
        if self.p0_first_inr:
            lock_pct = trail_lock_pct(self.best_pnl / self.p0_first_inr,
                                      self.trail_start, self.trail_step, self.trail_lock_step)
            if lock_pct is not None:
                self.trail_active = True
                self.trail_lock_inr = lock_pct * self.p0_first_inr
                if total_pnl <= self.trail_lock_inr:
                    return finish(f"Profit Lock Hit (PnL Rs.{total_pnl:.0f} <= lock Rs.{self.trail_lock_inr:.0f})")

        can_roll = self.roll_count < self.max_rolls and now_str < self.no_roll_after

        # No further rolls possible (cap reached or past the no-roll time): keep the straddle
        # and protect each leg with a fixed SL.
        # (The combined straddle SL below still applies while both legs are open.)
        if not can_roll:
            for label, ltp, avg, lots in (("CE", ce_ltp, self.ce_avg_price, self.ce_lots),
                                          ("PE", pe_ltp, self.pe_avg_price, self.pe_lots)):
                if lots > 0 and leg_sl_hit(ltp, avg, self.leg_sl_mult):
                    logger.warning(f"Per-leg SL: {label} {ltp:.2f} >= {self.leg_sl_mult} x entry {avg:.2f} — closing {label} only")
                    if not self._close_single_leg(label, ltp):
                        return False  # unconfirmed: leg still tracked as open, retry next tick
            if self.ce_lots <= 0 and self.pe_lots <= 0:
                return finish("Both legs stopped out by per-leg SL")

        # Per-straddle SL: combined premium >= mult * P0 of this straddle (both legs open only)
        if self.ce_lots > 0 and self.pe_lots > 0 and straddle_sl_hit(ce_ltp, pe_ltp, self.straddle_p0, self.straddle_sl_mult):
            if can_roll:
                logger.warning(f"Straddle SL: {ce_ltp + pe_ltp:.2f} >= {self.straddle_sl_mult} x P0 {self.straddle_p0:.2f} — rolling")
                self.roll_straddle(spot, "UP" if spot >= self.ref_spot else "DOWN", allow_same_strike=True)
                return False
            return finish(f"Straddle SL ({ce_ltp + pe_ltp:.2f} >= {self.straddle_sl_mult} x P0 {self.straddle_p0:.2f}), no rolls left/allowed")

        # Roll trigger
        # No roll cooldown in rules mode; 3s is only an order-spam guard after a failed roll attempt.
        if can_roll and (time.time() - self.last_roll_time) >= 3:
            reason = self._rules_roll_reason(spot, ce_ltp, pe_ltp)
            if reason:
                logger.warning(f"Roll trigger ({self.roll_trigger}): {reason}")
                self.roll_straddle(spot, "UP" if spot >= self.ref_spot else "DOWN", allow_same_strike=True)
        return False

    def run(self):
        if self.roll_type == "percentage":
            variant_info = f"Rolling Trigger ({self.roll_trigger_pct}%)"
        elif self.rules_mode:
            variant_info = (f"Rules (trigger={self.roll_trigger}+imbalance {self.roll_imbalance_ratio}x, "
                            f"straddle SL {self.straddle_sl_mult}x, day stop Rs.{self.day_stop_inr:.0f})")
        elif self.roll_type == "atm":
            variant_info = f"Follow ATM (hysteresis {self.atm_hysteresis} pts)"
        else:
            variant_info = f"Fixed Buffer ({self.roll_buffer} pts)"
        logger.info("=== STARTING ROLLING SHORT STRADDLE STRATEGY ===")
        logger.info(f"Config: Mode={'DRY-RUN' if self.dry_run else 'LIVE'} | Lots={self.initial_lots} | Variant={variant_info} | Max Rolls={self.max_rolls} | Cooldown={self.roll_cooldown}s")
        logger.info(f"Risk: Target={self.profit_target} | StopLoss={self.stop_loss} | TrailStart=Rs.{self.trail_start_rs} | TrailGap=Rs.{self.trail_gap_rs}")

        if self.expiry_day_only:
            dte = self.helper.days_to_expiry("NIFTY")
            if dte != 0:
                logger.info(f"--expiry-day-only: NIFTY DTE is {dte} (need 0) — not trading today.")
                self.save_state(0, 0, 0, 0, status="STOPPED")
                return
            logger.info("--expiry-day-only: today is NIFTY expiry day (0 DTE) — proceeding.")

        # rules mode: expiry day (0 DTE) starts later, after the opening volatility settles
        if self.rules_mode:
            dte = self.helper.days_to_expiry("NIFTY")
            if dte == 0:
                self.start_time = max(self.start_time, self.expiry_start_time)
                logger.info(f"rules: expiry day — entry delayed to {self.start_time}")

        # Wait for start time
        while True:
            exit_if_market_closed(self.helper, self.dry_run)
            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request before entry. Exiting.")
                self.save_state(0, 0, 0, 0, status="STOPPED")
                return

            now_str = datetime.now().strftime("%H:%M")
            if now_str >= self.start_time:
                break
            logger.info(f"Waiting for start time {self.start_time} (Current: {now_str})...")
            self.sleep_cooldown(10)

        # Initial Entry
        spot = self.helper.get_ltp(str(self.NIFTY_SPOT_SID), exchange="IDX_I", instrument="INDEX")
        if spot <= 0:
            logger.error("Failed to fetch initial NIFTY spot price. Retrying...")
            time.sleep(3)
            spot = self.helper.get_ltp(str(self.NIFTY_SPOT_SID), exchange="IDX_I", instrument="INDEX")
            if spot <= 0:
                logger.critical("Cannot proceed without valid spot price.")
                self.save_state(0, 0, 0, 0, status="STOPPED")
                return

        if self.rules_mode:
            skip = None
            if self.vix_max > 0:
                # Fail closed: a filter the user asked for must not silently turn off because
                # the VIX quote failed. Retry a few times, then skip the day.
                vix = 0.0
                for attempt in range(1, 4):
                    try:
                        vix = float(self.helper.get_ltp("21", exchange="IDX_I", instrument="INDEX") or 0.0)
                    except Exception as e:
                        logger.warning(f"VIX fetch attempt {attempt} failed: {e}")
                        vix = 0.0
                    if vix > 0:
                        break
                    time.sleep(2)
                if vix <= 0:
                    skip = f"India VIX unavailable after 3 tries (--vix-max {self.vix_max} is set, failing closed)"
                elif vix > self.vix_max:
                    skip = f"India VIX {vix:.2f} > cutoff {self.vix_max}"
            if not skip and self.gap_skip_pct > 0 and self.prev_day_close:
                gap = abs(spot - self.prev_day_close) / self.prev_day_close * 100.0
                if gap > self.gap_skip_pct:
                    skip = f"open gap {gap:.2f}% > {self.gap_skip_pct}%"
            if skip:
                logger.warning(f"rules: skipping the day — {skip}")
                self.save_state(spot, 0, 0, 0, status="STOPPED")
                return

        initial_atm = round(spot / 50.0) * 50
        if not self.enter_straddle(initial_atm, spot=spot):
            # An aborted entry (ATM drift, transient quote failure) is recoverable —
            # the main loop's flat branch retries. Only a hard stop ends the day.
            logger.warning("Initial straddle entry did not complete. Main loop will retry.")

        # Main Monitoring Loop
        last_status_log = 0.0
        last_phantom_check = time.time()
        while True:
            exit_if_market_closed(self.helper, self.dry_run)
            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request received during strategy run. Liquidation initiated.")
                self.force_exit_all("UI Graceful Stop")
                self.save_state(spot, 0, 0, self.realized_pnl, status="STOPPED")
                return

            # --- Flat: no live legs (initial entry or a roll's re-entry failed) ---
            if self.is_flat():
                now_str = datetime.now().strftime("%H:%M")
                if now_str >= self.eod_time:
                    logger.info(f"EOD time reached ({self.eod_time}) while flat. Strategy finished for the day.")
                    self.save_state(spot, 0, 0, self.realized_pnl, status="STOPPED")
                    return

                # rules mode: a roll's re-entry failed (or a stop left us flat) — the day-level
                # limits still apply before another straddle is sold.
                if self.rules_mode:
                    stop_reason = None
                    if self.p0_first_inr is None:
                        # never entered: only the time cutoff applies
                        if now_str >= self.no_roll_after:
                            stop_reason = f"never balanced/entered before {self.no_roll_after}"
                    elif self.realized_pnl <= -self.day_stop_inr:
                        stop_reason = f"Daily Stop (Rs.{self.realized_pnl:.0f} <= -Rs.{self.day_stop_inr:.0f})"
                    elif self.trail_lock_inr is not None and self.realized_pnl <= self.trail_lock_inr:
                        stop_reason = f"Profit Lock (Rs.{self.realized_pnl:.0f} <= lock Rs.{self.trail_lock_inr:.0f})"
                    elif now_str >= self.no_roll_after:
                        stop_reason = f"past no-roll time {self.no_roll_after}"
                    if stop_reason:
                        logger.warning(f"Flat in rules mode — not re-entering: {stop_reason}")
                        self.save_state(spot, 0, 0, self.realized_pnl, status="STOPPED")
                        return

                spot_now = self.helper.get_ltp(str(self.NIFTY_SPOT_SID), exchange="IDX_I", instrument="INDEX")
                if spot_now > 0:
                    spot = spot_now
                self.save_state(spot, 0, 0, self.realized_pnl, status="FLAT")

                if spot <= 0:
                    logger.warning("Flat and no valid spot price. Retrying in 5s.")
                    self.sleep_cooldown(5)
                    continue

                if not self.enter_straddle(round(spot / 50.0) * 50, spot=spot):
                    logger.warning("Entry attempt failed while flat. Retrying in 5s.")
                    self.sleep_cooldown(5)
                continue

            ce_ltp, pe_ltp, spot = self.fetch_ltps()
            if ce_ltp <= 0 or pe_ltp <= 0 or spot <= 0:
                time.sleep(1)
                continue

            total_pnl = self._calculate_pnl(ce_ltp, pe_ltp)

            # Victim-side check (2026-07-30 incident follow-up): notice if a
            # sibling instance's exit or a manual dashboard square-off already
            # flattened a leg we still think is open.
            if time.time() - last_phantom_check >= PHANTOM_CHECK_INTERVAL_SEC:
                last_phantom_check = time.time()
                if self.ce_id and self.ce_lots > 0 and detect_phantom_leg_broker(
                    self.broker, self.ce_strike, self.expiry, "CE",
                    self.ce_lots * self.nifty_lot_size, "BUY", logger, dry_run=self.dry_run,
                ):
                    logger.warning(f"Phantom CE leg detected ({self.ce_strike}) — broker shows it "
                                   f"already closed elsewhere. Correcting internal state, not placing an order.")
                    self.ce_lots = 0
                if self.pe_id and self.pe_lots > 0 and detect_phantom_leg_broker(
                    self.broker, self.pe_strike, self.expiry, "PE",
                    self.pe_lots * self.nifty_lot_size, "BUY", logger, dry_run=self.dry_run,
                ):
                    logger.warning(f"Phantom PE leg detected ({self.pe_strike}) — broker shows it "
                                   f"already closed elsewhere. Correcting internal state, not placing an order.")
                    self.pe_lots = 0

            self.save_state(spot, ce_ltp, pe_ltp, total_pnl, status="RUNNING")

            now_str = datetime.now().strftime("%H:%M")
            # Throttled to 5s: this loop ticks every second, and logging unconditionally
            # produced ~22k lines per session. Every other strategy throttles to 5-30s.
            if time.time() - last_status_log >= 5:
                logger.info(f"NIFTY: {spot:.2f} | Straddle {self.current_atm_strike} [Bounds: {self.lower_bound:.1f} - {self.upper_bound:.1f}] | CE: {ce_ltp:.2f} | PE: {pe_ltp:.2f} | Rolls: {self.roll_count}/{self.max_rolls} | PnL: Rs.{total_pnl:+.0f}")
                last_status_log = time.time()

            if self.rules_mode:
                if self._rules_step(spot, ce_ltp, pe_ltp, total_pnl, now_str):
                    logger.info("Strategy finished for the day.")
                    return
                time.sleep(1)
                continue

            # 1. EOD Exit Check
            if now_str >= self.eod_time:
                self.force_exit_all(f"Intraday EOD Time Reached ({self.eod_time})")
                self.save_state(spot, ce_ltp, pe_ltp, total_pnl, status="STOPPED")
                logger.info("Strategy finished for the day.")
                return

            # 2. Profit Target Check
            if self.profit_target and total_pnl >= self.profit_target:
                self.force_exit_all(f"Target Hit (+Rs.{total_pnl:.0f} >= Rs.{self.profit_target:.0f})")
                self.save_state(spot, ce_ltp, pe_ltp, total_pnl, status="STOPPED")
                return

            # 3. Stop Loss Check
            if self.stop_loss and total_pnl <= self.stop_loss:
                self.force_exit_all(f"Stop Loss Hit (Rs.{total_pnl:.0f} <= Rs.{self.stop_loss:.0f})")
                self.save_state(spot, ce_ltp, pe_ltp, total_pnl, status="STOPPED")
                return

            # 4. Trailing SL Check
            if total_pnl > self.best_pnl:
                self.best_pnl = total_pnl
            if self.trail_start_rs > 0 and self.best_pnl >= self.trail_start_rs:
                if not self.trail_active:
                    self.trail_active = True
                    logger.info(f"Trailing SL Activated at Profit Rs.{total_pnl:.0f}! Trail gap: Rs.{self.trail_gap_rs:.0f}")

                trail_exit_threshold = self.best_pnl - self.trail_gap_rs
                if total_pnl <= trail_exit_threshold:
                    self.force_exit_all(f"Trailing Stop Loss Hit (PnL Rs.{total_pnl:.0f} <= Trail Exit Rs.{trail_exit_threshold:.0f})")
                    self.save_state(spot, ce_ltp, pe_ltp, total_pnl, status="STOPPED")
                    return

            # 5. Rolling Straddle Check
            now_time = time.time()
            bound_breached = spot >= self.upper_bound or spot <= self.lower_bound
            if self.roll_count < self.max_rolls and (now_time - self.last_roll_time) >= self.roll_cooldown:
                if spot >= self.upper_bound:
                    logger.warning(f"Upper Bound Breached! Spot {spot:.2f} >= {self.upper_bound:.2f}")
                    self.roll_straddle(spot, direction="UP")
                elif spot <= self.lower_bound:
                    logger.warning(f"Lower Bound Breached! Spot {spot:.2f} <= {self.lower_bound:.2f}")
                    self.roll_straddle(spot, direction="DOWN")
            elif self.roll_count >= self.max_rolls and bound_breached and self.exit_on_max_rolls:
                self.force_exit_all(
                    f"Max Rolls Exhausted ({self.roll_count}/{self.max_rolls}) — Bound Breached "
                    f"(Spot {spot:.2f}, Bounds [{self.lower_bound:.1f} - {self.upper_bound:.1f}])"
                )
                self.save_state(spot, ce_ltp, pe_ltp, total_pnl, status="STOPPED")
                return

            time.sleep(1)

def main():
    parser = argparse.ArgumentParser(description="Intraday Rolling Short Straddle Strategy for NIFTY")
    parser.add_argument("--dry-run", action="store_true", default=True, help="Run in dry-run mode without real order execution")
    parser.add_argument("--live", action="store_true", help="Run in live trading mode with real orders")
    parser.add_argument("--lots", type=int, default=1, help="Initial lot size per leg")
    parser.add_argument("--roll-type", type=str, choices=["points", "percentage", "atm", "rules"], default="points", help="Rolling trigger variant: 'points' (fixed buffer pts), 'percentage' (rolling trigger %%), 'atm' (follow the true ATM: roll once spot is 25 pts + --atm-hysteresis past the held strike) or 'rules' (spot%%/delta/imbalance roll + per-straddle SL + capital day stop + profit-lock trail; needs --capital)")
    parser.add_argument("--roll-trigger", choices=["spot_pct", "delta"], default="spot_pct", help="[rules] primary roll trigger, one of the two (spot_pct uses --roll-trigger-pct). Premium imbalance is always active in addition")
    parser.add_argument("--roll-delta", type=float, default=0.60, help="[rules] roll when either leg's |delta| >= this (delta trigger)")
    parser.add_argument("--roll-imbalance-ratio", type=float, default=2.0, help="[rules] roll when higher leg premium >= ratio x lower leg (imbalance trigger)")
    parser.add_argument("--straddle-sl-mult", type=float, default=1.25, help="[rules] per-straddle SL: exit/roll when combined premium >= mult x that straddle's entry premium")
    parser.add_argument("--leg-sl-mult", type=float, default=1.5, help="[rules] once --max-rolls is reached, each leg is stopped individually when its premium >= mult x its own entry premium")
    parser.add_argument("--no-roll-after", type=str, default="14:30", help="[rules] no rolls at/after HH:MM; an SL after this exits for the day")
    parser.add_argument("--expiry-start-time", type=str, default="09:30", help="[rules] entry time on NIFTY expiry day (default 09:30)")
    parser.add_argument("--capital", type=float, default=0.0, help="[rules] capital in INR; daily hard stop = --day-stop-pct-capital of this (required)")
    parser.add_argument("--day-stop-pct-capital", type=float, default=1.5, help="[rules] daily stop as %% of --capital (default 1.5)")
    parser.add_argument("--vix-max", type=float, default=0.0, help="[rules] skip the day if India VIX is above this (0 = off)")
    parser.add_argument("--gap-skip-pct", type=float, default=0.0, help="[rules] skip the day if the open gaps more than this %% vs prev close (0 = off, e.g. 0.8)")
    parser.add_argument("--trail-start", type=float, default=0.20, help="[rules] profit-lock arms at this fraction of the first straddle's premium (0.20 = +20%%)")
    parser.add_argument("--trail-step", type=float, default=0.10, help="[rules] profit step between lock rungs (fraction of first premium)")
    parser.add_argument("--trail-lock-step", type=float, default=0.08, help="[rules] lock raise per step beyond the +40%% rung")
    parser.add_argument("--atm-hysteresis", type=float, default=5.0, metavar="PTS", help="Extra points beyond the 25pt ATM midpoint before an 'atm' roll fires (default 5.0, 0 = roll exactly at the midpoint)")
    parser.add_argument("--roll-buffer", type=float, default=35.0, help="Custom ATM shift buffer in points (e.g., 35.0)")
    parser.add_argument("--roll-trigger-pct", type=float, default=0.4, help="Percentage movement trigger for rolling ATM straddle (e.g., 0.4)")
    parser.add_argument("--max-rolls", type=int, default=None, help="Maximum number of rolls allowed per day (default 5; 3 in rules mode)")
    parser.add_argument("--roll-cooldown", type=int, default=60, help="Minimum cooldown between rolls in seconds")
    parser.add_argument("--target-profit", type=str, default="25%", help="Profit target in INR or percentage (e.g. 25%% or 4000)")
    parser.add_argument("--stop-loss", type=str, default="25%", help="Stop loss in INR or percentage (e.g. 25%% or 4000)")
    parser.add_argument("--start-time", type=str, default="09:20", help="Strategy start time (HH:MM)")
    parser.add_argument("--eod-time", type=str, default=None, help="Intraday auto-exit time (HH:MM) (default 15:17; 15:15 in rules mode)")
    parser.add_argument("--trail-start-rs", type=float, default=500.0, help="MTM profit level to activate trailing SL")
    parser.add_argument("--trail-gap-rs", type=float, default=300.0, help="Trailing SL gap in INR")
    parser.add_argument("--entry-balance-threshold", type=float, default=None, metavar="PCT",
                        help="Max CE/PE premium difference %% allowed at entry (default: 15.0; 0 in rules mode; set 0 to disable)")
    parser.add_argument("--entry-balance-timeout", type=float, default=30.0, metavar="SECONDS",
                        help="Max seconds to wait for CE/PE balance before entering anyway (default: 30, set 0 to disable)")
    parser.add_argument("--exit-on-max-rolls", dest="exit_on_max_rolls", action="store_true", default=True,
                        help="Force-close the position once max-rolls is exhausted and bounds are still breached (default: on)")
    parser.add_argument("--no-exit-on-max-rolls", dest="exit_on_max_rolls", action="store_false",
                        help="Disable forced exit on max-rolls exhaustion; ride the stale strike instead")
    parser.add_argument("--expiry-day-only", action="store_true",
                        help="Trade only on the NIFTY weekly expiry day (0 DTE); exit immediately on other days (fails closed if DTE can't be resolved)")
    parser.add_argument("--instance-id", type=str, default=None, help="Optional instance identifier for multi-running")
    parser.add_argument(
        "--broker", choices=["dhan", "zerodha", "kotak"], default="dhan",
        help="Execution broker for order placement. Market data always comes from Dhan. "
             "Zerodha/Kotak stop-loss/target exits are software-managed only (no resting "
             "broker-side stop order)."
    )

    args = parser.parse_args()

    is_dry_run = not args.live
    rules = args.roll_type == "rules"
    if args.max_rolls is None:
        args.max_rolls = 3 if rules else 5
    if args.eod_time is None:
        args.eod_time = "15:15" if rules else "15:17"
    if args.entry_balance_threshold is None:
        args.entry_balance_threshold = 0.0 if rules else 15.0
    pt_val, pt_is_pct = parse_target_spec(args.target_profit)
    sl_val, sl_is_pct = parse_target_spec(args.stop_loss)

    state_key = "nifty_rolling_straddle"
    if args.instance_id:
        state_key = f"{state_key}_{args.instance_id}"

    strategy = RollingStraddleStrategy(
        dry_run=is_dry_run,
        initial_lots=args.lots,
        roll_type=args.roll_type,
        roll_buffer=args.roll_buffer,
        roll_trigger_pct=args.roll_trigger_pct,
        max_rolls=args.max_rolls,
        roll_cooldown=args.roll_cooldown,
        profit_target=pt_val,
        profit_target_is_pct=pt_is_pct,
        stop_loss=sl_val,
        stop_loss_is_pct=sl_is_pct,
        start_time=args.start_time,
        eod_time=args.eod_time,
        trail_start_rs=args.trail_start_rs,
        trail_gap_rs=args.trail_gap_rs,
        entry_balance_threshold=args.entry_balance_threshold,
        entry_balance_timeout=args.entry_balance_timeout,
        exit_on_max_rolls=args.exit_on_max_rolls,
        atm_hysteresis=args.atm_hysteresis,
        expiry_day_only=args.expiry_day_only,
        state_key=state_key,
        broker=args.broker,
        roll_trigger=args.roll_trigger,
        roll_delta=args.roll_delta,
        roll_imbalance_ratio=args.roll_imbalance_ratio,
        straddle_sl_mult=args.straddle_sl_mult,
        no_roll_after=args.no_roll_after,
        expiry_start_time=args.expiry_start_time,
        capital=args.capital,
        day_stop_pct_capital=args.day_stop_pct_capital,
        vix_max=args.vix_max,
        gap_skip_pct=args.gap_skip_pct,
        trail_start=args.trail_start,
        trail_step=args.trail_step,
        trail_lock_step=args.trail_lock_step,
        leg_sl_mult=args.leg_sl_mult,
    )

    strategy.run()

if __name__ == "__main__":
    main()
