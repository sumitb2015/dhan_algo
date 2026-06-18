import time
import sys
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
        logging.FileHandler(os.path.join(debug_dir, f"imbalance_{datetime.now().strftime('%Y%m%d')}.log"))
    ]
)
logger = logging.getLogger(__name__)

class ValueImbalanceStrategy:
    def __init__(self, dry_run=True, initial_lots=1, max_lots=4, 
                 threshold_lot=25.0, threshold_strike=40.0, target_rebalance=5.0,
                 profit_target=4000.0, stop_loss=4000.0):
        self.dry_run = dry_run
        self.initial_lots = initial_lots
        self.max_lots = max_lots
        self.threshold_lot = threshold_lot
        self.threshold_strike = threshold_strike
        self.target_rebalance = target_rebalance
        self.profit_target = profit_target
        self.stop_loss = -abs(stop_loss) # Ensure it's negative
        
        self.dhan = get_dhan_client()
        if not self.dhan:
            raise Exception("Failed to connect to Dhan.")
        self.helper = DhanHelper(self.dhan)
        
        self.nifty_lot_size = self.helper.get_lot_size("NIFTY 50")
        
        # State
        self.ce_strike = None
        self.pe_strike = None
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
        self.trail_threshold = 1500.0
        self.trail_offset = 500.0
        self.peak_pnl = -999999.0 # Track highest PnL reached
        self.trailing_sl_active = False
        
        # Session Control
        self.last_adjustment_time = None 

    def _calculate_pnl(self, ce_ltp, pe_ltp):
        # PnL = (Entry - Current) * Qty (since we are selling)
        # self.realized_pnl contains profits from closed legs in previous adjustments
        ce_unrealized = (self.ce_avg_price - ce_ltp) * (self.ce_lots * self.nifty_lot_size)
        pe_unrealized = (self.pe_avg_price - pe_ltp) * (self.pe_lots * self.nifty_lot_size)
        
        return self.realized_pnl + ce_unrealized + pe_unrealized

    def get_pnl(self):
        # Kept for backward compatibility or external calls, but optimized internally
        ce_ltp = self.helper.get_ltp(str(self.ce_id), exchange="NSE_FNO")
        pe_ltp = self.helper.get_ltp(str(self.pe_id), exchange="NSE_FNO")
        
        if ce_ltp <= 0 or pe_ltp <= 0:
            return self.realized_pnl
            
        return self._calculate_pnl(ce_ltp, pe_ltp)

    def get_traded_values(self):
        ce_ltp = self.helper.get_ltp(str(self.ce_id), exchange="NSE_FNO")
        pe_ltp = self.helper.get_ltp(str(self.pe_id), exchange="NSE_FNO")
        
        if ce_ltp <= 0 or pe_ltp <= 0:
            return None, None
            
        ce_value = self.ce_lots * ce_ltp
        pe_value = self.pe_lots * pe_ltp
        
        return ce_value, pe_value

    def log_state(self, nifty_spot, ce_ltp, pe_ltp, ce_val, pe_val, diff_pct, total_pnl):
        logger.info(f"Nifty: {nifty_spot:.2f} | Straddle: {self.ce_strike}CE / {self.pe_strike}PE | CE: {ce_ltp:.2f} ({self.ce_lots}L) Val: {ce_val:.2f} | PE: {pe_ltp:.2f} ({self.pe_lots}L) Val: {pe_val:.2f} | PnL: {total_pnl:.2f} | Diff: {diff_pct:.2f}% | Adj: {self.adjustment_count}")

    def exit_all_positions(self, reason):
        logger.warning(f"!!! EXITING ALL POSITIONS: {reason} !!!")
        if not self.dry_run:
            if self.ce_id:
                self.helper.buy(str(self.ce_id), self.ce_lots * self.nifty_lot_size)
            if self.pe_id:
                self.helper.buy(str(self.pe_id), self.pe_lots * self.nifty_lot_size)
        else:
            logger.info(f"[DRY RUN] Simulating Exit of all positions.")

    def reset_session(self):
        """Resets session-specific variables for a new entry cycle."""
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
        self.peak_pnl = -999999.0
        self.trailing_sl_active = False
        self.last_adjustment_time = None
        logger.info("Session state reset for new cycle.")

    def run(self):
        logger.info(f"Starting Nifty Value Imbalance Strategy (Dry Run: {self.dry_run})")
        
        while True:
            # 1. Initialization / Re-initialization
            self.reset_session()
            
            nifty_spot = self.helper.get_ltp("NIFTY", instrument="INDEX")
            if nifty_spot == 0:
                 logger.warning("Direct LTP failed for NIFTY Index. Falling back to Option Chain...")
                 nearest_expiry = self.helper.get_nearest_expiry("NIFTY")
                 if nearest_expiry:
                     chain_df = self.helper.get_option_chain_df("NIFTY", nearest_expiry)
                     nifty_spot = chain_df.attrs.get('underlying_ltp', 0)
                 
                 if nifty_spot == 0:
                     logger.error("Could not fetch Nifty Spot. Retrying in 30s...")
                     time.sleep(30)
                     continue

            self.ce_strike = int(round(nifty_spot / 50) * 50)
            self.pe_strike = self.ce_strike
            
            ce_quote = None
            pe_quote = None
            
            # Retry mechanism for initial quotes
            for attempt in range(5):
                ce_quote = self.helper.option("NIFTY", self.ce_strike, "CE")
                pe_quote = self.helper.option("NIFTY", self.pe_strike, "PE")
                if ce_quote and pe_quote: break
                logger.warning(f"Initial quotes failed (Attempt {attempt+1}/5). Retrying in 5s...")
                time.sleep(5)
                
            if not ce_quote or not pe_quote:
                logger.error("Initial quotes failed. Waiting 5m before restart.")
                time.sleep(300)
                continue

            self.ce_symbol_name = ce_quote['CONTRACT_INFO']['SYMBOL_NAME']
            self.pe_symbol_name = pe_quote['CONTRACT_INFO']['SYMBOL_NAME']
            self.ce_id = ce_quote['CONTRACT_INFO']['SECURITY_ID']
            self.pe_id = pe_quote['CONTRACT_INFO']['SECURITY_ID']
            self.expiry = ce_quote['CONTRACT_INFO']['SM_EXPIRY_DATE']
            self.nifty_lot_size = int(ce_quote['CONTRACT_INFO'].get('LOT_SIZE', self.nifty_lot_size))
            
            logger.info(f"New Cycle: {self.ce_strike} CE/PE | Lot Size: {self.nifty_lot_size} | Expiry: {self.expiry}")
            
            # Wait for premiums to balance
            logger.info(f"Waiting for premiums to balance at ATM {self.ce_strike}...")
            while True:
                # Check 15:17 even during waiting
                if datetime.now().strftime("%H:%M") >= "15:17":
                    logger.info("Market nearing close. Ending strategy.")
                    return

                ce_price = self.helper.get_ltp(str(self.ce_id), exchange="NSE_FNO")
                pe_price = self.helper.get_ltp(str(self.pe_id), exchange="NSE_FNO")
                
                if ce_price > 0 and pe_price > 0:
                    max_prem = max(ce_price, pe_price)
                    diff_pct = abs(ce_price - pe_price) / max_prem * 100
                    if diff_pct < 10.0:
                        self.ce_avg_price = ce_price
                        self.pe_avg_price = pe_price
                        self.entry_diff_pct = diff_pct
                        logger.info(f"Balanced! Entry Diff: {self.entry_diff_pct:.2f}%. Entering.")
                        break
                time.sleep(5)

            if not self.dry_run:
                ce_oid = self.helper.sell(str(self.ce_id), self.initial_lots * self.nifty_lot_size)
                pe_oid = self.helper.sell(str(self.pe_id), self.initial_lots * self.nifty_lot_size)
                if not ce_oid or not pe_oid:
                    logger.error("Entry Failed. Restarting cycle.")
                    continue
            else:
                logger.info(f"[DRY RUN] Simulating Entry: {self.ce_strike} CE/PE")

            last_log_time = time.time()
            cycle_active = True

            # --- MAIN MONITORING LOOP ---
            while cycle_active:
                time.sleep(1)
                now = datetime.now()
                current_time_str = now.strftime("%H:%M")
                current_bar = now.strftime("%Y-%m-%d %H:%M")

                if current_time_str >= "15:17":
                    self.exit_all_positions(f"Intraday Auto-Exit at {current_time_str}")
                    return # End for the day

                if not self.helper.is_market_open() and not self.dry_run:
                    self.exit_all_positions("Market Closed")
                    return # End for the day
                    
                ce_ltp = self.helper.get_ltp(str(self.ce_id), exchange="NSE_FNO")
                pe_ltp = self.helper.get_ltp(str(self.pe_id), exchange="NSE_FNO")
                if ce_ltp <= 0 or pe_ltp <= 0: continue
                
                total_pnl = self._calculate_pnl(ce_ltp, pe_ltp)
                
                # Fetch current spot for checks
                curr_nifty = self.helper.get_ltp("NIFTY", instrument="INDEX", exchange="NSE")
                if curr_nifty == 0: curr_nifty = nifty_spot # Fallback to start spot

                # --- Phase 5: Straddle Shift (100pt Move) ---
                if abs(curr_nifty - self.ce_strike) >= 100:
                    self.exit_all_positions(f"Phase 5: Straddle Shift! Nifty moved 100pts from {self.ce_strike} to {curr_nifty:.2f}")
                    logger.info("Waiting 5 minutes before re-centering straddle at new ATM...")
                    time.sleep(300)
                    cycle_active = False
                    break
                
                # --- Trailing Stop Loss Logic ---
                if total_pnl >= self.trail_threshold:
                    if not self.trailing_sl_active:
                        logger.info(f"Trailing SL Activated at {total_pnl:.2f}")
                        self.trailing_sl_active = True
                    if total_pnl > self.peak_pnl:
                        self.peak_pnl = total_pnl
                
                if self.trailing_sl_active:
                    current_sl = self.peak_pnl - self.trail_offset
                    if total_pnl <= current_sl:
                        self.exit_all_positions(f"Trailing SL Hit! Peak: {self.peak_pnl:.2f}, Final: {total_pnl:.2f}")
                        logger.info("Waiting 5 minutes before next re-entry cycle...")
                        time.sleep(300)
                        cycle_active = False
                        break # Break inner loop to restart outer loop
                
                # --- Hard Targets ---
                if total_pnl >= self.profit_target:
                    self.exit_all_positions(f"Profit Target Reached: {total_pnl:.2f}")
                    return 
                if total_pnl <= self.stop_loss:
                    self.exit_all_positions(f"Global Stop Loss Hit: {total_pnl:.2f}")
                    return

                ce_val = self.ce_lots * ce_ltp
                pe_val = self.pe_lots * pe_ltp
                max_val = max(ce_val, pe_val)
                diff_pct = abs(ce_val - pe_val) / max_val * 100
                
                if time.time() - last_log_time >= 2:
                    curr_nifty = self.helper.get_ltp("NIFTY", instrument="INDEX", exchange="NSE")
                    self.log_state(curr_nifty or nifty_spot, ce_ltp, pe_ltp, ce_val, pe_val, diff_pct, total_pnl)
                    last_log_time = time.time()

                if self.last_adjustment_time == current_bar: continue

                winner = "CE" if ce_val < pe_val else "PE"
                loser = "PE" if ce_val < pe_val else "CE"
                winner_lots = self.ce_lots if winner == "CE" else self.pe_lots
                loser_lots = self.pe_lots if winner == "CE" else self.ce_lots

                # Phase 3: Lot Addition
                if diff_pct > (self.threshold_lot + self.entry_diff_pct) and winner_lots < self.max_lots:
                    logger.info(f"!!! Lot Addition !!! Diff: {diff_pct:.2f}%")
                    symbol_id = str(self.ce_id) if winner == "CE" else str(self.pe_id)
                    new_price = self.helper.get_ltp(symbol_id)
                    if new_price > 0:
                        old_lots = winner_lots
                        if winner == "CE":
                            self.ce_avg_price = ((self.ce_avg_price * old_lots) + new_price) / (old_lots + 1)
                            self.ce_lots += 1
                        else:
                            self.pe_avg_price = ((self.pe_avg_price * old_lots) + new_price) / (old_lots + 1)
                            self.pe_lots += 1
                        if not self.dry_run: self.helper.sell(symbol_id, self.nifty_lot_size)
                        self.adjustment_count += 1
                        self.last_adjustment_time = current_bar
                    continue 

                # Phase 4 & 5: Strike Adjustment
                if diff_pct > (self.threshold_strike + self.entry_diff_pct) and (self.ce_lots == self.max_lots or self.pe_lots == self.max_lots):
                    logger.info(f"!!! Strike Adjustment !!! Diff: {diff_pct:.2f}%")
                    chain_df = self.helper.get_option_chain_df("NIFTY", self.expiry)
                    if chain_df.empty: continue
                    winner_val = ce_val if loser == "PE" else pe_val
                    new_strike, new_price = self.find_rebalance_strike(loser, winner_val, loser_lots, chain_df)
                    if not new_strike: continue
                    old_id = str(self.ce_id) if loser == "CE" else str(self.pe_id)
                    old_avg = self.ce_avg_price if loser == "CE" else self.pe_avg_price
                    exit_price = self.helper.get_ltp(old_id)
                    if exit_price > 0:
                        realized = (old_avg - exit_price) * (loser_lots * self.nifty_lot_size)
                        self.realized_pnl += realized
                        if not self.dry_run: self.helper.buy(old_id, loser_lots * self.nifty_lot_size)
                        new_quote = self.helper.option("NIFTY", new_strike, loser)
                        if new_quote:
                            new_id = str(new_quote['CONTRACT_INFO']['SECURITY_ID'])
                            if not self.dry_run: self.helper.sell(new_id, loser_lots * self.nifty_lot_size)
                            if loser == "CE":
                                self.ce_strike = new_strike
                                self.ce_symbol_name = new_quote['CONTRACT_INFO']['SYMBOL_NAME']
                                self.ce_id = new_quote['CONTRACT_INFO']['SECURITY_ID']
                                self.ce_avg_price = new_price
                            else:
                                self.pe_strike = new_strike
                                self.pe_symbol_name = new_quote['CONTRACT_INFO']['SYMBOL_NAME']
                                self.pe_id = new_quote['CONTRACT_INFO']['SECURITY_ID']
                                self.pe_avg_price = new_price
                        self.adjustment_count += 1
                        self.last_adjustment_time = current_bar
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
    # Default to dry run
    # Usage: python strategies/nifty_value_imbalance.py [dry|live] [initial_lots]
    mode = sys.argv[1] if len(sys.argv) > 1 else "dry"
    initial_lots = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    
    is_dry = True if mode == "dry" else False
    
    strat = ValueImbalanceStrategy(dry_run=is_dry, initial_lots=initial_lots)
    strat.run()
