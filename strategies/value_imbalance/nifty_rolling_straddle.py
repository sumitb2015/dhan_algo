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
from lib.strategy_state_helper import save_strategy_state, check_shutdown_trigger, exit_if_market_closed, parse_target_spec, instance_log_suffix
from lib.strategy_risk import resolve_exit_qty

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
        FlushingFileHandler(os.path.join(log_dir, f"{datetime.now().strftime('%Y%m%d')}{instance_log_suffix()}.log"))
    ],
    force=True
)
logger = logging.getLogger(__name__)

class RollingStraddleStrategy:
    def __init__(self, dry_run=True, initial_lots=1, roll_buffer=35.0, max_rolls=5,
                 roll_cooldown=60, profit_target=4000.0, profit_target_is_pct=False,
                 stop_loss=4000.0, stop_loss_is_pct=False, start_time="09:20", eod_time="15:15",
                 trail_start_rs=500.0, trail_gap_rs=300.0, roll_type="points",
                 roll_trigger_pct=0.4, entry_balance_threshold=15.0,
                 state_key="nifty_rolling_straddle"):
        self.state_key = state_key
        self.dry_run = dry_run
        self.initial_lots = initial_lots
        self.roll_buffer = float(roll_buffer)
        self.roll_type = roll_type.lower() if isinstance(roll_type, str) else "points"
        self.roll_trigger_pct = float(roll_trigger_pct)
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

        self.dhan = get_dhan_client()
        if not self.dhan:
            raise Exception("Failed to connect to Dhan API.")
        self.helper = DhanHelper(self.dhan)

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
            "entry_balance_threshold": self.entry_balance_threshold,
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
            "profit_target": self.profit_target,
            "stop_loss": self.stop_loss,
            "trail_active": self.trail_active,
            "trail_start_rs": self.trail_start_rs,
            "trail_gap_rs": self.trail_gap_rs,
            "best_pnl": round(self.best_pnl, 2),
            "trail_exit_pnl": round(self.best_pnl - self.trail_gap_rs, 2) if self.trail_active else None,
        }
        save_strategy_state(self.state_key, state_dict)

    def _calculate_pnl(self, ce_ltp, pe_ltp):
        ce_unrealized = (self.ce_avg_price - ce_ltp) * (self.ce_lots * self.nifty_lot_size)
        pe_unrealized = (self.pe_avg_price - pe_ltp) * (self.pe_lots * self.nifty_lot_size)
        return self.realized_pnl + ce_unrealized + pe_unrealized

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
        logger.warning(f"!!! EXITING ALL POSITIONS: {reason} !!!")
        if not self.dry_run:
            if self.ce_id:
                try:
                    own_qty = self.ce_lots * self.nifty_lot_size
                    qty_to_buy, _ = resolve_exit_qty(self.helper, self.ce_id, own_qty, "BUY", logger)
                    if qty_to_buy > 0:
                        ce_exit_id = self.helper.buy(str(self.ce_id), qty_to_buy)
                        logger.info(f"CE Exit Order placed ({qty_to_buy} qty): {ce_exit_id}")
                except Exception as e:
                    logger.error(f"Exit CE Error: {e}")
            if self.pe_id:
                try:
                    own_qty = self.pe_lots * self.nifty_lot_size
                    qty_to_buy, _ = resolve_exit_qty(self.helper, self.pe_id, own_qty, "BUY", logger)
                    if qty_to_buy > 0:
                        pe_exit_id = self.helper.buy(str(self.pe_id), qty_to_buy)
                        logger.info(f"PE Exit Order placed ({qty_to_buy} qty): {pe_exit_id}")
                except Exception as e:
                    logger.error(f"Exit PE Error: {e}")

        # Update realized PnL from latest market price before exiting
        ce_ltp, pe_ltp, _ = self.fetch_ltps()
        if ce_ltp > 0 and pe_ltp > 0:
            final_pnl = self._calculate_pnl(ce_ltp, pe_ltp)
            self.realized_pnl = final_pnl

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

        # --- Entry Balance Wait ---
        if self.entry_balance_threshold > 0:
            logger.info(f"Waiting for CE/PE premium to balance (diff < {self.entry_balance_threshold:.1f}%)...")
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
                time.sleep(2)

        if self.dry_run:
            ce_avg_price = ce_price
            pe_avg_price = pe_price
            logger.info(f"[DRY-RUN] Shorted {self.initial_lots} lot {ce_symbol} @ {ce_price:.2f}")
            logger.info(f"[DRY-RUN] Shorted {self.initial_lots} lot {pe_symbol} @ {pe_price:.2f}")
        else:
            logger.info(f"Placing live SELL order for {self.initial_lots} lot {ce_symbol}...")
            ce_order_id = self.helper.sell(str(ce_id), qty)
            ce_avg_price = self.helper.wait_for_fill(ce_order_id, timeout=5) or ce_price

            logger.info(f"Placing live SELL order for {self.initial_lots} lot {pe_symbol}...")
            pe_order_id = self.helper.sell(str(pe_id), qty)
            pe_avg_price = self.helper.wait_for_fill(pe_order_id, timeout=5) or pe_price

        # --- Commit: from here the position is live and `self` is authoritative ---
        self.current_atm_strike = atm_strike
        self.ref_spot = float(spot) if spot > 0 else float(atm_strike)
        if self.roll_type == "percentage":
            self.upper_bound = round(self.ref_spot * (1.0 + self.roll_trigger_pct / 100.0), 2)
            self.lower_bound = round(self.ref_spot * (1.0 - self.roll_trigger_pct / 100.0), 2)
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

        combined_premium = self.ce_avg_price + self.pe_avg_price
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

    def roll_straddle(self, nifty_spot, direction):
        """Rolls the short straddle UP or DOWN to the new ATM strike."""
        new_atm = round(nifty_spot / 50.0) * 50
        logger.warning(f">>> ROLLING STRADDLE {direction.upper()} <<<")
        logger.warning(f"Spot: {nifty_spot:.2f} | Prev ATM: {self.current_atm_strike} -> New ATM: {new_atm}")

        ce_ltp, pe_ltp, _ = self.fetch_ltps()
        if ce_ltp <= 0 or pe_ltp <= 0:
            logger.error("Failed to fetch LTPs for current straddle leg close during roll!")
            return False

        old_ce_id, old_pe_id = self.ce_id, self.pe_id

        # Close existing CE & PE legs
        close_ce_pnl = (self.ce_avg_price - ce_ltp) * (self.ce_lots * self.nifty_lot_size)
        close_pe_pnl = (self.pe_avg_price - pe_ltp) * (self.pe_lots * self.nifty_lot_size)
        self.realized_pnl += (close_ce_pnl + close_pe_pnl)

        if not self.dry_run:
            if old_ce_id:
                own_qty = self.ce_lots * self.nifty_lot_size
                qty_to_buy, _ = resolve_exit_qty(self.helper, old_ce_id, own_qty, "BUY", logger)
                if qty_to_buy > 0:
                    self.helper.buy(str(old_ce_id), qty_to_buy)
            if old_pe_id:
                own_qty = self.pe_lots * self.nifty_lot_size
                qty_to_buy, _ = resolve_exit_qty(self.helper, old_pe_id, own_qty, "BUY", logger)
                if qty_to_buy > 0:
                    self.helper.buy(str(old_pe_id), qty_to_buy)

        logger.info(f"Closed prev legs @ CE: {ce_ltp:.2f}, PE: {pe_ltp:.2f} | Realized PnL so far: Rs.{self.realized_pnl:+.0f}")

        # Go flat and charge the roll BEFORE attempting re-entry. The close above is
        # now booked exactly once: if the entry below fails, the main loop sees a flat
        # strategy and re-enters, rather than re-running this same close against legs
        # that no longer exist on every 1s tick.
        #
        # roll_count increments HERE, not on entry success: the roll is committed the
        # moment the old legs are closed. Counting it at entry success instead would
        # let a failed entry followed by the main loop's flat re-entry move the
        # position to a new strike without ever charging it against --max-rolls.
        self.go_flat()
        self.roll_count += 1
        self.last_roll_time = time.time()
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

    def run(self):
        variant_info = f"Rolling Trigger ({self.roll_trigger_pct}%)" if self.roll_type == "percentage" else f"Fixed Buffer ({self.roll_buffer} pts)"
        logger.info("=== STARTING ROLLING SHORT STRADDLE STRATEGY ===")
        logger.info(f"Config: Mode={'DRY-RUN' if self.dry_run else 'LIVE'} | Lots={self.initial_lots} | Variant={variant_info} | Max Rolls={self.max_rolls} | Cooldown={self.roll_cooldown}s")
        logger.info(f"Risk: Target={self.profit_target} | StopLoss={self.stop_loss} | TrailStart=Rs.{self.trail_start_rs} | TrailGap=Rs.{self.trail_gap_rs}")

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

        initial_atm = round(spot / 50.0) * 50
        if not self.enter_straddle(initial_atm, spot=spot):
            # An aborted entry (ATM drift, transient quote failure) is recoverable —
            # the main loop's flat branch retries. Only a hard stop ends the day.
            logger.warning("Initial straddle entry did not complete. Main loop will retry.")

        # Main Monitoring Loop
        while True:
            exit_if_market_closed(self.helper, self.dry_run)
            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request received during strategy run. Liquidation initiated.")
                self.exit_all_positions("UI Graceful Stop")
                self.save_state(spot, 0, 0, self.realized_pnl, status="STOPPED")
                return

            # --- Flat: no live legs (initial entry or a roll's re-entry failed) ---
            if self.is_flat():
                now_str = datetime.now().strftime("%H:%M")
                if now_str >= self.eod_time:
                    logger.info(f"EOD time reached ({self.eod_time}) while flat. Strategy finished for the day.")
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
            self.save_state(spot, ce_ltp, pe_ltp, total_pnl, status="RUNNING")

            now_str = datetime.now().strftime("%H:%M")
            logger.info(f"NIFTY: {spot:.2f} | Straddle {self.current_atm_strike} [Bounds: {self.lower_bound:.1f} - {self.upper_bound:.1f}] | CE: {ce_ltp:.2f} | PE: {pe_ltp:.2f} | Rolls: {self.roll_count}/{self.max_rolls} | PnL: Rs.{total_pnl:+.0f}")

            # 1. EOD Exit Check
            if now_str >= self.eod_time:
                self.exit_all_positions(f"Intraday EOD Time Reached ({self.eod_time})")
                self.save_state(spot, ce_ltp, pe_ltp, total_pnl, status="STOPPED")
                logger.info("Strategy finished for the day.")
                return

            # 2. Profit Target Check
            if self.profit_target and total_pnl >= self.profit_target:
                self.exit_all_positions(f"Target Hit (+Rs.{total_pnl:.0f} >= Rs.{self.profit_target:.0f})")
                self.save_state(spot, ce_ltp, pe_ltp, total_pnl, status="STOPPED")
                return

            # 3. Stop Loss Check
            if self.stop_loss and total_pnl <= self.stop_loss:
                self.exit_all_positions(f"Stop Loss Hit (Rs.{total_pnl:.0f} <= Rs.{self.stop_loss:.0f})")
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
                    self.exit_all_positions(f"Trailing Stop Loss Hit (PnL Rs.{total_pnl:.0f} <= Trail Exit Rs.{trail_exit_threshold:.0f})")
                    self.save_state(spot, ce_ltp, pe_ltp, total_pnl, status="STOPPED")
                    return

            # 5. Rolling Straddle Check
            now_time = time.time()
            if self.roll_count < self.max_rolls and (now_time - self.last_roll_time) >= self.roll_cooldown:
                if spot >= self.upper_bound:
                    logger.warning(f"Upper Bound Breached! Spot {spot:.2f} >= {self.upper_bound:.2f}")
                    self.roll_straddle(spot, direction="UP")
                elif spot <= self.lower_bound:
                    logger.warning(f"Lower Bound Breached! Spot {spot:.2f} <= {self.lower_bound:.2f}")
                    self.roll_straddle(spot, direction="DOWN")

            time.sleep(1)

def main():
    parser = argparse.ArgumentParser(description="Intraday Rolling Short Straddle Strategy for NIFTY")
    parser.add_argument("--dry-run", action="store_true", default=True, help="Run in dry-run mode without real order execution")
    parser.add_argument("--live", action="store_true", help="Run in live trading mode with real orders")
    parser.add_argument("--lots", type=int, default=1, help="Initial lot size per leg")
    parser.add_argument("--roll-type", type=str, choices=["points", "percentage"], default="points", help="Rolling trigger variant: 'points' (fixed buffer pts) or 'percentage' (rolling trigger %%)")
    parser.add_argument("--roll-buffer", type=float, default=35.0, help="Custom ATM shift buffer in points (e.g., 35.0)")
    parser.add_argument("--roll-trigger-pct", type=float, default=0.4, help="Percentage movement trigger for rolling ATM straddle (e.g., 0.4)")
    parser.add_argument("--max-rolls", type=int, default=5, help="Maximum number of rolls allowed per day")
    parser.add_argument("--roll-cooldown", type=int, default=60, help="Minimum cooldown between rolls in seconds")
    parser.add_argument("--target-profit", type=str, default="25%", help="Profit target in INR or percentage (e.g. 25%% or 4000)")
    parser.add_argument("--stop-loss", type=str, default="25%", help="Stop loss in INR or percentage (e.g. 25%% or 4000)")
    parser.add_argument("--start-time", type=str, default="09:20", help="Strategy start time (HH:MM)")
    parser.add_argument("--eod-time", type=str, default="15:15", help="Intraday auto-exit time (HH:MM)")
    parser.add_argument("--trail-start-rs", type=float, default=500.0, help="MTM profit level to activate trailing SL")
    parser.add_argument("--trail-gap-rs", type=float, default=300.0, help="Trailing SL gap in INR")
    parser.add_argument("--entry-balance-threshold", type=float, default=15.0, metavar="PCT",
                        help="Max CE/PE premium difference %% allowed at entry (default: 15.0, set 0 to disable)")
    parser.add_argument("--instance-id", type=str, default=None, help="Optional instance identifier for multi-running")

    args = parser.parse_args()

    is_dry_run = not args.live
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
        state_key=state_key
    )

    strategy.run()

if __name__ == "__main__":
    main()
