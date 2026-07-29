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
log_dir = os.path.join(debug_dir, "logs", "delta_neutral")
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

class NiftyDeltaNeutral:
    def __init__(self, dry_run=True, initial_lots=1,
                 threshold_lot=50.0,
                 profit_target=4000.0, profit_target_is_pct=False,
                 stop_loss=4000.0, stop_loss_is_pct=False,
                 target_delta=0.5,
                 start_time="09:20",
                 trail_start_pct=5.0, trail_gap_pts=15.0,
                 state_key="nifty_delta_neutral"):
        self.state_key = state_key
        self.dry_run = dry_run
        self.initial_lots = initial_lots
        self.threshold_lot = threshold_lot
        # Target/SL may be an absolute INR amount or a percentage of entry premium
        # collected (resolved once the position is actually entered, see below).
        self.target_is_pct = profit_target_is_pct
        self.stop_is_pct = stop_loss_is_pct
        self.target_pct = profit_target if profit_target_is_pct else None
        self.stop_pct = stop_loss if stop_loss_is_pct else None
        self.profit_target = None if profit_target_is_pct else profit_target
        self.stop_loss = None if stop_loss_is_pct else -abs(stop_loss)  # Ensure it's negative
        self.target_delta = target_delta
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

        # Fetch OHLC levels
        _levels = self.helper.get_prev_day_levels("NIFTY")
        self.prev_day_high  = _levels["high"]  if _levels else None
        self.prev_day_low   = _levels["low"]   if _levels else None
        self.prev_day_close = _levels["close"] if _levels else None

        self.nifty_lot_size = self.helper.get_lot_size("NIFTY")

        # Short State
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
        self.realized_pnl = 0.0
        self.adjustment_count = 0
        self.expiry = None

        # Trailing Stop Loss State
        self.trail_active = False
        self.entry_combined_pts = 0.0
        self.best_combined_pts = 0.0

        # Session Control
        self.last_adjustment_time = None

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
            "strategy": "nifty_delta_neutral",
            "status": status,
            "mode": "delta_neutral_winner_roll",
            "dry_run": self.dry_run,
            "target_delta": self.target_delta,
            "lots": self.initial_lots,
            "threshold_lot": self.threshold_lot,
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
        return self.realized_pnl + ce_unrealized + pe_unrealized

    def log_state(self, nifty_spot, ce_ltp, pe_ltp, ce_val, pe_val, diff_pct, total_pnl):
        active_thresh = self.threshold_lot
        logger.info(
            f"Delta:{self.target_delta} | Position:{self.ce_strike}C / {self.pe_strike}P | "
            f"CE:{ce_ltp:.1f}({self.ce_lots}L) Val:{ce_val:.1f} | PE:{pe_ltp:.1f}({self.pe_lots}L) Val:{pe_val:.1f} | "
            f"Diff:{diff_pct:.1f}% (Thresh:{active_thresh:.1f}%) | Adj:{self.adjustment_count} | "
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

    def exit_all_positions(self, reason):
        logger.warning(f"!!! EXITING ALL POSITIONS: {reason} !!!")
        if not self.dry_run:
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
        self.ce_lots = self.initial_lots
        self.pe_lots = self.initial_lots
        self.ce_id = None
        self.pe_id = None
        self.ce_symbol_name = None
        self.pe_symbol_name = None
        self.ce_avg_price = 0.0
        self.pe_avg_price = 0.0
        self.adjustment_count = 0
        self.trail_active = False
        self.entry_combined_pts = 0.0
        self.best_combined_pts = 0.0
        self.last_adjustment_time = None
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
        """Selects CE and PE strikes independently: whichever strike is closest to target_delta.
        Because CE/PE 0.5-delta strikes aren't guaranteed symmetric around spot (skew), the
        resulting position can legitimately be a straddle, a strangle, or an inverted strangle
        (CE strike < PE strike) — no inversion guard is applied here."""
        logger.info(f"Selecting strikes for Nifty Spot: {nifty_spot:.2f} using target delta: {self.target_delta}...")

        if chain_df.empty:
            logger.warning("Empty option chain for delta selection.")
            return None, None

        greek_df = chain_df[(chain_df['ce_delta'] != 0) | (chain_df['pe_delta'] != 0)].copy()
        if greek_df.empty:
            logger.warning("No Greeks found in option chain.")
            return None, None

        greek_df['ce_delta_diff'] = abs(abs(greek_df['ce_delta']) - self.target_delta)
        greek_df['pe_delta_diff'] = abs(abs(greek_df['pe_delta']) - self.target_delta)

        ce_strike = int(greek_df.sort_values('ce_delta_diff').index[0])
        pe_strike = int(greek_df.sort_values('pe_delta_diff').index[0])

        shape = "Straddle" if ce_strike == pe_strike else ("Strangle" if ce_strike > pe_strike else "Inverted Strangle")
        logger.info(
            f"Delta Selection ({shape}): CE {ce_strike} (Delta: {greek_df.loc[ce_strike, 'ce_delta']:.2f}) | "
            f"PE {pe_strike} (Delta: {greek_df.loc[pe_strike, 'pe_delta']:.2f})"
        )
        return ce_strike, pe_strike

    def run(self):
        exit_if_market_closed(self.helper, self.dry_run)
        logger.info(f"Starting Nifty Delta Neutral Strategy | Target Delta: {self.target_delta} | Dry Run: {self.dry_run} | Start Time: {self.start_time}")

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

            # Wait for both legs to report a valid LTP before entering. Unlike the source
            # strategy's premium/distance-based entries, delta-selected CE/PE legs are NOT
            # expected to have balanced premiums — Nifty's put-call skew routinely prices
            # the PE leg well above the CE leg (or vice versa) at the same delta, so gating
            # entry on a premium-balance threshold here could block entry indefinitely.
            ready = False
            while True:
                # One batched fetch per iteration covers CE, PE and spot
                ce_price, pe_price, spot = self.fetch_ltps()

                # Check shutdown trigger
                if check_shutdown_trigger(self.state_key):
                    logger.info("UI Shutdown Request while waiting for quotes.")
                    self.save_state(nifty_spot, ce_price, pe_price, 0.0, status="STOPPED")
                    self.reset_session()
                    sys.exit(0)

                # Save current waiting state
                self.save_state(nifty_spot, ce_price, pe_price, 0.0, status="BALANCING")

                if datetime.now().strftime("%H:%M") >= "15:17":
                    logger.info("Market nearing close. Waiting for next cycle...")
                    break

                # Check if Spot has moved away from the strikes originally selected
                if spot > 0 and abs(spot - nifty_spot) >= 50:
                    logger.info(f"Nifty Spot shifted from {nifty_spot:.2f} to {spot:.2f} (>= 50 pts). Restarting entry cycle...")
                    break

                if ce_price > 0 and pe_price > 0:
                    max_prem = max(ce_price, pe_price)
                    diff_pct = abs(ce_price - pe_price) / max_prem * 100
                    self.ce_avg_price = ce_price
                    self.pe_avg_price = pe_price
                    logger.info(f"Quotes ready. CE: {ce_price:.2f} | PE: {pe_price:.2f} | Diff: {diff_pct:.1f}%. Entering.")
                    ready = True
                    break
                time.sleep(5)

            if not ready:
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
                logger.info(f"[DRY RUN] Simulating Entry: {self.ce_strike} CE / {self.pe_strike} PE")

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

                if curr_nifty == 0: curr_nifty = nifty_spot

                # Save current state
                self.save_state(curr_nifty, ce_ltp, pe_ltp, total_pnl, status="RUNNING")

                # --- Spot Drift Check ---
                # Delta-selected CE/PE strikes sit near ATM (often the same strike), so a
                # per-leg strike-boundary check (appropriate for far-OTM strangles) would
                # fire on ordinary intraday noise — or immediately/always when the two legs
                # share a strike. Instead, re-center when spot has drifted materially from
                # the level the position was built around.
                if abs(curr_nifty - nifty_spot) >= 100:
                    self.exit_all_positions(
                        f"Spot Shift! Nifty moved {abs(curr_nifty - nifty_spot):.1f}pts from entry "
                        f"spot {nifty_spot:.2f} to {curr_nifty:.2f} (>= 100pts)."
                    )
                    logger.info("Waiting 5 minutes before re-centering...")
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

                ce_val = self.ce_lots * ce_ltp
                pe_val = self.pe_lots * pe_ltp
                max_val = max(ce_val, pe_val) if max(ce_val, pe_val) > 0 else 1
                diff_pct = abs(ce_val - pe_val) / max_val * 100

                if time.time() - last_log_time >= 5:
                    # Separate fetch purely for the log line's spot display — must not clobber
                    # curr_nifty (used below by the adjustment logic) if this call fails/returns 0.
                    log_nifty = self.helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")
                    self.log_state(log_nifty or curr_nifty or nifty_spot, ce_ltp, pe_ltp, ce_val, pe_val, diff_pct, total_pnl)
                    last_log_time = time.time()

                if self.last_adjustment_time == current_bar: continue

                winner = "CE" if ce_val < pe_val else "PE"
                winner_lots = self.ce_lots if winner == "CE" else self.pe_lots

                # --- ADJUSTMENT TRIGGER: min(CE,PE)/max(CE,PE) below threshold ---
                # (equivalently, diff_pct = 100 - min/max*100 exceeds the threshold)
                active_thresh = self.threshold_lot
                if diff_pct > active_thresh:
                    logger.info(f"!!! Winner Value-balanced Roll Triggered !!! Diff: {diff_pct:.2f}%")

                    chain_df = self.helper.get_option_chain_df("NIFTY", self.expiry)
                    if chain_df.empty:
                        logger.warning("Option Chain empty. Skipping adjustment loop.")
                        continue

                    loser_val = pe_val if winner == "CE" else ce_val
                    new_strike, new_price = self.find_rebalance_strike(winner, loser_val, winner_lots, chain_df, curr_nifty)
                    current_winner_strike = self.ce_strike if winner == "CE" else self.pe_strike

                    if new_strike and new_strike != current_winner_strike:
                        # Close the winning leg
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
                        continue
                    else:
                        logger.info(f"Winner strike is already at target value-balancing strike {new_strike}. Rolling skipped.")
                        self.last_adjustment_time = current_bar  # prevent per-second retriggers
                        continue


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Nifty Delta Neutral Strategy — sells the option closest to a target delta "
                     "(default 0.5) independently for CE and PE. The result may be a straddle, "
                     "strangle, or inverted strangle depending on skew. When the winning leg decays "
                     "far enough below the losing leg (min/max premium ratio below threshold), the "
                     "winning leg is closed and a new strike is chosen whose premium matches the "
                     "losing leg's value.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run, default 0.5 delta on both legs
  python strategies/value_imbalance/nifty_delta_neutral.py

  # Live run, 2 lots, 0.4 target delta
  python strategies/value_imbalance/nifty_delta_neutral.py --live --lots 2 --target-delta 0.4
""")

    parser.add_argument("--live", action="store_true", default=False,
                        help="Run in LIVE mode (default: dry run)")

    parser.add_argument("--lots", type=int, default=1, metavar="N",
                        help="Lots per leg (default: 1)")

    parser.add_argument("--threshold-lot", type=float, default=50.0, metavar="PCT",
                        help="Premium imbalance %% that triggers a winner-roll adjustment — equivalent "
                             "to min(CE,PE)/max(CE,PE) dropping below (100 - threshold)%% "
                             "(default: 50.0, i.e. min/max < 50%%)")

    parser.add_argument("--target-profit", type=str, default="4000", metavar="AMT",
                        help="Global profit target in INR, or a percentage of entry premium collected "
                             "e.g. '20%%' (default: 4000)")

    parser.add_argument("--stop-loss", type=str, default="4000", metavar="AMT",
                        help="Global stop loss in INR, or a percentage of entry premium collected "
                             "e.g. '20%%' (default: 4000)")

    parser.add_argument("--target-delta", type=float, default=0.5, metavar="D",
                        help="Target absolute delta for both CE and PE strike selection (default: 0.5)")

    # Customizable Start Time
    parser.add_argument("--start-time", type=str, default="09:20", metavar="TIME",
                        help="Market start monitoring time (HH:MM IST, default: 09:20)")

    parser.add_argument("--trail-start-pct", type=float, default=5.0,
                        help="Activate trailing SL when profit reaches this %% of entry combined premium (default: 5.0)")
    parser.add_argument("--trail-gap-pts", type=float, default=15.0,
                        help="Exit if combined premium rises this many pts above its best level (default: 15.0)")

    parser.add_argument("--instance-id", type=str, default="", metavar="ID",
                        help="Suffix for debug/state files to run a second concurrent copy of this strategy")

    args = parser.parse_args()
    STATE_KEY = f"nifty_delta_neutral_{args.instance_id}" if args.instance_id else "nifty_delta_neutral"

    try:
        target_val, target_is_pct = parse_target_spec(args.target_profit)
        stop_val, stop_is_pct = parse_target_spec(args.stop_loss)
    except ValueError as e:
        logger.error(f"[CONFIG ERROR] {e}")
        sys.exit(1)

    # --- Configuration Validation ---
    _errors = []

    if args.lots < 1:
        _errors.append(f"--lots must be >= 1, got {args.lots}.")
    if args.threshold_lot <= 0:
        _errors.append(f"--threshold-lot must be > 0, got {args.threshold_lot}.")
    if args.target_delta <= 0 or args.target_delta >= 1:
        _errors.append(f"--target-delta must be between 0 and 1 (exclusive), got {args.target_delta}.")

    if _errors:
        for e in _errors:
            logger.error(f"[CONFIG ERROR] {e}")
        logger.error("Aborting: fix the configuration errors above and retry.")
        sys.exit(1)
    # --- End Validation ---

    mode_label = "LIVE" if args.live else "DRY"
    stop_loss_val = abs(stop_val)

    target_label = f"{target_val:.0f}%" if target_is_pct else f"INR {target_val:.0f}"
    stop_label = f"-{stop_loss_val:.0f}%" if stop_is_pct else f"-INR {stop_loss_val:.0f}"
    logger.info(
        f"Config -> Mode: {mode_label} | Sizing: {args.lots}L | Start Time: {args.start_time} | "
        f"Target Delta: {args.target_delta} | Threshold Lot: {args.threshold_lot}% | "
        f"Profit Target: {target_label} | Stop Loss: {stop_label}"
    )

    strat = NiftyDeltaNeutral(
        dry_run=not args.live,
        initial_lots=args.lots,
        threshold_lot=args.threshold_lot,
        profit_target=target_val,
        profit_target_is_pct=target_is_pct,
        stop_loss=stop_loss_val,
        stop_loss_is_pct=stop_is_pct,
        target_delta=args.target_delta,
        start_time=args.start_time,
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
