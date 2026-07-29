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
log_dir = os.path.join(debug_dir, "logs", "advanced_imbalance")
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

class NiftyAdvancedImbalance:
    def __init__(self, mode="winner_roll_atm", dry_run=True, initial_lots=1, max_lots=4,
                 threshold_lot=25.0, threshold_strike=40.0,
                 profit_target=4000.0, profit_target_is_pct=False,
                 stop_loss=4000.0, stop_loss_is_pct=False,
                 entry_type="straddle", use_delta=False, target_delta=0.20,
                 ce_offset=200, pe_offset=200,
                 use_premium=False, target_premium=50.0,
                 start_time="09:20", loser_ratio_lots=1,
                 leg_sl_pct=0.20,
                 trail_start_pct=5.0, trail_gap_pts=15.0,
                 state_key="nifty_advanced_imbalance"):
        self.state_key = state_key
        self.mode = mode.lower()
        self.dry_run = dry_run
        self.initial_lots = initial_lots
        self.max_lots = max_lots
        self.threshold_lot = threshold_lot
        self.threshold_strike = threshold_strike
        # Target/SL may be an absolute INR amount or a percentage of entry premium
        # collected (resolved once the position is actually entered, see below).
        self.target_is_pct = profit_target_is_pct
        self.stop_is_pct = stop_loss_is_pct
        self.target_pct = profit_target if profit_target_is_pct else None
        self.stop_pct = stop_loss if stop_loss_is_pct else None
        self.profit_target = None if profit_target_is_pct else profit_target
        self.stop_loss = None if stop_loss_is_pct else -abs(stop_loss)  # Ensure it's negative
        self.entry_type = entry_type.lower()
        self.use_delta = use_delta
        self.target_delta = target_delta
        self.ce_offset = ce_offset
        self.pe_offset = pe_offset
        self.use_premium = use_premium
        self.target_premium = target_premium
        self.start_time = start_time
        self.loser_ratio_lots = loser_ratio_lots
        self.leg_sl_pct = leg_sl_pct
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
        
        # Fetch OHLC levels
        _levels = self.helper.get_prev_day_levels("NIFTY")
        self.prev_day_high  = _levels["high"]  if _levels else None
        self.prev_day_low   = _levels["low"]   if _levels else None
        self.prev_day_close = _levels["close"] if _levels else None
        
        self.nifty_lot_size = self.helper.get_lot_size("NIFTY")
        
        # Short State
        self.ce_strike = None
        self.pe_strike = None
        self.initial_ce_strike = None
        self.initial_pe_strike = None
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
        
        # Wing State (for hedged_addition mode)
        self.ce_wings = []
        self.pe_wings = []
        
        # Trailing Stop Loss State
        self.trail_active = False
        self.entry_combined_pts = 0.0
        self.best_combined_pts = 0.0

        # Session Control
        self.last_adjustment_time = None
        self.consecutive_chain_failures = 0

        # Reentry Straddle State (reentry_straddle mode only)
        self.ce_active = False
        self.pe_active = False
        self.ce_sl = 0.0
        self.pe_sl = 0.0
        self.ce_original_entry_premium = 0.0
        self.pe_original_entry_premium = 0.0

    def sleep_cooldown(self, seconds):
        """Shutdown-aware sleep for cooldowns and delays."""
        for _ in range(seconds):
            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request during cooldown sleep. Exiting.")
                self.save_state(0, 0, 0, 0, status="STOPPED")
                sys.exit(0)
            time.sleep(1)

    def save_state(self, nifty_spot, ce_ltp, pe_ltp, total_pnl, status="RUNNING"):
        state_dict = {
            "strategy": "nifty_advanced_imbalance",
            "status": status,
            "mode": self.mode,
            "dry_run": self.dry_run,
            "entry_type": self.entry_type,
            "lots": self.initial_lots,
            "max_lots": self.max_lots,
            "threshold_lot": self.threshold_lot,
            "loser_ratio_lots": self.loser_ratio_lots,
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
            "ce_active": self.ce_active,
            "pe_active": self.pe_active,
            "ce_sl": self.ce_sl,
            "pe_sl": self.pe_sl,
            "ce_original_entry_premium": self.ce_original_entry_premium,
            "pe_original_entry_premium": self.pe_original_entry_premium,
            "leg_sl_pct": self.leg_sl_pct,
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
        
        # Format 2: Flat chain format
        ot = option_type.lower()
        sid = quote.get(f'{ot}_security_id') or quote.get('security_id')
        price = quote.get(f'{ot}_last_price') or quote.get('last_price', 0.0)
        
        if sid:
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
        # Short positions: (Entry - Current) * Qty
        ce_unrealized = (self.ce_avg_price - ce_ltp) * (self.ce_lots * self.nifty_lot_size)
        pe_unrealized = (self.pe_avg_price - pe_ltp) * (self.pe_lots * self.nifty_lot_size)
        
        # Long positions (wings): (Current - Entry) * Qty
        wing_pnl = 0.0
        for wing in self.ce_wings:
            wing_ltp = self.helper.get_ltp(str(wing['id']), exchange="NSE_FNO", instrument="OPTIDX")
            if wing_ltp > 0:
                wing_pnl += (wing_ltp - wing['buy_price']) * (wing['lots'] * self.nifty_lot_size)
                
        for wing in self.pe_wings:
            wing_ltp = self.helper.get_ltp(str(wing['id']), exchange="NSE_FNO", instrument="OPTIDX")
            if wing_ltp > 0:
                wing_pnl += (wing_ltp - wing['buy_price']) * (wing['lots'] * self.nifty_lot_size)
                
        return self.realized_pnl + ce_unrealized + pe_unrealized + wing_pnl

    def log_state(self, nifty_spot, ce_ltp, pe_ltp, ce_val, pe_val, diff_pct, total_pnl):
        # Determine active threshold
        if self.ce_lots == self.max_lots or self.pe_lots == self.max_lots:
            active_thresh = self.threshold_strike + self.entry_diff_pct
            thresh_label = "Strk"
        else:
            active_thresh = self.threshold_lot + self.entry_diff_pct
            thresh_label = "Lot"

        wing_desc = ""
        if self.mode == "hedged_addition":
            wing_desc = f" | W_CE:{len(self.ce_wings)}L W_PE:{len(self.pe_wings)}L"

        logger.info(
            f"Mode:{self.mode} | Straddle:{self.ce_strike}C / {self.pe_strike}P | "
            f"CE:{ce_ltp:.1f}({self.ce_lots}L) Val:{ce_val:.1f} | PE:{pe_ltp:.1f}({self.pe_lots}L) Val:{pe_val:.1f}{wing_desc} | "
            f"Diff:{diff_pct:.1f}% (Thresh:{active_thresh:.1f}% {thresh_label}) | Adj:{self.adjustment_count} | "
            f"PnL:{total_pnl:+.0f} (Real:{self.realized_pnl:+.0f})"
        )

    NIFTY_SPOT_SID = 13  # Nifty 50 index (IDX_I) for spot price

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

    def _handle_reentry_sl_and_entry(self, ce_ltp: float, pe_ltp: float):
        """Per-leg independent SL exit and re-entry for reentry_straddle mode."""

        # --- CE: Stop Loss Check ---
        if self.ce_active and ce_ltp >= self.ce_sl:
            logger.warning(
                f"CE SL Hit! LTP {ce_ltp:.2f} >= SL {self.ce_sl:.2f} "
                f"(sold at {self.ce_avg_price:.2f})"
            )
            actual_exit = ce_ltp
            do_state_update = False
            if not self.dry_run:
                net_qty = self.helper.get_net_quantity(str(self.ce_id))
                if net_qty < 0:
                    buy_oid = self.helper.buy(str(self.ce_id), abs(net_qty))
                    if buy_oid:
                        actual_exit = self.get_execution_price(buy_oid, ce_ltp)
                    else:
                        logger.critical(
                            f"CE SL exit order FAILED (buy returned None). "
                            f"Marking leg inactive at LTP {actual_exit:.2f} to prevent a duplicate order. "
                            f"Verify CE position manually!"
                        )
                    do_state_update = True
                else:
                    logger.warning(f"CE net qty {net_qty} — already flat, marking inactive.")
                    do_state_update = True
            else:
                logger.info(f"[DRY RUN] CE SL exit at {actual_exit:.2f}")
                do_state_update = True
            if do_state_update:
                realized = (self.ce_avg_price - actual_exit) * (self.ce_lots * self.nifty_lot_size)
                self.realized_pnl += realized
                logger.info(
                    f"CE leg closed at {actual_exit:.2f}. Leg realized: {realized:+.2f}. "
                    f"Watching for re-entry at <= {self.ce_original_entry_premium:.2f}"
                )
                self.ce_avg_price = 0.0
                self.ce_lots = 0
                self.ce_active = False

        # --- PE: Stop Loss Check ---
        if self.pe_active and pe_ltp >= self.pe_sl:
            logger.warning(
                f"PE SL Hit! LTP {pe_ltp:.2f} >= SL {self.pe_sl:.2f} "
                f"(sold at {self.pe_avg_price:.2f})"
            )
            actual_exit = pe_ltp
            do_state_update = False
            if not self.dry_run:
                net_qty = self.helper.get_net_quantity(str(self.pe_id))
                if net_qty < 0:
                    buy_oid = self.helper.buy(str(self.pe_id), abs(net_qty))
                    if buy_oid:
                        actual_exit = self.get_execution_price(buy_oid, pe_ltp)
                    else:
                        logger.critical(
                            f"PE SL exit order FAILED (buy returned None). "
                            f"Marking leg inactive at LTP {actual_exit:.2f} to prevent a duplicate order. "
                            f"Verify PE position manually!"
                        )
                    do_state_update = True
                else:
                    logger.warning(f"PE net qty {net_qty} — already flat, marking inactive.")
                    do_state_update = True
            else:
                logger.info(f"[DRY RUN] PE SL exit at {actual_exit:.2f}")
                do_state_update = True
            if do_state_update:
                realized = (self.pe_avg_price - actual_exit) * (self.pe_lots * self.nifty_lot_size)
                self.realized_pnl += realized
                logger.info(
                    f"PE leg closed at {actual_exit:.2f}. Leg realized: {realized:+.2f}. "
                    f"Watching for re-entry at <= {self.pe_original_entry_premium:.2f}"
                )
                self.pe_avg_price = 0.0
                self.pe_lots = 0
                self.pe_active = False

        # --- CE: Re-entry Check ---
        if not self.ce_active and ce_ltp > 0 and ce_ltp <= self.ce_original_entry_premium:
            logger.info(
                f"CE Re-entry! LTP {ce_ltp:.2f} <= original entry {self.ce_original_entry_premium:.2f}"
            )
            actual_entry = ce_ltp
            success = True
            if not self.dry_run:
                sell_oid = self.helper.sell(str(self.ce_id), self.initial_lots * self.nifty_lot_size)
                if sell_oid:
                    actual_entry = self.get_execution_price(sell_oid, ce_ltp)
                else:
                    logger.error("CE re-entry sell order failed. Will retry next tick.")
                    success = False
            else:
                logger.info(f"[DRY RUN] CE re-entry at {actual_entry:.2f}")
            if success:
                self.ce_avg_price = actual_entry
                self.ce_lots = self.initial_lots
                self.ce_sl = round(actual_entry * (1 + self.leg_sl_pct), 2)
                self.ce_active = True
                logger.info(f"CE Re-entered at {actual_entry:.2f} | New SL: {self.ce_sl:.2f}")

        # --- PE: Re-entry Check ---
        if not self.pe_active and pe_ltp > 0 and pe_ltp <= self.pe_original_entry_premium:
            logger.info(
                f"PE Re-entry! LTP {pe_ltp:.2f} <= original entry {self.pe_original_entry_premium:.2f}"
            )
            actual_entry = pe_ltp
            success = True
            if not self.dry_run:
                sell_oid = self.helper.sell(str(self.pe_id), self.initial_lots * self.nifty_lot_size)
                if sell_oid:
                    actual_entry = self.get_execution_price(sell_oid, pe_ltp)
                else:
                    logger.error("PE re-entry sell order failed. Will retry next tick.")
                    success = False
            else:
                logger.info(f"[DRY RUN] PE re-entry at {actual_entry:.2f}")
            if success:
                self.pe_avg_price = actual_entry
                self.pe_lots = self.initial_lots
                self.pe_sl = round(actual_entry * (1 + self.leg_sl_pct), 2)
                self.pe_active = True
                logger.info(f"PE Re-entered at {actual_entry:.2f} | New SL: {self.pe_sl:.2f}")

    def exit_all_positions(self, reason):
        logger.warning(f"!!! EXITING ALL POSITIONS: {reason} !!!")
        if not self.dry_run:
            # 1. Buy back short options
            if self.ce_id:
                try:
                    net_qty = self.helper.get_net_quantity(str(self.ce_id))
                    if net_qty < 0:
                        qty_to_buy = abs(net_qty)
                        ce_exit_id = self.helper.buy(str(self.ce_id), qty_to_buy)
                        logger.info(f"CE short exit order placed for {qty_to_buy} qty: {ce_exit_id}")
                    else:
                        logger.info(f"CE position already flat or long (Net Qty: {net_qty}). Skipping buy-to-close.")
                except Exception as e:
                    logger.error(f"Exit CE Error: {e}")
            if self.pe_id:
                try:
                    net_qty = self.helper.get_net_quantity(str(self.pe_id))
                    if net_qty < 0:
                        qty_to_buy = abs(net_qty)
                        pe_exit_id = self.helper.buy(str(self.pe_id), qty_to_buy)
                        logger.info(f"PE short exit order placed for {qty_to_buy} qty: {pe_exit_id}")
                    else:
                        logger.info(f"PE position already flat or long (Net Qty: {net_qty}). Skipping buy-to-close.")
                except Exception as e:
                    logger.error(f"Exit PE Error: {e}")
            
            # 2. Sell back long wings
            for wing in self.ce_wings:
                try:
                    net_qty = self.helper.get_net_quantity(str(wing['id']))
                    if net_qty > 0:
                        qty_to_sell = net_qty
                        wing_exit_id = self.helper.sell(str(wing['id']), qty_to_sell)
                        logger.info(f"CE long wing {wing['strike']} exit order placed for {qty_to_sell} qty: {wing_exit_id}")
                    else:
                        logger.info(f"CE long wing {wing['strike']} already flat or short (Net Qty: {net_qty}). Skipping sell-to-close.")
                except Exception as e:
                    logger.error(f"Exit CE Wing strike {wing['strike']} Error: {e}")
            for wing in self.pe_wings:
                try:
                    net_qty = self.helper.get_net_quantity(str(wing['id']))
                    if net_qty > 0:
                        qty_to_sell = net_qty
                        wing_exit_id = self.helper.sell(str(wing['id']), qty_to_sell)
                        logger.info(f"PE long wing {wing['strike']} exit order placed for {qty_to_sell} qty: {wing_exit_id}")
                    else:
                        logger.info(f"PE long wing {wing['strike']} already flat or short (Net Qty: {net_qty}). Skipping sell-to-close.")
                except Exception as e:
                    logger.error(f"Exit PE Wing strike {wing['strike']} Error: {e}")
        else:
            logger.info(f"[DRY RUN] Simulating Exit of all positions.")

    def reset_session(self):
        """Resets session-specific variables for a new entry cycle."""
        if self.ce_id and self.pe_id:
            logger.info(f"Unsubscribing from old short strikes: {self.ce_id}, {self.pe_id}")
            try:
                self.helper.unsubscribe_instruments([
                    ("NSE_FNO", str(self.ce_id), 15),
                    ("NSE_FNO", str(self.pe_id), 15)
                ])
            except: pass

        # Unsubscribe from wings
        for wing in self.ce_wings:
            try: self.helper.unsubscribe_instruments([("NSE_FNO", str(wing['id']), 15)])
            except: pass
        for wing in self.pe_wings:
            try: self.helper.unsubscribe_instruments([("NSE_FNO", str(wing['id']), 15)])
            except: pass

        self.ce_strike = None
        self.pe_strike = None
        self.initial_ce_strike = None
        self.initial_pe_strike = None
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
        self.ce_wings = []
        self.pe_wings = []
        self.ce_active = False
        self.pe_active = False
        self.ce_sl = 0.0
        self.pe_sl = 0.0
        self.ce_original_entry_premium = 0.0
        self.pe_original_entry_premium = 0.0
        logger.info("Session state reset.")

    def find_rebalance_strike(self, option_type, target_value, lots, chain_df, spot):
        """
        Finds an OTM strike for the given option_type (CE/PE) such that:
        lots * price is close to target_value.
        We filter to ensure the strike is OTM relative to the current spot.
        """
        if lots <= 0 or chain_df.empty:
            return None, 0.0
            
        prefix = option_type.lower()
        price_col = f"{prefix}_last_price"
        
        if price_col not in chain_df.columns:
            logger.error(f"Price column {price_col} not found in option chain.")
            return None, 0.0

        target_price = target_value / lots
        
        # Filter valid and OTM prices
        valid_df = chain_df[chain_df[price_col] > 0].copy()
        if option_type == "CE":
            valid_df = valid_df[valid_df.index > spot]
        else:
            valid_df = valid_df[valid_df.index < spot]
            
        if valid_df.empty:
            logger.warning(f"No valid OTM strikes found for {option_type}.")
            return None, 0.0
            
        valid_df['diff'] = abs(valid_df[price_col] - target_price)
        best_row = valid_df.sort_values('diff').iloc[0]
        
        try:
            return int(float(best_row.name)), float(best_row[price_col])
        except:
            return None, 0.0

    def select_strikes(self, nifty_spot, chain_df):
        """Selects CE and PE strikes based on straddle or strangle selection (distance, delta, or premium)."""
        logger.info(f"Selecting strikes for Nifty Spot: {nifty_spot:.2f} using entry type: {self.entry_type}...")
        
        if self.entry_type == "straddle":
            ce_strike = int(round(nifty_spot / 50) * 50)
            pe_strike = ce_strike
            logger.info(f"Straddle ATM Selection: {ce_strike} CE / PE")
            return ce_strike, pe_strike
            
        elif self.entry_type == "strangle":
            ce_strike = None
            pe_strike = None
            
            if self.use_premium:
                if chain_df.empty:
                    logger.warning("Empty option chain for premium selection. Falling back to distance offset.")
                else:
                    # Filter CE: must have last price > 0 and be OTM (strike > spot)
                    ce_df = chain_df[(chain_df['ce_last_price'] > 0) & (chain_df.index > nifty_spot)].copy()
                    if not ce_df.empty:
                        below_ce = ce_df[ce_df['ce_last_price'] <= self.target_premium]
                        if not below_ce.empty:
                            ce_strike = int(float(below_ce['ce_last_price'].idxmax()))
                        else:
                            ce_df['diff'] = abs(ce_df['ce_last_price'] - self.target_premium)
                            ce_strike = int(float(ce_df.sort_values('diff').index[0]))
                    else:
                        ce_strike = int(round((nifty_spot + self.ce_offset) / 50) * 50)

                    # Filter PE: must have last price > 0 and be OTM (strike < spot)
                    pe_df = chain_df[(chain_df['pe_last_price'] > 0) & (chain_df.index < nifty_spot)].copy()
                    if not pe_df.empty:
                        below_pe = pe_df[pe_df['pe_last_price'] <= self.target_premium]
                        if not below_pe.empty:
                            pe_strike = int(float(below_pe['pe_last_price'].idxmax()))
                        else:
                            pe_df['diff'] = abs(pe_df['pe_last_price'] - self.target_premium)
                            pe_strike = int(float(pe_df.sort_values('diff').index[0]))
                    else:
                        pe_strike = int(round((nifty_spot - self.pe_offset) / 50) * 50)

                    ce_price = chain_df.loc[float(ce_strike), 'ce_last_price'] if float(ce_strike) in chain_df.index else 0.0
                    pe_price = chain_df.loc[float(pe_strike), 'pe_last_price'] if float(pe_strike) in chain_df.index else 0.0
                    logger.info(f"Premium Strangle Selection: CE {ce_strike} (Price: {ce_price:.2f}) | PE {pe_strike} (Price: {pe_price:.2f}) [Target: <= {self.target_premium:.2f}]")

            if ce_strike is None or pe_strike is None:
                if self.use_delta:
                    if chain_df.empty:
                        logger.warning("Empty option chain for delta selection. Falling back to distance offset.")
                    else:
                        greek_df = chain_df[(chain_df['ce_delta'] != 0) | (chain_df['pe_delta'] != 0)].copy()
                        if greek_df.empty:
                            logger.warning("No Greeks found in option chain. Falling back to distance selection.")
                        else:
                            greek_df['ce_delta_diff'] = abs(abs(greek_df['ce_delta']) - self.target_delta)
                            greek_df['pe_delta_diff'] = abs(abs(greek_df['pe_delta']) - self.target_delta)
                            
                            ce_strike = int(greek_df.sort_values('ce_delta_diff').index[0])
                            pe_strike = int(greek_df.sort_values('pe_delta_diff').index[0])
                            
                            logger.info(f"Delta Strangle Selection: CE {ce_strike} (Delta: {greek_df.loc[ce_strike, 'ce_delta']:.2f}) | PE {pe_strike} (Delta: {greek_df.loc[pe_strike, 'pe_delta']:.2f})")
                
            if ce_strike is None or pe_strike is None:
                # Distance offset fallback or standard
                ce_strike = int(round((nifty_spot + self.ce_offset) / 50) * 50)
                pe_strike = int(round((nifty_spot - self.pe_offset) / 50) * 50)
                logger.info(f"Distance Strangle Selection: {ce_strike} CE (+{self.ce_offset}) | {pe_strike} PE (-{self.pe_offset})")

            # Check for inverted strikes
            if ce_strike <= pe_strike:
                logger.error(f"Inverted strikes detected! CE strike {ce_strike} must be strictly greater than PE strike {pe_strike}. Bypassing selection.")
                return None, None
            return ce_strike, pe_strike
            
        return None, None

    def run(self):
        exit_if_market_closed(self.helper, self.dry_run)
        logger.info(f"Starting Nifty Advanced Imbalance Strategy | Mode: {self.mode} | Dry Run: {self.dry_run} | Start Time: {self.start_time}")
        
        while True:
            # Check shutdown trigger
            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request in outer loop.")
                self.save_state(0, 0, 0, 0, status="STOPPED")
                sys.exit(0)
            self.save_state(0, 0, 0, 0, status="INITIALIZING")

            # Wait for market open if closed
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

            self.ce_strike, self.pe_strike = self.select_strikes(nifty_spot, chain_df)
            if not self.ce_strike or not self.pe_strike:
                logger.error("Strike selection failed. Retrying in 10s...")
                time.sleep(10)
                continue
            self.initial_ce_strike = self.ce_strike
            self.initial_pe_strike = self.pe_strike
            
            # Check shutdown trigger before option quote fetches
            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request before option quote fetches.")
                self.save_state(nifty_spot, 0, 0, 0.0, status="STOPPED")
                sys.exit(0)

            ce_quote = self.helper.option("NIFTY", self.ce_strike, "CE")
            pe_quote = self.helper.option("NIFTY", self.pe_strike, "PE")
                
            # Fallback to chain_df if initial quotes fail
            if (self.is_quote_invalid(ce_quote) or self.is_quote_invalid(pe_quote)) and not chain_df.empty:
                logger.warning("Initial helper.option() failed. Falling back to option chain...")
                if self.is_quote_invalid(ce_quote) and float(self.ce_strike) in chain_df.index:
                    ce_quote = chain_df.loc[float(self.ce_strike)].to_dict()
                if self.is_quote_invalid(pe_quote) and float(self.pe_strike) in chain_df.index:
                    pe_quote = chain_df.loc[float(self.pe_strike)].to_dict()

            # Extract fields from quotes
            self.ce_id, self.ce_avg_price, self.expiry, self.nifty_lot_size, self.ce_symbol_name = \
                self._extract_quote_fields(ce_quote, self.ce_strike, "CE")

            self.pe_id, self.pe_avg_price, _, _, self.pe_symbol_name = \
                self._extract_quote_fields(pe_quote, self.pe_strike, "PE")

            if not self.ce_id or not self.pe_id:
                logger.error(f"Initial quotes failed for CE {self.ce_strike} / PE {self.pe_strike}. Waiting 1m.")
                time.sleep(60)
                continue
            
            logger.info(f"New Cycle: {self.ce_strike}CE / {self.pe_strike}PE | Lot Size: {self.nifty_lot_size} | Expiry: {self.expiry}")
            
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
                time.sleep(2) # Wait for initial ticks
            except Exception as e:
                logger.error(f"Failed to subscribe to WebSocket: {e}")
            
            # Wait for premiums to balance
            target_diff = 10.0 if self.entry_type == "straddle" else 25.0
            logger.info(f"Waiting for premiums to balance (Target: < {target_diff}%)...")
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

                if datetime.now().strftime("%H:%M") >= "15:17":
                    logger.info("Market nearing close. Waiting for next cycle...")
                    break

                # Check if ATM or Spot has changed while waiting
                if spot > 0:
                    if self.entry_type == "straddle":
                        current_atm = int(round(spot / 50) * 50)
                        if current_atm != self.ce_strike:
                            logger.info(f"ATM strike shifted from {self.ce_strike} to {current_atm} (Spot: {spot:.2f}). Restarting entry cycle...")
                            break
                    else:
                        if abs(spot - nifty_spot) >= 50:
                            logger.info(f"Nifty Spot shifted from {nifty_spot:.2f} to {spot:.2f} (>= 50 pts). Restarting entry cycle...")
                            break

                if ce_price > 0 and pe_price > 0:
                    max_prem = max(ce_price, pe_price)
                    diff_pct = abs(ce_price - pe_price) / max_prem * 100
                    logger.info(f"Waiting for Balance... CE: {ce_price:.2f} | PE: {pe_price:.2f} | Diff: {diff_pct:.1f}% (Target: < {target_diff}%)")
                    if diff_pct < target_diff:
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

            if self.mode == "reentry_straddle":
                self.ce_active = True
                self.pe_active = True
                self.ce_original_entry_premium = self.ce_avg_price
                self.pe_original_entry_premium = self.pe_avg_price
                self.ce_sl = round(self.ce_avg_price * (1 + self.leg_sl_pct), 2)
                self.pe_sl = round(self.pe_avg_price * (1 + self.leg_sl_pct), 2)
                logger.info(
                    f"Reentry Straddle Started | "
                    f"CE: {self.ce_avg_price:.2f} (SL: {self.ce_sl:.2f}) | "
                    f"PE: {self.pe_avg_price:.2f} (SL: {self.pe_sl:.2f})"
                )

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

                if curr_nifty == 0: curr_nifty = nifty_spot

                # Save current state
                self.save_state(curr_nifty, ce_ltp, pe_ltp, total_pnl, status="RUNNING")

                # --- Phase 5: Position Shift ---
                if self.entry_type == "straddle":
                    current_atm = int(round(curr_nifty / 50) * 50)
                    if abs(current_atm - self.initial_ce_strike) >= 100:
                        self.exit_all_positions(
                            f"Straddle Shift! Current ATM strike {current_atm} shifted 100pts or more "
                            f"from original strike {self.initial_ce_strike} (Spot: {curr_nifty:.2f})"
                        )
                        logger.info("Waiting 5 minutes before re-centering straddle...")
                        self.sleep_cooldown(300)
                        cycle_active = False
                        break
                else:
                    # Strangle exit boundaries:
                    # - If a strike is at its initial OTM level or has been rolled further OTM (outer roll), it acts as a hard boundary.
                    # - If a strike has been rolled closer to ATM (inner roll), it gets a 100-point buffer to allow market wiggles.
                    if self.ce_strike < self.initial_ce_strike:
                        # CE rolled closer to ATM (downward inner roll) -> 100pt buffer above it
                        upper_bound = self.ce_strike + 100
                    else:
                        # CE is at initial strike or rolled further OTM -> hard boundary
                        upper_bound = self.ce_strike
                        
                    if self.pe_strike > self.initial_pe_strike:
                        # PE rolled closer to ATM (upward inner roll) -> 100pt buffer below it
                        lower_bound = self.pe_strike - 100
                    else:
                        # PE is at initial strike or rolled further OTM -> hard boundary
                        lower_bound = self.pe_strike

                    if curr_nifty >= upper_bound or curr_nifty <= lower_bound:
                        self.exit_all_positions(
                            f"Strangle Shift! Market breached strike boundary! Nifty: {curr_nifty:.2f} "
                            f"(Boundaries: {lower_bound} - {upper_bound})"
                        )
                        logger.info("Waiting 5 minutes before re-centering strangle...")
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
                    if not self.helper.wait_for_next_day_market_open(self.dry_run, start_time=self.start_time, shutdown_check=lambda: check_shutdown_trigger(self.state_key)):
                        self.save_state(0, 0, 0, 0, status="STOPPED")
                        sys.exit(0)
                    cycle_active = False
                    break
                if total_pnl <= self.stop_loss:
                    self.exit_all_positions(f"Global Stop Loss Hit: {total_pnl:.2f}")
                    if not self.helper.wait_for_next_day_market_open(self.dry_run, start_time=self.start_time, shutdown_check=lambda: check_shutdown_trigger(self.state_key)):
                        self.save_state(0, 0, 0, 0, status="STOPPED")
                        sys.exit(0)
                    cycle_active = False
                    break

                # --- MODE 5: reentry_straddle (independent per-leg SL + re-entry) ---
                if self.mode == "reentry_straddle":
                    # Periodic logging
                    if time.time() - last_log_time >= 5:
                        ce_status = f"ACTIVE SL:{self.ce_sl:.1f}" if self.ce_active else f"FLAT(reenter@<={self.ce_original_entry_premium:.1f})"
                        pe_status = f"ACTIVE SL:{self.pe_sl:.1f}" if self.pe_active else f"FLAT(reenter@<={self.pe_original_entry_premium:.1f})"
                        logger.info(
                            f"ReentryStraddle | CE:{ce_ltp:.1f} [{ce_status}] | "
                            f"PE:{pe_ltp:.1f} [{pe_status}] | "
                            f"PnL:{total_pnl:+.0f} (Real:{self.realized_pnl:+.0f})"
                        )
                        last_log_time = time.time()

                    self._handle_reentry_sl_and_entry(ce_ltp, pe_ltp)
                    continue  # skip imbalance-based adjustment logic

                ce_val = self.ce_lots * ce_ltp
                pe_val = self.pe_lots * pe_ltp
                max_val = max(ce_val, pe_val) if max(ce_val, pe_val) > 0 else 1
                diff_pct = abs(ce_val - pe_val) / max_val * 100

                if time.time() - last_log_time >= 5:
                    curr_nifty = self.helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")
                    self.log_state(curr_nifty or nifty_spot, ce_ltp, pe_ltp, ce_val, pe_val, diff_pct, total_pnl)
                    last_log_time = time.time()

                if self.last_adjustment_time == current_bar: continue

                winner = "CE" if ce_val < pe_val else "PE"
                loser = "PE" if ce_val < pe_val else "CE"
                winner_lots = self.ce_lots if winner == "CE" else self.pe_lots
                loser_lots = self.pe_lots if winner == "CE" else self.ce_lots

                # --- ADJUSTMENT TRIGGERS ---
                active_thresh = (self.threshold_strike if (self.ce_lots == self.max_lots or self.pe_lots == self.max_lots) else self.threshold_lot) + self.entry_diff_pct
                if diff_pct > active_thresh:
                    
                    # --- MODE 1: winner_roll_atm (Value-balanced Winner Roll) ---
                    if self.mode == "winner_roll_atm":
                        logger.info(f"!!! Winner Value-balanced Roll Triggered !!! Diff: {diff_pct:.2f}%")

                        # Early deadlock detection: in a straddle (or when strikes have converged),
                        # rolling the winner closer to ATM requires crossing the opposite leg — impossible.
                        # PE winner needs to go UP but can't exceed CE strike; CE winner needs to go DOWN but can't go below PE strike.
                        if winner == "PE" and self.pe_strike + 50 >= self.ce_strike:
                            self.exit_all_positions(
                                f"Structural deadlock: PE winner at {self.pe_strike} has no room to roll "
                                f"closer to ATM without crossing CE at {self.ce_strike}. Exiting cycle."
                            )
                            logger.info("Waiting 5 minutes before restart...")
                            self.sleep_cooldown(300)
                            cycle_active = False
                            break
                        elif winner == "CE" and self.ce_strike - 50 <= self.pe_strike:
                            self.exit_all_positions(
                                f"Structural deadlock: CE winner at {self.ce_strike} has no room to roll "
                                f"closer to ATM without crossing PE at {self.pe_strike}. Exiting cycle."
                            )
                            logger.info("Waiting 5 minutes before restart...")
                            self.sleep_cooldown(300)
                            cycle_active = False
                            break

                        chain_df = self.helper.get_option_chain_df("NIFTY", self.expiry)
                        if chain_df.empty:
                            logger.warning("Option Chain empty. Skipping adjustment loop.")
                            continue

                        loser_val = pe_val if winner == "CE" else ce_val
                        new_strike, new_price = self.find_rebalance_strike(winner, loser_val, winner_lots, chain_df, curr_nifty)
                        current_winner_strike = self.ce_strike if winner == "CE" else self.pe_strike

                        if new_strike and new_strike != current_winner_strike:
                            # Prevent strike inversion during winner roll - exit cycle
                            if (winner == "CE" and new_strike <= self.pe_strike) or (winner == "PE" and new_strike >= self.ce_strike):
                                self.exit_all_positions(
                                    f"Blocked strike inversion adjustment (winner roll): new {winner} strike {new_strike} "
                                    f"would cross/equal opposite leg. Exiting cycle."
                                )
                                logger.info("Waiting 5 minutes before restart...")
                                self.sleep_cooldown(300)
                                cycle_active = False
                                break

                            # Roll winner to new strike
                            old_id = str(self.ce_id) if winner == "CE" else str(self.pe_id)
                            old_avg = self.ce_avg_price if winner == "CE" else self.pe_avg_price
                            exit_price = self.helper.get_ltp(old_id, exchange="NSE_FNO", instrument="OPTIDX")
                            
                            if exit_price > 0:
                                buy_oid = None
                                if not self.dry_run:
                                    buy_oid = self.helper.buy(old_id, winner_lots * self.nifty_lot_size)
                                    if not buy_oid:
                                        logger.error(f"Failed to buy-to-close old winner {old_id}. Aborting adjustment.")
                                        continue
                                actual_exit_price = self.get_execution_price(buy_oid, exit_price) if buy_oid else exit_price
                                
                                realized = (old_avg - actual_exit_price) * (winner_lots * self.nifty_lot_size)
                                self.realized_pnl += realized
                                
                                new_quote = self.helper.option("NIFTY", new_strike, winner)
                                if self.is_quote_invalid(new_quote) and not chain_df.empty:
                                    if float(new_strike) in chain_df.index:
                                        new_quote = chain_df.loc[float(new_strike)].to_dict()
                                        
                                new_id, price_from_quote, _, lot_size, symbol_name = \
                                    self._extract_quote_fields(new_quote, new_strike, winner)
                                
                                if new_id:
                                    self.nifty_lot_size = lot_size
                                    new_price = price_from_quote if price_from_quote > 0 else new_price
                                    
                                    # Update WS subscription
                                    try:
                                        self.helper.unsubscribe_instruments([("NSE_FNO", str(old_id), 15)])
                                        self.helper.subscribe_instruments([("NSE_FNO", str(new_id), 15)])
                                    except Exception as ws_err:
                                        logger.error(f"WebSocket update failed: {ws_err}")
                                        
                                    sell_oid = None
                                    if not self.dry_run:
                                        sell_oid = self.helper.sell(str(new_id), winner_lots * self.nifty_lot_size)
                                        if not sell_oid:
                                            logger.critical(f"CRITICAL ERROR: Failed to place sell order for new winner strike {new_id}! Executing emergency exit.")
                                            try:
                                                self.helper.unsubscribe_instruments([("NSE_FNO", str(new_id), 15)])
                                            except Exception:
                                                pass
                                            self.exit_all_positions("Winner roll sell order failed")
                                            cycle_active = False
                                            break
                                    actual_entry_price = self.get_execution_price(sell_oid, new_price) if sell_oid else new_price
                                    
                                    if winner == "CE":
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
                        else:
                            logger.info(f"Winner strike is already at target value-balancing strike {new_strike}. Rolling skipped.")
                            self.last_adjustment_time = current_bar  # prevent per-second retriggers
                            continue

                    # --- MODE 2: loser_ratio_roll (OTM Roll with Quantity Increment) ---
                    elif self.mode == "loser_ratio_roll":
                        logger.info(f"!!! Loser Ratio Roll Triggered !!! Diff: {diff_pct:.2f}%")
                        chain_df = self.helper.get_option_chain_df("NIFTY", self.expiry)
                        if chain_df.empty:
                            logger.warning("Option Chain empty. Skipping adjustment loop.")
                            continue
                            
                        # Increment lot count up to max lots
                        new_loser_lots = min(self.max_lots, loser_lots + self.loser_ratio_lots)
                        if new_loser_lots == loser_lots:
                            self.exit_all_positions(f"Loser already at max lots ({self.max_lots}). Exiting.")
                            cycle_active = False
                            break
                            
                        winner_val = ce_val if loser == "PE" else pe_val
                        new_strike, new_price = self.find_rebalance_strike(loser, winner_val, new_loser_lots, chain_df, curr_nifty)
                        
                        if new_strike:
                            # Prevent strike inversion during loser ratio roll - exit cycle
                            if (loser == "CE" and new_strike <= self.pe_strike) or (loser == "PE" and new_strike >= self.ce_strike):
                                self.exit_all_positions(
                                    f"Blocked strike inversion adjustment (loser ratio roll): new {loser} strike {new_strike} "
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
                                        logger.error(f"Failed to buy-to-close old loser leg. Aborting adjustment.")
                                        continue
                                actual_exit_price = self.get_execution_price(buy_oid, exit_price) if buy_oid else exit_price
                                
                                realized = (old_avg - actual_exit_price) * (loser_lots * self.nifty_lot_size)
                                self.realized_pnl += realized
                                
                                new_quote = self.helper.option("NIFTY", new_strike, loser)
                                if self.is_quote_invalid(new_quote) and not chain_df.empty:
                                    if float(new_strike) in chain_df.index:
                                        new_quote = chain_df.loc[float(new_strike)].to_dict()
                                        
                                new_id, price_from_quote, _, lot_size, symbol_name = \
                                    self._extract_quote_fields(new_quote, new_strike, loser)
                                    
                                if new_id:
                                    self.nifty_lot_size = lot_size
                                    new_price = price_from_quote if price_from_quote > 0 else new_price
                                    
                                    try:
                                        self.helper.unsubscribe_instruments([("NSE_FNO", str(old_id), 15)])
                                        self.helper.subscribe_instruments([("NSE_FNO", str(new_id), 15)])
                                    except Exception as ws_err:
                                        logger.error(f"WebSocket update failed: {ws_err}")
                                        
                                    sell_oid = None
                                    if not self.dry_run:
                                        sell_oid = self.helper.sell(str(new_id), new_loser_lots * self.nifty_lot_size)
                                        if not sell_oid:
                                            logger.critical(f"CRITICAL ERROR: Failed to place sell order for new OTM loser strike {new_id}! Executing emergency exit.")
                                            try:
                                                self.helper.unsubscribe_instruments([("NSE_FNO", str(new_id), 15)])
                                            except Exception:
                                                pass
                                            self.exit_all_positions("Loser roll sell order failed")
                                            cycle_active = False
                                            break
                                    actual_entry_price = self.get_execution_price(sell_oid, new_price) if sell_oid else new_price
                                    
                                    if loser == "CE":
                                        self.ce_strike = new_strike
                                        self.ce_symbol_name = symbol_name
                                        self.ce_id = new_id
                                        self.ce_avg_price = actual_entry_price
                                        self.ce_lots = new_loser_lots
                                    else:
                                        self.pe_strike = new_strike
                                        self.pe_symbol_name = symbol_name
                                        self.pe_id = new_id
                                        self.pe_avg_price = actual_entry_price
                                        self.pe_lots = new_loser_lots
                                        
                                    self.adjustment_count += 1
                                    self.last_adjustment_time = current_bar
                                    self.update_baseline_imbalance()
                            continue

                    # --- MODE 3: hedged_addition (Short Winner + Buy Protective Wing) ---
                    elif self.mode == "hedged_addition":
                        if winner_lots < self.max_lots:
                            logger.info(f"!!! Hedged Addition Triggered !!! Diff: {diff_pct:.2f}%")
                            winner_id = str(self.ce_id) if winner == "CE" else str(self.pe_id)
                            winner_strike = self.ce_strike if winner == "CE" else self.pe_strike
                            new_price = self.helper.get_ltp(winner_id, exchange="NSE_FNO", instrument="OPTIDX")
                            
                            # Select wing strike (200 points OTM)
                            wing_strike = winner_strike + 200 if winner == "CE" else winner_strike - 200
                            wing_quote = self.helper.option("NIFTY", wing_strike, winner)
                            
                            wing_id, wing_price, _, _, symbol_name = \
                                self._extract_quote_fields(wing_quote, wing_strike, winner)
                                
                            if wing_id and new_price > 0:
                                # 1. Buy Wing First (Safety First)
                                wing_oid = None
                                if not self.dry_run:
                                    wing_oid = self.helper.buy(str(wing_id), self.nifty_lot_size)
                                    if not wing_oid:
                                        logger.error(f"Failed to place buy-to-open order for protective wing {wing_id}. Aborting short adjustment.")
                                        continue
                                exec_wing_price = self.get_execution_price(wing_oid, wing_price) if wing_oid else wing_price
                                
                                # 2. Sell short option
                                sell_oid = None
                                if not self.dry_run:
                                    sell_oid = self.helper.sell(winner_id, self.nifty_lot_size)
                                    if not sell_oid:
                                        logger.critical(f"Failed to place sell order for short leg {winner_id}! Close protective wing to prevent unmatched long.")
                                        try: self.helper.sell(str(wing_id), self.nifty_lot_size)
                                        except Exception as close_err: logger.error(f"Failed to dump protective wing: {close_err}")
                                        continue
                                exec_short_price = self.get_execution_price(sell_oid, new_price) if sell_oid else new_price
                                
                                # Subscribe both winner and wing to websocket
                                try:
                                    self.helper.subscribe_instruments([("NSE_FNO", str(wing_id), 15)])
                                except Exception as ws_err:
                                    logger.error(f"WebSocket update failed for wing: {ws_err}")
                                    
                                # 3. Update state
                                if winner == "CE":
                                    self.ce_avg_price = ((self.ce_avg_price * self.ce_lots) + exec_short_price) / (self.ce_lots + 1)
                                    self.ce_lots += 1
                                    self.ce_wings.append({
                                        'id': wing_id,
                                        'lots': 1,
                                        'strike': wing_strike,
                                        'buy_price': exec_wing_price,
                                        'symbol': symbol_name
                                    })
                                else:
                                    self.pe_avg_price = ((self.pe_avg_price * self.pe_lots) + exec_short_price) / (self.pe_lots + 1)
                                    self.pe_lots += 1
                                    self.pe_wings.append({
                                        'id': wing_id,
                                        'lots': 1,
                                        'strike': wing_strike,
                                        'buy_price': exec_wing_price,
                                        'symbol': symbol_name
                                    })
                                    
                                self.adjustment_count += 1
                                self.last_adjustment_time = current_bar
                                self.update_baseline_imbalance()
                            continue
                        else:
                            self.exit_all_positions(f"Winner leg ({winner}) already at max lots ({self.max_lots}). Exiting.")
                            cycle_active = False
                            break

                    # --- MODE 4: legacy (Unhedged Winner Lot Addition) ---
                    else:
                        if winner_lots < self.max_lots:
                            logger.info(f"!!! Legacy Lot Addition !!! Diff: {diff_pct:.2f}%")
                            symbol_id = str(self.ce_id) if winner == "CE" else str(self.pe_id)
                            new_price = self.helper.get_ltp(symbol_id, exchange="NSE_FNO", instrument="OPTIDX")
                            
                            if new_price > 0:
                                oid = None
                                if not self.dry_run:
                                    oid = self.helper.sell(symbol_id, self.nifty_lot_size)
                                    if not oid:
                                        logger.error(f"Failed to place legacy short addition order for {symbol_id}. Aborting adjustment.")
                                        continue
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
                            self.exit_all_positions(f"Winner leg ({winner}) already at max lots ({self.max_lots}). Exiting.")
                            cycle_active = False
                            break

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Nifty Advanced Imbalance Strategy",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Available Adjustment Modes:
  winner_roll_atm  : Roll the untested/winner strike closer to spot to balance against losing leg's value (flat 1:1 lots)
  loser_ratio_roll : Roll the challenged loser strike further OTM and increase lots (OTM ratio)
  hedged_addition  : Sell winner leg lot (like legacy) but buy a further OTM protective wing (hedged)
  legacy           : Legacy lot addition on the winner leg (unhedged)
  reentry_straddle : Sell ATM straddle; each leg has an independent per-leg SL (see --leg-sl-pct);
                     stopped leg re-enters when its premium returns to the original entry level;
                     global profit/SL targets and straddle-shift exit still apply
                     (requires --entry-type straddle)

Examples:
  # Dry run with value-balanced winner roll adjustment
  python strategies/nifty_advanced_imbalance.py --mode winner_roll_atm

  # Live run with hedged addition adjustment, initial 2 lots
  python strategies/nifty_advanced_imbalance.py --live --lots 2 --mode hedged_addition

  # Dry run with reentry straddle (independent per-leg SL + re-entry)
  python strategies/nifty_advanced_imbalance.py --mode reentry_straddle --entry-type straddle
""")

    parser.add_argument("--mode", type=str, default="winner_roll_atm",
                        choices=["winner_roll_atm", "loser_ratio_roll", "hedged_addition", "legacy", "reentry_straddle"],
                        help="Select the adjustment strategy mode (default: winner_roll_atm)")
    
    parser.add_argument("--live", action="store_true", default=False,
                        help="Run in LIVE mode (default: dry run)")

    parser.add_argument("--lots", type=int, default=1, metavar="N",
                        help="Initial lots per leg (default: 1)")
    parser.add_argument("--max-lots", type=int, default=4, metavar="N",
                        help="Maximum lots per leg before triggering a strike shift (default: 4)")
    parser.add_argument("--threshold-lot", type=float, default=25.0, metavar="PCT",
                        help="Base premium imbalance %% (added to entry_diff_pct) that triggers an "
                             "adjustment while below --max-lots (default: 25.0)")

    parser.add_argument("--target-profit", type=str, default="4000", metavar="AMT",
                        help="Global profit target in INR, or a percentage of entry premium collected "
                             "e.g. '20%%' (default: 4000)")

    parser.add_argument("--stop-loss", type=str, default="4000", metavar="AMT",
                        help="Global stop loss in INR, or a percentage of entry premium collected "
                             "e.g. '20%%' (default: 4000)")

    parser.add_argument("--entry-type", type=str, default="straddle",
                        choices=["straddle", "strangle"],
                        help="Select the entry position type (default: straddle)")

    parser.add_argument("--delta", action="store_true", default=False,
                        help="Use delta-based strike selection for strangle (default: False)")

    parser.add_argument("--target-delta", type=float, default=0.20, metavar="D",
                        help="Target absolute delta in delta strangle mode (default: 0.20)")

    parser.add_argument("--premium", action="store_true", default=False,
                        help="Use premium-based strike selection for strangle (default: False)")

    parser.add_argument("--target-premium", type=float, default=50.0, metavar="PREM",
                        help="Target premium value for premium strangle mode (default: 50.0)")

    parser.add_argument("--ce-offset", type=int, default=200, metavar="PTS",
                        help="Points above spot for CE in distance strangle mode (default: 200)")

    parser.add_argument("--pe-offset", type=int, default=200, metavar="PTS",
                        help="Points below spot for PE in distance strangle mode (default: 200)")

    # Customizable Start Time
    parser.add_argument("--start-time", type=str, default="09:20", metavar="TIME",
                        help="Market start monitoring time (HH:MM IST, default: 09:20)")

    parser.add_argument("--loser-ratio-lots", type=int, default=1, metavar="N",
                        help="Number of lots to add for loser ratio roll (default: 1)")


    parser.add_argument("--leg-sl-pct", type=float, default=0.20, metavar="PCT",
                        help="Per-leg stop loss as a fraction of entry premium in reentry_straddle mode "
                             "(default: 0.20 = 20%%). E.g. 0.30 triggers SL at 130%% of entry price.")
    parser.add_argument("--trail-start-pct", type=float, default=5.0,
                        help="Activate trailing SL when profit reaches this %% of entry combined premium (default: 5.0)")
    parser.add_argument("--trail-gap-pts", type=float, default=15.0,
                        help="Exit if combined premium rises this many pts above its best level (default: 15.0)")
    parser.add_argument("--instance-id", type=str, default="", metavar="ID",
                        help="Suffix for debug/state files to run a second concurrent copy of this strategy")

    args = parser.parse_args()
    STATE_KEY = f"nifty_advanced_imbalance_{args.instance_id}" if args.instance_id else "nifty_advanced_imbalance"

    try:
        target_val, target_is_pct = parse_target_spec(args.target_profit)
        stop_val, stop_is_pct = parse_target_spec(args.stop_loss)
    except ValueError as e:
        logger.error(f"[CONFIG ERROR] {e}")
        sys.exit(1)

    # --- Configuration Validation ---
    _errors = []

    # winner_roll_atm requires a strangle: in a straddle both legs share the same ATM strike,
    # so rolling the winner closer to ATM always crosses the opposite leg (inversion).
    if args.mode == "winner_roll_atm" and args.entry_type == "straddle":
        _errors.append(
            "--mode winner_roll_atm is incompatible with --entry-type straddle.\n"
            "  Reason: in a straddle both legs are at the same ATM strike, so rolling the winner\n"
            "  closer to ATM immediately crosses/equals the opposite leg (strike inversion).\n"
            "  Fix: use --entry-type strangle with winner_roll_atm, OR switch to\n"
            "       --mode hedged_addition / loser_ratio_roll / legacy with straddle."
        )

    # reentry_straddle is inherently a straddle-only mode (ATM entry with per-leg SL/re-entry).
    if args.mode == "reentry_straddle" and args.entry_type != "straddle":
        _errors.append(
            "--mode reentry_straddle requires --entry-type straddle.\n"
            "  Reason: this mode sells ATM CE and PE and manages each leg independently."
        )


    # --leg-sl-pct only applies to reentry_straddle
    if args.leg_sl_pct != 0.20 and args.mode != "reentry_straddle":
        _errors.append(
            f"--leg-sl-pct {args.leg_sl_pct} has no effect in --mode {args.mode} "
            f"(only used with reentry_straddle)."
        )

    if args.leg_sl_pct <= 0:
        _errors.append(f"--leg-sl-pct must be > 0, got {args.leg_sl_pct}.")

    # --max-lots has no effect in reentry_straddle (always re-enters at initial lot size)
    if args.mode == "reentry_straddle" and args.max_lots != 4:
        _errors.append(
            f"--max-lots {args.max_lots} has no effect in --mode reentry_straddle "
            f"(this mode always re-enters at the initial lot size; "
            f"lot scaling is not used)."
        )

    # --delta and --premium are mutually exclusive strike selection methods
    if args.delta and args.premium:
        _errors.append(
            "--delta and --premium are mutually exclusive.\n"
            "  Use only one strike selection method at a time."
        )

    # Lot sizing sanity checks
    if args.lots < 1:
        _errors.append(f"--lots must be >= 1, got {args.lots}.")
    if args.max_lots < 1:
        _errors.append(f"--max-lots must be >= 1, got {args.max_lots}.")
    if args.threshold_lot <= 0:
        _errors.append(f"--threshold-lot must be > 0, got {args.threshold_lot}.")
    if args.lots > args.max_lots:
        _errors.append(
            f"--lots {args.lots} exceeds --max-lots ({args.max_lots}).\n"
            "  The initial lot count cannot exceed the adjustment ceiling."
        )

    # Strangle-only flags have no effect with straddle entry
    if args.entry_type == "straddle":
        if args.delta:
            _errors.append("--delta requires --entry-type strangle (straddle always enters at ATM, ignoring delta selection).")
        if args.premium:
            _errors.append("--premium requires --entry-type strangle (straddle always enters at ATM, ignoring premium selection).")
        if args.ce_offset != 200:
            _errors.append(f"--ce-offset {args.ce_offset} has no effect with --entry-type straddle (straddle always enters at ATM).")
        if args.pe_offset != 200:
            _errors.append(f"--pe-offset {args.pe_offset} has no effect with --entry-type straddle (straddle always enters at ATM).")

    # loser_ratio_roll-specific flag has no effect in other modes
    if args.loser_ratio_lots != 1 and args.mode != "loser_ratio_roll":
        _errors.append(
            f"--loser-ratio-lots {args.loser_ratio_lots} has no effect in --mode {args.mode} "
            f"(only used with loser_ratio_roll)."
        )

    # --target-delta has no effect without --delta
    if args.target_delta != 0.20 and not args.delta:
        _errors.append(f"--target-delta {args.target_delta} has no effect without --delta flag.")

    # --target-premium has no effect without --premium
    if args.target_premium != 50.0 and not args.premium:
        _errors.append(f"--target-premium {args.target_premium} has no effect without --premium flag.")

    if _errors:
        for e in _errors:
            logger.error(f"[CONFIG ERROR] {e}")
        logger.error("Aborting: fix the configuration errors above and retry.")
        sys.exit(1)
    # --- End Validation ---

    mode_label = "LIVE" if args.live else "DRY"
    stop_loss_val = abs(stop_val)

    selection_label = "distance"
    if args.entry_type == "strangle":
        if args.premium:
            selection_label = f"premium (<= {args.target_premium})"
        elif args.delta:
            selection_label = f"delta (target {args.target_delta})"
        else:
            selection_label = f"distance (CE +{args.ce_offset} | PE -{args.pe_offset})"

    target_label = f"{target_val:.0f}%" if target_is_pct else f"INR {target_val:.0f}"
    stop_label = f"-{stop_loss_val:.0f}%" if stop_is_pct else f"-INR {stop_loss_val:.0f}"
    logger.info(
        f"Config -> Mode: {mode_label} | Sizing: {args.lots}L | Start Time: {args.start_time} | Entry Type: {args.entry_type} ({selection_label}) | "
        f"Adjustment Mode: {args.mode} (Loser Ratio Lots: {args.loser_ratio_lots}, Threshold Lot: {args.threshold_lot}%) | Profit Target: {target_label} | Stop Loss: {stop_label}"
    )

    strat = NiftyAdvancedImbalance(
        mode=args.mode,
        dry_run=not args.live,
        initial_lots=args.lots,
        max_lots=args.max_lots,
        threshold_lot=args.threshold_lot,
        profit_target=target_val,
        profit_target_is_pct=target_is_pct,
        stop_loss=stop_loss_val,
        stop_loss_is_pct=stop_is_pct,
        entry_type=args.entry_type,
        use_delta=args.delta,
        target_delta=args.target_delta,
        ce_offset=args.ce_offset,
        pe_offset=args.pe_offset,
        use_premium=args.premium,
        target_premium=args.target_premium,
        start_time=args.start_time,
        loser_ratio_lots=args.loser_ratio_lots,
        leg_sl_pct=args.leg_sl_pct,
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
