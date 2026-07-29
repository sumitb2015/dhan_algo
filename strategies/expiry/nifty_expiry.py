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
from lib.strategy_state_helper import save_strategy_state, check_shutdown_trigger, exit_if_market_closed, parse_target_spec

# Setup Logging
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
debug_dir = os.path.join(project_root, "debug")
os.makedirs(debug_dir, exist_ok=True)

class FlushingFileHandler(logging.FileHandler):
    def emit(self, record):
        super().emit(record)
        self.flush()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        FlushingFileHandler(os.path.join(debug_dir, f"expiry_{datetime.now().strftime('%Y%m%d')}.log"))
    ],
    force=True
)
logger = logging.getLogger(__name__)

class NiftyExpiry:
    def __init__(self, dry_run=True, lots=1, entry_type="straddle",
                 ce_offset=100, pe_offset=100,
                 use_delta=False, target_delta=0.20,
                 use_premium=False, target_premium=50.0,
                 leg_sl_pct=40.0, adjustment_mode="c2c", max_adjustments=3,
                 profit_target=4000.0, profit_target_is_pct=False,
                 stop_loss=4000.0, stop_loss_is_pct=False,
                 start_time="09:20", eod_time="15:15",
                 imbalance_threshold=50.0, max_lots=4, min_adjust_price=10.0,
                 post_sl_balance=False, product_type="INTRADAY"):
        self.dry_run = dry_run
        self.lots = lots
        self.entry_type = entry_type.lower()
        self.ce_offset = ce_offset
        self.pe_offset = pe_offset
        self.use_delta = use_delta
        self.target_delta = target_delta
        self.use_premium = use_premium
        self.target_premium = target_premium
        self.leg_sl_pct = leg_sl_pct
        self.adjustment_mode = adjustment_mode.lower()
        self.max_adjustments = max_adjustments
        # Target/SL may be an absolute INR amount or a percentage of entry premium
        # collected (resolved once the position is actually entered, see below).
        self.target_is_pct = profit_target_is_pct
        self.stop_is_pct = stop_loss_is_pct
        self.target_pct = profit_target if profit_target_is_pct else None
        self.stop_pct = stop_loss if stop_loss_is_pct else None
        self.profit_target = None if profit_target_is_pct else profit_target
        self.stop_loss = None if stop_loss_is_pct else -abs(stop_loss)  # Ensure it is negative
        self.start_time = start_time
        self.eod_time = eod_time
        self.imbalance_threshold = imbalance_threshold
        self.max_lots = max_lots
        self.min_adjust_price = min_adjust_price
        self.post_sl_balance = post_sl_balance
        self.product_type = product_type.upper()
        self.ce_lots = lots
        self.pe_lots = lots
        self.entry_diff_pct = 0.0
        self.last_adjustment_time = 0.0

        self.dhan = get_dhan_client()
        if not self.dhan:
            raise Exception("Failed to connect to Dhan.")
        self.helper = DhanHelper(self.dhan)

        # Start WebSocket for Nifty Spot
        logger.info("Starting WebSocket for NIFTY Index...")
        self.helper.start_websocket([("IDX_I", "13", 15)])
        time.sleep(2)  # Wait for initial tick

        self.nifty_lot_size = self.helper.get_lot_size("NIFTY")
        logger.info(f"Nifty Lot Size resolved to: {self.nifty_lot_size}")

        # Fetch and log previous day OHLC levels via library method
        _levels = self.helper.get_prev_day_levels("NIFTY")
        self.prev_day_high = _levels["high"] if _levels else None
        self.prev_day_low = _levels["low"] if _levels else None
        self.prev_day_close = _levels["close"] if _levels else None

        # Strategy State
        self.expiry = None
        self.ce_strike = None
        self.pe_strike = None
        self.ce_id = None
        self.pe_id = None
        self.ce_symbol_name = None
        self.pe_symbol_name = None

        self.ce_avg_price = 0.0
        self.pe_avg_price = 0.0
        self.ce_qty = 0
        self.pe_qty = 0

        self.ce_sl_price = 0.0
        self.pe_sl_price = 0.0
        self.ce_sl_id = None
        self.pe_sl_id = None

        self.ce_sl_hit = False
        self.pe_sl_hit = False
        self.realized_pnl = 0.0
        self.adjustment_count = 0
        self._last_sl_check = {}

        self.NIFTY_SPOT_SID = 13  # Nifty 50 index (IDX_I) for spot price

    def fetch_ltps(self):
        """Batched CE/PE/spot LTP fetch — at most one REST call when the WebSocket misses.

        Inactive legs (qty 0) are skipped and returned as 0.0, matching the
        previous per-leg behaviour.
        """
        instruments = [("IDX_I", self.NIFTY_SPOT_SID)]
        if self.ce_id and self.ce_qty > 0:
            instruments.append(("NSE_FNO", self.ce_id))
        if self.pe_id and self.pe_qty > 0:
            instruments.append(("NSE_FNO", self.pe_id))
        ltps = self.helper.get_ltps(instruments)
        ce_ltp = ltps.get(str(self.ce_id), 0.0) if (self.ce_id and self.ce_qty > 0) else 0.0
        pe_ltp = ltps.get(str(self.pe_id), 0.0) if (self.pe_id and self.pe_qty > 0) else 0.0
        return ce_ltp, pe_ltp, ltps.get(str(self.NIFTY_SPOT_SID), 0.0)

    def save_state(self, nifty_spot, ce_ltp, pe_ltp, total_pnl, status="RUNNING"):
        state_dict = {
            "strategy": "nifty_expiry",
            "status": status,
            "dry_run": self.dry_run,
            "lots": self.lots,
            "entry_type": self.entry_type,
            "adjustment_mode": self.adjustment_mode,
            "ce_strike": self.ce_strike,
            "pe_strike": self.pe_strike,
            "ce_lots": self.ce_lots if self.ce_qty > 0 else 0,
            "pe_lots": self.pe_lots if self.pe_qty > 0 else 0,
            "ce_ltp": ce_ltp,
            "pe_ltp": pe_ltp,
            "ce_avg_price": self.ce_avg_price,
            "pe_avg_price": self.pe_avg_price,
            "ce_sl_price": self.ce_sl_price,
            "pe_sl_price": self.pe_sl_price,
            "ce_sl_hit": self.ce_sl_hit,
            "pe_sl_hit": self.pe_sl_hit,
            "realized_pnl": self.realized_pnl,
            "total_pnl": total_pnl,
            "spot": nifty_spot,
            "adjustments": self.adjustment_count,
            "profit_target": self.profit_target,
            "stop_loss": self.stop_loss
        }
        save_strategy_state("nifty_expiry", state_dict)

    def get_execution_price(self, order_id: str, fallback_price: float) -> float:
        """Wait for fill and get the average execution price, or return fallback."""
        if not order_id:
            return fallback_price
        if self.helper.wait_for_fill(order_id, timeout=5):
            order_details = self.helper.get_order_by_id(order_id)
            if order_details:
                fill_price = float(order_details.get('averageTradedPrice', 0.0) or
                                   order_details.get('avgFilledPrice', 0.0) or
                                   order_details.get('price', 0.0))
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
        """Extract needed fields from quote."""
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
        ce_unrealized = 0.0
        pe_unrealized = 0.0
        if self.ce_qty > 0 and not self.ce_sl_hit:
            ce_unrealized = (self.ce_avg_price - ce_ltp) * self.ce_qty
        if self.pe_qty > 0 and not self.pe_sl_hit:
            pe_unrealized = (self.pe_avg_price - pe_ltp) * self.pe_qty
        return self.realized_pnl + ce_unrealized + pe_unrealized

    def log_state(self, nifty_spot, ce_ltp, pe_ltp, total_pnl):
        ce_desc = f"{self.ce_strike}C:{ce_ltp:.1f}({self.ce_lots}L)" if self.ce_qty > 0 and not self.ce_sl_hit else "CE:FLAT"
        pe_desc = f"{self.pe_strike}P:{pe_ltp:.1f}({self.pe_lots}L)" if self.pe_qty > 0 and not self.pe_sl_hit else "PE:FLAT"
        
        imbalance_desc = ""
        if self.adjustment_mode == "winner_addition" and self.ce_qty > 0 and not self.ce_sl_hit and self.pe_qty > 0 and not self.pe_sl_hit:
            ce_val = self.ce_lots * ce_ltp
            pe_val = self.pe_lots * pe_ltp
            max_val = max(ce_val, pe_val)
            diff_pct = abs(ce_val - pe_val) / max_val * 100 if max_val > 0 else 0.0
            imbalance_desc = f" | Diff:{diff_pct:.1f}% (Thresh:{self.imbalance_threshold + self.entry_diff_pct:.1f}%)"

        logger.info(
            f"Spot:{nifty_spot:.1f} | {ce_desc} (SL:{self.ce_sl_price:.1f}) | "
            f"{pe_desc} (SL:{self.pe_sl_price:.1f}){imbalance_desc} | PnL:Rs.{total_pnl:.1f} | Adj:{self.adjustment_count}"
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

    def exit_all_positions(self, reason):
        logger.warning(f"!!! EXITING ALL POSITIONS: {reason} !!!")
        if not self.dry_run:
            # Cancel SL orders first
            if self.ce_sl_id:
                try: self.helper.cancel_order(self.ce_sl_id)
                except Exception as e: logger.error(f"Failed to cancel CE SL: {e}")
            if self.pe_sl_id:
                try: self.helper.cancel_order(self.pe_sl_id)
                except Exception as e: logger.error(f"Failed to cancel PE SL: {e}")

            # Close active legs
            if self.ce_id and self.ce_qty > 0 and not self.ce_sl_hit:
                try:
                    net_qty = self.helper.get_net_quantity(str(self.ce_id))
                    if net_qty < 0:
                        self.helper.buy(str(self.ce_id), abs(net_qty), product=self.product_type)
                        logger.info(f"CE leg buy-to-close order placed for {abs(net_qty)} qty.")
                except Exception as e:
                    logger.error(f"Exit CE Error: {e}")
            if self.pe_id and self.pe_qty > 0 and not self.pe_sl_hit:
                try:
                    net_qty = self.helper.get_net_quantity(str(self.pe_id))
                    if net_qty < 0:
                        self.helper.buy(str(self.pe_id), abs(net_qty), product=self.product_type)
                        logger.info(f"PE leg buy-to-close order placed for {abs(net_qty)} qty.")
                except Exception as e:
                    logger.error(f"Exit PE Error: {e}")
        else:
            logger.info("[DRY RUN] Simulating exit of all positions.")

        self.ce_qty = 0
        self.pe_qty = 0

    def select_strikes(self, nifty_spot, chain_df):
        """Select strikes based on entry type (Straddle vs Strangle)."""
        logger.info(f"Selecting strikes for Nifty Spot: {nifty_spot:.2f} using {self.entry_type} entry...")
        
        if self.entry_type == "straddle":
            atm = int(round(nifty_spot / 50) * 50)
            logger.info(f"ATM Straddle Strike: {atm}")
            return atm, atm

        elif self.entry_type == "strangle":
            ce_strike = None
            pe_strike = None

            if self.use_premium:
                if chain_df.empty:
                    logger.warning("Empty option chain for premium selection. Falling back to distance.")
                else:
                    # Filter OTM CE
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

                    # Filter OTM PE
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
                        logger.warning("Empty option chain for delta selection. Falling back to distance.")
                    else:
                        greek_df = chain_df[(chain_df['ce_delta'] != 0) | (chain_df['pe_delta'] != 0)].copy()
                        if greek_df.empty:
                            logger.warning("No Greeks found in option chain. Falling back to distance.")
                        else:
                            greek_df['ce_delta_diff'] = abs(abs(greek_df['ce_delta']) - self.target_delta)
                            greek_df['pe_delta_diff'] = abs(abs(greek_df['pe_delta']) - self.target_delta)
                            
                            ce_strike = int(greek_df.sort_values('ce_delta_diff').index[0])
                            pe_strike = int(greek_df.sort_values('pe_delta_diff').index[0])
                            
                            logger.info(f"Delta Strangle Selection: CE {ce_strike} (Delta: {greek_df.loc[ce_strike, 'ce_delta']:.2f}) | PE {pe_strike} (Delta: {greek_df.loc[pe_strike, 'pe_delta']:.2f})")

            if ce_strike is None or pe_strike is None:
                # Distance offset default
                ce_strike = int(round((nifty_spot + self.ce_offset) / 50) * 50)
                pe_strike = int(round((nifty_spot - self.pe_offset) / 50) * 50)
                logger.info(f"Distance Strangle Selection: {ce_strike} CE (+{self.ce_offset}) | {pe_strike} PE (-{self.pe_offset})")

            if ce_strike <= pe_strike:
                logger.error(f"Inverted strikes detected! CE strike {ce_strike} must be strictly greater than PE strike {pe_strike}. Bypassing selection.")
                return None, None
            
            return ce_strike, pe_strike

        return None, None

    def run(self):
        exit_if_market_closed(self.helper, self.dry_run)
        logger.info(f"Starting Nifty Expiry Strategy | Dry Run: {self.dry_run} | Entry Time: {self.start_time}")
        
        while True:
            # Check shutdown trigger
            if check_shutdown_trigger("nifty_expiry"):
                logger.info("UI Shutdown Request in outer loop.")
                self.save_state(0, 0, 0, 0, status="STOPPED")
                sys.exit(0)
            self.save_state(0, 0, 0, 0, status="INITIALIZING")

            # Wait for market open
            self.helper.wait_for_market_open(self.dry_run, start_time=self.start_time, eod_time=self.eod_time)

            # Session Reset
            self.ce_strike = None
            self.pe_strike = None
            self.ce_id = None
            self.pe_id = None
            self.ce_avg_price = 0.0
            self.pe_avg_price = 0.0
            self.ce_qty = 0
            self.pe_qty = 0
            self.ce_sl_price = 0.0
            self.pe_sl_price = 0.0
            self.ce_sl_id = None
            self.pe_sl_id = None
            self.ce_sl_hit = False
            self.pe_sl_hit = False
            self.realized_pnl = 0.0
            self.adjustment_count = 0

            # Reset winner addition states
            self.ce_lots = self.lots
            self.pe_lots = self.lots
            self.entry_diff_pct = 0.0
            self.last_adjustment_time = 0.0

            nifty_spot = self.helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")
            self.expiry = self.helper.get_nearest_expiry("NIFTY")
            chain_df = self.helper.get_option_chain_df("NIFTY", self.expiry) if self.expiry else pd.DataFrame()

            if nifty_spot == 0 and not chain_df.empty:
                nifty_spot = chain_df.attrs.get('underlying_ltp', 0)
            if nifty_spot == 0 and self.prev_day_close and self.prev_day_close > 0:
                nifty_spot = self.prev_day_close
                logger.warning(f"Fallback to previous day close spot price: {nifty_spot:.2f}")

            if nifty_spot == 0:
                logger.error("Could not fetch Nifty Spot. Retrying in 10s...")
                time.sleep(10)
                continue

            self.ce_strike, self.pe_strike = self.select_strikes(nifty_spot, chain_df)
            if not self.ce_strike or not self.pe_strike:
                logger.error("Strike selection failed. Retrying in 10s...")
                time.sleep(10)
                continue

            # Fetch Option contracts
            ce_quote = self.helper.option("NIFTY", self.ce_strike, "CE")
            pe_quote = self.helper.option("NIFTY", self.pe_strike, "PE")

            # Fallback to chain_df if initial quotes fail
            if (self.is_quote_invalid(ce_quote) or self.is_quote_invalid(pe_quote)) and not chain_df.empty:
                logger.warning("Initial helper.option() failed. Falling back to option chain...")
                if self.is_quote_invalid(ce_quote) and float(self.ce_strike) in chain_df.index:
                    ce_quote = chain_df.loc[float(self.ce_strike)].to_dict()
                if self.is_quote_invalid(pe_quote) and float(self.pe_strike) in chain_df.index:
                    pe_quote = chain_df.loc[float(self.pe_strike)].to_dict()

            self.ce_id, self.ce_avg_price, self.expiry, self.nifty_lot_size, self.ce_symbol_name = \
                self._extract_quote_fields(ce_quote, self.ce_strike, "CE")

            self.pe_id, self.pe_avg_price, _, _, self.pe_symbol_name = \
                self._extract_quote_fields(pe_quote, self.pe_strike, "PE")

            if not self.ce_id or not self.pe_id:
                logger.error("Initial quotes failed. Retrying in 30s...")
                time.sleep(30)
                continue

            # Subscribe to WebSocket for real-time updates
            logger.info(f"Subscribing to WebSocket for {self.ce_symbol_name} (ID: {self.ce_id}) and {self.pe_symbol_name} (ID: {self.pe_id})")
            try:
                self.helper.subscribe_instruments([
                    ("NSE_FNO", str(self.ce_id), 15),
                    ("NSE_FNO", str(self.pe_id), 15)
                ])
                time.sleep(2)  # Wait for initial ticks
            except Exception as e:
                logger.error(f"Failed to subscribe to WebSocket: {e}")

            # Define trade quantities
            self.ce_qty = self.lots * self.nifty_lot_size
            self.pe_qty = self.lots * self.nifty_lot_size

            # Execute Entry
            if not self.dry_run:
                logger.info(f"Executing LIVE entry for Straddle/Strangle. Quantity: {self.ce_qty} each.")
                ce_oid = self.helper.sell(str(self.ce_id), self.ce_qty, product=self.product_type)
                pe_oid = self.helper.sell(str(self.pe_id), self.pe_qty, product=self.product_type)
                if not ce_oid or not pe_oid:
                    logger.error("Entry Order placement failed. Squaring off any orphan leg...")
                    if ce_oid: self.helper.buy(str(self.ce_id), self.ce_qty, product=self.product_type)
                    if pe_oid: self.helper.buy(str(self.pe_id), self.pe_qty, product=self.product_type)
                    continue
                
                # Fetch actual execution prices
                self.ce_avg_price = self.get_execution_price(ce_oid, self.ce_avg_price)
                self.pe_avg_price = self.get_execution_price(pe_oid, self.pe_avg_price)
            else:
                logger.info(f"[DRY RUN] Simulating Entry: CE Sold at {self.ce_avg_price:.2f}, PE Sold at {self.pe_avg_price:.2f}")

            # Set initial baseline imbalance
            ce_val = self.ce_lots * self.ce_avg_price
            pe_val = self.pe_lots * self.pe_avg_price
            max_val = max(ce_val, pe_val)
            self.entry_diff_pct = abs(ce_val - pe_val) / max_val * 100 if max_val > 0 else 0.0
            logger.info(f"Initial entry imbalance: {self.entry_diff_pct:.2f}%")

            if self.target_is_pct or self.stop_is_pct:
                entry_value = self.ce_avg_price * self.ce_qty + self.pe_avg_price * self.pe_qty
                if self.target_is_pct:
                    self.profit_target = entry_value * self.target_pct / 100.0
                    logger.info(f"Resolved profit target: {self.target_pct}% of entry premium INR{entry_value:.0f} = INR{self.profit_target:.0f}")
                if self.stop_is_pct:
                    self.stop_loss = -abs(entry_value * self.stop_pct / 100.0)
                    logger.info(f"Resolved stop loss: {self.stop_pct}% of entry premium INR{entry_value:.0f} = -INR{abs(self.stop_loss):.0f}")

            # Calculate and round Stop Losses (round to nearest 0.05 tick)
            self.ce_sl_price = round(self.ce_avg_price * (1 + self.leg_sl_pct / 100) * 20) / 20
            self.pe_sl_price = round(self.pe_avg_price * (1 + self.leg_sl_pct / 100) * 20) / 20

            # Place broker-side Stop Loss Limit (SL-L) orders (fallback in place_sl_market)
            if not self.dry_run:
                logger.info(f"Placing live SL-L orders: CE Trigger {self.ce_sl_price:.2f} | PE Trigger {self.pe_sl_price:.2f}")
                self.ce_sl_id = self.helper.place_sl_market(str(self.ce_id), self.ce_qty, self.ce_sl_price, "BUY", product_type=self.product_type)
                self.pe_sl_id = self.helper.place_sl_market(str(self.pe_id), self.pe_qty, self.pe_sl_price, "BUY", product_type=self.product_type)
                if not self.ce_sl_id or not self.pe_sl_id:
                    logger.critical("Failed to place Stop Loss orders! Squaring off immediately for safety.")
                    self.exit_all_positions("Failed Stop Loss placement")
                    continue
            else:
                logger.info(f"[DRY RUN] Simulating Stop Loss Placement: CE SL {self.ce_sl_price:.2f} | PE SL {self.pe_sl_price:.2f}")

            last_log_time = time.time()
            cycle_active = True

            # --- MONITORING LOOP ---
            while cycle_active:
                time.sleep(1)

                # Check UI Shutdown
                if check_shutdown_trigger("nifty_expiry"):
                    self.exit_all_positions("UI Shutdown Request")
                    self.save_state(0, 0, 0, 0, status="STOPPED")
                    sys.exit(0)

                # Check EOD
                now = datetime.now()
                current_time_str = now.strftime("%H:%M")
                if current_time_str >= self.eod_time:
                    self.exit_all_positions("EOD Auto-Exit")
                    cycle_active = False
                    break

                # Fetch active prices in one batched call (CE + PE + spot)
                ce_ltp, pe_ltp, curr_spot = self.fetch_ltps()

                if (self.ce_qty > 0 and ce_ltp <= 0) or (self.pe_qty > 0 and pe_ltp <= 0):
                    continue

                total_pnl = self._calculate_pnl(ce_ltp, pe_ltp)
                self.save_state(curr_spot, ce_ltp, pe_ltp, total_pnl, status="RUNNING")

                if time.time() - last_log_time >= 5:
                    self.log_state(curr_spot, ce_ltp, pe_ltp, total_pnl)
                    last_log_time = time.time()

                # Global Profit/Loss exits
                if total_pnl >= self.profit_target or total_pnl <= self.stop_loss:
                    reason = "Profit Target Reached" if total_pnl >= self.profit_target else "Global Stop Loss Hit"
                    self.exit_all_positions(f"{reason} ({total_pnl:.2f})")
                    self.helper.wait_for_next_day_market_open(self.dry_run, start_time=self.start_time)
                    cycle_active = False
                    break

                # --- WINNER LOT ADDITION ADJUSTMENT (While both legs are active) ---
                if self.adjustment_mode == "winner_addition" and self.ce_qty > 0 and not self.ce_sl_hit and self.pe_qty > 0 and not self.pe_sl_hit:
                    # Bypass adjustments entirely if BOTH premiums are below min_adjust_price
                    if ce_ltp < self.min_adjust_price and pe_ltp < self.min_adjust_price:
                        pass
                    # Time-based cooldown: 60s limit between adjustments
                    elif time.time() - self.last_adjustment_time >= 60:
                        ce_val = self.ce_lots * ce_ltp
                        pe_val = self.pe_lots * pe_ltp
                        max_val = max(ce_val, pe_val)
                        diff_pct = abs(ce_val - pe_val) / max_val * 100 if max_val > 0 else 0.0

                        # Check if diff_pct exceeds (self.imbalance_threshold + self.entry_diff_pct)
                        active_threshold = self.imbalance_threshold + self.entry_diff_pct
                        if diff_pct > active_threshold:
                            winner = "CE" if ce_val < pe_val else "PE"
                            winner_lots = self.ce_lots if winner == "CE" else self.pe_lots
                            winner_ltp = ce_ltp if winner == "CE" else pe_ltp

                            loser = "PE" if winner == "CE" else "CE"
                            loser_lots = self.pe_lots if winner == "CE" else self.ce_lots
                            loser_ltp = pe_ltp if winner == "CE" else ce_ltp
                            loser_val = loser_lots * loser_ltp

                            projected_winner_val = (winner_lots + 1) * winner_ltp
                            projected_diff_pct = abs(loser_val - projected_winner_val) / max(loser_val, projected_winner_val) * 100 if max(loser_val, projected_winner_val) > 0 else 0.0

                            if projected_diff_pct <= 10.0 and winner_ltp >= self.min_adjust_price and winner_lots < self.max_lots:
                                # Proceed with adding 1 lot to the same strike
                                logger.info(f"!!! Winner Lot Addition Triggered !!! Imbalance: {diff_pct:.2f}%, Projected addition imbalance: {projected_diff_pct:.2f}% (<= 10%). Proceeding with lot addition.")
                                winner_id = str(self.ce_id) if winner == "CE" else str(self.pe_id)
                                winner_qty = self.nifty_lot_size

                                oid = None
                                if not self.dry_run:
                                    logger.info(f"Selling 1 additional lot of {winner} (ID: {winner_id}) at market")
                                    oid = self.helper.sell(winner_id, winner_qty, product=self.product_type)
                                    if not oid:
                                        logger.error(f"Failed to place sell order for additional {winner} lot. Skipping adjustment.")
                                        self.last_adjustment_time = time.time()
                                        continue
                                exec_price = self.get_execution_price(oid, winner_ltp) if oid else winner_ltp

                                old_avg = self.ce_avg_price if winner == "CE" else self.pe_avg_price
                                new_avg = ((old_avg * winner_lots) + exec_price) / (winner_lots + 1)

                                if winner == "CE":
                                    self.ce_lots += 1
                                    self.ce_qty = self.ce_lots * self.nifty_lot_size
                                    self.ce_avg_price = new_avg
                                    self.ce_sl_price = round(self.ce_avg_price * (1 + self.leg_sl_pct / 100) * 20) / 20
                                    logger.info(f"CE updated: Avg Price: {self.ce_avg_price:.2f}, Qty: {self.ce_qty}, New SL: {self.ce_sl_price:.2f}")
                                    if not self.dry_run:
                                        if self.ce_sl_id:
                                            try: self.helper.cancel_order(self.ce_sl_id)
                                            except Exception as e: logger.error(f"Failed to cancel old CE SL: {e}")
                                        self.ce_sl_id = self.helper.place_sl_market(str(self.ce_id), self.ce_qty, self.ce_sl_price, "BUY", product_type=self.product_type)
                                        if not self.ce_sl_id:
                                            logger.critical("Failed to place updated Stop Loss order! Squaring off immediately.")
                                            self.exit_all_positions("Failed Stop Loss placement during adjustment")
                                            cycle_active = False
                                            break
                                else:
                                    self.pe_lots += 1
                                    self.pe_qty = self.pe_lots * self.nifty_lot_size
                                    self.pe_avg_price = new_avg
                                    self.pe_sl_price = round(self.pe_avg_price * (1 + self.leg_sl_pct / 100) * 20) / 20
                                    logger.info(f"PE updated: Avg Price: {self.pe_avg_price:.2f}, Qty: {self.pe_qty}, New SL: {self.pe_sl_price:.2f}")
                                    if not self.dry_run:
                                        if self.pe_sl_id:
                                            try: self.helper.cancel_order(self.pe_sl_id)
                                            except Exception as e: logger.error(f"Failed to cancel old PE SL: {e}")
                                        self.pe_sl_id = self.helper.place_sl_market(str(self.pe_id), self.pe_qty, self.pe_sl_price, "BUY", product_type=self.product_type)
                                        if not self.pe_sl_id:
                                            logger.critical("Failed to place updated Stop Loss order! Squaring off immediately.")
                                            self.exit_all_positions("Failed Stop Loss placement during adjustment")
                                            cycle_active = False
                                            break

                                self.adjustment_count += 1
                                self.last_adjustment_time = time.time()
                                self.update_baseline_imbalance()

                            else:
                                # Roll winner to a new strike closer to spot
                                if winner_lots >= self.max_lots:
                                    reason = f"Winner leg already at max lots ({self.max_lots})"
                                elif winner_ltp < self.min_adjust_price:
                                    reason = f"Winner LTP ({winner_ltp:.2f}) < min adjust price ({self.min_adjust_price})"
                                else:
                                    reason = f"Projected addition imbalance {projected_diff_pct:.2f}% > 10%"

                                logger.info(f"!!! Winner Roll Closer Triggered !!! Imbalance: {diff_pct:.2f}%. Reason: {reason}. Rolling winner to balance values.")
                                
                                # Query option chain
                                chain_df = self.helper.get_option_chain_df("NIFTY", self.expiry)
                                if chain_df.empty:
                                    logger.warning("Option chain empty. Skipping adjustment.")
                                    continue

                                # Upper limit price for new strike (so new_winner_val < loser_val)
                                target_price_upper = (loser_lots * loser_ltp) / winner_lots
                                
                                # Filter strikes
                                if winner == "CE":
                                    # CE strike must be strictly greater than PE strike (prevent strike inversion)
                                    valid_df = chain_df[
                                        (chain_df['ce_last_price'] > 0) & 
                                        (chain_df.index > self.pe_strike) &
                                        (chain_df['ce_last_price'] < target_price_upper)
                                    ].copy()
                                    price_col = 'ce_last_price'
                                else:
                                    # PE strike must be strictly less than CE strike (prevent strike inversion)
                                    valid_df = chain_df[
                                        (chain_df['pe_last_price'] > 0) & 
                                        (chain_df.index < self.ce_strike) &
                                        (chain_df['pe_last_price'] < target_price_upper)
                                    ].copy()
                                    price_col = 'pe_last_price'

                                if valid_df.empty:
                                    logger.warning(f"No valid {winner} strikes found below target price {target_price_upper:.2f} that avoid strike inversion. Skipping adjustment.")
                                    continue

                                # Find the strike with the maximum price below target_price_upper (closest from below)
                                best_strike = float(valid_df[price_col].idxmax())
                                best_price = float(valid_df.loc[best_strike, price_col])
                                
                                projected_new_val = winner_lots * best_price
                                new_diff_pct = abs(loser_lots * loser_ltp - projected_new_val) / (loser_lots * loser_ltp) * 100 if (loser_lots * loser_ltp) > 0 else 0.0
                                
                                logger.info(f"Selected rolled {winner} strike: {best_strike} (Price: {best_price:.2f}, Projected Diff: {new_diff_pct:.1f}%)")
                                
                                # Execute Roll:
                                old_winner_id = str(self.ce_id) if winner == "CE" else str(self.pe_id)
                                old_winner_qty = self.ce_qty if winner == "CE" else self.pe_qty
                                old_sl_id = self.ce_sl_id if winner == "CE" else self.pe_sl_id
                                old_avg = self.ce_avg_price if winner == "CE" else self.pe_avg_price
                                
                                # Buy to close the old winner leg
                                exit_price = winner_ltp
                                buy_oid = None
                                if not self.dry_run:
                                    logger.info(f"Closing old winner {winner} (ID: {old_winner_id}, Qty: {old_winner_qty})")
                                    buy_oid = self.helper.buy(old_winner_id, old_winner_qty, product=self.product_type)
                                    if not buy_oid:
                                        logger.error(f"Failed to place buy-to-close order for old winner {winner}. Skipping adjustment.")
                                        continue
                                    
                                    # Cancel old SL
                                    if old_sl_id:
                                        try: self.helper.cancel_order(old_sl_id)
                                        except Exception as cancel_err: logger.error(f"Failed to cancel old SL: {cancel_err}")
                                
                                actual_exit_price = self.get_execution_price(buy_oid, exit_price) if buy_oid else exit_price
                                self.realized_pnl += (old_avg - actual_exit_price) * old_winner_qty
                                logger.info(f"Closed old winner leg at {actual_exit_price:.2f}. Realized PnL change: {((old_avg - actual_exit_price) * old_winner_qty):.2f}")

                                # Resolve and sell the new winner strike
                                new_quote = self.helper.option("NIFTY", int(best_strike), winner)
                                if self.is_quote_invalid(new_quote) and not chain_df.empty:
                                    if float(best_strike) in chain_df.index:
                                        new_quote = chain_df.loc[float(best_strike)].to_dict()

                                new_id, price_from_quote, _, lot_size, symbol_name = \
                                    self._extract_quote_fields(new_quote, int(best_strike), winner)
                                
                                if new_id:
                                    self.nifty_lot_size = lot_size
                                    new_price = price_from_quote if price_from_quote > 0 else best_price
                                    
                                    # Update WS subscription
                                    try:
                                        self.helper.unsubscribe_instruments([("NSE_FNO", old_winner_id, 15)])
                                        self.helper.subscribe_instruments([("NSE_FNO", str(new_id), 15)])
                                    except Exception as ws_err:
                                        logger.error(f"WebSocket update failed: {ws_err}")

                                    sell_oid = None
                                    if not self.dry_run:
                                        logger.info(f"Selling new rolled winner {winner} (ID: {new_id}, Qty: {old_winner_qty})")
                                        sell_oid = self.helper.sell(str(new_id), old_winner_qty, product=self.product_type)
                                        if not sell_oid:
                                            logger.critical(f"Failed to place sell order for new rolled winner {new_id}! Squaring off for safety.")
                                            self.exit_all_positions("New rolled winner order failed")
                                            cycle_active = False
                                            break
                                    
                                    actual_entry_price = self.get_execution_price(sell_oid, new_price) if sell_oid else new_price
                                    
                                    if winner == "CE":
                                        self.ce_strike = int(best_strike)
                                        self.ce_symbol_name = symbol_name
                                        self.ce_id = new_id
                                        self.ce_avg_price = actual_entry_price
                                        self.ce_sl_price = round(self.ce_avg_price * (1 + self.leg_sl_pct / 100) * 20) / 20
                                        logger.info(f"CE rolled and updated: Strike: {self.ce_strike}, Price: {self.ce_avg_price:.2f}, SL: {self.ce_sl_price:.2f}")
                                        if not self.dry_run:
                                            self.ce_sl_id = self.helper.place_sl_market(str(self.ce_id), self.ce_qty, self.ce_sl_price, "BUY", product_type=self.product_type)
                                            if not self.ce_sl_id:
                                                logger.critical("Failed to place updated Stop Loss order! Squaring off immediately.")
                                                self.exit_all_positions("Failed Stop Loss placement during adjustment")
                                                cycle_active = False
                                                break
                                    else:
                                        self.pe_strike = int(best_strike)
                                        self.pe_symbol_name = symbol_name
                                        self.pe_id = new_id
                                        self.pe_avg_price = actual_entry_price
                                        self.pe_sl_price = round(self.pe_avg_price * (1 + self.leg_sl_pct / 100) * 20) / 20
                                        logger.info(f"PE rolled and updated: Strike: {self.pe_strike}, Price: {self.pe_avg_price:.2f}, SL: {self.pe_sl_price:.2f}")
                                        if not self.dry_run:
                                            self.pe_sl_id = self.helper.place_sl_market(str(self.pe_id), self.pe_qty, self.pe_sl_price, "BUY", product_type=self.product_type)
                                            if not self.pe_sl_id:
                                                logger.critical("Failed to place updated Stop Loss order! Squaring off immediately.")
                                                self.exit_all_positions("Failed Stop Loss placement during adjustment")
                                                cycle_active = False
                                                break
                                    
                                    self.adjustment_count += 1
                                    self.last_adjustment_time = time.time()
                                    self.update_baseline_imbalance()
                                else:
                                    logger.error(f"Failed to resolve rolled {winner} contract fields. Leg remains closed.")
                                    if winner == "CE":
                                        self.ce_qty = 0
                                    else:
                                        self.pe_qty = 0

                # --- CHECK CE LEG STOP LOSS ---
                if self.ce_qty > 0 and not self.ce_sl_hit:
                    ce_hit = self._is_sl_hit(ce_ltp, self.ce_sl_price, self.ce_sl_id, self.ce_id)

                    if ce_hit:
                        exec_price = self.get_execution_price(self.ce_sl_id, self.ce_sl_price)
                        logger.warning(f"!!! CE SL HIT at price {exec_price:.2f} !!!")
                        self.ce_sl_hit = True
                        # Realize PnL for CE
                        self.realized_pnl += (self.ce_avg_price - exec_price) * self.ce_qty
                        self.ce_qty = 0
                        self.ce_sl_price = 0.0

                        # Apply Adjustments on PE surviving leg
                        if self.pe_qty > 0 and not self.pe_sl_hit:
                            self._adjust_surviving_leg("CE", curr_spot)

                # --- CHECK PE LEG STOP LOSS ---
                if self.pe_qty > 0 and not self.pe_sl_hit:
                    pe_hit = self._is_sl_hit(pe_ltp, self.pe_sl_price, self.pe_sl_id, self.pe_id)

                    if pe_hit:
                        exec_price = self.get_execution_price(self.pe_sl_id, self.pe_sl_price)
                        logger.warning(f"!!! PE SL HIT at price {exec_price:.2f} !!!")
                        self.pe_sl_hit = True
                        # Realize PnL for PE
                        self.realized_pnl += (self.pe_avg_price - exec_price) * self.pe_qty
                        self.pe_qty = 0
                        self.pe_sl_price = 0.0

                        # Apply Adjustments on CE surviving leg
                        if self.ce_qty > 0 and not self.ce_sl_hit:
                            self._adjust_surviving_leg("PE", curr_spot)

                # If both legs are stopped out, exit cycle
                if (self.ce_qty == 0 or self.ce_sl_hit) and (self.pe_qty == 0 or self.pe_sl_hit):
                    logger.info("Both legs hit Stop Loss. Ending cycle for today.")
                    self.exit_all_positions("Both legs hit SL")
                    self.helper.wait_for_next_day_market_open(self.dry_run, start_time=self.start_time)
                    cycle_active = False
                    break

    def _is_sl_hit(self, ltp, sl_price, sl_id, symbol_id) -> bool:
        """Robust Stop Loss verification logic to prevent false positives on API failures."""
        if self.dry_run:
            return ltp >= sl_price
            
        now = time.time()
        last_check = self._last_sl_check.get(symbol_id, 0.0)
        
        # Rate-limit safety: if ltp < sl_price, we only perform backup API checks once every 10 seconds.
        if ltp < sl_price and (now - last_check) < 10.0:
            return False
            
        self._last_sl_check[symbol_id] = now
            
        # 1. Check if the specific SL order is filled on the broker
        if sl_id and self.helper.is_order_filled(sl_id):
            return True
            
        # 2. Backup check: Fetch position and verify if it's flat/closed
        try:
            positions_df = self.helper.get_positions()
            if not positions_df.empty:
                # Ensure we match string representation of security ID
                match = positions_df[positions_df['securityId'].astype(str) == str(symbol_id)]
                if not match.empty:
                    net_qty = int(match.iloc[0].get('netQty', 0))
                    if net_qty >= 0:
                        return True
                else:
                    # If position list successfully fetched but ID not found, it is closed
                    return True
        except Exception as e:
            logger.error(f"Failed to verify position status during SL check: {e}")
            
        return False

    def _adjust_surviving_leg(self, stopped_leg_type, spot):
        """Applies adjustments (C2C, Roll Closer, Restrangle, or Post-SL balancing) to the surviving leg/system."""
        if self.post_sl_balance:
            if self.adjustment_count >= self.max_adjustments:
                logger.info(f"Max adjustments ({self.max_adjustments}) reached. Surviving leg will run unadjusted post-SL.")
                return

            logger.info(f"!!! POST-SL BALANCE TRIGGERED !!! Rebalancing stopped-out leg ({stopped_leg_type}) to match surviving leg's premium and lots.")
            
            surviving_leg_type = "PE" if stopped_leg_type == "CE" else "CE"
            
            # Fetch surviving leg info
            if surviving_leg_type == "PE":
                surviving_ltp = self.helper.get_ltp(str(self.pe_id), exchange="NSE_FNO", instrument="OPTIDX")
                surviving_lots = self.pe_lots
                surviving_qty = self.pe_qty
                surviving_strike = self.pe_strike
            else:
                surviving_ltp = self.helper.get_ltp(str(self.ce_id), exchange="NSE_FNO", instrument="OPTIDX")
                surviving_lots = self.ce_lots
                surviving_qty = self.ce_qty
                surviving_strike = self.ce_strike

            if surviving_ltp <= 0:
                logger.error(f"Cannot perform post-SL balance: surviving {surviving_leg_type} LTP is {surviving_ltp}")
                return

            chain_df = self.helper.get_option_chain_df("NIFTY", self.expiry)
            if chain_df.empty:
                logger.error("Option chain empty. Cannot perform post-SL balance.")
                return

            if stopped_leg_type == "CE":
                # CE strike must be strictly greater than PE strike (the surviving leg)
                valid_df = chain_df[
                    (chain_df['ce_last_price'] > 0) & 
                    (chain_df.index > surviving_strike)
                ].copy()
                price_col = 'ce_last_price'
            else:
                # PE strike must be strictly less than CE strike (the surviving leg)
                valid_df = chain_df[
                    (chain_df['pe_last_price'] > 0) & 
                    (chain_df.index < surviving_strike)
                ].copy()
                price_col = 'pe_last_price'

            if valid_df.empty:
                logger.error(f"No valid {stopped_leg_type} strikes found that prevent strike inversion with surviving {surviving_leg_type} strike {surviving_strike}. Cannot rebalance.")
                return

            # Find closest strike to surviving_ltp
            valid_df['diff'] = abs(valid_df[price_col] - surviving_ltp)
            best_strike = float(valid_df.sort_values('diff').index[0])
            best_price = float(valid_df.loc[best_strike, price_col])

            logger.info(f"Selected new {stopped_leg_type} strike: {best_strike} (Price: {best_price:.2f}) to match surviving {surviving_leg_type} LTP: {surviving_ltp:.2f}")

            # Sell new option contract on stopped-out side
            new_quote = self.helper.option("NIFTY", int(best_strike), stopped_leg_type)
            if self.is_quote_invalid(new_quote) and not chain_df.empty:
                if float(best_strike) in chain_df.index:
                    new_quote = chain_df.loc[float(best_strike)].to_dict()

            new_id, price_from_quote, _, lot_size, symbol_name = \
                self._extract_quote_fields(new_quote, int(best_strike), stopped_leg_type)

            if not new_id:
                logger.error(f"Failed to resolve {stopped_leg_type} contract fields for strike {best_strike}.")
                return

            self.nifty_lot_size = lot_size
            new_price = price_from_quote if price_from_quote > 0 else best_price

            # Update WS subscription
            try:
                old_id = self.ce_id if stopped_leg_type == "CE" else self.pe_id
                if old_id:
                    self.helper.unsubscribe_instruments([("NSE_FNO", str(old_id), 15)])
                self.helper.subscribe_instruments([("NSE_FNO", str(new_id), 15)])
                time.sleep(1)
            except Exception as ws_err:
                logger.error(f"WebSocket update failed: {ws_err}")

            # Match surviving lots and quantity
            new_qty = surviving_qty
            new_lots = surviving_lots

            sell_oid = None
            if not self.dry_run:
                logger.info(f"Selling new {stopped_leg_type} (ID: {new_id}, Qty: {new_qty})")
                sell_oid = self.helper.sell(str(new_id), new_qty, product=self.product_type)
                if not sell_oid:
                    logger.critical(f"Failed to place sell order for new {stopped_leg_type} during post-SL balance! Squaring off for safety.")
                    self.exit_all_positions("Post-SL balancing entry failed")
                    return
            
            actual_entry_price = self.get_execution_price(sell_oid, new_price) if sell_oid else new_price

            # Update attributes and reset sl_hit state
            if stopped_leg_type == "CE":
                self.ce_strike = int(best_strike)
                self.ce_symbol_name = symbol_name
                self.ce_id = new_id
                self.ce_avg_price = actual_entry_price
                self.ce_qty = new_qty
                self.ce_lots = new_lots
                self.ce_sl_price = round(self.ce_avg_price * (1 + self.leg_sl_pct / 100) * 20) / 20
                self.ce_sl_hit = False
                logger.info(f"CE re-entered and balanced: Strike: {self.ce_strike}, Price: {self.ce_avg_price:.2f}, Lots: {self.ce_lots}, SL: {self.ce_sl_price:.2f}")
                if not self.dry_run:
                    self.ce_sl_id = self.helper.place_sl_market(str(self.ce_id), self.ce_qty, self.ce_sl_price, "BUY", product_type=self.product_type)
                    if not self.ce_sl_id:
                        logger.critical("Failed to place updated Stop Loss order! Squaring off immediately.")
                        self.exit_all_positions("Failed Stop Loss placement during post-SL balance")
                        return
            else:
                self.pe_strike = int(best_strike)
                self.pe_symbol_name = symbol_name
                self.pe_id = new_id
                self.pe_avg_price = actual_entry_price
                self.pe_qty = new_qty
                self.pe_lots = new_lots
                self.pe_sl_price = round(self.pe_avg_price * (1 + self.leg_sl_pct / 100) * 20) / 20
                self.pe_sl_hit = False
                logger.info(f"PE re-entered and balanced: Strike: {self.pe_strike}, Price: {self.pe_avg_price:.2f}, Lots: {self.pe_lots}, SL: {self.pe_sl_price:.2f}")
                if not self.dry_run:
                    self.pe_sl_id = self.helper.place_sl_market(str(self.pe_id), self.pe_qty, self.pe_sl_price, "BUY", product_type=self.product_type)
                    if not self.pe_sl_id:
                        logger.critical("Failed to place updated Stop Loss order! Squaring off immediately.")
                        self.exit_all_positions("Failed Stop Loss placement during post-SL balance")
                        return

            self.adjustment_count += 1
            self.update_baseline_imbalance()
            return

        if self.adjustment_mode == "winner_addition":
            logger.info("Adjustment mode is 'winner_addition' and post-SL balance is disabled. No surviving leg adjustments will be made.")
            return

        if self.adjustment_count >= self.max_adjustments:
            logger.info(f"Max adjustments ({self.max_adjustments}) reached. Surviving leg will run unadjusted.")
            return

        self.adjustment_count += 1
        
        if stopped_leg_type == "CE":
            # CE was stopped out, PE is surviving.
            logger.info(f"Applying adjustment '{self.adjustment_mode}' after CE SL hit. Surviving PE: {self.pe_strike}")
            
            if self.adjustment_mode == "c2c":
                # Cancel old PE SL
                if not self.dry_run and self.pe_sl_id:
                    self.helper.cancel_order(self.pe_sl_id)
                
                # Set new trigger price to entry price
                self.pe_sl_price = round(self.pe_avg_price * 20) / 20
                logger.info(f"PE Stop Loss adjusted to Cost-to-Cost (entry price): {self.pe_sl_price:.2f}")
                
                if not self.dry_run:
                    self.pe_sl_id = self.helper.place_sl_market(str(self.pe_id), self.pe_qty, self.pe_sl_price, "BUY", product_type=self.product_type)
                    if not self.pe_sl_id:
                        logger.critical("Failed to place Stop Loss order! Squaring off immediately for safety.")
                        self.exit_all_positions("Failed Stop Loss placement during adjustment")
                        return
            
            elif self.adjustment_mode == "roll_closer":
                # Close current PE leg
                pe_exit_price = self.helper.get_ltp(str(self.pe_id), exchange="NSE_FNO", instrument="OPTIDX")
                if not self.dry_run:
                    if self.pe_sl_id: self.helper.cancel_order(self.pe_sl_id)
                    buy_oid = self.helper.buy(str(self.pe_id), self.pe_qty, product=self.product_type)
                    pe_exit_price = self.get_execution_price(buy_oid, pe_exit_price)
                
                self.realized_pnl += (self.pe_avg_price - pe_exit_price) * self.pe_qty
                logger.info(f"Closed PE leg for roll-closer at {pe_exit_price:.2f}. Realized: {(self.pe_avg_price - pe_exit_price) * self.pe_qty:.2f}")
                
                # Unsubscribe old PE
                try: self.helper.unsubscribe_instruments([("NSE_FNO", str(self.pe_id), 15)])
                except: pass
                
                # Select new PE strike closer to spot
                new_strike = int(round(spot / 50) * 50)
                logger.info(f"Rolling PE to new closer strike: {new_strike}")
                
                new_quote = self.helper.option("NIFTY", new_strike, "PE")
                self.pe_id, self.pe_avg_price, _, _, self.pe_symbol_name = \
                    self._extract_quote_fields(new_quote, new_strike, "PE")
                
                if self.pe_id:
                    try:
                        self.helper.subscribe_instruments([("NSE_FNO", str(self.pe_id), 15)])
                        time.sleep(1)
                    except Exception as ws_err:
                        logger.error(f"WebSocket update failed: {ws_err}")
                        
                    # Execute entry for new leg
                    if not self.dry_run:
                        sell_oid = self.helper.sell(str(self.pe_id), self.pe_qty, product=self.product_type)
                        self.pe_avg_price = self.get_execution_price(sell_oid, self.pe_avg_price)
                    else:
                        logger.info(f"[DRY RUN] Simulating entry for rolled PE at {self.pe_avg_price:.2f}")
                    
                    # Set new SL trigger (40% SL)
                    self.pe_sl_price = round(self.pe_avg_price * (1 + self.leg_sl_pct / 100) * 20) / 20
                    self.pe_sl_hit = False
                    
                    if not self.dry_run:
                        self.pe_sl_id = self.helper.place_sl_market(str(self.pe_id), self.pe_qty, self.pe_sl_price, "BUY", product_type=self.product_type)
                        if not self.pe_sl_id:
                            logger.critical("Failed to place Stop Loss order! Squaring off immediately for safety.")
                            self.exit_all_positions("Failed Stop Loss placement during adjustment")
                            return
                        logger.info(f"Rolled PE SL placed at {self.pe_sl_price:.2f}")
                    else:
                        logger.info(f"[DRY RUN] Rolled PE SL set at {self.pe_sl_price:.2f}")
                else:
                    logger.error("Failed to find rolled PE contract ID. PE leg remains flat.")
                    self.pe_qty = 0

            elif self.adjustment_mode == "restrangle":
                # Sell a new OTM CE option to balance the surviving PE leg
                new_strike = int(round((spot + self.ce_offset) / 50) * 50)
                
                # Prevent strike inversion
                if new_strike <= self.pe_strike:
                    new_strike = self.pe_strike + 50
                    logger.warning(f"Adjusted rolled CE strike to {new_strike} to prevent strike inversion with PE {self.pe_strike}")
                
                logger.info(f"Re-strangling: Selling new OTM CE at strike {new_strike}")
                new_quote = self.helper.option("NIFTY", new_strike, "CE")
                self.ce_id, self.ce_avg_price, _, _, self.ce_symbol_name = \
                    self._extract_quote_fields(new_quote, new_strike, "CE")
                
                if self.ce_id:
                    try:
                        self.helper.subscribe_instruments([("NSE_FNO", str(self.ce_id), 15)])
                        time.sleep(1)
                    except Exception as ws_err:
                        logger.error(f"WebSocket subscription failed for rolled CE: {ws_err}")
                    
                    self.ce_qty = self.lots * self.nifty_lot_size
                    if not self.dry_run:
                        sell_oid = self.helper.sell(str(self.ce_id), self.ce_qty, product=self.product_type)
                        self.ce_avg_price = self.get_execution_price(sell_oid, self.ce_avg_price)
                    else:
                        logger.info(f"[DRY RUN] Simulating entry for rolled CE at {self.ce_avg_price:.2f}")
                        
                    # Set new SL trigger on CE (40% SL)
                    self.ce_sl_price = round(self.ce_avg_price * (1 + self.leg_sl_pct / 100) * 20) / 20
                    self.ce_sl_hit = False
                    
                    if not self.dry_run:
                        self.ce_sl_id = self.helper.place_sl_market(str(self.ce_id), self.ce_qty, self.ce_sl_price, "BUY", product_type=self.product_type)
                        if not self.ce_sl_id:
                            logger.critical("Failed to place Stop Loss order! Squaring off immediately for safety.")
                            self.exit_all_positions("Failed Stop Loss placement during adjustment")
                            return
                        logger.info(f"Rolled CE SL placed at {self.ce_sl_price:.2f}")
                    else:
                        logger.info(f"[DRY RUN] Rolled CE SL set at {self.ce_sl_price:.2f}")
                else:
                    logger.error("Failed to find rolled CE contract ID. CE side remains flat.")
                    self.ce_qty = 0

        else:
            # PE was stopped out, CE is surviving.
            logger.info(f"Applying adjustment '{self.adjustment_mode}' after PE SL hit. Surviving CE: {self.ce_strike}")
            
            if self.adjustment_mode == "c2c":
                # Cancel old CE SL
                if not self.dry_run and self.ce_sl_id:
                    self.helper.cancel_order(self.ce_sl_id)
                
                # Set new trigger price to entry price
                self.ce_sl_price = round(self.ce_avg_price * 20) / 20
                logger.info(f"CE Stop Loss adjusted to Cost-to-Cost (entry price): {self.ce_sl_price:.2f}")
                
                if not self.dry_run:
                    self.ce_sl_id = self.helper.place_sl_market(str(self.ce_id), self.ce_qty, self.ce_sl_price, "BUY", product_type=self.product_type)
                    if not self.ce_sl_id:
                        logger.critical("Failed to place Stop Loss order! Squaring off immediately for safety.")
                        self.exit_all_positions("Failed Stop Loss placement during adjustment")
                        return
            
            elif self.adjustment_mode == "roll_closer":
                # Close current CE leg
                ce_exit_price = self.helper.get_ltp(str(self.ce_id), exchange="NSE_FNO", instrument="OPTIDX")
                if not self.dry_run:
                    if self.ce_sl_id: self.helper.cancel_order(self.ce_sl_id)
                    buy_oid = self.helper.buy(str(self.ce_id), self.ce_qty, product=self.product_type)
                    ce_exit_price = self.get_execution_price(buy_oid, ce_exit_price)
                
                self.realized_pnl += (self.ce_avg_price - ce_exit_price) * self.ce_qty
                logger.info(f"Closed CE leg for roll-closer at {ce_exit_price:.2f}. Realized: {(self.ce_avg_price - ce_exit_price) * self.ce_qty:.2f}")
                
                # Unsubscribe old CE
                try: self.helper.unsubscribe_instruments([("NSE_FNO", str(self.ce_id), 15)])
                except: pass
                
                # Select new CE strike closer to spot
                new_strike = int(round(spot / 50) * 50)
                logger.info(f"Rolling CE to new closer strike: {new_strike}")
                
                new_quote = self.helper.option("NIFTY", new_strike, "CE")
                self.ce_id, self.ce_avg_price, _, _, self.ce_symbol_name = \
                    self._extract_quote_fields(new_quote, new_strike, "CE")
                
                if self.ce_id:
                    try:
                        self.helper.subscribe_instruments([("NSE_FNO", str(self.ce_id), 15)])
                        time.sleep(1)
                    except Exception as ws_err:
                        logger.error(f"WebSocket update failed: {ws_err}")
                        
                    # Execute entry for new leg
                    if not self.dry_run:
                        sell_oid = self.helper.sell(str(self.ce_id), self.ce_qty, product=self.product_type)
                        self.ce_avg_price = self.get_execution_price(sell_oid, self.ce_avg_price)
                    else:
                        logger.info(f"[DRY RUN] Simulating entry for rolled CE at {self.ce_avg_price:.2f}")
                    
                    # Set new SL trigger (40% SL)
                    self.ce_sl_price = round(self.ce_avg_price * (1 + self.leg_sl_pct / 100) * 20) / 20
                    self.ce_sl_hit = False
                    
                    if not self.dry_run:
                        self.ce_sl_id = self.helper.place_sl_market(str(self.ce_id), self.ce_qty, self.ce_sl_price, "BUY", product_type=self.product_type)
                        if not self.ce_sl_id:
                            logger.critical("Failed to place Stop Loss order! Squaring off immediately for safety.")
                            self.exit_all_positions("Failed Stop Loss placement during adjustment")
                            return
                        logger.info(f"Rolled CE SL placed at {self.ce_sl_price:.2f}")
                    else:
                        logger.info(f"[DRY RUN] Rolled CE SL set at {self.ce_sl_price:.2f}")
                else:
                    logger.error("Failed to find rolled CE contract ID. CE leg remains flat.")
                    self.ce_qty = 0

            elif self.adjustment_mode == "restrangle":
                # Sell a new OTM PE option to balance the surviving CE leg
                new_strike = int(round((spot - self.pe_offset) / 50) * 50)
                
                # Prevent strike inversion
                if new_strike >= self.ce_strike:
                    new_strike = self.ce_strike - 50
                    logger.warning(f"Adjusted rolled PE strike to {new_strike} to prevent strike inversion with CE {self.ce_strike}")
                
                logger.info(f"Re-strangling: Selling new OTM PE at strike {new_strike}")
                new_quote = self.helper.option("NIFTY", new_strike, "PE")
                self.pe_id, self.pe_avg_price, _, _, self.pe_symbol_name = \
                    self._extract_quote_fields(new_quote, new_strike, "PE")
                
                if self.pe_id:
                    try:
                        self.helper.subscribe_instruments([("NSE_FNO", str(self.pe_id), 15)])
                        time.sleep(1)
                    except Exception as ws_err:
                        logger.error(f"WebSocket subscription failed for rolled PE: {ws_err}")
                    
                    self.pe_qty = self.lots * self.nifty_lot_size
                    if not self.dry_run:
                        sell_oid = self.helper.sell(str(self.pe_id), self.pe_qty, product=self.product_type)
                        self.pe_avg_price = self.get_execution_price(sell_oid, self.pe_avg_price)
                    else:
                        logger.info(f"[DRY RUN] Simulating entry for rolled PE at {self.pe_avg_price:.2f}")
                        
                    # Set new SL trigger on PE (40% SL)
                    self.pe_sl_price = round(self.pe_avg_price * (1 + self.leg_sl_pct / 100) * 20) / 20
                    self.pe_sl_hit = False
                    
                    if not self.dry_run:
                        self.pe_sl_id = self.helper.place_sl_market(str(self.pe_id), self.pe_qty, self.pe_sl_price, "BUY", product_type=self.product_type)
                        if not self.pe_sl_id:
                            logger.critical("Failed to place Stop Loss order! Squaring off immediately for safety.")
                            self.exit_all_positions("Failed Stop Loss placement during adjustment")
                            return
                        logger.info(f"Rolled PE SL placed at {self.pe_sl_price:.2f}")
                    else:
                        logger.info(f"[DRY RUN] Rolled PE SL set at {self.pe_sl_price:.2f}")
                else:
                    logger.error("Failed to find rolled PE contract ID. PE side remains flat.")
                    self.pe_qty = 0

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Nifty Expiry Strategy",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument("--live", action="store_true", default=False,
                        help="Run in LIVE mode (default: dry run)")
    parser.add_argument("--lots", type=int, default=1,
                        help="Lots per leg (default: 1)")
    parser.add_argument("--entry-type", type=str, default="straddle", choices=["straddle", "strangle"],
                        help="Entry position type (default: straddle)")
    parser.add_argument("--ce-offset", type=int, default=100,
                        help="Points above spot for CE strike in distance strangle (default: 100)")
    parser.add_argument("--pe-offset", type=int, default=100,
                        help="Points below spot for PE strike in distance strangle (default: 100)")
    parser.add_argument("--delta", dest="use_delta", action="store_true", default=False,
                        help="Use delta-based strike selection")
    parser.add_argument("--target-delta", type=float, default=0.20,
                        help="Target delta in delta strangle mode (default: 0.20)")
    parser.add_argument("--premium", dest="use_premium", action="store_true", default=False,
                        help="Use premium-based strike selection")
    parser.add_argument("--target-premium", type=float, default=50.0,
                        help="Target premium in premium strangle mode (default: 50.0)")
    parser.add_argument("--leg-sl-pct", type=float, default=40.0,
                        help="Stop loss percentage per individual leg (default: 40.0)")
    parser.add_argument("--adjustment", type=str, default="c2c", choices=["c2c", "restrangle", "roll_closer", "winner_addition", "none"],
                        help="Adjustment mode (default: c2c)")
    parser.add_argument("--max-adjustments", type=int, default=3,
                        help="Maximum adjustments/rolls permitted per session (default: 3)")
    parser.add_argument("--target-profit", type=str, default="4000",
                        help="Global target profit in INR, or a percentage of entry premium collected "
                             "e.g. '20%%' (default: 4000)")
    parser.add_argument("--stop-loss", type=str, default="4000",
                        help="Global stop loss in INR, or a percentage of entry premium collected "
                             "e.g. '20%%' (default: 4000)")
    parser.add_argument("--start-time", type=str, default="09:20",
                        help="Market entry time in HH:MM IST (default: 09:20)")
    parser.add_argument("--eod-time", type=str, default="15:15",
                        help="Auto exit square-off time (default: 15:15)")
    parser.add_argument("--imbalance-threshold", type=float, default=50.0,
                        help="Threshold percentage difference between CE and PE to trigger winner addition (default: 50.0)")
    parser.add_argument("--max-lots", type=int, default=4,
                        help="Maximum lots permitted per leg for winner addition (default: 4)")
    parser.add_argument("--min-adjust-price", type=float, default=10.0,
                        help="Minimum price of the winner leg below which no adjustments will be triggered (default: 10.0)")
    parser.add_argument("--post-sl-balance", action="store_true", default=False,
                        help="Rebalance stopped-out leg to match surviving leg's current premium and lots (default: False)")
    parser.add_argument("--product-type", type=str, default="INTRADAY", choices=["INTRADAY", "MARGIN", "CNC"],
                        help="Product type for orders (default: INTRADAY)")

    args = parser.parse_args()

    try:
        target_val, target_is_pct = parse_target_spec(args.target_profit)
        stop_val, stop_is_pct = parse_target_spec(args.stop_loss)
    except ValueError as e:
        logger.error(f"[CONFIG ERROR] {e}")
        sys.exit(1)

    strategy = NiftyExpiry(
        dry_run=not args.live,
        lots=args.lots,
        entry_type=args.entry_type,
        ce_offset=args.ce_offset,
        pe_offset=args.pe_offset,
        use_delta=args.use_delta,
        target_delta=args.target_delta,
        use_premium=args.use_premium,
        target_premium=args.target_premium,
        leg_sl_pct=args.leg_sl_pct,
        adjustment_mode=args.adjustment,
        max_adjustments=args.max_adjustments,
        profit_target=target_val,
        profit_target_is_pct=target_is_pct,
        stop_loss=stop_val,
        stop_loss_is_pct=stop_is_pct,
        start_time=args.start_time,
        eod_time=args.eod_time,
        imbalance_threshold=args.imbalance_threshold,
        max_lots=args.max_lots,
        min_adjust_price=args.min_adjust_price,
        post_sl_balance=args.post_sl_balance,
        product_type=args.product_type
    )

    try:
        strategy.run()
    except KeyboardInterrupt:
        logger.info("Strategy execution interrupted by user.")
        strategy.exit_all_positions("Keyboard Interrupt")
    except Exception as e:
        logger.exception(f"Unhandled exception in strategy run: {e}")
        strategy.exit_all_positions("Unhandled Exception")
