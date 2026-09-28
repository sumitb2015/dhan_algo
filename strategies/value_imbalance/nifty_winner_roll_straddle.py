"""
Nifty Winner-Roll Straddle.

Intraday Nifty short ATM straddle that waits for CE/PE premiums to balance
before entering, then — once the decaying ("winner") leg's premium falls to a
fraction of the other ("loser") leg's premium — rolls ONLY the winner to a
fresh strike whose current premium matches the loser's, and repeats the check
against the new baseline. No lot-averaging: both legs stay at a fixed lot size
for the whole cycle; the only adjustment is the winner-leg roll.

Because both legs start at the same ATM strike, rolling the winner closer to
spot to match the loser's (elevated, ITM-ward) premium can require crossing
the loser's strike (CE strike > PE strike inverted). This is the same
strike-inversion risk documented for nifty_advanced_imbalance.py's
winner_roll_atm mode restricted to strangles — here it is handled the way the
rest of this codebase handles it for straddles: detect the inversion before
committing the new leg, and treat it as a signal to flatten and start a fresh
cycle (emergency exit + 5-minute pause), not as a bug to route around.

Validation status: NOT backtested. Dry-run by default; --live places real orders.
"""
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
from lib.strategy_risk import resolve_exit_qty_broker, detect_phantom_leg_broker, PHANTOM_CHECK_INTERVAL_SEC
from lib.execution_broker import ExecutionBroker, ExecutionBrokerError
from lib.telegram_alert import notify

# Setup Logging
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
debug_dir = os.path.join(project_root, "debug")
log_dir = os.path.join(debug_dir, "logs", "winner_roll_straddle")
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
        FlushingFileHandler(
            os.path.join(log_dir, f"{datetime.now().strftime('%Y%m%d')}{instance_log_suffix()}.log"),
            encoding="utf-8",
        )
    ],
    force=True
)
logger = logging.getLogger(__name__)

STRATEGY_KEY_DEFAULT = "nifty_winner_roll_straddle"


class WinnerRollStraddleStrategy:
    def __init__(self, dry_run=True, lots=1,
                 entry_balance_threshold=10.0, roll_threshold_pct=50.0,
                 max_rolls=5, roll_cooldown=60, atm_shift_reset_pts=100.0,
                 profit_target=20.0, profit_target_is_pct=True,
                 stop_loss=20.0, stop_loss_is_pct=True,
                 start_time="09:20", eod_time="15:17",
                 trail_start_rs=500.0, trail_gap_rs=300.0,
                 state_key=STRATEGY_KEY_DEFAULT, broker="dhan"):
        self.state_key = state_key
        self.broker_name = broker
        self.dry_run = dry_run
        self.lots = lots
        self.entry_balance_threshold = entry_balance_threshold
        self.roll_threshold_pct = roll_threshold_pct
        self.max_rolls = max_rolls
        self.roll_cooldown = roll_cooldown
        self.atm_shift_reset_pts = atm_shift_reset_pts
        self.start_time = start_time
        self.eod_time = eod_time

        # Target/SL may be an absolute INR amount or a percentage of the entry
        # premium collected (resolved once the position is actually entered).
        self.target_is_pct = profit_target_is_pct
        self.stop_is_pct = stop_loss_is_pct
        self.target_pct = profit_target if profit_target_is_pct else None
        self.stop_pct = stop_loss if stop_loss_is_pct else None
        self.profit_target = None if profit_target_is_pct else profit_target
        self.stop_loss = None if stop_loss_is_pct else -abs(stop_loss)

        self.trail_start_rs = trail_start_rs
        self.trail_gap_rs = trail_gap_rs

        self.dhan = get_dhan_client()
        if not self.dhan:
            raise Exception("Failed to connect to Dhan.")
        self.helper = DhanHelper(self.dhan)

        try:
            self.broker = ExecutionBroker.create(broker, self.helper, underlying="NIFTY", log=logger.info)
        except ExecutionBrokerError as e:
            logger.error(f"Could not start {broker} execution: {e}")
            raise

        logger.info("Starting WebSocket for NIFTY Index...")
        self.helper.start_websocket([("IDX_I", "13", 15)])
        time.sleep(2)

        _levels = self.helper.get_prev_day_levels("NIFTY")
        self.prev_day_close = _levels["close"] if _levels else None

        self.nifty_lot_size = self.helper.get_lot_size("NIFTY")

        # Position state
        self.ce_strike = None
        self.pe_strike = None
        self.initial_ce_strike = None
        self.ce_id = None
        self.pe_id = None
        self.ce_symbol_name = None
        self.pe_symbol_name = None
        self.ce_avg_price = 0.0
        self.pe_avg_price = 0.0
        self.entry_diff_pct = 0.0
        self.realized_pnl = 0.0
        self.roll_count = 0
        self.expiry = None
        self.last_roll_ts = 0.0

        # Trailing Stop Loss state
        self.trail_active = False
        self.best_pnl = 0.0

        self.consecutive_chain_failures = 0

        self.NIFTY_SPOT_SID = 13

    # ------------------------------------------------------------------
    # Helpers (shared shape with nifty_value_imbalance_straddle.py)
    # ------------------------------------------------------------------

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
        if status == "STOPPED" and not getattr(self, "_stopped_notified", False):
            self._stopped_notified = True
            notify(f"[{self.state_key}] Strategy stopped.")
        state_dict = {
            "strategy": STRATEGY_KEY_DEFAULT,
            "status": status,
            "dry_run": self.dry_run,
            "broker": self.broker_name,
            "lots": self.lots,
            "ce_strike": self.ce_strike,
            "pe_strike": self.pe_strike,
            "ce_ltp": ce_ltp,
            "pe_ltp": pe_ltp,
            "ce_avg_price": self.ce_avg_price,
            "pe_avg_price": self.pe_avg_price,
            "realized_pnl": self.realized_pnl,
            "total_pnl": total_pnl,
            "spot": nifty_spot,
            "rolls": self.roll_count,
            "max_rolls": self.max_rolls,
            "roll_threshold_pct": self.roll_threshold_pct,
            "profit_target": self.profit_target,
            "stop_loss": self.stop_loss,
            "trail_active": self.trail_active,
            "trail_start_rs": self.trail_start_rs,
            "trail_gap_rs": self.trail_gap_rs,
            "best_pnl": round(self.best_pnl, 2),
            "trail_exit_pnl": round(self.best_pnl - self.trail_gap_rs, 2) if self.trail_active else None,
        }
        save_strategy_state(self.state_key, state_dict)

    def get_execution_price(self, order_id: str, fallback_price: float) -> float:
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
            except Exception:
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
        ce_unrealized = (self.ce_avg_price - ce_ltp) * (self.lots * self.nifty_lot_size)
        pe_unrealized = (self.pe_avg_price - pe_ltp) * (self.lots * self.nifty_lot_size)
        return self.realized_pnl + ce_unrealized + pe_unrealized

    def log_state(self, nifty_spot, ce_ltp, pe_ltp, ce_val, pe_val, diff_pct, total_pnl):
        active_thresh = self.roll_threshold_pct + self.entry_diff_pct
        logger.info(
            f"Straddle: {self.ce_strike}CE / {self.pe_strike}PE | CE: {ce_ltp:.2f} Val: {ce_val:.2f} | "
            f"PE: {pe_ltp:.2f} Val: {pe_val:.2f} | Diff: {diff_pct:.2f}% (Thresh: {active_thresh:.2f}%) | "
            f"Rolls: {self.roll_count}/{self.max_rolls} | PnL: {total_pnl:+.0f} (Real: {self.realized_pnl:+.0f})"
        )

    def update_baseline_imbalance(self):
        """Re-baseline the roll threshold after a roll, using fresh LTPs.

        Without this, the threshold would keep firing against the pre-roll gap
        instead of watching for the imbalance to re-emerge from the just-rolled,
        rebalanced position (mirrors nifty_value_imbalance_straddle.py).
        """
        time.sleep(1)
        ce_ltp, pe_ltp, _ = self.fetch_ltps()
        if ce_ltp > 0 and pe_ltp > 0:
            max_val = max(ce_ltp, pe_ltp)
            self.entry_diff_pct = abs(ce_ltp - pe_ltp) / max_val * 100 if max_val > 0 else 0.0
        else:
            self.entry_diff_pct = 0.0
        logger.info(f"Post-Roll baseline imbalance updated to: {self.entry_diff_pct:.2f}%")

    def _book_exit_pnl(self, ce_exit_price, pe_exit_price):
        if ce_exit_price <= 0:
            ce_exit_price = self.ce_avg_price
        if pe_exit_price <= 0:
            pe_exit_price = self.pe_avg_price
        self.realized_pnl = self._calculate_pnl(ce_exit_price, pe_exit_price)
        logger.info(
            f"Cycle closed at CE {ce_exit_price:.2f} / PE {pe_exit_price:.2f} | "
            f"Session realized: INR {self.realized_pnl:+.0f}"
        )

    def exit_all_positions(self, reason):
        logger.warning(f"!!! EXITING ALL POSITIONS: {reason} !!!")
        notify(f"[{self.state_key}] Exiting all positions: {reason}")
        ce_exit_price, pe_exit_price = 0.0, 0.0
        if not self.dry_run:
            if self.ce_id:
                try:
                    own_qty = self.lots * self.nifty_lot_size
                    qty_to_buy, net_qty = resolve_exit_qty_broker(self.broker, self.ce_strike, self.expiry, "CE", own_qty, "BUY", logger)
                    if qty_to_buy > 0:
                        ce_exit_id = self.broker.buy(self.ce_strike, self.expiry, "CE", qty_to_buy)
                        if not ce_exit_id:
                            logger.critical(f"CRITICAL ERROR: Emergency exit order failed for CE (ID: {self.ce_id})!")
                        else:
                            logger.info(f"CE Emergency exit order placed for {qty_to_buy} qty (own {own_qty}, broker net {net_qty}): {ce_exit_id}")
                            ce_exit_price = self.get_execution_price(ce_exit_id, 0.0)
                except Exception as e:
                    logger.error(f"Exit CE Error: {e}")
            if self.pe_id:
                try:
                    own_qty = self.lots * self.nifty_lot_size
                    qty_to_buy, net_qty = resolve_exit_qty_broker(self.broker, self.pe_strike, self.expiry, "PE", own_qty, "BUY", logger)
                    if qty_to_buy > 0:
                        pe_exit_id = self.broker.buy(self.pe_strike, self.expiry, "PE", qty_to_buy)
                        if not pe_exit_id:
                            logger.critical(f"CRITICAL ERROR: Emergency exit order failed for PE (ID: {self.pe_id})!")
                        else:
                            logger.info(f"PE Emergency exit order placed for {qty_to_buy} qty (own {own_qty}, broker net {net_qty}): {pe_exit_id}")
                            pe_exit_price = self.get_execution_price(pe_exit_id, 0.0)
                except Exception as e:
                    logger.error(f"Exit PE Error: {e}")
        else:
            logger.info("[DRY RUN] Simulating Exit of all positions.")

        if (ce_exit_price <= 0 or pe_exit_price <= 0) and self.ce_id and self.pe_id:
            ce_ltp, pe_ltp, _ = self.fetch_ltps()
            ce_exit_price = ce_exit_price or ce_ltp
            pe_exit_price = pe_exit_price or pe_ltp
        self._book_exit_pnl(ce_exit_price, pe_exit_price)

    def reset_session(self):
        if self.ce_id and self.pe_id:
            logger.info(f"Unsubscribing from old strikes: {self.ce_id}, {self.pe_id}")
            try:
                self.helper.unsubscribe_instruments([
                    ("NSE_FNO", str(self.ce_id), 15),
                    ("NSE_FNO", str(self.pe_id), 15)
                ])
            except Exception:
                pass

        self.ce_strike = None
        self.pe_strike = None
        self.initial_ce_strike = None
        self.ce_id = None
        self.pe_id = None
        self.ce_symbol_name = None
        self.pe_symbol_name = None
        self.ce_avg_price = 0.0
        self.pe_avg_price = 0.0
        self.entry_diff_pct = 0.0
        self.roll_count = 0
        self.last_roll_ts = 0.0
        self.consecutive_chain_failures = 0
        self.trail_active = False
        self.best_pnl = 0.0
        logger.info("Session state reset for new cycle.")

    def find_winner_match_strike(self, option_type, target_price, chain_df):
        """
        Find the strike for `option_type` (the WINNER leg being rolled) whose
        current premium is closest to `target_price` (the loser leg's current
        premium). Unlike a rebalance that pushes a leg further OTM to shrink its
        value, matching a higher target premium on the winner leg means moving
        its strike CLOSER to spot (potentially into the money) — so this
        deliberately searches the whole chain rather than restricting to the
        OTM side. The caller's inversion guard, not a directional filter here,
        is what catches a resulting strike that would cross the loser leg.
        """
        prefix = option_type.lower()
        price_col = f"{prefix}_last_price"

        if price_col not in chain_df.columns or chain_df.empty:
            logger.error(f"Price column {price_col} not found in option chain.")
            return None, 0.0

        valid_df = chain_df[chain_df[price_col] > 0].copy()
        if valid_df.empty:
            return None, 0.0

        valid_df['diff'] = (valid_df[price_col] - target_price).abs()
        best_row = valid_df.sort_values('diff').iloc[0]
        best_strike = best_row.name
        best_price = best_row[price_col]

        logger.info(f"Winner-Roll: Target Price {target_price:.2f} | Found Strike {best_strike} @ {best_price:.2f}")
        return int(best_strike), best_price

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    def run(self):
        exit_if_market_closed(self.helper, self.dry_run)
        logger.info(f"Starting Nifty Winner-Roll Straddle (Dry Run: {self.dry_run} | Start Time: {self.start_time})")

        while True:
            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request in outer loop.")
                self.save_state(0, 0, 0, 0, status="STOPPED")
                sys.exit(0)
            self.save_state(0, 0, 0, 0, status="INITIALIZING")

            self.helper.wait_for_market_open(self.dry_run, start_time=self.start_time, eod_time=self.eod_time, shutdown_check=lambda: check_shutdown_trigger(self.state_key))

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

            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request before option quote fetches.")
                self.save_state(nifty_spot, 0, 0, 0.0, status="STOPPED")
                sys.exit(0)

            ce_quote = self.helper.option("NIFTY", self.ce_strike, "CE")
            pe_quote = self.helper.option("NIFTY", self.pe_strike, "PE")

            if (self.is_quote_invalid(ce_quote) or self.is_quote_invalid(pe_quote)) and not chain_df.empty:
                logger.warning("Initial helper.option() failed or returned empty data. Falling back to option chain...")
                if self.is_quote_invalid(ce_quote) and float(self.ce_strike) in chain_df.index:
                    ce_quote = chain_df.loc[float(self.ce_strike)].to_dict()
                    logger.info(f"CE Fallback: {ce_quote.get('ce_last_price')} (ID: {int(ce_quote.get('ce_security_id', 0))})")
                if self.is_quote_invalid(pe_quote) and float(self.pe_strike) in chain_df.index:
                    pe_quote = chain_df.loc[float(self.pe_strike)].to_dict()
                    logger.info(f"PE Fallback: {pe_quote.get('pe_last_price')} (ID: {int(pe_quote.get('pe_security_id', 0))})")

            self.ce_id, self.ce_avg_price, self.expiry, self.nifty_lot_size, self.ce_symbol_name = \
                self._extract_quote_fields(ce_quote, self.ce_strike, "CE")
            self.pe_id, self.pe_avg_price, _, _, self.pe_symbol_name = \
                self._extract_quote_fields(pe_quote, self.pe_strike, "PE")

            if not self.ce_id or not self.pe_id:
                logger.error(f"Initial quotes failed for {self.ce_strike} CE/PE. Waiting 1m.")
                time.sleep(60)
                continue

            logger.info(f"New Cycle: {self.ce_strike} CE/PE | Lot Size: {self.nifty_lot_size} | Expiry: {self.expiry}")

            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request before websocket subscription.")
                self.save_state(nifty_spot, self.ce_avg_price, self.pe_avg_price, 0.0, status="STOPPED")
                sys.exit(0)

            logger.info(f"Subscribing to WebSocket for {self.ce_symbol_name} (ID: {self.ce_id}) and {self.pe_symbol_name} (ID: {self.pe_id})")
            try:
                self.helper.subscribe_instruments([
                    ("NSE_FNO", str(self.ce_id), 15),
                    ("NSE_FNO", str(self.pe_id), 15)
                ])
                time.sleep(2)
            except Exception as e:
                logger.error(f"Failed to subscribe to WebSocket: {e}")

            logger.info(f"Waiting for premiums to balance at ATM {self.ce_strike} (Entry Balance <= {self.entry_balance_threshold}%)...")
            balanced = False
            while True:
                ce_price, pe_price, spot = self.fetch_ltps()

                if check_shutdown_trigger(self.state_key):
                    logger.info("UI Shutdown Request during balanced entry wait.")
                    self.save_state(nifty_spot, ce_price, pe_price, 0.0, status="STOPPED")
                    self.reset_session()
                    sys.exit(0)

                self.save_state(nifty_spot, ce_price, pe_price, 0.0, status="BALANCING")

                if datetime.now().strftime("%H:%M") >= self.eod_time:
                    logger.info("Market nearing close. Waiting for next cycle...")
                    break

                if spot > 0:
                    current_atm = int(round(spot / 50) * 50)
                    if current_atm != self.ce_strike:
                        logger.info(f"ATM strike shifted from {self.ce_strike} to {current_atm} (Spot: {spot:.2f}). Restarting entry cycle...")
                        break

                if ce_price > 0 and pe_price > 0:
                    max_prem = max(ce_price, pe_price)
                    diff_pct = abs(ce_price - pe_price) / max_prem * 100
                    logger.info(f"Waiting for Balance... CE: {ce_price:.2f} | PE: {pe_price:.2f} | Diff: {diff_pct:.1f}% (Target: <= {self.entry_balance_threshold}%)")
                    if diff_pct <= self.entry_balance_threshold:
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
                ce_oid = self.broker.sell(self.ce_strike, self.expiry, "CE", self.lots * self.nifty_lot_size)
                pe_oid = self.broker.sell(self.pe_strike, self.expiry, "PE", self.lots * self.nifty_lot_size)
                if not ce_oid or not pe_oid:
                    logger.error("Entry Failed. Rolling back any successful order to prevent orphaned legs.")
                    if ce_oid and not pe_oid:
                        logger.warning("Rolling back CE order...")
                        try: self.broker.buy(self.ce_strike, self.expiry, "CE", self.lots * self.nifty_lot_size)
                        except Exception as rollback_err: logger.error(f"CE Rollback exception: {rollback_err}")
                    elif pe_oid and not ce_oid:
                        logger.warning("Rolling back PE order...")
                        try: self.broker.buy(self.pe_strike, self.expiry, "PE", self.lots * self.nifty_lot_size)
                        except Exception as rollback_err: logger.error(f"PE Rollback exception: {rollback_err}")
                    continue
                self.ce_avg_price = self.get_execution_price(ce_oid, self.ce_avg_price)
                self.pe_avg_price = self.get_execution_price(pe_oid, self.pe_avg_price)
            else:
                logger.info(f"[DRY RUN] Simulating Entry: {self.ce_strike} CE/PE")

            logger.info(f"Trail SL: arms at +INR {self.trail_start_rs:.0f} MTM, gives back INR {self.trail_gap_rs:.0f}")

            if self.target_is_pct or self.stop_is_pct:
                entry_value = (self.ce_avg_price + self.pe_avg_price) * self.lots * self.nifty_lot_size
                if self.target_is_pct:
                    self.profit_target = entry_value * self.target_pct / 100.0
                    logger.info(f"Resolved profit target: {self.target_pct}% of entry premium INR{entry_value:.0f} = INR{self.profit_target:.0f}")
                if self.stop_is_pct:
                    self.stop_loss = -abs(entry_value * self.stop_pct / 100.0)
                    logger.info(f"Resolved stop loss: {self.stop_pct}% of entry premium INR{entry_value:.0f} = -INR{abs(self.stop_loss):.0f}")

            last_log_time = time.time()
            last_phantom_check = time.time()
            cycle_active = True

            while cycle_active:
                time.sleep(1)

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

                if current_time_str >= self.eod_time:
                    self.exit_all_positions(f"Intraday Auto-Exit at {current_time_str}")
                    break

                if not self.helper.is_market_open() and not self.dry_run:
                    self.exit_all_positions("Market Closed")
                    break

                ce_ltp, pe_ltp, curr_nifty = self.fetch_ltps()
                if ce_ltp <= 0 or pe_ltp <= 0: continue

                total_pnl = self._calculate_pnl(ce_ltp, pe_ltp)
                if curr_nifty == 0: curr_nifty = nifty_spot

                # Victim-side check: notice if a sibling instance's exit or a manual
                # dashboard square-off already flattened a leg we still think is open.
                if time.time() - last_phantom_check >= PHANTOM_CHECK_INTERVAL_SEC:
                    last_phantom_check = time.time()
                    if self.ce_id and detect_phantom_leg_broker(
                        self.broker, self.ce_strike, self.expiry, "CE",
                        self.lots * self.nifty_lot_size, "BUY", logger,
                    ):
                        logger.warning(f"Phantom CE leg detected ({self.ce_strike}) — broker shows it "
                                       f"already closed elsewhere. Ending cycle without placing an order.")
                        self.ce_id = None
                        self.exit_all_positions("Phantom CE leg detected")
                        cycle_active = False
                        break
                    if self.pe_id and detect_phantom_leg_broker(
                        self.broker, self.pe_strike, self.expiry, "PE",
                        self.lots * self.nifty_lot_size, "BUY", logger,
                    ):
                        logger.warning(f"Phantom PE leg detected ({self.pe_strike}) — broker shows it "
                                       f"already closed elsewhere. Ending cycle without placing an order.")
                        self.pe_id = None
                        self.exit_all_positions("Phantom PE leg detected")
                        cycle_active = False
                        break

                self.save_state(curr_nifty, ce_ltp, pe_ltp, total_pnl, status="RUNNING")

                # --- ATM Shift Reset ---
                current_atm = int(round(curr_nifty / 50) * 50)
                if abs(current_atm - self.initial_ce_strike) >= self.atm_shift_reset_pts:
                    self.exit_all_positions(
                        f"ATM Shift! Current ATM strike {current_atm} shifted {self.atm_shift_reset_pts:.0f}pts or more "
                        f"from original strike {self.initial_ce_strike} (Spot: {curr_nifty:.2f})"
                    )
                    logger.info("Waiting 5 minutes before re-centering straddle at new ATM...")
                    self.sleep_cooldown(300)
                    cycle_active = False
                    break

                # --- Trailing Stop Loss (rupee MTM basis; continuous across rolls) ---
                if not self.trail_active and total_pnl >= self.trail_start_rs:
                    self.trail_active = True
                    self.best_pnl = total_pnl
                    logger.info(
                        f"Trail SL activated at {total_pnl:+.0f} "
                        f"(arm {self.trail_start_rs:.0f}, gap {self.trail_gap_rs:.0f})"
                    )

                if self.trail_active:
                    if total_pnl > self.best_pnl:
                        self.best_pnl = total_pnl
                    trail_exit = self.best_pnl - self.trail_gap_rs
                    if total_pnl < trail_exit:
                        self.exit_all_positions(
                            f"Trailing SL Hit! PnL {total_pnl:+.0f} < exit {trail_exit:+.0f} "
                            f"(best {self.best_pnl:+.0f})"
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

                ce_val = ce_ltp
                pe_val = pe_ltp
                max_val = max(ce_val, pe_val)
                diff_pct = abs(ce_val - pe_val) / max_val * 100

                if time.time() - last_log_time >= 2:
                    self.log_state(curr_nifty or nifty_spot, ce_ltp, pe_ltp, ce_val, pe_val, diff_pct, total_pnl)
                    last_log_time = time.time()

                winner = "CE" if ce_val < pe_val else "PE"
                loser = "PE" if ce_val < pe_val else "CE"
                loser_val = pe_val if winner == "CE" else ce_val

                active_thresh = self.roll_threshold_pct + self.entry_diff_pct
                cooldown_elapsed = (time.time() - self.last_roll_ts) >= self.roll_cooldown

                if diff_pct <= active_thresh or not cooldown_elapsed:
                    continue

                if self.roll_count >= self.max_rolls:
                    self.exit_all_positions(
                        f"Max rolls reached ({self.roll_count}/{self.max_rolls}) with imbalance still at {diff_pct:.2f}%."
                    )
                    logger.info("Waiting 5 minutes before restart...")
                    self.sleep_cooldown(300)
                    cycle_active = False
                    break

                logger.info(f"!!! Winner-Roll Trigger !!! Diff: {diff_pct:.2f}% > Thresh: {active_thresh:.2f}%")
                chain_df = self.helper.get_option_chain_df("NIFTY", self.expiry)
                if chain_df.empty:
                    self.consecutive_chain_failures += 1
                    logger.warning(f"Option Chain empty / failed. Consecutive failures: {self.consecutive_chain_failures}")
                    if self.consecutive_chain_failures >= 10:
                        self.exit_all_positions("Emergency Exit: 10 consecutive option chain failures during roll.")
                        cycle_active = False
                        break
                    continue
                else:
                    self.consecutive_chain_failures = 0

                new_strike, new_price = self.find_winner_match_strike(winner, loser_val, chain_df)
                if not new_strike:
                    continue

                # Strike-inversion guard: a straddle starts both legs at the same
                # strike, so rolling the winner closer to spot to match the
                # loser's elevated premium can push it past the loser's strike.
                # Rather than silently allow CE strike <= PE strike (or the
                # reverse), flatten and start a fresh cycle — matches the
                # inversion-guard convention used across this strategy family.
                if (winner == "CE" and new_strike <= self.pe_strike) or (winner == "PE" and new_strike >= self.ce_strike):
                    self.exit_all_positions(
                        f"Blocked strike inversion on winner-roll: new {winner} strike {new_strike} "
                        f"would cross/equal opposite leg ({self.pe_strike if winner == 'CE' else self.ce_strike}). Exiting cycle."
                    )
                    logger.info("Waiting 5 minutes before restart...")
                    self.sleep_cooldown(300)
                    cycle_active = False
                    break

                old_id = str(self.ce_id) if winner == "CE" else str(self.pe_id)
                old_strike = self.ce_strike if winner == "CE" else self.pe_strike
                old_avg = self.ce_avg_price if winner == "CE" else self.pe_avg_price
                exit_price = self.helper.get_ltp(old_id, exchange="NSE_FNO", instrument="OPTIDX")
                if exit_price <= 0:
                    continue

                buy_oid = None
                if not self.dry_run:
                    own_qty = self.lots * self.nifty_lot_size
                    qty_to_buy, net_qty = resolve_exit_qty_broker(self.broker, old_strike, self.expiry, winner, own_qty, "BUY", logger)
                    if qty_to_buy <= 0:
                        logger.warning(
                            f"resolve_exit_qty_broker returned 0 for {winner} {old_strike} roll "
                            f"(own {own_qty}, broker net {net_qty}); nothing to buy back. Aborting roll."
                        )
                        continue
                    buy_oid = self.broker.buy(old_strike, self.expiry, winner, qty_to_buy)
                    if not buy_oid:
                        logger.error(f"Failed to place buy-to-close order for old leg {old_id}. Aborting roll to prevent orphaned legs.")
                        continue
                    logger.info(f"{winner} roll buy-to-close placed for {qty_to_buy} qty (own {own_qty}, broker net {net_qty}): {buy_oid}")
                actual_exit_price = self.get_execution_price(buy_oid, exit_price) if buy_oid else exit_price

                realized = (old_avg - actual_exit_price) * (self.lots * self.nifty_lot_size)
                self.realized_pnl += realized

                new_quote = self.helper.option("NIFTY", new_strike, winner)
                if self.is_quote_invalid(new_quote) and not chain_df.empty:
                    logger.warning(f"New quote fetch failed for roll strike {new_strike}. Falling back to option chain...")
                    if float(new_strike) in chain_df.index:
                        new_quote = chain_df.loc[float(new_strike)].to_dict()

                new_id, price_from_quote, _, lot_size, symbol_name = \
                    self._extract_quote_fields(new_quote, new_strike, winner)

                if not new_id:
                    # The old leg is already bought back and its PnL booked, but we
                    # cannot open the replacement. Leaving ce_id/pe_id pointed at
                    # the CLOSED contract would keep pricing a position we no
                    # longer hold, so treat the leg as closed and end the cycle.
                    logger.critical(
                        f"Could not resolve replacement contract for {winner} strike {new_strike} "
                        f"after closing {old_id}. Treating {winner} as CLOSED and exiting the cycle."
                    )
                    if winner == "CE":
                        self.ce_id, self.ce_strike, self.ce_avg_price = None, None, 0.0
                    else:
                        self.pe_id, self.pe_strike, self.pe_avg_price = None, None, 0.0
                    self.exit_all_positions("Replacement contract unavailable during winner roll")
                    self.sleep_cooldown(300)
                    cycle_active = False
                    break

                self.nifty_lot_size = lot_size
                new_price = price_from_quote if price_from_quote > 0 else new_price

                logger.info(f"Updating WebSocket: Unsubscribing {old_id}, Subscribing {new_id}")
                try:
                    self.helper.unsubscribe_instruments([("NSE_FNO", str(old_id), 15)])
                    self.helper.subscribe_instruments([("NSE_FNO", str(new_id), 15)])
                except Exception as ws_err:
                    logger.error(f"WebSocket update failed: {ws_err}")

                sell_oid = None
                if not self.dry_run:
                    sell_oid = self.broker.sell(new_strike, self.expiry, winner, self.lots * self.nifty_lot_size)
                    if not sell_oid:
                        # Never commit the new leg on an unplaced order — that would
                        # track a short we do not hold. The opposite leg is still
                        # live, so square everything off rather than run one-legged.
                        logger.critical(
                            f"CRITICAL ERROR: Failed to place sell order for new {winner} strike "
                            f"{new_id}! Executing emergency exit."
                        )
                        try:
                            self.helper.unsubscribe_instruments([("NSE_FNO", str(new_id), 15)])
                        except Exception:
                            pass
                        if winner == "CE":
                            self.ce_id, self.ce_strike, self.ce_avg_price = None, None, 0.0
                        else:
                            self.pe_id, self.pe_strike, self.pe_avg_price = None, None, 0.0
                        self.exit_all_positions("Winner-roll sell order failed")
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

                self.roll_count += 1
                self.last_roll_ts = time.time()
                self.update_baseline_imbalance()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Nifty Winner-Roll Straddle Strategy",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run, 1 lot, all defaults (10% entry balance, 50% roll threshold, 20% target/stop)
  python strategies/value_imbalance/nifty_winner_roll_straddle.py

  # Live run, 2 lots
  python strategies/value_imbalance/nifty_winner_roll_straddle.py --live --lots 2

  # Tighter roll trigger (rolls sooner), fewer rolls allowed, flat-rupee target/stop
  python strategies/value_imbalance/nifty_winner_roll_straddle.py --roll-threshold-pct 35 --max-rolls 3 --target-profit 4000 --stop-loss 4000
"""
    )

    parser.add_argument("--live", action="store_true", default=False,
                        help="Run in LIVE mode (default: dry run)")

    parser.add_argument("--lots", type=int, default=1, metavar="N",
                        help="Fixed lots per leg for the whole cycle — no lot-averaging (default: 1)")

    parser.add_argument("--start-time", type=str, default="09:20", metavar="TIME",
                        help="Market start monitoring time (HH:MM IST, default: 09:20)")
    parser.add_argument("--eod-time", type=str, default="15:17", metavar="TIME",
                        help="Intraday auto square-off time (HH:MM IST, default: 15:17)")

    parser.add_argument("--entry-balance-threshold", type=float, default=10.0, metavar="PCT",
                        help="Max CE/PE premium difference %% allowed before entry; waits (BALANCING) until "
                             "premiums are within this band (default: 10.0)")
    parser.add_argument("--roll-threshold-pct", type=float, default=50.0, metavar="PCT",
                        help="Roll the winner leg once the lower-premium leg falls to this %% of the higher-"
                             "premium leg's value, i.e. once |CE-PE|/max(CE,PE) exceeds this pct plus the "
                             "post-entry/post-roll baseline offset (default: 50.0)")
    parser.add_argument("--max-rolls", type=int, default=5, metavar="N",
                        help="Maximum winner-leg rolls allowed per cycle; the next breach past this cap forces "
                             "a full exit and a fresh ATM cycle instead of rolling again (default: 5)")
    parser.add_argument("--roll-cooldown", type=int, default=60, metavar="SEC",
                        help="Minimum seconds between consecutive winner-leg rolls (default: 60)")
    parser.add_argument("--atm-shift-reset-pts", type=float, default=100.0, metavar="PTS",
                        help="If spot moves this many points from the entry ATM strike, square off everything "
                             "and start a fresh cycle at the new ATM (default: 100.0)")

    parser.add_argument("--target-profit", type=str, default="20%", metavar="AMT",
                        help="Global profit target in INR, or a percentage of entry premium collected, "
                             "e.g. '20%%' or '4000' (default: 20%%)")
    parser.add_argument("--stop-loss", type=str, default="20%", metavar="AMT",
                        help="Global stop loss in INR, or a percentage of entry premium collected, "
                             "e.g. '20%%' or '4000' (default: 20%%)")

    parser.add_argument("--trail-start-rs", type=float, default=500.0, metavar="INR",
                        help="Activate trailing SL once MTM profit reaches this many rupees (default: 500)")
    parser.add_argument("--trail-gap-rs", type=float, default=300.0, metavar="INR",
                        help="Exit if MTM gives back this many rupees from its best level (default: 300)")

    parser.add_argument("--instance-id", type=str, default="", metavar="ID",
                        help="Suffix for debug/state files to run a second concurrent copy of this strategy")

    parser.add_argument(
        "--broker", choices=["dhan", "zerodha", "kotak"], default="dhan",
        help="Execution broker for order placement. Market data always comes from Dhan. "
             "Zerodha/Kotak stop-loss/target exits are software-managed only (no resting "
             "broker-side stop order)."
    )

    args = parser.parse_args()
    STATE_KEY = f"{STRATEGY_KEY_DEFAULT}_{args.instance_id}" if args.instance_id else STRATEGY_KEY_DEFAULT

    _errors = []
    if args.roll_threshold_pct <= args.entry_balance_threshold:
        _errors.append(
            f"--roll-threshold-pct ({args.roll_threshold_pct}) must be greater than "
            f"--entry-balance-threshold ({args.entry_balance_threshold}), or the roll trigger could fire "
            f"immediately after entry."
        )
    if args.max_rolls < 0:
        _errors.append("--max-rolls must be >= 0.")
    if _errors:
        for e in _errors:
            logger.error(f"[CONFIG ERROR] {e}")
        sys.exit(1)

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
                f"Roll Threshold: {args.roll_threshold_pct:.1f}% | Max Rolls: {args.max_rolls} | "
                f"Profit Target: {target_label} | Stop Loss: {stop_label}")

    strat = WinnerRollStraddleStrategy(
        dry_run=not args.live,
        lots=args.lots,
        entry_balance_threshold=args.entry_balance_threshold,
        roll_threshold_pct=args.roll_threshold_pct,
        max_rolls=args.max_rolls,
        roll_cooldown=args.roll_cooldown,
        atm_shift_reset_pts=args.atm_shift_reset_pts,
        start_time=args.start_time,
        eod_time=args.eod_time,
        profit_target=target_val,
        profit_target_is_pct=target_is_pct,
        stop_loss=stop_loss_val,
        stop_loss_is_pct=stop_is_pct,
        trail_start_rs=args.trail_start_rs,
        trail_gap_rs=args.trail_gap_rs,
        state_key=STATE_KEY,
        broker=args.broker,
    )
    try:
        strat.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt detected. Gracefully exiting and squaring off all positions...")
        strat.exit_all_positions("KeyboardInterrupt / Manual Stop")
        sys.exit(0)
