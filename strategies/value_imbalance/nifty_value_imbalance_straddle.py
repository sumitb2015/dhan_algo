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

# Setup Logging
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
debug_dir = os.path.join(project_root, "debug")
log_dir = os.path.join(debug_dir, "logs", "straddle")
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

class ValueImbalanceStrategy:
    def __init__(self, dry_run=True, initial_lots=1, max_lots=4,
                 threshold_lot=25.0, threshold_strike=40.0, target_rebalance=5.0,
                 entry_balance_threshold=15.0,
                 profit_target=4000.0, profit_target_is_pct=False,
                 stop_loss=4000.0, stop_loss_is_pct=False, start_time="09:20",
                 trail_start_pct=5.0, trail_gap_pts=15.0,
                 state_key="nifty_value_imbalance_straddle"):
        self.state_key = state_key
        self.dry_run = dry_run
        self.initial_lots = initial_lots
        self.max_lots = max_lots
        self.threshold_lot = threshold_lot
        self.threshold_strike = threshold_strike
        self.target_rebalance = target_rebalance
        self.entry_balance_threshold = entry_balance_threshold
        # Target/SL may be an absolute INR amount or a percentage of entry premium
        # collected (resolved once the position is actually entered, see below).
        self.target_is_pct = profit_target_is_pct
        self.stop_is_pct = stop_loss_is_pct
        self.target_pct = profit_target if profit_target_is_pct else None
        self.stop_pct = stop_loss if stop_loss_is_pct else None
        self.profit_target = None if profit_target_is_pct else profit_target
        self.stop_loss = None if stop_loss_is_pct else -abs(stop_loss)  # Ensure it's negative
        self.start_time = start_time
        self.trail_start_pct = trail_start_pct
        self.trail_gap_pts = trail_gap_pts

        self.dhan = get_dhan_client()
        if not self.dhan:
            raise Exception("Failed to connect to Dhan.")
        self.helper = DhanHelper(self.dhan)
        
        # Start WebSocket for Nifty Spot (Essential for reliable LTP)
        logger.info("Starting WebSocket for NIFTY Index...")
        self.helper.start_websocket([("IDX_I", "13", 15)])
        time.sleep(2) # Wait for initial tick
        
        # Fetch and log previous day OHLC levels via library method
        _levels = self.helper.get_prev_day_levels("NIFTY")
        self.prev_day_high  = _levels["high"]  if _levels else None
        self.prev_day_low   = _levels["low"]   if _levels else None
        self.prev_day_close = _levels["close"] if _levels else None
        
        self.nifty_lot_size = self.helper.get_lot_size("NIFTY")
        
        # State
        self.ce_strike = None
        self.pe_strike = None
        self.initial_ce_strike = None
        self.ce_lots = initial_lots
        self.pe_lots = initial_lots
        self.ce_id = None
        self.pe_id = None
        self.ce_symbol_name = None # Keep for logging/orders
        self.pe_symbol_name = None
        self.ce_avg_price = 0.0
        self.pe_avg_price = 0.0
        self.entry_diff_pct = 0.0
        self.realized_pnl = 0.0
        self.adjustment_count = 0
        self.expiry = None
        
        # Trailing Stop Loss State
        self.trail_active = False
        self.entry_combined_pts = 0.0
        self.best_combined_pts = 0.0

        # Session Control
        self.last_adjustment_time = None
        self.consecutive_chain_failures = 0

        self.NIFTY_SPOT_SID = 13  # Nifty 50 index (IDX_I) for spot price

    def sleep_cooldown(self, seconds):
        """Shutdown-aware sleep for cooldowns and delays."""
        for _ in range(seconds):
            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request during cooldown sleep. Exiting.")
                self.save_state(0, 0, 0, 0, status="STOPPED")
                sys.exit(0)
            time.sleep(1)

    def fetch_ltps(self):
        """Batched CE/PE/spot LTP fetch — at most one REST call when the WebSocket misses."""
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
            "strategy": "nifty_value_imbalance_straddle",
            "status": status,
            "dry_run": self.dry_run,
            "lots": self.initial_lots,
            "max_lots": self.max_lots,
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
            "adjustments": self.adjustment_count,
            "profit_target": self.profit_target,
            "stop_loss": self.stop_loss,
            "trail_active": self.trail_active,
            "trail_start_pct": self.trail_start_pct,
            "trail_gap_pts": self.trail_gap_pts,
            "entry_combined_pts": self.entry_combined_pts,
            "best_combined_pts": self.best_combined_pts,
            "trail_exit_combined": round(self.best_combined_pts + self.trail_gap_pts, 2) if self.trail_active else None,
        }
        save_strategy_state(self.state_key, state_dict)

    def get_execution_price(self, order_id: str, fallback_price: float) -> float:
        """Wait for fill and get the average execution price, or return fallback."""
        if not order_id:
            return fallback_price
        # Wait for fill (up to 5 seconds for immediate execution on market order)
        if self.helper.wait_for_fill(order_id, timeout=5):
            order_details = self.helper.get_order_by_id(order_id)
            if order_details:
                fill_price = float(order_details.get('averageTradedPrice', 0.0) or order_details.get('avgFilledPrice', 0.0) or order_details.get('price', 0.0))
                if fill_price > 0:
                    logger.info(f"Order {order_id} execution price confirmed: {fill_price:.2f}")
                    return fill_price
        return fallback_price

    def is_quote_invalid(self, q):
        if not q: return True
        if isinstance(q, dict) and 'CONTRACT_INFO' in q:
            return float(q.get('last_price', 0) or q.get('LTP', 0)) == 0
        return False

    def _extract_quote_fields(self, quote, strike, option_type):
        """Extract needed fields from either helper.option() or chain fallback format."""
        if not quote:
            return None, None, None, None, None
        
        # Format 1: helper.option() result (standard library format)
        if isinstance(quote, dict) and 'CONTRACT_INFO' in quote:
            ci = quote['CONTRACT_INFO']
            return (
                int(ci['SECURITY_ID']),
                float(quote.get('last_price', 0.0) or quote.get('LTP', 0.0)),
                ci.get('SM_EXPIRY_DATE') or self.expiry,
                int(ci.get('LOT_SIZE', self.nifty_lot_size)),
                ci.get('SYMBOL_NAME', f"NIFTY-{self.expiry}-{strike}-{option_type}")
            )
        
        # Format 2: Flat chain format (Series.to_dict() or construction)
        ot = option_type.lower()
        sid = quote.get(f'{ot}_security_id') or quote.get('security_id')
        price = quote.get(f'{ot}_last_price') or quote.get('last_price', 0.0)
        
        if sid:
            # Try to resolve lot size from master list dynamically
            lot_size = self.nifty_lot_size
            try:
                sec = self.helper.get_security_id(symbol=str(int(sid)))
                if sec:
                    lot_size = int(sec.get('LOT_SIZE', self.nifty_lot_size))
            except:
                pass
            return (
                int(sid),
                float(price),
                self.expiry,
                lot_size,
                f"NIFTY-{self.expiry}-{strike}-{option_type}"
            )
            
        return None, None, None, None, None

    def _calculate_pnl(self, ce_ltp, pe_ltp):
        # PnL = (Entry - Current) * Qty (since we are selling)
        # self.realized_pnl contains profits from closed legs in previous adjustments
        ce_unrealized = (self.ce_avg_price - ce_ltp) * (self.ce_lots * self.nifty_lot_size)
        pe_unrealized = (self.pe_avg_price - pe_ltp) * (self.pe_lots * self.nifty_lot_size)
        
        return self.realized_pnl + ce_unrealized + pe_unrealized

    def get_pnl(self):
        # Kept for backward compatibility or external calls, but optimized internally
        ce_ltp = self.helper.get_ltp(str(self.ce_id), exchange="NSE_FNO", instrument="OPTIDX")
        pe_ltp = self.helper.get_ltp(str(self.pe_id), exchange="NSE_FNO", instrument="OPTIDX")
        
        if ce_ltp <= 0 or pe_ltp <= 0:
            return self.realized_pnl
            
        return self._calculate_pnl(ce_ltp, pe_ltp)

    def get_traded_values(self):
        ce_ltp = self.helper.get_ltp(str(self.ce_id), exchange="NSE_FNO", instrument="OPTIDX")
        pe_ltp = self.helper.get_ltp(str(self.pe_id), exchange="NSE_FNO", instrument="OPTIDX")
        
        if ce_ltp <= 0 or pe_ltp <= 0:
            return None, None
            
        ce_value = self.ce_lots * ce_ltp
        pe_value = self.pe_lots * pe_ltp
        
        return ce_value, pe_value

    def log_state(self, nifty_spot, ce_ltp, pe_ltp, ce_val, pe_val, diff_pct, total_pnl):
        # Determine active threshold
        if self.ce_lots == self.max_lots or self.pe_lots == self.max_lots:
            active_thresh = self.threshold_strike + self.entry_diff_pct
            thresh_label = "Strike"
        else:
            active_thresh = self.threshold_lot + self.entry_diff_pct
            thresh_label = "Lot"

        logger.info(f"Straddle: {self.ce_strike}CE / {self.pe_strike}PE | CE: {ce_ltp:.2f} ({self.ce_lots}L) Val: {ce_val:.2f} | PE: {pe_ltp:.2f} ({self.pe_lots}L) Val: {pe_val:.2f} | Diff: {diff_pct:.2f}% (Thresh: {active_thresh:.2f}% {thresh_label}) | Adj: {self.adjustment_count} | PnL: {total_pnl:+.0f} (Real: {self.realized_pnl:+.0f})")

    def update_baseline_imbalance(self):
        """Update baseline imbalance (entry_diff_pct) after an adjustment using new LTPs."""
        time.sleep(1) # Let the live feed stabilize
        ce_ltp, pe_ltp, _ = self.fetch_ltps()
        if ce_ltp > 0 and pe_ltp > 0:
            ce_val = self.ce_lots * ce_ltp
            pe_val = self.pe_lots * pe_ltp
            max_val = max(ce_val, pe_val)
            self.entry_diff_pct = abs(ce_val - pe_val) / max_val * 100 if max_val > 0 else 0.0
        else:
            self.entry_diff_pct = 0.0
        logger.info(f"Post-Adjustment baseline imbalance updated to: {self.entry_diff_pct:.2f}%")

    def exit_all_positions(self, reason):
        logger.warning(f"!!! EXITING ALL POSITIONS: {reason} !!!")
        if not self.dry_run:
            if self.ce_id:
                try:
                    net_qty = self.helper.get_net_quantity(str(self.ce_id))
                    if net_qty < 0:
                        qty_to_buy = abs(net_qty)
                        ce_exit_id = self.helper.buy(str(self.ce_id), qty_to_buy)
                        if not ce_exit_id:
                            logger.critical(f"CRITICAL ERROR: Emergency exit order failed for CE (ID: {self.ce_id})!")
                        else:
                            logger.info(f"CE Emergency exit order placed for {qty_to_buy} qty: {ce_exit_id}")
                    else:
                        logger.info(f"CE position already flat or long (Net Qty: {net_qty}). Skipping exit order.")
                except Exception as e:
                    logger.error(f"Exit CE Error: {e}")
            if self.pe_id:
                try:
                    net_qty = self.helper.get_net_quantity(str(self.pe_id))
                    if net_qty < 0:
                        qty_to_buy = abs(net_qty)
                        pe_exit_id = self.helper.buy(str(self.pe_id), qty_to_buy)
                        if not pe_exit_id:
                            logger.critical(f"CRITICAL ERROR: Emergency exit order failed for PE (ID: {self.pe_id})!")
                        else:
                            logger.info(f"PE Emergency exit order placed for {qty_to_buy} qty: {pe_exit_id}")
                    else:
                        logger.info(f"PE position already flat or long (Net Qty: {net_qty}). Skipping exit order.")
                except Exception as e:
                    logger.error(f"Exit PE Error: {e}")
        else:
            logger.info(f"[DRY RUN] Simulating Exit of all positions.")

    def reset_session(self):
        """Resets session-specific variables for a new entry cycle."""
        if self.ce_id and self.pe_id:
            logger.info(f"Unsubscribing from old strikes: {self.ce_id}, {self.pe_id}")
            try:
                self.helper.unsubscribe_instruments([
                    ("NSE_FNO", str(self.ce_id), 15),
                    ("NSE_FNO", str(self.pe_id), 15)
                ])
            except: pass

        self.ce_strike = None
        self.pe_strike = None
        self.initial_ce_strike = None
        self.ce_lots = self.initial_lots
        self.pe_lots = self.initial_lots
        self.ce_id = None
        self.pe_id = None
        self.ce_symbol_name = None
        self.pe_symbol_name = None
        self.ce_avg_price = 0.0
        self.pe_avg_price = 0.0
        self.entry_diff_pct = 0.0
        self.adjustment_count = 0
        self.consecutive_chain_failures = 0
        self.trail_active = False
        self.entry_combined_pts = 0.0
        self.best_combined_pts = 0.0
        self.last_adjustment_time = None
        logger.info("Session state reset for new cycle.")

    def run(self):
        exit_if_market_closed(self.helper, self.dry_run)
        logger.info(f"Starting Nifty Value Imbalance Strategy (Dry Run: {self.dry_run} | Start Time: {self.start_time})")
        
        while True:
            # Check shutdown trigger
            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request in outer loop.")
                self.save_state(0, 0, 0, 0, status="STOPPED")
                sys.exit(0)
            self.save_state(0, 0, 0, 0, status="INITIALIZING")

            # Wait for market open if closed (EOD is 15:17)
            self.helper.wait_for_market_open(self.dry_run, start_time=self.start_time, eod_time="15:17", shutdown_check=lambda: check_shutdown_trigger(self.state_key))
            
            # 1. Initialization / Re-initialization
            self.reset_session()
            
            self.expiry = self.helper.get_nearest_expiry("NIFTY")
            chain_df = self.helper.get_option_chain_df("NIFTY", self.expiry) if self.expiry else pd.DataFrame()

            nifty_spot = self.helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")
            if nifty_spot == 0 and not chain_df.empty:
                 logger.warning("Direct LTP failed for NIFTY Index. Falling back to Option Chain...")
                 nifty_spot = chain_df.attrs.get('underlying_ltp', 0)
                  
            if nifty_spot == 0 and self.prev_day_close and self.prev_day_close > 0:
                 nifty_spot = self.prev_day_close
                 logger.warning(f"Fallback to previous day close spot price: {nifty_spot:.2f} for dry-run simulation.")

            if nifty_spot == 0:
                 logger.error("Could not fetch Nifty Spot. Retrying in 30s...")
                 time.sleep(30)
                 continue

            self.ce_strike = int(round(nifty_spot / 50) * 50)
            self.pe_strike = self.ce_strike
            self.initial_ce_strike = self.ce_strike
            
            # Check shutdown trigger before option quote fetches
            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request before option quote fetches.")
                self.save_state(nifty_spot, 0, 0, 0.0, status="STOPPED")
                sys.exit(0)

            ce_quote = self.helper.option("NIFTY", self.ce_strike, "CE")
            pe_quote = self.helper.option("NIFTY", self.pe_strike, "PE")
                
            # Fallback to chain_df if initial quotes fail or lack price
            if (self.is_quote_invalid(ce_quote) or self.is_quote_invalid(pe_quote)) and not chain_df.empty:
                logger.warning("Initial helper.option() failed or returned empty data. Falling back to option chain...")
                if self.is_quote_invalid(ce_quote) and float(self.ce_strike) in chain_df.index:
                    ce_quote = chain_df.loc[float(self.ce_strike)].to_dict()
                    logger.info(f"CE Fallback: {ce_quote.get('ce_last_price')} (ID: {int(ce_quote.get('ce_security_id', 0))})")
                
                if self.is_quote_invalid(pe_quote) and float(self.pe_strike) in chain_df.index:
                    pe_quote = chain_df.loc[float(self.pe_strike)].to_dict()
                    logger.info(f"PE Fallback: {pe_quote.get('pe_last_price')} (ID: {int(pe_quote.get('pe_security_id', 0))})")

            # Extract fields from quotes
            self.ce_id, self.ce_avg_price, self.expiry, self.nifty_lot_size, self.ce_symbol_name = \
                self._extract_quote_fields(ce_quote, self.ce_strike, "CE")

            self.pe_id, self.pe_avg_price, _, _, self.pe_symbol_name = \
                self._extract_quote_fields(pe_quote, self.pe_strike, "PE")

            if not self.ce_id or not self.pe_id:
                logger.error(f"Initial quotes failed for {self.ce_strike} CE/PE. Waiting 1m.")
                time.sleep(60)
                continue
            
            logger.info(f"New Cycle: {self.ce_strike} CE/PE | Lot Size: {self.nifty_lot_size} | Expiry: {self.expiry}")
            
            # Check shutdown trigger before websocket subscription
            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request before websocket subscription.")
                self.save_state(nifty_spot, self.ce_avg_price, self.pe_avg_price, 0.0, status="STOPPED")
                sys.exit(0)

            # Subscribe to WebSocket for real-time updates
            logger.info(f"Subscribing to WebSocket for {self.ce_symbol_name} (ID: {self.ce_id}) and {self.pe_symbol_name} (ID: {self.pe_id})")
            try:
                self.helper.subscribe_instruments([
                    ("NSE_FNO", str(self.ce_id), 15),
                    ("NSE_FNO", str(self.pe_id), 15)
                ])
                time.sleep(2) # Wait for initial ticks to arrive in live_data
            except Exception as e:
                logger.error(f"Failed to subscribe to WebSocket: {e}")
            
            # Wait for premiums to balance
            logger.info(f"Waiting for premiums to balance at ATM {self.ce_strike}...")
            balanced = False
            while True:
                # One batched fetch per iteration covers CE, PE and spot
                ce_price, pe_price, spot = self.fetch_ltps()

                # Check shutdown trigger
                if check_shutdown_trigger(self.state_key):
                    logger.info("UI Shutdown Request during balanced entry wait.")
                    self.save_state(nifty_spot, ce_price, pe_price, 0.0, status="STOPPED")
                    self.reset_session()
                    sys.exit(0)

                # Save current balancing state
                self.save_state(nifty_spot, ce_price, pe_price, 0.0, status="BALANCING")

                # Check 15:17 even during waiting
                if datetime.now().strftime("%H:%M") >= "15:17":
                    logger.info("Market nearing close. Waiting for next cycle...")
                    break

                # Check if ATM has changed while waiting
                if spot > 0:
                    current_atm = int(round(spot / 50) * 50)
                    if current_atm != self.ce_strike:
                        logger.info(f"ATM strike shifted from {self.ce_strike} to {current_atm} (Spot: {spot:.2f}). Restarting entry cycle...")
                        break


                if ce_price > 0 and pe_price > 0:
                    max_prem = max(ce_price, pe_price)
                    diff_pct = abs(ce_price - pe_price) / max_prem * 100
                    logger.info(f"Waiting for Balance... CE: {ce_price:.2f} | PE: {pe_price:.2f} | Diff: {diff_pct:.1f}% (Target: < {self.entry_balance_threshold}%)")
                    if diff_pct < self.entry_balance_threshold:
                        self.ce_avg_price = ce_price
                        self.pe_avg_price = pe_price
                        self.entry_diff_pct = diff_pct
                        logger.info(f"Balanced! Entry Diff: {self.entry_diff_pct:.2f}%. Entering.")
                        balanced = True
                        break
                time.sleep(5)

            if not balanced:
                continue

            if not self.dry_run:
                ce_oid = self.helper.sell(str(self.ce_id), self.initial_lots * self.nifty_lot_size)
                pe_oid = self.helper.sell(str(self.pe_id), self.initial_lots * self.nifty_lot_size)
                if not ce_oid or not pe_oid:
                    logger.error("Entry Failed. Rolling back any successful order to prevent orphaned legs.")
                    if ce_oid and not pe_oid:
                        logger.warning("Rolling back CE order...")
                        try: self.helper.buy(str(self.ce_id), self.initial_lots * self.nifty_lot_size)
                        except Exception as rollback_err: logger.error(f"CE Rollback exception: {rollback_err}")
                    elif pe_oid and not ce_oid:
                        logger.warning("Rolling back PE order...")
                        try: self.helper.buy(str(self.pe_id), self.initial_lots * self.nifty_lot_size)
                        except Exception as rollback_err: logger.error(f"PE Rollback exception: {rollback_err}")
                    continue
                # Confirm execution prices to account for slippage
                self.ce_avg_price = self.get_execution_price(ce_oid, self.ce_avg_price)
                self.pe_avg_price = self.get_execution_price(pe_oid, self.pe_avg_price)
            else:
                logger.info(f"[DRY RUN] Simulating Entry: {self.ce_strike} CE/PE")

            self.entry_combined_pts = self.ce_avg_price + self.pe_avg_price
            logger.info(f"Trail SL reference: entry_combined={self.entry_combined_pts:.2f} pts (CE={self.ce_avg_price:.2f} + PE={self.pe_avg_price:.2f})")

            if self.target_is_pct or self.stop_is_pct:
                entry_value = (self.ce_avg_price * self.ce_lots + self.pe_avg_price * self.pe_lots) * self.nifty_lot_size
                if self.target_is_pct:
                    self.profit_target = entry_value * self.target_pct / 100.0
                    logger.info(f"Resolved profit target: {self.target_pct}% of entry premium INR{entry_value:.0f} = INR{self.profit_target:.0f}")
                if self.stop_is_pct:
                    self.stop_loss = -abs(entry_value * self.stop_pct / 100.0)
                    logger.info(f"Resolved stop loss: {self.stop_pct}% of entry premium INR{entry_value:.0f} = -INR{abs(self.stop_loss):.0f}")

            last_log_time = time.time()
            cycle_active = True

            # --- MAIN MONITORING LOOP ---
            while cycle_active:
                time.sleep(1)
                
                # Check shutdown trigger first
                if check_shutdown_trigger(self.state_key):
                    c_ltp, p_ltp, curr_nifty = self.fetch_ltps()
                    ce_ltp_val = c_ltp if c_ltp > 0 else self.ce_avg_price
                    pe_ltp_val = p_ltp if p_ltp > 0 else self.pe_avg_price
                    total_pnl = self._calculate_pnl(ce_ltp_val, pe_ltp_val)
                    if curr_nifty <= 0: curr_nifty = nifty_spot
                    self.exit_all_positions("UI Shutdown Request")
                    self.save_state(curr_nifty, ce_ltp_val, pe_ltp_val, total_pnl, status="STOPPED")
                    sys.exit(0)

                now = datetime.now()
                current_time_str = now.strftime("%H:%M")
                current_bar = now.strftime("%Y-%m-%d %H:%M")

                if current_time_str >= "15:17":
                    self.exit_all_positions(f"Intraday Auto-Exit at {current_time_str}")
                    break

                if not self.helper.is_market_open() and not self.dry_run:
                    self.exit_all_positions("Market Closed")
                    break
                    
                # One batched fetch per iteration covers CE, PE and spot
                ce_ltp, pe_ltp, curr_nifty = self.fetch_ltps()
                if ce_ltp <= 0 or pe_ltp <= 0: continue

                total_pnl = self._calculate_pnl(ce_ltp, pe_ltp)

                if curr_nifty == 0: curr_nifty = nifty_spot # Fallback to start spot

                # Save current state
                self.save_state(curr_nifty, ce_ltp, pe_ltp, total_pnl, status="RUNNING")

                # --- Phase 5: Straddle Shift (100pt Move) ---
                current_atm = int(round(curr_nifty / 50) * 50)
                if abs(current_atm - self.initial_ce_strike) >= 100:
                    self.exit_all_positions(
                        f"Phase 5: Straddle Shift! Current ATM strike {current_atm} shifted 100pts or more "
                        f"from original strike {self.initial_ce_strike} (Spot: {curr_nifty:.2f})"
                    )
                    logger.info("Waiting 5 minutes before re-centering straddle at new ATM...")
                    self.sleep_cooldown(300)
                    cycle_active = False
                    break
                
                # --- Trailing Stop Loss Logic (combined-premium points) ---
                if self.entry_combined_pts > 0:
                    current_combined_pts = ce_ltp + pe_ltp
                    profit_pts = self.entry_combined_pts - current_combined_pts
                    trail_trigger = self.trail_start_pct / 100.0 * self.entry_combined_pts

                    if not self.trail_active and profit_pts >= trail_trigger:
                        self.trail_active = True
                        self.best_combined_pts = current_combined_pts
                        logger.info(
                            f"Trail SL activated: combined={current_combined_pts:.2f}, "
                            f"entry={self.entry_combined_pts:.2f}, trigger={trail_trigger:.2f}pts"
                        )

                    if self.trail_active:
                        if current_combined_pts < self.best_combined_pts:
                            self.best_combined_pts = current_combined_pts
                        trail_exit = self.best_combined_pts + self.trail_gap_pts
                        if current_combined_pts > trail_exit:
                            self.exit_all_positions(
                                f"Trailing SL Hit! Combined: {current_combined_pts:.2f} > exit: {trail_exit:.2f} "
                                f"(best: {self.best_combined_pts:.2f})"
                            )
                            logger.info("Waiting 5 minutes before next re-entry cycle...")
                            self.sleep_cooldown(300)
                            cycle_active = False
                            break
                
                # --- Hard Targets ---
                if total_pnl >= self.profit_target:
                    self.exit_all_positions(f"Profit Target Reached: {total_pnl:.2f}")
                    if not self.helper.wait_for_next_day_market_open(self.dry_run, shutdown_check=lambda: check_shutdown_trigger(self.state_key)):
                        self.save_state(0, 0, 0, 0, status="STOPPED")
                        sys.exit(0)
                    cycle_active = False
                    break
                if total_pnl <= self.stop_loss:
                    self.exit_all_positions(f"Global Stop Loss Hit: {total_pnl:.2f}")
                    if not self.helper.wait_for_next_day_market_open(self.dry_run, shutdown_check=lambda: check_shutdown_trigger(self.state_key)):
                        self.save_state(0, 0, 0, 0, status="STOPPED")
                        sys.exit(0)
                    cycle_active = False
                    break

                ce_val = self.ce_lots * ce_ltp
                pe_val = self.pe_lots * pe_ltp
                max_val = max(ce_val, pe_val)
                diff_pct = abs(ce_val - pe_val) / max_val * 100
                
                if time.time() - last_log_time >= 2:
                    self.log_state(curr_nifty or nifty_spot, ce_ltp, pe_ltp, ce_val, pe_val, diff_pct, total_pnl)
                    last_log_time = time.time()

                if self.last_adjustment_time == current_bar: continue

                winner = "CE" if ce_val < pe_val else "PE"
                loser = "PE" if ce_val < pe_val else "CE"
                winner_lots = self.ce_lots if winner == "CE" else self.pe_lots
                loser_lots = self.pe_lots if winner == "CE" else self.ce_lots

                # Phase 3 & 4: Adjustments
                active_thresh = (self.threshold_strike if (self.ce_lots == self.max_lots or self.pe_lots == self.max_lots) else self.threshold_lot) + self.entry_diff_pct
                if diff_pct > active_thresh:
                    if winner_lots < self.max_lots:
                        logger.info(f"!!! Lot Addition !!! Diff: {diff_pct:.2f}%")
                        symbol_id = str(self.ce_id) if winner == "CE" else str(self.pe_id)
                        new_price = self.helper.get_ltp(symbol_id, exchange="NSE_FNO", instrument="OPTIDX")
                        if new_price > 0:
                            oid = None
                            if not self.dry_run:
                                oid = self.helper.sell(symbol_id, self.nifty_lot_size)
                                if not oid:
                                    logger.error(f"Failed to place sell order for lot addition ({winner}). Skipping adjustment.")
                                    continue
                            # Get actual execution price if live, else use new_price
                            exec_price = self.get_execution_price(oid, new_price) if oid else new_price
                            
                            if winner == "CE":
                                self.ce_avg_price = ((self.ce_avg_price * winner_lots) + exec_price) / (winner_lots + 1)
                                self.ce_lots += 1
                            else:
                                self.pe_avg_price = ((self.pe_avg_price * winner_lots) + exec_price) / (winner_lots + 1)
                                self.pe_lots += 1
                            self.adjustment_count += 1
                            self.last_adjustment_time = current_bar
                            self.update_baseline_imbalance()
                        continue
                    else:
                        logger.info(f"!!! Strike Adjustment !!! Diff: {diff_pct:.2f}%")
                        chain_df = self.helper.get_option_chain_df("NIFTY", self.expiry)
                        if chain_df.empty:
                            self.consecutive_chain_failures += 1
                            logger.warning(f"Option Chain empty / failed. Consecutive failures: {self.consecutive_chain_failures}")
                            if self.consecutive_chain_failures >= 10:
                                self.exit_all_positions("Emergency Exit: 10 consecutive option chain failures during rebalance.")
                                cycle_active = False
                                break
                            continue
                        else:
                            self.consecutive_chain_failures = 0
                        winner_val = ce_val if loser == "PE" else pe_val
                        new_strike, new_price = self.find_rebalance_strike(loser, winner_val, loser_lots, chain_df)
                        if not new_strike: continue
                        
                        # Prevent strike inversion during rebalance - exit cycle
                        if (loser == "CE" and new_strike <= self.pe_strike) or (loser == "PE" and new_strike >= self.ce_strike):
                            self.exit_all_positions(
                                f"Blocked strike inversion adjustment: new {loser} strike {new_strike} "
                                f"would cross/equal opposite leg. Exiting cycle."
                            )
                            logger.info("Waiting 5 minutes before restart...")
                            self.sleep_cooldown(300)
                            cycle_active = False
                            break
                        old_id = str(self.ce_id) if loser == "CE" else str(self.pe_id)
                        old_avg = self.ce_avg_price if loser == "CE" else self.pe_avg_price
                        exit_price = self.helper.get_ltp(old_id, exchange="NSE_FNO", instrument="OPTIDX")
                        if exit_price > 0:
                            buy_oid = None
                            if not self.dry_run:
                                buy_oid = self.helper.buy(old_id, loser_lots * self.nifty_lot_size)
                                if not buy_oid:
                                    logger.error(f"Failed to place buy-to-close order for old leg {old_id}. Aborting strike adjustment to prevent orphaned legs.")
                                    continue
                            # Get actual exit price if live
                            actual_exit_price = self.get_execution_price(buy_oid, exit_price) if buy_oid else exit_price
                            
                            realized = (old_avg - actual_exit_price) * (loser_lots * self.nifty_lot_size)
                            self.realized_pnl += realized
                            
                            new_quote = self.helper.option("NIFTY", new_strike, loser)
                            if self.is_quote_invalid(new_quote) and not chain_df.empty:
                                logger.warning(f"New quote fetch failed for adjustment strike {new_strike}. Falling back to option chain...")
                                if float(new_strike) in chain_df.index:
                                    new_quote = chain_df.loc[float(new_strike)].to_dict()

                            new_id, price_from_quote, _, lot_size, symbol_name = \
                                self._extract_quote_fields(new_quote, new_strike, loser)

                            if new_id:
                                self.nifty_lot_size = lot_size
                                new_price = price_from_quote if price_from_quote > 0 else new_price
                                
                                # Update WebSocket subscription
                                logger.info(f"Updating WebSocket: Unsubscribing {old_id}, Subscribing {new_id}")
                                try:
                                    self.helper.unsubscribe_instruments([("NSE_FNO", str(old_id), 15)])
                                    self.helper.subscribe_instruments([("NSE_FNO", str(new_id), 15)])
                                except Exception as ws_err:
                                    logger.error(f"WebSocket update failed: {ws_err}")
      
                                sell_oid = None
                                if not self.dry_run:
                                    sell_oid = self.helper.sell(str(new_id), loser_lots * self.nifty_lot_size)
                                # Get actual entry price for the new strike
                                actual_entry_price = self.get_execution_price(sell_oid, new_price) if sell_oid else new_price
                                
                                if loser == "CE":
                                    self.ce_strike = new_strike
                                    self.ce_symbol_name = symbol_name
                                    self.ce_id = new_id
                                    self.ce_avg_price = actual_entry_price
                                else:
                                    self.pe_strike = new_strike
                                    self.pe_symbol_name = symbol_name
                                    self.pe_id = new_id
                                    self.pe_avg_price = actual_entry_price
                            self.adjustment_count += 1
                            self.last_adjustment_time = current_bar
                            self.update_baseline_imbalance()
                        continue


    def find_rebalance_strike(self, option_type, target_value, lots, chain_df):
        """
        Finds a strike for the given option_type (CE/PE) such that:
        lots * price is close to target_value.
        """
        prefix = option_type.lower()
        price_col = f"{prefix}_last_price"
        
        if price_col not in chain_df.columns:
            logger.error(f"Price column {price_col} not found in option chain.")
            return None, 0.0

        # Target Price per lot
        target_price = target_value / lots
        
        # Filter valid prices
        valid_df = chain_df[chain_df[price_col] > 0].copy()
        if valid_df.empty:
            return None, 0.0
            
        valid_df['diff'] = abs(valid_df[price_col] - target_price)
        
        # Sort by smallest difference
        best_row = valid_df.sort_values('diff').iloc[0]
        
        best_strike = best_row.name
        best_price = best_row[price_col]
        
        logger.info(f"Rebalance: Target Price {target_price:.2f} | Found Strike {best_strike} @ {best_price:.2f}")
        return int(best_strike), best_price

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Nifty Value Imbalance Straddle Strategy",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run, 1 lot, default INR 4000 profit/loss targets
  python strategies/nifty_value_imbalance.py

  # Live run, 2 lots, default targets
  python strategies/nifty_value_imbalance.py --live --lots 2

  # Live run, custom profit and stop loss targets
  python strategies/nifty_value_imbalance.py --live --lots 1 --target-profit 5000 --stop-loss 3000
""")

    # Run mode
    parser.add_argument("--live", action="store_true", default=False,
                        help="Run in LIVE mode (default: dry run)")

    # Position sizing
    parser.add_argument("--lots", type=int, default=1, metavar="N",
                        help="Initial lots per leg (default: 1)")
    parser.add_argument("--max-lots", type=int, default=4, metavar="N",
                        help="Maximum lots per leg before triggering a strike shift (default: 4)")

    # Customizable Start Time
    parser.add_argument("--start-time", type=str, default="09:20", metavar="TIME",
                        help="Market start monitoring time (HH:MM IST, default: 09:20)")

    # Risk targets
    parser.add_argument("--target-profit", type=str, default="4000", metavar="AMT",
                        help="Global profit target in INR, or a percentage of entry premium collected "
                             "e.g. '20%%' (default: 4000)")
    parser.add_argument("--stop-loss", type=str, default="4000", metavar="AMT",
                        help="Global stop loss in INR, or a percentage of entry premium collected "
                             "e.g. '20%%' (default: 4000)")

    # Entry criteria
    parser.add_argument("--entry-balance-threshold", type=float, default=15.0, metavar="PCT",
                        help="Initial balance threshold percentage for entry (default: 15.0)")
    parser.add_argument("--trail-start-pct", type=float, default=5.0,
                        help="Activate trailing SL when profit reaches this %% of entry combined premium (default: 5.0)")
    parser.add_argument("--trail-gap-pts", type=float, default=15.0,
                        help="Exit if combined premium rises this many pts above its best level (default: 15.0)")

    parser.add_argument("--instance-id", type=str, default="", metavar="ID",
                        help="Suffix for debug/state files to run a second concurrent copy of this strategy")

    args = parser.parse_args()
    STATE_KEY = f"nifty_value_imbalance_straddle_{args.instance_id}" if args.instance_id else "nifty_value_imbalance_straddle"

    try:
        target_val, target_is_pct = parse_target_spec(args.target_profit)
        stop_val, stop_is_pct = parse_target_spec(args.stop_loss)
    except ValueError as e:
        logger.error(f"[CONFIG ERROR] {e}")
        sys.exit(1)

    mode_label = "LIVE" if args.live else "DRY"
    stop_loss_val = abs(stop_val)

    target_label = f"{target_val:.0f}%" if target_is_pct else f"INR {target_val:.0f}"
    stop_label = f"-{stop_loss_val:.0f}%" if stop_is_pct else f"-INR {stop_loss_val:.0f}"
    logger.info(f"Config -> Mode: {mode_label} | Lots: {args.lots} | Start Time: {args.start_time} | "
                f"Entry Balance Threshold: {args.entry_balance_threshold:.1f}% | "
                f"Profit Target: {target_label} | Stop Loss: {stop_label}")

    strat = ValueImbalanceStrategy(
        dry_run=not args.live,
        initial_lots=args.lots,
        max_lots=args.max_lots,
        start_time=args.start_time,
        entry_balance_threshold=args.entry_balance_threshold,
        profit_target=target_val,
        profit_target_is_pct=target_is_pct,
        stop_loss=stop_loss_val,
        stop_loss_is_pct=stop_is_pct,
        trail_start_pct=args.trail_start_pct,
        trail_gap_pts=args.trail_gap_pts,
        state_key=STATE_KEY,
    )
    try:
        strat.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt detected. Gracefully exiting and squaring off all positions...")
        strat.exit_all_positions("KeyboardInterrupt / Manual Stop")
        sys.exit(0)
