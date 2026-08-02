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
                 trail_start_rs=500.0, trail_gap_rs=300.0,
                 state_key="nifty_rolling_straddle"):
        self.state_key = state_key
        self.dry_run = dry_run
        self.initial_lots = initial_lots
        self.roll_buffer = float(roll_buffer)
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

        # Rolling Straddle State
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

    def fetch_ltps(self):
        """Batched CE/PE/spot LTP fetch using library method."""
        if not self.ce_id or not self.pe_id:
            spot = self.helper.get_ltp(str(self.NIFTY_SPOT_SID), exchange="IDX_I", instrument="INDEX")
            return 0.0, 0.0, spot

        ltps = self.helper.get_ltps([
            ("NSE_FNO", self.ce_id),
            ("NSE_FNO", self.pe_id),
            ("IDX_I", self.NIFTY_SPOT_SID),
        ])
        return (
            ltps.get(str(self.ce_id), 0.0),
            ltps.get(str(self.pe_id), 0.0),
            ltps.get(str(self.NIFTY_SPOT_SID), 0.0),
        )

    def save_state(self, nifty_spot, ce_ltp, pe_ltp, total_pnl, status="RUNNING"):
        state_dict = {
            "strategy": "nifty_rolling_straddle",
            "status": status,
            "dry_run": self.dry_run,
            "lots": self.initial_lots,
            "roll_buffer": self.roll_buffer,
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

    def enter_straddle(self, atm_strike):
        """Finds and sells ATM CE and PE options at the specified strike."""
        logger.info(f"--- ENTERING SHORT STRADDLE AT ATM STRIKE {atm_strike} ---")
        
        # Resolve CE contract
        ce_quote = self.helper.option("NIFTY", atm_strike, "CE")
        ce_id, ce_price, expiry, lot_size, ce_symbol = self._extract_quote_fields(ce_quote, atm_strike, "CE")

        # Resolve PE contract
        pe_quote = self.helper.option("NIFTY", atm_strike, "PE")
        pe_id, pe_price, _, _, pe_symbol = self._extract_quote_fields(pe_quote, atm_strike, "PE")

        if not ce_id or not pe_id or ce_price <= 0 or pe_price <= 0:
            logger.error(f"Failed to fetch quotes for ATM {atm_strike}. CE: {ce_price}, PE: {pe_price}")
            return False

        self.current_atm_strike = atm_strike
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

        qty = self.initial_lots * self.nifty_lot_size

        if self.dry_run:
            self.ce_avg_price = ce_price
            self.pe_avg_price = pe_price
            logger.info(f"[DRY-RUN] Shorted {self.initial_lots} lot {ce_symbol} @ {ce_price:.2f}")
            logger.info(f"[DRY-RUN] Shorted {self.initial_lots} lot {pe_symbol} @ {pe_price:.2f}")
        else:
            logger.info(f"Placing live SELL order for {self.initial_lots} lot {ce_symbol}...")
            ce_order_id = self.helper.sell(str(ce_id), qty)
            self.ce_avg_price = self.helper.wait_for_fill(ce_order_id, timeout=5) or ce_price

            logger.info(f"Placing live SELL order for {self.initial_lots} lot {pe_symbol}...")
            pe_order_id = self.helper.sell(str(pe_id), qty)
            self.pe_avg_price = self.helper.wait_for_fill(pe_order_id, timeout=5) or pe_price

        # Register positions with WebSocket live feed
        self.helper.start_websocket([
            ("NSE_FNO", str(self.ce_id), 15),
            ("NSE_FNO", str(self.pe_id), 15)
        ])

        combined_premium = self.ce_avg_price + self.pe_avg_price
        logger.info(f"Straddle Entered! ATM: {atm_strike} | Upper Bound: {self.upper_bound:.1f} | Lower Bound: {self.lower_bound:.1f}")
        logger.info(f"CE Avg: {self.ce_avg_price:.2f} | PE Avg: {self.pe_avg_price:.2f} | Total Premium: {combined_premium:.2f} pts")

        # Resolve percentage targets if configured as percentage
        if self.target_is_pct and self.target_pct:
            total_premium_inr = combined_premium * qty
            self.profit_target = total_premium_inr * (self.target_pct / 100.0)
            logger.info(f"Resolved % Profit Target ({self.target_pct}% of ₹{total_premium_inr:.0f}) = +₹{self.profit_target:.0f}")

        if self.stop_is_pct and self.stop_pct:
            total_premium_inr = combined_premium * qty
            self.stop_loss = -abs(total_premium_inr * (self.stop_pct / 100.0))
            logger.info(f"Resolved % Stop Loss ({self.stop_pct}% of ₹{total_premium_inr:.0f}) = -₹{abs(self.stop_loss):.0f}")

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

        # Close existing CE & PE legs
        close_ce_pnl = (self.ce_avg_price - ce_ltp) * (self.ce_lots * self.nifty_lot_size)
        close_pe_pnl = (self.pe_avg_price - pe_ltp) * (self.pe_lots * self.nifty_lot_size)
        self.realized_pnl += (close_ce_pnl + close_pe_pnl)

        if not self.dry_run:
            if self.ce_id:
                own_qty = self.ce_lots * self.nifty_lot_size
                qty_to_buy, _ = resolve_exit_qty(self.helper, self.ce_id, own_qty, "BUY", logger)
                if qty_to_buy > 0:
                    self.helper.buy(str(self.ce_id), qty_to_buy)
            if self.pe_id:
                own_qty = self.pe_lots * self.nifty_lot_size
                qty_to_buy, _ = resolve_exit_qty(self.helper, self.pe_id, own_qty, "BUY", logger)
                if qty_to_buy > 0:
                    self.helper.buy(str(self.pe_id), qty_to_buy)

        logger.info(f"Closed prev legs @ CE: {ce_ltp:.2f}, PE: {pe_ltp:.2f} | Realized PnL so far: ₹{self.realized_pnl:+.0f}")

        # Enter new ATM straddle
        success = self.enter_straddle(new_atm)
        if success:
            self.roll_count += 1
            self.last_roll_time = time.time()
            logger.info(f"Roll #{self.roll_count} completed successfully! New bounds: [{self.lower_bound:.1f} - {self.upper_bound:.1f}]")
        return success

    def run(self):
        logger.info("=== STARTING ROLLING SHORT STRADDLE STRATEGY ===")
        logger.info(f"Config: Mode={'DRY-RUN' if self.dry_run else 'LIVE'} | Lots={self.initial_lots} | Roll Buffer={self.roll_buffer} pts | Max Rolls={self.max_rolls} | Cooldown={self.roll_cooldown}s")
        logger.info(f"Risk: Target={self.profit_target} | StopLoss={self.stop_loss} | TrailStart=₹{self.trail_start_rs} | TrailGap=₹{self.trail_gap_rs}")

        # Wait for start time
        while True:
            exit_if_market_closed()
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
        if not self.enter_straddle(initial_atm):
            logger.critical("Initial straddle entry failed. Exiting.")
            self.save_state(spot, 0, 0, 0, status="STOPPED")
            return

        # Main Monitoring Loop
        while True:
            exit_if_market_closed()
            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request received during strategy run. Liquidation initiated.")
                self.exit_all_positions("UI Graceful Stop")
                self.save_state(spot, 0, 0, self.realized_pnl, status="STOPPED")
                return

            ce_ltp, pe_ltp, spot = self.fetch_ltps()
            if ce_ltp <= 0 or pe_ltp <= 0 or spot <= 0:
                time.sleep(1)
                continue

            total_pnl = self._calculate_pnl(ce_ltp, pe_ltp)
            self.save_state(spot, ce_ltp, pe_ltp, total_pnl, status="RUNNING")

            now_str = datetime.now().strftime("%H:%M")
            logger.info(f"NIFTY: {spot:.2f} | Straddle {self.current_atm_strike} [Bounds: {self.lower_bound:.1f} - {self.upper_bound:.1f}] | CE: {ce_ltp:.2f} | PE: {pe_ltp:.2f} | Rolls: {self.roll_count}/{self.max_rolls} | PnL: ₹{total_pnl:+.0f}")

            # 1. EOD Exit Check
            if now_str >= self.eod_time:
                self.exit_all_positions(f"Intraday EOD Time Reached ({self.eod_time})")
                self.save_state(spot, ce_ltp, pe_ltp, total_pnl, status="STOPPED")
                logger.info("Strategy finished for the day.")
                return

            # 2. Profit Target Check
            if self.profit_target and total_pnl >= self.profit_target:
                self.exit_all_positions(f"Target Hit (+₹{total_pnl:.0f} >= ₹{self.profit_target:.0f})")
                self.save_state(spot, ce_ltp, pe_ltp, total_pnl, status="STOPPED")
                return

            # 3. Stop Loss Check
            if self.stop_loss and total_pnl <= self.stop_loss:
                self.exit_all_positions(f"Stop Loss Hit (₹{total_pnl:.0f} <= ₹{self.stop_loss:.0f})")
                self.save_state(spot, ce_ltp, pe_ltp, total_pnl, status="STOPPED")
                return

            # 4. Trailing SL Check
            if total_pnl > self.best_pnl:
                self.best_pnl = total_pnl
            if self.trail_start_rs > 0 and self.best_pnl >= self.trail_start_rs:
                if not self.trail_active:
                    self.trail_active = True
                    logger.info(f"Trailing SL Activated at Profit ₹{total_pnl:.0f}! Trail gap: ₹{self.trail_gap_rs:.0f}")

                trail_exit_threshold = self.best_pnl - self.trail_gap_rs
                if total_pnl <= trail_exit_threshold:
                    self.exit_all_positions(f"Trailing Stop Loss Hit (PnL ₹{total_pnl:.0f} <= Trail Exit ₹{trail_exit_threshold:.0f})")
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
    parser.add_argument("--roll-buffer", type=float, default=35.0, help="Custom ATM shift buffer in points (e.g., 35.0)")
    parser.add_argument("--max-rolls", type=int, default=5, help="Maximum number of rolls allowed per day")
    parser.add_argument("--roll-cooldown", type=int, default=60, help="Minimum cooldown between rolls in seconds")
    parser.add_argument("--profit-target", type=str, default="4000", help="Profit target in INR or percentage (e.g. 4000 or 50%%)")
    parser.add_argument("--stop-loss", type=str, default="4000", help="Stop loss in INR or percentage (e.g. 4000 or 50%%)")
    parser.add_argument("--start-time", type=str, default="09:20", help="Strategy start time (HH:MM)")
    parser.add_argument("--eod-time", type=str, default="15:15", help="Intraday auto-exit time (HH:MM)")
    parser.add_argument("--trail-start-rs", type=float, default=500.0, help="MTM profit level to activate trailing SL")
    parser.add_argument("--trail-gap-rs", type=float, default=300.0, help="Trailing SL gap in INR")
    parser.add_argument("--instance-id", type=str, default=None, help="Optional instance identifier for multi-running")

    args = parser.parse_args()

    is_dry_run = not args.live
    pt_val, pt_is_pct = parse_target_spec(args.profit_target)
    sl_val, sl_is_pct = parse_target_spec(args.stop_loss)

    state_key = "nifty_rolling_straddle"
    if args.instance_id:
        state_key = f"{state_key}_{args.instance_id}"

    strategy = RollingStraddleStrategy(
        dry_run=is_dry_run,
        initial_lots=args.lots,
        roll_buffer=args.roll_buffer,
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
        state_key=state_key
    )

    strategy.run()

if __name__ == "__main__":
    main()
