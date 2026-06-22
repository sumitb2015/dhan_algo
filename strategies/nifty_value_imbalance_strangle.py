import time
import sys
import argparse
import os
import logging
import pandas as pd
from datetime import datetime

# Add parent directory to path to import login and lib
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Setup Logging
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
debug_dir = os.path.join(project_root, "debug")
os.makedirs(debug_dir, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(os.path.join(debug_dir, f"strangle_{datetime.now().strftime('%Y%m%d')}.log"))
    ]
)
logger = logging.getLogger(__name__)

class ValueImbalanceStrangle:
    def __init__(self, dry_run=True, initial_lots=1, max_lots=4, 
                 threshold_lot=25.0, threshold_strike=40.0,
                 profit_target=4000.0, stop_loss=4000.0,
                 strike_selection="distance", # "distance", "delta", or "premium"
                 ce_offset=200, pe_offset=200,
                 target_delta=0.20, target_premium=50.0,
                 start_time="09:20"):
        self.dry_run = dry_run
        self.initial_lots = initial_lots
        self.max_lots = max_lots
        self.threshold_lot = threshold_lot
        self.threshold_strike = threshold_strike
        self.profit_target = profit_target
        self.stop_loss = -abs(stop_loss) # Ensure it's negative
        self.start_time = start_time
        
        # Selection Params
        self.strike_selection = strike_selection
        self.ce_offset = ce_offset
        self.pe_offset = pe_offset
        self.target_delta = target_delta
        self.target_premium = target_premium
        
        self.dhan = get_dhan_client()
        if not self.dhan:
            raise Exception("Failed to connect to Dhan.")
        self.helper = DhanHelper(self.dhan)
        
        # Start WebSocket for Nifty Spot (Essential for reliable LTP)
        logger.info("Starting WebSocket for NIFTY Index...")
        self.helper.start_websocket([("IDX_I", "13", 15)])
        time.sleep(2) # Wait for initial tick
        
        self.nifty_lot_size = self.helper.get_lot_size("NIFTY")
        logger.info(f"Nifty Lot Size set to: {self.nifty_lot_size}")
        
        # Fetch and log previous day OHLC levels via library method
        _levels = self.helper.get_prev_day_levels("NIFTY")
        self.prev_day_high  = _levels["high"]  if _levels else None
        self.prev_day_low   = _levels["low"]   if _levels else None
        self.prev_day_close = _levels["close"] if _levels else None

        
        # State
        self.ce_strike = None
        self.pe_strike = None
        self.ce_lots = initial_lots
        self.pe_lots = initial_lots
        self.ce_id = None
        self.pe_id = None
        self.ce_symbol_name = None 
        self.pe_symbol_name = None
        self.ce_avg_price = 0.0
        self.pe_avg_price = 0.0
        self.entry_diff_pct = 0.0
        self.realized_pnl = 0.0
        self.adjustment_count = 0
        self.expiry = None
        
        # Trailing Stop Loss State
        self.trail_threshold = 1500.0
        self.trail_offset = 500.0
        self.peak_pnl = -999999.0 
        self.trailing_sl_active = False
        
        # Session Control
        self.last_adjustment_time = None 
        self.consecutive_chain_failures = 0

    def get_execution_price(self, order_id: str, fallback_price: float) -> float:
        """Wait for fill and get the average execution price, or return fallback."""
        if not order_id:
            return fallback_price
        # Wait for fill (up to 5 seconds for immediate execution on market order)
        if self.helper.wait_for_fill(order_id, timeout=5):
            order_details = self.helper.get_order_by_id(order_id)
            if order_details:
                fill_price = float(order_details.get('avgFilledPrice', 0.0) or order_details.get('price', 0.0))
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
        ce_unrealized = (self.ce_avg_price - ce_ltp) * (self.ce_lots * self.nifty_lot_size)
        pe_unrealized = (self.pe_avg_price - pe_ltp) * (self.pe_lots * self.nifty_lot_size)
        return self.realized_pnl + ce_unrealized + pe_unrealized

    def log_state(self, nifty_spot, ce_ltp, pe_ltp, ce_val, pe_val, diff_pct, total_pnl):
        # Determine active threshold
        if self.ce_lots == self.max_lots or self.pe_lots == self.max_lots:
            active_thresh = self.threshold_strike + self.entry_diff_pct
            thresh_label = "Strk"
        else:
            active_thresh = self.threshold_lot + self.entry_diff_pct
            thresh_label = "Lot"

        # Shortened labels for a cleaner one-liner
        logger.info(f"Nifty:{nifty_spot:.0f} | {self.ce_strike}C:{ce_ltp:.1f}({self.ce_lots}L) | {self.pe_strike}P:{pe_ltp:.1f}({self.pe_lots}L) | PnL:{total_pnl:.0f} | Diff:{diff_pct:.1f}% (Thresh:{active_thresh:.1f}% {thresh_label}) | Adj:{self.adjustment_count}")

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
        self.peak_pnl = -999999.0
        self.trailing_sl_active = False
        self.last_adjustment_time = None
        # realized_pnl is NOT reset as it's cumulative for the script run
        logger.info("Session state reset.")

    def select_strikes(self, nifty_spot, chain_df):
        """Selects CE and PE strikes based on distance, delta, or premium."""
        logger.info(f"Selecting strikes for Nifty Spot: {nifty_spot:.2f} using {self.strike_selection} method...")
        
        ce_strike = None
        pe_strike = None

        if self.strike_selection == "distance":
            ce_strike = int(round((nifty_spot + self.ce_offset) / 50) * 50)
            pe_strike = int(round((nifty_spot - self.pe_offset) / 50) * 50)
            logger.info(f"Distance Selection: {ce_strike} CE (+{self.ce_offset}) | {pe_strike} PE (-{self.pe_offset})")
        
        elif self.strike_selection == "delta":
            # Filter for rows that actually have Greeks
            greek_df = chain_df[(chain_df['ce_delta'] != 0) | (chain_df['pe_delta'] != 0)].copy()
            if greek_df.empty:
                logger.warning("No Greeks found in option chain. Falling back to distance selection.")
                # Fallback to distance
                ce_strike = int(round((nifty_spot + self.ce_offset) / 50) * 50)
                pe_strike = int(round((nifty_spot - self.pe_offset) / 50) * 50)
            else:
                greek_df['ce_delta_diff'] = abs(greek_df['ce_delta'] - self.target_delta)
                greek_df['pe_delta_diff'] = abs(greek_df['pe_delta'] - (-self.target_delta))
                
                ce_strike = int(greek_df.sort_values('ce_delta_diff').index[0])
                pe_strike = int(greek_df.sort_values('pe_delta_diff').index[0])
                logger.info(f"Delta Selection: CE {ce_strike} (Delta: {greek_df.loc[ce_strike, 'ce_delta']:.2f}) | PE {pe_strike} (Delta: {greek_df.loc[pe_strike, 'pe_delta']:.2f})")

        elif self.strike_selection == "premium":
            if chain_df.empty:
                logger.warning("Empty option chain for premium selection. Falling back to distance selection.")
                ce_strike = int(round((nifty_spot + self.ce_offset) / 50) * 50)
                pe_strike = int(round((nifty_spot - self.pe_offset) / 50) * 50)
            else:
                # Filter CE: must have last price > 0 and be OTM (strike > spot)
                ce_df = chain_df[(chain_df['ce_last_price'] > 0) & (chain_df.index > nifty_spot)].copy()
                if not ce_df.empty:
                    # Find strikes below or equal to target premium
                    below_ce = ce_df[ce_df['ce_last_price'] <= self.target_premium]
                    if not below_ce.empty:
                        ce_strike = int(float(below_ce['ce_last_price'].idxmax()))
                    else:
                        # Fallback to closest absolute price
                        ce_df['diff'] = abs(ce_df['ce_last_price'] - self.target_premium)
                        ce_strike = int(float(ce_df.sort_values('diff').index[0]))
                else:
                    ce_strike = int(round((nifty_spot + self.ce_offset) / 50) * 50)

                # Filter PE: must have last price > 0 and be OTM (strike < spot)
                pe_df = chain_df[(chain_df['pe_last_price'] > 0) & (chain_df.index < nifty_spot)].copy()
                if not pe_df.empty:
                    # Find strikes below or equal to target premium
                    below_pe = pe_df[pe_df['pe_last_price'] <= self.target_premium]
                    if not below_pe.empty:
                        pe_strike = int(float(below_pe['pe_last_price'].idxmax()))
                    else:
                        # Fallback to closest absolute price
                        pe_df['diff'] = abs(pe_df['pe_last_price'] - self.target_premium)
                        pe_strike = int(float(pe_df.sort_values('diff').index[0]))
                else:
                    pe_strike = int(round((nifty_spot - self.pe_offset) / 50) * 50)

                ce_price = chain_df.loc[float(ce_strike), 'ce_last_price'] if float(ce_strike) in chain_df.index else 0.0
                pe_price = chain_df.loc[float(pe_strike), 'pe_last_price'] if float(pe_strike) in chain_df.index else 0.0
                logger.info(f"Premium Selection: CE {ce_strike} (Price: {ce_price:.2f}) | PE {pe_strike} (Price: {pe_price:.2f}) [Target: <= {self.target_premium:.2f}]")

        if ce_strike is not None and pe_strike is not None:
            if ce_strike <= pe_strike:
                logger.error(f"Inverted strikes detected! CE strike {ce_strike} must be strictly greater than PE strike {pe_strike}. Bypassing selection.")
                return None, None
            return ce_strike, pe_strike
        
        return None, None

    def _preview_strikes(self):
        """Fetch last known spot + chain and log the projected CE/PE strikes.
        Called before sleeping for market open so the user can verify config."""
        try:
            spot = self.helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")
            expiry = self.helper.get_nearest_expiry("NIFTY")
            if spot and spot > 0 and expiry:
                chain_df = self.helper.get_option_chain_df("NIFTY", expiry)
                ce_s, pe_s = self.select_strikes(spot, chain_df if not chain_df.empty else pd.DataFrame())
                logger.info("=" * 60)
                logger.info("  PROJECTED STRIKES (based on last known price)")
                logger.info("=" * 60)
                logger.info(f"  Nifty Last Price : {spot:.2f}")
                logger.info(f"  Expiry           : {expiry}")
                logger.info(f"  CE Strike        : {ce_s}")
                logger.info(f"  PE Strike        : {pe_s}")
                if self.strike_selection == "delta":
                    logger.info(f"  Selection Mode   : delta  (target ±{self.target_delta:.2f})")
                elif self.strike_selection == "premium":
                    logger.info(f"  Selection Mode   : premium (target <= {self.target_premium:.2f})")
                else:
                    logger.info(f"  Selection Mode   : distance  (CE +{self.ce_offset} | PE -{self.pe_offset})")
                logger.info("=" * 60)
            else:
                logger.warning("Strike preview skipped: could not fetch Nifty spot price.")
        except Exception as e:
            logger.warning(f"Strike preview failed: {e}")

    def run(self):
        logger.info(f"Starting Nifty Value Imbalance STRANGLE (Dry Run: {self.dry_run} | Start Time: {self.start_time})")

        # Show projected strikes immediately, even before market opens
        self._preview_strikes()

        while True:
            # Wait for market open if closed (EOD is 15:17)
            self.helper.wait_for_market_open(self.dry_run, start_time=self.start_time, eod_time="15:17")
            
            self.reset_session()
            
            nifty_spot = self.helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")
            if nifty_spot == 0:
                 logger.warning("Direct LTP failed for NIFTY Index. Falling back to Option Chain...")
                 self.expiry = self.helper.get_nearest_expiry("NIFTY")
                 if self.expiry:
                     chain_df = self.helper.get_option_chain_df("NIFTY", self.expiry)
                     nifty_spot = chain_df.attrs.get('underlying_ltp', 0)
                 
                 if nifty_spot == 0:
                     logger.error("Could not fetch Nifty Spot. Retrying in 30s...")
                     time.sleep(30)
                     continue

            self.expiry = self.helper.get_nearest_expiry("NIFTY")
            chain_df = self.helper.get_option_chain_df("NIFTY", self.expiry)
            if chain_df.empty:
                logger.error("Empty option chain. Retrying...")
                time.sleep(10)
                continue

            self.ce_strike, self.pe_strike = self.select_strikes(nifty_spot, chain_df)
            
            if not self.ce_strike or not self.pe_strike:
                logger.error("Strike selection failed. Retrying...")
                time.sleep(10)
                continue

            ce_quote = self.helper.option("NIFTY", self.ce_strike, "CE")
            pe_quote = self.helper.option("NIFTY", self.pe_strike, "PE")
                
            # --- Fallback to chain_df if initial quotes fail or lack price ---
            if (self.is_quote_invalid(ce_quote) or self.is_quote_invalid(pe_quote)) and not chain_df.empty:
                logger.warning("Initial helper.option() failed or returned empty data. Falling back to option chain...")
                if self.is_quote_invalid(ce_quote) and float(self.ce_strike) in chain_df.index:
                    ce_quote = chain_df.loc[float(self.ce_strike)].to_dict()
                    logger.info(f"CE Fallback: {ce_quote.get('ce_last_price')} (ID: {int(ce_quote.get('ce_security_id', 0))})")
                
                if self.is_quote_invalid(pe_quote) and float(self.pe_strike) in chain_df.index:
                    pe_quote = chain_df.loc[float(self.pe_strike)].to_dict()
                    logger.info(f"PE Fallback: {pe_quote.get('pe_last_price')} (ID: {int(pe_quote.get('pe_security_id', 0))})")

            # Extract fields from quotes (standardizes API vs Fallback formats)
            self.ce_id, self.ce_avg_price, self.expiry, self.nifty_lot_size, self.ce_symbol_name = \
                self._extract_quote_fields(ce_quote, self.ce_strike, "CE")

            self.pe_id, self.pe_avg_price, _, _, self.pe_symbol_name = \
                self._extract_quote_fields(pe_quote, self.pe_strike, "PE")

            if not self.ce_id or not self.pe_id:
                logger.error(f"Initial quotes failed for {self.ce_strike}CE / {self.pe_strike}PE. Waiting 1m.")
                time.sleep(60)
                continue

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

            logger.info(f"New Cycle: {self.ce_strike}CE / {self.pe_strike}PE | Expiry: {self.expiry}")
            
            # Wait for premiums to balance (Strangle usually starts relatively balanced if symmetric)
            logger.info(f"Waiting for premiums to stabilize...")
            stabilized = False
            while True:
                if datetime.now().strftime("%H:%M") >= "15:17":
                    logger.info("Market nearing close. Waiting for next cycle...")
                    break

                # Check if Spot has moved significantly while waiting
                curr_spot = self.helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")
                if curr_spot > 0 and nifty_spot > 0:
                    if abs(curr_spot - nifty_spot) >= 50:
                        logger.info(f"Nifty Spot shifted from {nifty_spot:.2f} to {curr_spot:.2f}. Restarting entry cycle...")
                        break

                ce_price = self.helper.get_ltp(str(self.ce_id), exchange="NSE_FNO", instrument="OPTIDX")
                pe_price = self.helper.get_ltp(str(self.pe_id), exchange="NSE_FNO", instrument="OPTIDX")
                
                if ce_price > 0 and pe_price > 0:
                    max_prem = max(ce_price, pe_price)
                    diff_pct = abs(ce_price - pe_price) / max_prem * 100
                    logger.info(f"Waiting for Balance... CE: {ce_price:.2f} | PE: {pe_price:.2f} | Diff: {diff_pct:.1f}% (Target: < 25.0%)")
                    if diff_pct < 25.0: # Increased from 15% to 25% for strangles
                        self.ce_avg_price = ce_price
                        self.pe_avg_price = pe_price
                        self.entry_diff_pct = diff_pct
                        logger.info(f"Balanced! Entry Diff: {self.entry_diff_pct:.2f}%. Entering.")
                        stabilized = True
                        break
                time.sleep(5)

            if not stabilized:
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
                logger.info(f"[DRY RUN] Simulating Entry: {self.ce_strike}CE/{self.pe_strike}PE")

            last_log_time = time.time()
            cycle_active = True

            while cycle_active:
                time.sleep(1)
                now = datetime.now()
                current_time_str = now.strftime("%H:%M")
                current_bar = now.strftime("%Y-%m-%d %H:%M")

                if current_time_str >= "15:17":
                    self.exit_all_positions("Intraday Auto-Exit")
                    break

                ce_ltp = self.helper.get_ltp(str(self.ce_id), exchange="NSE_FNO", instrument="OPTIDX")
                pe_ltp = self.helper.get_ltp(str(self.pe_id), exchange="NSE_FNO", instrument="OPTIDX")
                if ce_ltp <= 0 or pe_ltp <= 0: continue
                
                total_pnl = self._calculate_pnl(ce_ltp, pe_ltp)
                curr_nifty = self.helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")
                if curr_nifty <= 0:
                     # Attempt fallback to option chain attr
                     chain_df = self.helper.get_option_chain_df("NIFTY", self.expiry)
                     curr_nifty = chain_df.attrs.get('underlying_ltp', 0)
                     if curr_nifty <= 0: continue # Skip this iteration if spot is lost

                # Phase 5: Strangle Shift (Market moved past one of the strikes)
                if curr_nifty >= self.ce_strike or curr_nifty <= self.pe_strike:
                    self.exit_all_positions(f"Phase 5: Market breached strike! Nifty: {curr_nifty:.2f}")
                    logger.info("Waiting 5 minutes before restart...")
                    time.sleep(300)
                    cycle_active = False
                    break
                
                # Hard Targets & Trailing SL (Existing logic)
                if total_pnl >= self.trail_threshold:
                    self.trailing_sl_active = True
                    if total_pnl > self.peak_pnl: self.peak_pnl = total_pnl
                
                if self.trailing_sl_active and total_pnl <= (self.peak_pnl - self.trail_offset):
                    self.exit_all_positions(f"Trailing SL Hit! Peak: {self.peak_pnl:.2f}")
                    time.sleep(300)
                    cycle_active = False
                    break
                
                if total_pnl >= self.profit_target or total_pnl <= self.stop_loss:
                    reason = "Profit Target Reached" if total_pnl >= self.profit_target else "Global Stop Loss Hit"
                    self.exit_all_positions(f"Target/SL Hit: {reason} ({total_pnl:.2f})")
                    self.helper.wait_for_next_day_market_open(self.dry_run, start_time=self.start_time)
                    cycle_active = False
                    break

                # Value Balancing (Existing logic)
                ce_val = self.ce_lots * ce_ltp
                pe_val = self.pe_lots * pe_ltp
                max_val = max(ce_val, pe_val)
                diff_pct = abs(ce_val - pe_val) / max_val * 100 if max_val > 0 else 0
                
                if time.time() - last_log_time >= 5:
                    self.log_state(curr_nifty, ce_ltp, pe_ltp, ce_val, pe_val, diff_pct, total_pnl)
                    last_log_time = time.time()

                if self.last_adjustment_time == current_bar: continue

                winner = "CE" if ce_val < pe_val else "PE"
                loser = "PE" if ce_val < pe_val else "CE"
                winner_lots = self.ce_lots if winner == "CE" else self.pe_lots

                # Phase 3: Lot Addition or Exit on Max Lots Reached
                if diff_pct > (self.threshold_lot + self.entry_diff_pct):
                    if winner_lots < self.max_lots:
                        logger.info(f"!!! Lot Addition !!! Diff: {diff_pct:.2f}%")
                        symbol_id = str(self.ce_id) if winner == "CE" else str(self.pe_id)
                        new_price = self.helper.get_ltp(symbol_id, exchange="NSE_FNO", instrument="OPTIDX")
                        oid = None
                        if not self.dry_run:
                            oid = self.helper.sell(symbol_id, self.nifty_lot_size)
                        # Get actual execution price if live, else use new_price
                        exec_price = self.get_execution_price(oid, new_price) if oid else new_price
                        
                        if winner == "CE":
                            self.ce_avg_price = ((self.ce_avg_price * self.ce_lots) + exec_price) / (self.ce_lots + 1)
                            self.ce_lots += 1
                        else:
                            self.pe_avg_price = ((self.pe_avg_price * self.pe_lots) + exec_price) / (self.pe_lots + 1)
                            self.pe_lots += 1
                        self.adjustment_count += 1
                        self.last_adjustment_time = current_bar
                        continue
                    else:
                        # Winner leg already at max lots, cannot adjust further. Close all and re-enter.
                        self.exit_all_positions(
                            f"Winner leg ({winner}) already at max lots ({self.max_lots}) and requires adjustment. "
                            f"Closing all positions to start a new cycle."
                        )
                        cycle_active = False
                        break 

                # Phase 4: Strike Adjustment
                if diff_pct > (self.threshold_strike + self.entry_diff_pct) and (self.ce_lots == self.max_lots or self.pe_lots == self.max_lots):
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
                    old_loser_lots = self.pe_lots if loser == "PE" else self.ce_lots
                    new_loser_lots = 2  # Change/set to 2 lots for adjustments
                    
                    new_strike, new_price = self.find_rebalance_strike(loser, winner_val, new_loser_lots, chain_df)
                    if new_strike:
                        # Prevent strike inversion during rebalance - exit cycle
                        if (loser == "CE" and new_strike <= self.pe_strike) or (loser == "PE" and new_strike >= self.ce_strike):
                            self.exit_all_positions(
                                f"Blocked strike inversion adjustment: new {loser} strike {new_strike} "
                                f"would cross/equal opposite leg. Exiting cycle."
                            )
                            logger.info("Waiting 5 minutes before restart...")
                            time.sleep(300)
                            cycle_active = False
                            break

                        old_id = str(self.ce_id) if loser == "CE" else str(self.pe_id)
                        old_avg = self.ce_avg_price if loser == "CE" else self.pe_avg_price
                        exit_price = self.helper.get_ltp(old_id, exchange="NSE_FNO", instrument="OPTIDX")
                        if exit_price > 0:
                            buy_oid = None
                            if not self.dry_run:
                                buy_oid = self.helper.buy(old_id, old_loser_lots * self.nifty_lot_size)
                                if not buy_oid:
                                    logger.error(f"Failed to place buy-to-close order for old leg {old_id}. Aborting strike adjustment to prevent orphaned legs.")
                                    continue
                            # Get actual exit price if live
                            actual_exit_price = self.get_execution_price(buy_oid, exit_price) if buy_oid else exit_price
                            
                            # Realize PnL based on the old lot count we bought back
                            self.realized_pnl += (old_avg - actual_exit_price) * (old_loser_lots * self.nifty_lot_size)
                            
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
                                    sell_oid = self.helper.sell(str(new_id), new_loser_lots * self.nifty_lot_size)
                                # Get actual entry price for the new strike
                                actual_entry_price = self.get_execution_price(sell_oid, new_price) if sell_oid else new_price
                                
                                # Sell the new further OTM strike with the adjusted lot count (2 lots)
                                if loser == "CE":
                                    self.ce_strike, self.ce_id, self.ce_avg_price, self.ce_lots = new_strike, new_id, actual_entry_price, new_loser_lots
                                else:
                                    self.pe_strike, self.pe_id, self.pe_avg_price, self.pe_lots = new_strike, new_id, actual_entry_price, new_loser_lots
                        self.adjustment_count += 1
                        self.last_adjustment_time = current_bar
                    continue

    def find_rebalance_strike(self, option_type, target_value, lots, chain_df):
        if lots <= 0 or chain_df.empty: return None, 0.0
        price_col = f"{option_type.lower()}_last_price"
        target_price = target_value / lots
        valid_df = chain_df[chain_df[price_col] > 0].copy()
        if valid_df.empty: return None, 0.0
        valid_df['diff'] = abs(valid_df[price_col] - target_price)
        best_row = valid_df.sort_values('diff').iloc[0]
        try: return int(float(best_row.name)), float(best_row[price_col])
        except: return None, 0.0

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Nifty Value Imbalance STRANGLE Strategy",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Distance mode — symmetric 200-pt strangle, dry run
  python strategies/nifty_value_imbalance_strangle.py

  # Distance mode — wider 300-pt, live, 2 lots
  python strategies/nifty_value_imbalance_strangle.py --live --lots 2 --ce-offset 300 --pe-offset 300

  # Distance mode — asymmetric (tighter CE, wider PE)
  python strategies/nifty_value_imbalance_strangle.py --ce-offset 150 --pe-offset 250

  # Delta mode — standard ~1 SD strangle (delta 0.20)
  python strategies/nifty_value_imbalance_strangle.py --delta --target-delta 0.20

  # Delta mode — wider/safer (delta 0.15), live, 2 lots
  python strategies/nifty_value_imbalance_strangle.py --live --lots 2 --delta --target-delta 0.15

  # Delta mode — aggressive (delta 0.30)
  python strategies/nifty_value_imbalance_strangle.py --delta --target-delta 0.30
""")

    # Run mode
    parser.add_argument("--live", action="store_true", default=False,
                        help="Run in LIVE mode (default: dry run)")

    # Position sizing
    parser.add_argument("--lots", type=int, default=1, metavar="N",
                        help="Initial lots per leg (default: 1)")

    # Strike selection mode
    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument("--delta", dest="use_delta", action="store_true", default=False,
                            help="Use delta-based strike selection instead of fixed offset")
    mode_group.add_argument("--distance", dest="use_delta", action="store_false",
                            help="Use fixed-point offset strike selection (default)")

    parser.add_argument("--premium", action="store_true", default=False,
                        help="Use premium-based strike selection (finds strikes closest to and below the target premium)")
    parser.add_argument("--target-premium", type=float, default=50.0, metavar="PREM",
                        help="Target premium value for premium mode (default: 50.0)")

    # Distance mode options
    parser.add_argument("--ce-offset", type=int, default=200, metavar="PTS",
                        help="Points ABOVE spot for CE strike in distance mode (default: 200). "
                             "Snapped to nearest 50-pt strike. e.g. Nifty=24000, --ce-offset 300 -> CE ~24300")
    parser.add_argument("--pe-offset", type=int, default=200, metavar="PTS",
                        help="Points BELOW spot for PE strike in distance mode (default: 200). "
                             "e.g. Nifty=24000, --pe-offset 300 -> PE ~23700")

    # Delta mode option
    parser.add_argument("--target-delta", type=float, default=0.20, metavar="D",
                        help="Absolute delta to target in delta mode (default: 0.20). "
                             "0.10=far OTM safe | 0.20=~1 SD standard | 0.25=aggressive | 0.30=near ATM. "
                             "Falls back to distance mode if broker Greeks are unavailable.")

    # Risk targets
    parser.add_argument("--target-profit", type=float, default=4000.0, metavar="AMT",
                        help="Global profit target in INR (default: 4000.0)")
    parser.add_argument("--stop-loss", type=float, default=4000.0, metavar="AMT",
                        help="Global stop loss in INR (default: 4000.0). Can be passed as positive or negative.")

    # Customizable Start Time
    parser.add_argument("--start-time", type=str, default="09:20", metavar="TIME",
                        help="Market start monitoring time (HH:MM IST, default: 09:20)")

    args = parser.parse_args()

    if args.premium:
        selection = "premium"
    elif args.use_delta:
        selection = "delta"
    else:
        selection = "distance"

    mode_label   = "LIVE" if args.live else "DRY"
    
    # Ensure stop loss is internally passed as positive or handled correctly by the strat
    stop_loss_val = abs(args.stop_loss)

    if selection == "delta":
        logger.info(f"Config -> Mode: {mode_label} | Lots: {args.lots} | Start Time: {args.start_time} | Selection: delta | Target Delta: ±{args.target_delta:.2f} | Profit Target: INR {args.target_profit:.0f} | Stop Loss: -INR {stop_loss_val:.0f}")
    elif selection == "premium":
        logger.info(f"Config -> Mode: {mode_label} | Lots: {args.lots} | Start Time: {args.start_time} | Selection: premium | Target Premium: <= {args.target_premium:.2f} | Profit Target: INR {args.target_profit:.0f} | Stop Loss: -INR {stop_loss_val:.0f}")
    else:
        logger.info(f"Config -> Mode: {mode_label} | Lots: {args.lots} | Start Time: {args.start_time} | Selection: distance | CE Offset: +{args.ce_offset} | PE Offset: -{args.pe_offset} | Profit Target: INR {args.target_profit:.0f} | Stop Loss: -INR {stop_loss_val:.0f}")

    strat = ValueImbalanceStrangle(
        dry_run=not args.live,
        initial_lots=args.lots,
        strike_selection=selection,
        ce_offset=args.ce_offset,
        pe_offset=args.pe_offset,
        target_delta=args.target_delta,
        target_premium=args.target_premium,
        profit_target=args.target_profit,
        stop_loss=stop_loss_val,
        start_time=args.start_time,
    )
    strat.run()
