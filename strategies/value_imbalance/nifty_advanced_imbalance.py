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
from lib.recovery_reweight import enter_recovery_leg, recovery_stop_price, next_otm_strike
from lib.telegram_alert import notify

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

EOD_EXIT_TIME = "15:17"        # hard intraday square-off (IST, HH:MM)
COOLDOWN_SEC = 300             # pause after any non-EOD cycle exit before re-entering
STRIKE_STEP = 50               # NIFTY strike interval
HEDGE_WING_OFFSET = 200        # hedged_addition: protective wing distance in points
NIFTY_SPOT_SID = 13            # Nifty 50 index (IDX_I) for spot price
ENTRY_BALANCE_PCT = {"straddle": 10.0, "strangle": 25.0}   # max CE/PE premium gap to enter
STRADDLE_SHIFT_PTS = 100       # straddle: exit when ATM drifts this far from the entry strike
STRANGLE_INNER_BUFFER = 100    # strangle: buffer for a leg rolled closer to ATM

SIDES = ("CE", "PE")


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
                 recovery_reweight=False, recovery_sl_pct=0.30, recovery_max_per_cycle=2,
                 trail_start_rs=500.0, trail_gap_rs=300.0,
                 scalp_floor_pct=0.0, multi_cycle=False, cycle_cooldown=300,
                 state_key="nifty_advanced_imbalance", broker="dhan"):
        self.state_key = state_key
        self.broker_name = broker
        self.mode = mode.lower()
        self.dry_run = dry_run
        self.initial_lots = initial_lots
        self.max_lots = max_lots
        self.threshold_lot = threshold_lot
        self.threshold_strike = threshold_strike
        # Target/SL may be an absolute INR amount or a percentage of entry premium
        # collected (resolved once the position is actually entered, see _enter_positions).
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
        self.recovery_reweight = bool(recovery_reweight)
        self.recovery_sl_pct = recovery_sl_pct
        self.recovery_max_per_cycle = int(recovery_max_per_cycle)
        self.trail_start_rs = trail_start_rs
        self.trail_gap_rs = trail_gap_rs
        self.scalp_floor_pct = float(scalp_floor_pct)
        self.multi_cycle = bool(multi_cycle)
        self.cycle_cooldown = int(cycle_cooldown)

        self.dhan = get_dhan_client()
        if not self.dhan:
            raise Exception("Failed to connect to Dhan.")
        self.helper = DhanHelper(self.dhan)

        try:
            self.broker = ExecutionBroker.create(broker, self.helper, underlying="NIFTY", log=logger.info)
        except ExecutionBrokerError as e:
            logger.error(f"Could not start {broker} execution: {e}")
            sys.exit(1)

        # Start WebSocket for Nifty Spot (Essential for reliable LTP)
        logger.info("Starting WebSocket for NIFTY Index...")
        self.helper.start_websocket([("IDX_I", str(NIFTY_SPOT_SID), 15)])
        time.sleep(2) # Wait for initial tick

        # Fetch OHLC levels
        _levels = self.helper.get_prev_day_levels("NIFTY")
        self.prev_day_high  = _levels["high"]  if _levels else None
        self.prev_day_low   = _levels["low"]   if _levels else None
        self.prev_day_close = _levels["close"] if _levels else None

        self.nifty_lot_size = self.helper.get_lot_size("NIFTY")

        # Day-level P&L: banked cycle results. Reset when the calendar date rolls.
        self.daily_pnl = 0.0
        self.pnl_date = datetime.now().date()

        # Cycle state (everything below is wiped by reset_session)
        self.expiry = None
        self.reset_session(unsubscribe=False)

    # ------------------------------------------------------------------
    # Per-leg attribute access: legs live in ce_* / pe_* attributes so the
    # state file keys stay stable; these helpers let CE/PE share one code path.
    # ------------------------------------------------------------------
    def _leg_get(self, side, name):
        return getattr(self, f"{side.lower()}_{name}")

    def _leg_set(self, side, **fields):
        for name, value in fields.items():
            setattr(self, f"{side.lower()}_{name}", value)

    def reset_session(self, unsubscribe=True):
        """Resets cycle-specific state for a new entry cycle."""
        if unsubscribe:
            to_drop = [self.ce_id, self.pe_id]
            to_drop += [w['id'] for w in self.ce_wings + self.pe_wings]
            # Defensive: exit_all_positions() already closes and clears any open
            # Recovery Reweight leg before every reset, but never let one survive.
            to_drop += [r['id'] for r in (self.ce_recovery, self.pe_recovery) if r]
            self._unsubscribe([i for i in to_drop if i])

        self.ce_strike = self.pe_strike = None
        self.initial_ce_strike = self.initial_pe_strike = None
        self.ce_lots = self.pe_lots = self.initial_lots
        self.ce_id = self.pe_id = None
        self.ce_symbol_name = self.pe_symbol_name = None
        self.ce_avg_price = self.pe_avg_price = 0.0
        self.entry_diff_pct = 0.0
        # realized_pnl is per-CYCLE, not per-day. Every cycle's total_pnl is banked
        # into self.daily_pnl when the cycle closes (see _end_cycle), so carrying
        # realized_pnl into the next cycle would count it twice.
        self.realized_pnl = 0.0
        self.adjustment_count = 0
        self.consecutive_chain_failures = 0
        self.last_adjustment_time = None

        # Trailing stop (rupee MTM basis)
        self.trail_active = False
        self.best_pnl = 0.0

        # Hedge wings (hedged_addition mode)
        self.ce_wings = []
        self.pe_wings = []

        # Entry premiums (scalp lock basis; also reentry_straddle re-entry level)
        self.initial_ce_entry_price = self.initial_pe_entry_price = 0.0

        # reentry_straddle per-leg state
        self.ce_active = self.pe_active = False
        self.ce_sl = self.pe_sl = 0.0
        self.ce_original_entry_premium = self.pe_original_entry_premium = 0.0

        # Recovery Reweight (--recovery-reweight, reentry_straddle only). None when no
        # recovery leg is open; otherwise {'id','strike','avg_price','sl','qty'} for a
        # long option one strike further OTM than the short leg that just stopped out.
        # While a side's recovery leg is open, that side's short-leg re-entry is
        # suppressed. Attempts are capped per side per cycle.
        self.ce_recovery = self.pe_recovery = None
        self.ce_recovery_count = self.pe_recovery_count = 0
        logger.info("Session state reset.")

    def _unsubscribe(self, ids):
        if not ids:
            return
        try:
            self.helper.unsubscribe_instruments([("NSE_FNO", str(i), 15) for i in ids])
        except Exception:
            pass

    def _subscribe(self, ids):
        try:
            self.helper.subscribe_instruments([("NSE_FNO", str(i), 15) for i in ids])
        except Exception as e:
            logger.error(f"WebSocket subscribe failed for {ids}: {e}")

    # ------------------------------------------------------------------
    # Dashboard state / shutdown
    # ------------------------------------------------------------------
    def save_state(self, nifty_spot, ce_ltp, pe_ltp, total_pnl, status="RUNNING", cycle_pnl=None):
        """Publish state for the dashboard.

        Two different numbers, deliberately decoupled:
          * `total_pnl`  -> the card's headline figure. While a cycle is open this is
            the cycle's P&L; once the day has ended it should be the day's total.
          * `cycle_pnl`  -> the OPEN cycle's contribution, used to derive "daily_pnl"
            as self.daily_pnl + cycle_pnl. Pass 0.0 once the cycle has been banked
            into self.daily_pnl, or the same cycle is counted twice.

        Defaults to cycle_pnl = total_pnl, which is correct for the common running
        case where the headline IS the open cycle.
        """
        cycle_pnl = total_pnl if cycle_pnl is None else cycle_pnl
        if status == "STOPPED" and not getattr(self, "_stopped_notified", False):
            self._stopped_notified = True
            notify(f"[{self.state_key}] Strategy stopped.")
        state_dict = {
            "strategy": "nifty_advanced_imbalance",
            "status": status,
            "broker": self.broker_name,
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
            "recovery_reweight": self.recovery_reweight,
            "recovery_sl_pct": self.recovery_sl_pct,
            "recovery_max_per_cycle": self.recovery_max_per_cycle,
            "ce_recovery": self.ce_recovery,
            "pe_recovery": self.pe_recovery,
            "ce_recovery_count": self.ce_recovery_count,
            "pe_recovery_count": self.pe_recovery_count,
            "trail_active": self.trail_active,
            "trail_start_rs": self.trail_start_rs,
            "trail_gap_rs": self.trail_gap_rs,
            "best_pnl": round(self.best_pnl, 2),
            "trail_exit_pnl": round(self.best_pnl - self.trail_gap_rs, 2) if self.trail_active else None,
            "scalp_floor_pct": self.scalp_floor_pct,
            "multi_cycle": self.multi_cycle,
            "cycle_cooldown": self.cycle_cooldown,
            "initial_combined_premium": round(self.initial_ce_entry_price + self.initial_pe_entry_price, 2) if (self.initial_ce_entry_price > 0 and self.initial_pe_entry_price > 0) else None,
            "daily_pnl": round(self.daily_pnl + cycle_pnl, 2),
        }
        save_strategy_state(self.state_key, state_dict)

    def _shutdown_requested(self):
        return check_shutdown_trigger(self.state_key)

    def _stop_now(self, spot=0.0, ce_ltp=0.0, pe_ltp=0.0, cycle_pnl=0.0):
        """Publish STOPPED (headline = day total) and exit the process."""
        self.save_state(spot, ce_ltp, pe_ltp, self.daily_pnl + cycle_pnl, status="STOPPED", cycle_pnl=cycle_pnl)
        sys.exit(0)

    def _stop_if_requested(self, where, spot=0.0, ce_ltp=0.0, pe_ltp=0.0):
        """Shutdown check for points where no positions are open."""
        if self._shutdown_requested():
            logger.info(f"UI Shutdown Request {where}.")
            self._stop_now(spot, ce_ltp, pe_ltp)

    def _stop_with_positions(self, fallback_spot):
        """Shutdown check inside the monitor loop: flatten, then exit."""
        if not self._shutdown_requested():
            return
        try:
            ce_ltp, pe_ltp, spot = self.fetch_ltps()
            ce_ltp = ce_ltp if ce_ltp > 0 else self.ce_avg_price
            pe_ltp = pe_ltp if pe_ltp > 0 else self.pe_avg_price
            cycle_pnl = self._calculate_pnl(ce_ltp, pe_ltp)
            spot = spot if spot > 0 else fallback_spot
        except Exception as e:
            logger.warning(f"LTP fetch exception during shutdown: {e}")
            ce_ltp, pe_ltp, spot, cycle_pnl = self.ce_avg_price, self.pe_avg_price, fallback_spot, 0.0
        self.exit_all_positions("UI Shutdown Request")
        self._stop_now(spot, ce_ltp, pe_ltp, cycle_pnl)

    def sleep_cooldown(self, seconds, reason="Cooldown"):
        """Shutdown-aware sleep for cooldowns and delays with UI status updates."""
        for remaining in range(int(seconds), 0, -1):
            self._stop_if_requested("during cooldown sleep")
            if remaining % 5 == 0 or remaining <= 5:
                # No cycle is open during a cooldown — the day's P&L is already banked.
                self.save_state(0, 0, 0, self.daily_pnl, status=f"COOLDOWN ({remaining}s)", cycle_pnl=0.0)
            time.sleep(1)

    def _wait_next_day(self):
        """Block until the next session opens (day target / stop reached)."""
        if not self.helper.wait_for_next_day_market_open(
                self.dry_run, start_time=self.start_time, shutdown_check=self._shutdown_requested):
            self._stop_now()

    def _end_cycle(self, reason, cycle_pnl, cooldown=COOLDOWN_SEC, next_day=False):
        """Flatten everything, bank the cycle's P&L into the day total, then pause.

        Every cycle exit goes through here so daily_pnl can never miss a cycle —
        the global target / stop-loss compare against it.
        """
        self.exit_all_positions(reason)
        self.daily_pnl += cycle_pnl
        if next_day:
            logger.info(f"Day P&L banked: INR {self.daily_pnl:+.0f}. Waiting for next session.")
            self._wait_next_day()
        elif cooldown > 0:
            logger.info(f"Cycle P&L {cycle_pnl:+.0f} banked (day {self.daily_pnl:+.0f}). Waiting {cooldown}s before next cycle...")
            self.sleep_cooldown(cooldown)

    # ------------------------------------------------------------------
    # Quotes / pricing
    # ------------------------------------------------------------------
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

    def _quote_for(self, strike, side, chain_df=None):
        """Quote for `strike` via helper.option(), falling back to the chain row."""
        quote = self.helper.option("NIFTY", strike, side)
        if self.is_quote_invalid(quote) and chain_df is not None and not chain_df.empty \
                and float(strike) in chain_df.index:
            quote = chain_df.loc[float(strike)].to_dict()
        return quote

    def fetch_ltps(self):
        """Batched CE/PE/spot LTP fetch — at most one REST call when the WebSocket misses."""
        ltps = self.helper.get_ltps([
            ("NSE_FNO", self.ce_id),
            ("NSE_FNO", self.pe_id),
            ("IDX_I", NIFTY_SPOT_SID),
        ])
        return (
            ltps.get(str(self.ce_id), 0.0),
            ltps.get(str(self.pe_id), 0.0),
            ltps.get(str(NIFTY_SPOT_SID), 0.0),
        )

    def _calculate_pnl(self, ce_ltp, pe_ltp):
        # Short positions: (Entry - Current) * Qty
        ce_unrealized = (self.ce_avg_price - ce_ltp) * (self.ce_lots * self.nifty_lot_size)
        pe_unrealized = (self.pe_avg_price - pe_ltp) * (self.pe_lots * self.nifty_lot_size)

        # Long positions (hedge wings): (Current - Entry) * Qty
        long_pnl = 0.0
        for wing in self.ce_wings + self.pe_wings:
            wing_ltp = self.helper.get_ltp(str(wing['id']), exchange="NSE_FNO", instrument="OPTIDX")
            if wing_ltp > 0:
                long_pnl += (wing_ltp - wing['buy_price']) * (wing['lots'] * self.nifty_lot_size)

        # Recovery Reweight legs are also long options
        for recovery in (self.ce_recovery, self.pe_recovery):
            if not recovery:
                continue
            recovery_ltp = self.helper.get_ltp(str(recovery['id']), exchange="NSE_FNO", instrument="OPTIDX")
            if recovery_ltp > 0:
                long_pnl += (recovery_ltp - recovery['avg_price']) * recovery['qty']

        return self.realized_pnl + ce_unrealized + pe_unrealized + long_pnl

    def _imbalance(self, ce_ltp, pe_ltp):
        """(ce_value, pe_value, diff_pct) — premium value = lots x LTP, diff relative to the larger."""
        ce_val = self.ce_lots * ce_ltp
        pe_val = self.pe_lots * pe_ltp
        max_val = max(ce_val, pe_val)
        diff_pct = abs(ce_val - pe_val) / max_val * 100 if max_val > 0 else 0.0
        return ce_val, pe_val, diff_pct

    def _active_threshold(self):
        """Adjustment trigger: lot threshold, or the (wider) strike threshold once a leg is at max lots."""
        at_max = self.ce_lots == self.max_lots or self.pe_lots == self.max_lots
        return (self.threshold_strike if at_max else self.threshold_lot) + self.entry_diff_pct

    def log_state(self, nifty_spot, ce_ltp, pe_ltp, ce_val, pe_val, diff_pct, total_pnl):
        thresh_label = "Strk" if (self.ce_lots == self.max_lots or self.pe_lots == self.max_lots) else "Lot"
        wing_desc = ""
        if self.mode == "hedged_addition":
            wing_desc = f" | W_CE:{len(self.ce_wings)}L W_PE:{len(self.pe_wings)}L"

        logger.info(
            f"Mode:{self.mode} | Straddle:{self.ce_strike}C / {self.pe_strike}P | "
            f"CE:{ce_ltp:.1f}({self.ce_lots}L) Val:{ce_val:.1f} | PE:{pe_ltp:.1f}({self.pe_lots}L) Val:{pe_val:.1f}{wing_desc} | "
            f"Diff:{diff_pct:.1f}% (Thresh:{self._active_threshold():.1f}% {thresh_label}) | Adj:{self.adjustment_count} | "
            f"PnL:{total_pnl:+.0f} (Real:{self.realized_pnl:+.0f})"
        )

    def update_baseline_imbalance(self):
        """Update baseline imbalance (entry_diff_pct) after an adjustment using new LTPs."""
        time.sleep(1) # Let the live feed stabilize
        ce_ltp, pe_ltp, _ = self.fetch_ltps()
        if ce_ltp > 0 and pe_ltp > 0:
            self.entry_diff_pct = self._imbalance(ce_ltp, pe_ltp)[2]
        else:
            self.entry_diff_pct = 0.0
        logger.info(f"Post-Adjustment baseline imbalance updated to: {self.entry_diff_pct:.2f}%")

    # ------------------------------------------------------------------
    # Order primitives
    # ------------------------------------------------------------------
    def _close_leg(self, label, strike, opt_type, own_qty, side, ltp):
        """Close a leg this strategy opened. `side` is the closing side: BUY for a
        short, SELL for a long. Only this strategy's own quantity is traded, clamped
        to what the broker still shows (lib/strategy_risk.py).

        Returns (exit_price, qty_closed, order_failed). Never raises on a failed
        order — the caller decides whether to keep or drop its tracking.
        """
        if self.dry_run:
            logger.info(f"[DRY RUN] {label}: {side} {opt_type} {strike} x{own_qty} @ {ltp:.2f}")
            return ltp, own_qty, False
        qty, net_qty = resolve_exit_qty_broker(self.broker, strike, self.expiry, opt_type, own_qty, side, logger)
        if qty <= 0:
            logger.warning(f"{label}: {opt_type} {strike} broker net {net_qty} — nothing to close.")
            return ltp, 0, False
        place = self.broker.buy if side == "BUY" else self.broker.sell
        oid = place(strike, self.expiry, opt_type, qty)
        if not oid:
            logger.critical(f"{label}: {side} order FAILED for {opt_type} {strike} x{qty}. Verify the position manually!")
            return ltp, qty, True
        price = self.get_execution_price(oid, ltp)
        logger.info(f"{label}: {side} {opt_type} {strike} x{qty} (own {own_qty}, broker net {net_qty}) @ {price:.2f}: {oid}")
        return price, qty, False

    def _open_short(self, strike, opt_type, qty, ltp):
        """Sell to open. Returns (fill_price, ok)."""
        if self.dry_run:
            return ltp, True
        oid = self.broker.sell(strike, self.expiry, opt_type, qty)
        if not oid:
            return ltp, False
        return self.get_execution_price(oid, ltp), True

    def exit_all_positions(self, reason):
        """Flatten every leg this strategy holds: shorts first, then long wings, then recovery legs."""
        logger.warning(f"!!! EXITING ALL POSITIONS: {reason} !!!")
        notify(f"[{self.state_key}] Exiting all positions: {reason}")

        legs = []  # (label, strike, opt_type, own_qty, closing_side)
        for side in SIDES:
            if self._leg_get(side, "id") and self._leg_get(side, "lots") > 0:
                legs.append((f"{side} short", self._leg_get(side, "strike"), side,
                             self._leg_get(side, "lots") * self.nifty_lot_size, "BUY"))
        for side in SIDES:
            for wing in self._leg_get(side, "wings"):
                legs.append((f"{side} wing {wing['strike']}", wing['strike'], side,
                             wing['lots'] * self.nifty_lot_size, "SELL"))
        for side in SIDES:
            recovery = self._leg_get(side, "recovery")
            if recovery:
                legs.append((f"{side} recovery {recovery['strike']}", recovery['strike'], side,
                             recovery['qty'], "SELL"))

        for label, strike, opt_type, own_qty, closing_side in legs:
            try:
                self._close_leg(f"Exit {label}", strike, opt_type, own_qty, closing_side, 0.0)
            except Exception as e:
                logger.error(f"Exit {label} Error: {e}")

        # Recovery tracking always clears on a full exit, dry-run or live — the leg
        # is gone either way, and stale tracking would block re-entry checks (or
        # double-close) on the next cycle.
        self._unsubscribe([r['id'] for r in (self.ce_recovery, self.pe_recovery) if r])
        self.ce_recovery = None
        self.pe_recovery = None

    # ------------------------------------------------------------------
    # Strike selection
    # ------------------------------------------------------------------
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
        except Exception:
            return None, 0.0

    def select_strikes(self, nifty_spot, chain_df):
        """Selects CE and PE strikes based on straddle or strangle selection (distance, delta, or premium)."""
        logger.info(f"Selecting strikes for Nifty Spot: {nifty_spot:.2f} using entry type: {self.entry_type}...")

        if self.entry_type == "straddle":
            ce_strike = int(round(nifty_spot / STRIKE_STEP) * STRIKE_STEP)
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
                        ce_strike = int(round((nifty_spot + self.ce_offset) / STRIKE_STEP) * STRIKE_STEP)

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
                        pe_strike = int(round((nifty_spot - self.pe_offset) / STRIKE_STEP) * STRIKE_STEP)

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
                ce_strike = int(round((nifty_spot + self.ce_offset) / STRIKE_STEP) * STRIKE_STEP)
                pe_strike = int(round((nifty_spot - self.pe_offset) / STRIKE_STEP) * STRIKE_STEP)
                logger.info(f"Distance Strangle Selection: {ce_strike} CE (+{self.ce_offset}) | {pe_strike} PE (-{self.pe_offset})")

            # Check for inverted strikes
            if ce_strike <= pe_strike:
                logger.error(f"Inverted strikes detected! CE strike {ce_strike} must be strictly greater than PE strike {pe_strike}. Bypassing selection.")
                return None, None
            return ce_strike, pe_strike

        return None, None

    # ------------------------------------------------------------------
    # Cycle start: pick strikes -> subscribe -> wait for balance -> enter
    # ------------------------------------------------------------------
    def _resolve_spot(self, chain_df):
        spot = self.helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")
        if spot == 0 and not chain_df.empty:
            logger.warning("Direct LTP failed for NIFTY Index. Falling back to Option Chain...")
            spot = chain_df.attrs.get('underlying_ltp', 0)
        if spot == 0 and self.prev_day_close and self.prev_day_close > 0:
            spot = self.prev_day_close
            logger.warning(f"Fallback to previous day close spot price: {spot:.2f} for dry-run simulation.")
        return spot

    def _prepare_cycle(self):
        """Select strikes, resolve contracts, subscribe feeds. Returns the entry spot, or None to retry."""
        self.expiry = self.helper.get_nearest_expiry("NIFTY")
        chain_df = self.helper.get_option_chain_df("NIFTY", self.expiry) if self.expiry else pd.DataFrame()

        spot = self._resolve_spot(chain_df)
        if spot == 0:
            logger.error("Could not fetch Nifty Spot. Retrying in 30s...")
            time.sleep(30)
            return None

        self.ce_strike, self.pe_strike = self.select_strikes(spot, chain_df)
        if not self.ce_strike or not self.pe_strike:
            logger.error("Strike selection failed. Retrying in 10s...")
            time.sleep(10)
            return None
        self.initial_ce_strike = self.ce_strike
        self.initial_pe_strike = self.pe_strike

        self._stop_if_requested("before option quote fetches", spot)

        ce_quote = self._quote_for(self.ce_strike, "CE", chain_df)
        pe_quote = self._quote_for(self.pe_strike, "PE", chain_df)
        self.ce_id, self.ce_avg_price, self.expiry, self.nifty_lot_size, self.ce_symbol_name = \
            self._extract_quote_fields(ce_quote, self.ce_strike, "CE")
        self.pe_id, self.pe_avg_price, _, _, self.pe_symbol_name = \
            self._extract_quote_fields(pe_quote, self.pe_strike, "PE")

        if not self.ce_id or not self.pe_id:
            logger.error(f"Initial quotes failed for CE {self.ce_strike} / PE {self.pe_strike}. Waiting 1m.")
            time.sleep(60)
            return None

        logger.info(f"New Cycle: {self.ce_strike}CE / {self.pe_strike}PE | Lot Size: {self.nifty_lot_size} | Expiry: {self.expiry}")
        self._stop_if_requested("before websocket subscription", spot, self.ce_avg_price, self.pe_avg_price)

        logger.info(f"Subscribing to WebSocket for {self.ce_symbol_name} (ID: {self.ce_id}) and {self.pe_symbol_name} (ID: {self.pe_id})")
        self._subscribe([self.ce_id, self.pe_id])
        time.sleep(2) # Wait for initial ticks
        return spot

    def _wait_for_balance(self, entry_spot):
        """Poll until CE/PE premiums are within the entry-balance gap. False = restart the cycle."""
        target_diff = ENTRY_BALANCE_PCT[self.entry_type]
        logger.info(f"Waiting for premiums to balance (Target: < {target_diff}%)...")
        while True:
            # One batched fetch per iteration covers CE, PE and spot
            ce_price, pe_price, spot = self.fetch_ltps()

            if self._shutdown_requested():
                logger.info("UI Shutdown Request during balanced entry wait.")
                self.save_state(entry_spot, ce_price, pe_price, self.daily_pnl, status="STOPPED", cycle_pnl=0.0)
                self.reset_session()
                sys.exit(0)

            self.save_state(entry_spot, ce_price, pe_price, 0.0, status="BALANCING", cycle_pnl=0.0)

            if datetime.now().strftime("%H:%M") >= EOD_EXIT_TIME:
                logger.info("Market nearing close. Waiting for next cycle...")
                return False

            # Check if ATM or Spot has changed while waiting
            if spot > 0:
                if self.entry_type == "straddle":
                    current_atm = int(round(spot / STRIKE_STEP) * STRIKE_STEP)
                    if current_atm != self.ce_strike:
                        logger.info(f"ATM strike shifted from {self.ce_strike} to {current_atm} (Spot: {spot:.2f}). Restarting entry cycle...")
                        return False
                elif abs(spot - entry_spot) >= 50:
                    logger.info(f"Nifty Spot shifted from {entry_spot:.2f} to {spot:.2f} (>= 50 pts). Restarting entry cycle...")
                    return False

            if ce_price > 0 and pe_price > 0:
                diff_pct = abs(ce_price - pe_price) / max(ce_price, pe_price) * 100
                logger.info(f"Waiting for Balance... CE: {ce_price:.2f} | PE: {pe_price:.2f} | Diff: {diff_pct:.1f}% (Target: < {target_diff}%)")
                if diff_pct < target_diff:
                    self.ce_avg_price = ce_price
                    self.pe_avg_price = pe_price
                    self.entry_diff_pct = diff_pct
                    logger.info(f"Balanced! Entry Diff: {self.entry_diff_pct:.2f}%. Entering.")
                    return True
            time.sleep(5)

    def _enter_positions(self):
        """Sell the initial CE+PE. Returns False (after rolling back any lone leg) if either order fails."""
        qty = self.initial_lots * self.nifty_lot_size
        if not self.dry_run:
            ce_oid = self.broker.sell(self.ce_strike, self.expiry, "CE", qty)
            pe_oid = self.broker.sell(self.pe_strike, self.expiry, "PE", qty)
            if not ce_oid or not pe_oid:
                logger.error("Entry Failed. Rolling back any successful order to prevent orphaned legs.")
                for oid, side, strike in ((ce_oid, "CE", self.ce_strike), (pe_oid, "PE", self.pe_strike)):
                    if oid and not (ce_oid and pe_oid):
                        logger.warning(f"Rolling back {side} order...")
                        try:
                            self.broker.buy(strike, self.expiry, side, qty)
                        except Exception as rollback_err:
                            logger.error(f"{side} Rollback exception: {rollback_err}")
                time.sleep(30)  # don't hammer a failing order path
                return False
            self.ce_avg_price = self.get_execution_price(ce_oid, self.ce_avg_price)
            self.pe_avg_price = self.get_execution_price(pe_oid, self.pe_avg_price)
        else:
            logger.info(f"[DRY RUN] Simulating Entry: {self.ce_strike} CE/PE")

        self.initial_ce_entry_price = self.ce_avg_price
        self.initial_pe_entry_price = self.pe_avg_price

        logger.info(f"Trail SL: arms at +INR {self.trail_start_rs:.0f} MTM, gives back INR {self.trail_gap_rs:.0f}")
        if self.scalp_floor_pct > 0:
            combined_prem = self.initial_ce_entry_price + self.initial_pe_entry_price
            initial_val = combined_prem * self.initial_lots * self.nifty_lot_size
            logger.info(
                f"Scalp Lock Active: target exit when premium decays {self.scalp_floor_pct:.1f}% "
                f"(Initial Premium: {combined_prem:.2f} | Initial Value: INR {initial_val:.0f} | "
                f"Scalp Lock Target: +INR {initial_val * self.scalp_floor_pct / 100.0:.0f})"
            )

        if self.target_is_pct or self.stop_is_pct:
            entry_value = (self.ce_avg_price * self.ce_lots + self.pe_avg_price * self.pe_lots) * self.nifty_lot_size
            if self.target_is_pct:
                self.profit_target = entry_value * self.target_pct / 100.0
                logger.info(f"Resolved profit target: {self.target_pct}% of entry premium INR{entry_value:.0f} = INR{self.profit_target:.0f}")
            if self.stop_is_pct:
                self.stop_loss = -abs(entry_value * self.stop_pct / 100.0)
                logger.info(f"Resolved stop loss: {self.stop_pct}% of entry premium INR{entry_value:.0f} = -INR{abs(self.stop_loss):.0f}")

        if self.mode == "reentry_straddle":
            self.ce_active = self.pe_active = True
            self.ce_original_entry_premium = self.ce_avg_price
            self.pe_original_entry_premium = self.pe_avg_price
            self.ce_sl = round(self.ce_avg_price * (1 + self.leg_sl_pct), 2)
            self.pe_sl = round(self.pe_avg_price * (1 + self.leg_sl_pct), 2)
            logger.info(
                f"Reentry Straddle Started | "
                f"CE: {self.ce_avg_price:.2f} (SL: {self.ce_sl:.2f}) | "
                f"PE: {self.pe_avg_price:.2f} (SL: {self.pe_sl:.2f})"
            )
        return True

    # ------------------------------------------------------------------
    # Monitoring loop
    # ------------------------------------------------------------------
    def _monitor_cycle(self, entry_spot):
        """Run one open cycle until it ends (always via _end_cycle / EOD)."""
        last_log = last_phantom = time.time()
        total_pnl = 0.0

        while True:
            time.sleep(1)
            self._stop_with_positions(entry_spot)

            now = datetime.now()
            hhmm = now.strftime("%H:%M")
            current_bar = now.strftime("%Y-%m-%d %H:%M")

            if hhmm >= EOD_EXIT_TIME:
                self._end_cycle(f"Intraday Auto-Exit at {hhmm}", total_pnl, cooldown=0)
                return
            if not self.dry_run and not self.helper.is_market_open():
                self._end_cycle("Market Closed", total_pnl, cooldown=0)
                return

            # One batched fetch per iteration covers CE, PE and spot
            ce_ltp, pe_ltp, spot = self.fetch_ltps()
            if ce_ltp <= 0 or pe_ltp <= 0:
                continue
            spot = spot or entry_spot
            total_pnl = self._calculate_pnl(ce_ltp, pe_ltp)

            if time.time() - last_phantom >= PHANTOM_CHECK_INTERVAL_SEC:
                last_phantom = time.time()
                self._check_phantom_legs()

            self.save_state(spot, ce_ltp, pe_ltp, total_pnl, status="RUNNING")

            if (self._check_range_exit(spot, total_pnl)
                    or self._check_trail_exit(total_pnl)
                    or self._check_scalp_lock(total_pnl)
                    or self._check_day_limits(total_pnl)):
                return

            if self.mode == "reentry_straddle":
                if time.time() - last_log >= 5:
                    self._log_reentry_state(ce_ltp, pe_ltp, total_pnl)
                    last_log = time.time()
                self._handle_reentry_sl_and_entry(ce_ltp, pe_ltp)
                continue  # skip imbalance-based adjustment logic

            ce_val, pe_val, diff_pct = self._imbalance(ce_ltp, pe_ltp)
            if time.time() - last_log >= 5:
                self.log_state(spot, ce_ltp, pe_ltp, ce_val, pe_val, diff_pct, total_pnl)
                last_log = time.time()

            if self.last_adjustment_time == current_bar:
                continue  # at most one adjustment per minute bar

            if diff_pct > self._active_threshold():
                winner, loser = ("CE", "PE") if ce_val < pe_val else ("PE", "CE")
                if self._adjust(winner, loser, diff_pct, ce_ltp, pe_ltp, ce_val, pe_val, spot, current_bar):
                    return

    def _check_phantom_legs(self):
        """Victim-side check (2026-07-30 incident follow-up): notice if a sibling
        instance's exit or a manual square-off already flattened a leg we still
        think is open, instead of trading against phantom state."""
        for side in SIDES:
            if self._leg_get(side, "active") and detect_phantom_leg_broker(
                self.broker, self._leg_get(side, "strike"), self.expiry, side,
                self._leg_get(side, "lots") * self.nifty_lot_size, "BUY", logger,
            ):
                logger.warning(f"Phantom {side} leg detected ({self._leg_get(side, 'strike')}) — broker shows it "
                               f"already closed elsewhere. Correcting internal state, not placing an order.")
                self._leg_set(side, active=False, lots=0)

    def _check_range_exit(self, spot, total_pnl):
        """Straddle ATM drift / strangle strike breach. True if the cycle ended."""
        if self.entry_type == "straddle":
            current_atm = int(round(spot / STRIKE_STEP) * STRIKE_STEP)
            if abs(current_atm - self.initial_ce_strike) >= STRADDLE_SHIFT_PTS:
                self._end_cycle(
                    f"Straddle Shift! Current ATM strike {current_atm} shifted {STRADDLE_SHIFT_PTS}pts or more "
                    f"from original strike {self.initial_ce_strike} (Spot: {spot:.2f})", total_pnl)
                return True
            return False

        # Strangle boundaries: a strike at its initial OTM level, or rolled further OTM,
        # is a hard boundary. One rolled closer to ATM gets a buffer for market wiggles.
        upper = self.ce_strike + STRANGLE_INNER_BUFFER if self.ce_strike < self.initial_ce_strike else self.ce_strike
        lower = self.pe_strike - STRANGLE_INNER_BUFFER if self.pe_strike > self.initial_pe_strike else self.pe_strike
        if spot >= upper or spot <= lower:
            self._end_cycle(
                f"Strangle Shift! Market breached strike boundary! Nifty: {spot:.2f} "
                f"(Boundaries: {lower} - {upper})", total_pnl)
            return True
        return False

    def _update_trail(self, total_pnl):
        """Advance the rupee-MTM trailing stop. True if it has been hit.

        total_pnl already folds in realized_pnl, so every roll / lot-add is
        absorbed automatically — there is no baseline to go stale.
        """
        if self.ce_lots <= 0 and self.pe_lots <= 0:
            return False
        if not self.trail_active and total_pnl >= self.trail_start_rs:
            self.trail_active = True
            self.best_pnl = total_pnl
            logger.info(f"Trail SL activated at {total_pnl:+.0f} (arm {self.trail_start_rs:.0f}, gap {self.trail_gap_rs:.0f})")
        if not self.trail_active:
            return False
        self.best_pnl = max(self.best_pnl, total_pnl)
        return total_pnl < self.best_pnl - self.trail_gap_rs

    def _check_trail_exit(self, total_pnl):
        if not self._update_trail(total_pnl):
            return False
        self._end_cycle(
            f"Trailing SL Hit! PnL {total_pnl:+.0f} < exit {self.best_pnl - self.trail_gap_rs:+.0f} "
            f"(best {self.best_pnl:+.0f})", total_pnl)
        return True

    def _scalp_decay_pct(self, total_pnl):
        """Cycle P&L as % of the entry premium value of the lots actually held, or None.

        The denominator tracks held lots: total_pnl reflects post-adjustment sizing, so
        pricing the basis at initial_lots would inflate the % and fire the lock early
        after every lot addition.
        """
        if self.scalp_floor_pct <= 0 or (self.ce_lots <= 0 and self.pe_lots <= 0):
            return None
        basis = (self.initial_ce_entry_price * self.ce_lots + self.initial_pe_entry_price * self.pe_lots) * self.nifty_lot_size
        return (total_pnl / basis) * 100.0 if basis > 0 else None

    def _check_scalp_lock(self, total_pnl):
        decay_pct = self._scalp_decay_pct(total_pnl)
        if decay_pct is None or decay_pct < self.scalp_floor_pct:
            return False
        reached_day_target = self.profit_target is not None and self.daily_pnl + total_pnl >= self.profit_target
        stop_for_day = reached_day_target or not self.multi_cycle
        if reached_day_target:
            logger.info(f"Scalp Lock hit & Global Daily Profit Target Reached (+INR {self.daily_pnl + total_pnl:.0f})! Stopping strategy for the day.")
        self._end_cycle(
            f"Scalp Lock Triggered! Premium decay achieved: {decay_pct:.1f}% "
            f"(Target: >={self.scalp_floor_pct:.1f}% | Cycle PnL: {total_pnl:+.0f})",
            total_pnl, cooldown=self.cycle_cooldown, next_day=stop_for_day)
        return True

    def _check_day_limits(self, total_pnl):
        """Global daily profit target / stop loss against banked + open P&L."""
        cumulative = self.daily_pnl + total_pnl
        if self.profit_target is not None and cumulative >= self.profit_target:
            self._end_cycle(f"Global Daily Profit Target Reached: {cumulative:.2f}", total_pnl, next_day=True)
            return True
        if self.stop_loss is not None and cumulative <= self.stop_loss:
            self._end_cycle(f"Global Daily Stop Loss Hit: {cumulative:.2f}", total_pnl, next_day=True)
            return True
        return False

    # ------------------------------------------------------------------
    # Imbalance adjustments (every mode except reentry_straddle)
    # ------------------------------------------------------------------
    def _adjust(self, winner, loser, diff_pct, ce_ltp, pe_ltp, ce_val, pe_val, spot, bar):
        """Dispatch one imbalance adjustment. True if the cycle ended."""
        winner_lots = self._leg_get(winner, "lots")
        if self.mode == "winner_roll_atm":
            logger.info(f"!!! Winner Value-balanced Roll Triggered !!! Diff: {diff_pct:.2f}%")
            return self._adjust_winner_roll(winner, winner_lots, ce_ltp, pe_ltp, ce_val, pe_val, spot, bar)
        if self.mode == "loser_ratio_roll":
            logger.info(f"!!! Loser Ratio Roll Triggered !!! Diff: {diff_pct:.2f}%")
            return self._adjust_loser_ratio(loser, ce_ltp, pe_ltp, ce_val, pe_val, spot, bar)
        # hedged_addition / legacy
        return self._adjust_add_winner(winner, diff_pct, ce_ltp, pe_ltp, bar, hedged=self.mode == "hedged_addition")

    def _roll_would_invert(self, side, new_strike):
        return (side == "CE" and new_strike <= self.pe_strike) or (side == "PE" and new_strike >= self.ce_strike)

    def _adjust_winner_roll(self, winner, winner_lots, ce_ltp, pe_ltp, ce_val, pe_val, spot, bar):
        # Early deadlock detection: rolling the winner closer to ATM requires crossing the
        # opposite leg. PE winner must go UP but can't reach the CE strike; CE winner must
        # go DOWN but can't reach the PE strike.
        if (winner == "PE" and self.pe_strike + STRIKE_STEP >= self.ce_strike) or \
           (winner == "CE" and self.ce_strike - STRIKE_STEP <= self.pe_strike):
            other = "CE" if winner == "PE" else "PE"
            self._end_cycle(
                f"Structural deadlock: {winner} winner at {self._leg_get(winner, 'strike')} has no room to roll "
                f"closer to ATM without crossing {other} at {self._leg_get(other, 'strike')}. Exiting cycle.",
                self._calculate_pnl(ce_ltp, pe_ltp))
            return True

        chain_df = self.helper.get_option_chain_df("NIFTY", self.expiry)
        if chain_df.empty:
            logger.warning("Option Chain empty. Skipping adjustment loop.")
            return False

        loser_val = pe_val if winner == "CE" else ce_val
        new_strike, new_price = self.find_rebalance_strike(winner, loser_val, winner_lots, chain_df, spot)
        if not new_strike or new_strike == self._leg_get(winner, "strike"):
            logger.info(f"Winner strike is already at target value-balancing strike {new_strike}. Rolling skipped.")
            self.last_adjustment_time = bar  # prevent per-second retriggers
            return False

        return self._roll_leg(winner, new_strike, new_price, winner_lots, ce_ltp, pe_ltp, chain_df, bar,
                              label="winner roll")

    def _adjust_loser_ratio(self, loser, ce_ltp, pe_ltp, ce_val, pe_val, spot, bar):
        loser_lots = self._leg_get(loser, "lots")
        new_loser_lots = min(self.max_lots, loser_lots + self.loser_ratio_lots)
        if new_loser_lots == loser_lots:
            self._end_cycle(f"Loser already at max lots ({self.max_lots}). Exiting.", self._calculate_pnl(ce_ltp, pe_ltp))
            return True

        chain_df = self.helper.get_option_chain_df("NIFTY", self.expiry)
        if chain_df.empty:
            logger.warning("Option Chain empty. Skipping adjustment loop.")
            return False

        winner_val = ce_val if loser == "PE" else pe_val
        new_strike, new_price = self.find_rebalance_strike(loser, winner_val, new_loser_lots, chain_df, spot)
        if not new_strike:
            return False
        return self._roll_leg(loser, new_strike, new_price, new_loser_lots, ce_ltp, pe_ltp, chain_df, bar,
                              label="loser ratio roll")

    def _roll_leg(self, side, new_strike, new_price, new_lots, ce_ltp, pe_ltp, chain_df, bar, label):
        """Buy back `side`'s short leg and re-sell `new_lots` at `new_strike`. True if the cycle ended.

        Failure handling: if the buy-back fails nothing has changed and the roll is simply
        skipped. Once the old leg is closed its lots are zeroed immediately, so any later
        abort (no quote / sell rejected) banks the correct P&L and never re-closes it.
        """
        if self._roll_would_invert(side, new_strike):
            self._end_cycle(
                f"Blocked strike inversion adjustment ({label}): new {side} strike {new_strike} "
                f"would cross/equal opposite leg. Exiting cycle.", self._calculate_pnl(ce_ltp, pe_ltp))
            return True

        old_id = self._leg_get(side, "id")
        old_strike = self._leg_get(side, "strike")
        old_lots = self._leg_get(side, "lots")
        old_avg = self._leg_get(side, "avg_price")
        old_ltp = ce_ltp if side == "CE" else pe_ltp
        if old_ltp <= 0:
            return False

        exit_price, qty_closed, failed = self._close_leg(
            f"Roll {side} {old_strike}", old_strike, side, old_lots * self.nifty_lot_size, "BUY", old_ltp)
        if failed:
            logger.error(f"Failed to buy-to-close old {side} {old_id}. Aborting adjustment.")
            return False
        self.realized_pnl += (old_avg - exit_price) * qty_closed
        self._leg_set(side, lots=0)
        self._unsubscribe([old_id])

        new_id, quote_price, _, lot_size, symbol_name = self._extract_quote_fields(
            self._quote_for(new_strike, side, chain_df), new_strike, side)
        if not new_id:
            logger.critical(f"No quote for new {side} strike {new_strike} after closing the old leg. Exiting cycle.")
            self._end_cycle(f"{label}: no quote for new strike", self._calculate_pnl(ce_ltp, pe_ltp))
            return True
        self.nifty_lot_size = lot_size
        new_price = quote_price if quote_price > 0 else new_price
        self._subscribe([new_id])

        fill_price, ok = self._open_short(new_strike, side, new_lots * self.nifty_lot_size, new_price)
        if not ok:
            logger.critical(f"CRITICAL ERROR: Failed to place sell order for new {side} strike {new_id}! Executing emergency exit.")
            self._unsubscribe([new_id])
            self._end_cycle(f"{label}: sell order failed", self._calculate_pnl(ce_ltp, pe_ltp))
            return True

        self._leg_set(side, strike=new_strike, symbol_name=symbol_name, id=new_id,
                      avg_price=fill_price, lots=new_lots)
        self.adjustment_count += 1
        self.last_adjustment_time = bar
        self.update_baseline_imbalance()
        return False

    def _adjust_add_winner(self, winner, diff_pct, ce_ltp, pe_ltp, bar, hedged):
        """Sell one more lot of the winner (hedged: buy a protective wing first). True if the cycle ended."""
        winner_lots = self._leg_get(winner, "lots")
        if winner_lots >= self.max_lots:
            self._end_cycle(f"Winner leg ({winner}) already at max lots ({self.max_lots}). Exiting.",
                            self._calculate_pnl(ce_ltp, pe_ltp))
            return True

        logger.info(f"!!! {'Hedged Addition' if hedged else 'Legacy Lot Addition'} Triggered !!! Diff: {diff_pct:.2f}%")
        strike = self._leg_get(winner, "strike")
        ltp = ce_ltp if winner == "CE" else pe_ltp
        lot_qty = self.nifty_lot_size
        wing = None

        if hedged:
            # Buy the wing first (safety first), then sell the extra short lot.
            wing_strike = strike + HEDGE_WING_OFFSET if winner == "CE" else strike - HEDGE_WING_OFFSET
            wing_id, wing_price, _, _, symbol_name = self._extract_quote_fields(
                self.helper.option("NIFTY", wing_strike, winner), wing_strike, winner)
            if not wing_id:
                return False
            wing_fill = wing_price
            if not self.dry_run:
                wing_oid = self.broker.buy(wing_strike, self.expiry, winner, lot_qty)
                if not wing_oid:
                    logger.error(f"Failed to place buy-to-open order for protective wing {wing_id}. Aborting short adjustment.")
                    return False
                wing_fill = self.get_execution_price(wing_oid, wing_price)
            wing = {'id': wing_id, 'lots': 1, 'strike': wing_strike, 'buy_price': wing_fill, 'symbol': symbol_name}

        fill_price, ok = self._open_short(strike, winner, lot_qty, ltp)
        if not ok:
            logger.error(f"Failed to place short addition order for {winner} {strike}. Aborting adjustment.")
            if wing and not self.dry_run:
                logger.critical("Closing protective wing to prevent an unmatched long.")
                try:
                    self.broker.sell(wing['strike'], self.expiry, winner, lot_qty)
                except Exception as close_err:
                    logger.error(f"Failed to dump protective wing: {close_err}")
            return False

        if wing:
            self._subscribe([wing['id']])
            self._leg_get(winner, "wings").append(wing)
        avg = self._leg_get(winner, "avg_price")
        self._leg_set(winner, avg_price=((avg * winner_lots) + fill_price) / (winner_lots + 1), lots=winner_lots + 1)
        self.adjustment_count += 1
        self.last_adjustment_time = bar
        self.update_baseline_imbalance()
        return False

    # ------------------------------------------------------------------
    # reentry_straddle: independent per-leg SL + re-entry (+ optional recovery leg)
    # ------------------------------------------------------------------
    def _log_reentry_state(self, ce_ltp, pe_ltp, total_pnl):
        def status(side):
            recovery = self._leg_get(side, "recovery")
            if self._leg_get(side, "active"):
                return f"ACTIVE SL:{self._leg_get(side, 'sl'):.1f}"
            if recovery:
                return f"RECOVERY@{recovery['strike']} SL:{recovery['sl']:.1f}"
            return f"FLAT(reenter@<={self._leg_get(side, 'original_entry_premium'):.1f})"
        logger.info(
            f"ReentryStraddle | CE:{ce_ltp:.1f} [{status('CE')}] | PE:{pe_ltp:.1f} [{status('PE')}] | "
            f"PnL:{total_pnl:+.0f} (Real:{self.realized_pnl:+.0f})"
        )

    def _handle_reentry_sl_and_entry(self, ce_ltp, pe_ltp):
        """Per-leg stop-out and re-entry. Recovery legs are managed first so a leg
        that stops out this tick is free to open a fresh recovery leg."""
        ltps = {"CE": ce_ltp, "PE": pe_ltp}
        if self.recovery_reweight:
            for side in SIDES:
                self._check_recovery_exit(side)
        for side in SIDES:
            if self._leg_get(side, "active") and ltps[side] >= self._leg_get(side, "sl"):
                self._stop_out_leg(side, ltps[side])
        for side in SIDES:
            if (not self._leg_get(side, "active") and not self._leg_get(side, "recovery")
                    and 0 < ltps[side] <= self._leg_get(side, "original_entry_premium")):
                self._reenter_leg(side, ltps[side])

    def _stop_out_leg(self, side, ltp):
        avg = self._leg_get(side, "avg_price")
        logger.warning(f"{side} SL Hit! LTP {ltp:.2f} >= SL {self._leg_get(side, 'sl'):.2f} (sold at {avg:.2f})")
        exit_price, qty_closed, failed = self._close_leg(
            f"{side} SL exit", self._leg_get(side, "strike"), side,
            self._leg_get(side, "lots") * self.nifty_lot_size, "BUY", ltp)
        if failed:
            logger.critical(f"{side} SL exit order FAILED. Marking leg inactive at LTP {ltp:.2f} "
                            f"to prevent a duplicate order. Verify {side} position manually!")
        realized = (avg - exit_price) * qty_closed
        self.realized_pnl += realized
        logger.info(f"{side} leg closed at {exit_price:.2f}. Leg realized: {realized:+.2f}. "
                    f"Watching for re-entry at <= {self._leg_get(side, 'original_entry_premium'):.2f}")
        self._leg_set(side, avg_price=0.0, lots=0, active=False)
        if self.recovery_reweight:
            self._enter_recovery(side, qty_closed)

    def _reenter_leg(self, side, ltp):
        logger.info(f"{side} Re-entry! LTP {ltp:.2f} <= original entry {self._leg_get(side, 'original_entry_premium'):.2f}")
        fill_price, ok = self._open_short(self._leg_get(side, "strike"), side,
                                          self.initial_lots * self.nifty_lot_size, ltp)
        if not ok:
            logger.error(f"{side} re-entry sell order failed. Will retry next tick.")
            return
        sl = round(fill_price * (1 + self.leg_sl_pct), 2)
        self._leg_set(side, avg_price=fill_price, lots=self.initial_lots, sl=sl, active=True)
        logger.info(f"{side} Re-entered at {fill_price:.2f} | New SL: {sl:.2f}")

    def _enter_recovery(self, opt_type: str, qty: int):
        """Recovery Reweight (--recovery-reweight): after `opt_type`'s short leg just
        stopped out, buy a fresh long option one strike further OTM, betting the
        stop-out marks a real trend rather than noise. Suppresses that side's normal
        short-leg re-entry until the recovery leg exits."""
        if qty <= 0:
            logger.warning(f"Recovery Reweight: nothing to recover for {opt_type} (qty={qty}). Skipping.")
            return

        count = self._leg_get(opt_type, "recovery_count")
        if count >= self.recovery_max_per_cycle:
            logger.warning(
                f"Recovery Reweight: {opt_type} recovery cap reached "
                f"({count}/{self.recovery_max_per_cycle} this cycle) — leaving {opt_type} flat, "
                f"will resume normal re-entry-on-premium watch instead."
            )
            return

        stopped_strike = self._leg_get(opt_type, "strike")
        recovery_strike = next_otm_strike(stopped_strike, opt_type, strike_step=STRIKE_STEP)

        quote = self.helper.option("NIFTY", recovery_strike, opt_type)
        if self.is_quote_invalid(quote):
            logger.error(f"Recovery Reweight: no valid quote for {opt_type} {recovery_strike}. "
                         f"Skipping recovery entry — {opt_type} side stays flat this tick.")
            return
        new_id, price, _, _, _ = self._extract_quote_fields(quote, recovery_strike, opt_type)
        if not new_id or not price or price <= 0:
            logger.error(f"Recovery Reweight: invalid quote fields for {opt_type} {recovery_strike}. Skipping.")
            return

        entry_price = price
        if not self.dry_run:
            result = enter_recovery_leg(
                self.broker, "NIFTY", self.expiry, stopped_strike, opt_type, qty,
                strike_step=STRIKE_STEP, log=logger,
            )
            if not result:
                return  # enter_recovery_leg already logged the failure
            entry_price = self.get_execution_price(result['order_id'], price)
        else:
            logger.info(f"[DRY RUN] Recovery Reweight: would buy {opt_type} {recovery_strike} qty={qty} @ ~{price:.2f}")

        self._subscribe([new_id])
        recovery = {
            'id': new_id, 'strike': recovery_strike, 'avg_price': entry_price,
            'sl': recovery_stop_price(entry_price, self.recovery_sl_pct), 'qty': qty,
        }
        self._leg_set(opt_type, recovery=recovery, recovery_count=count + 1)
        logger.info(
            f"Recovery Reweight: {opt_type} recovery leg opened at {recovery_strike} "
            f"(stopped leg was {stopped_strike}, attempt {count + 1}/{self.recovery_max_per_cycle} this cycle) "
            f"qty={qty} entry={entry_price:.2f} SL={recovery['sl']:.2f}"
        )

    def _check_recovery_exit(self, opt_type: str):
        """SL-only exit for an open Recovery Reweight leg — it rides with the trend
        until stopped. Once it closes, the side's short-leg re-entry check resumes."""
        recovery = self._leg_get(opt_type, "recovery")
        if not recovery:
            return
        ltp = self.helper.get_ltp(str(recovery['id']), exchange="NSE_FNO", instrument="OPTIDX")
        if ltp <= 0 or ltp > recovery['sl']:
            return

        logger.warning(f"Recovery Reweight: {opt_type} recovery leg SL hit! LTP {ltp:.2f} <= "
                       f"SL {recovery['sl']:.2f} (bought at {recovery['avg_price']:.2f})")
        exit_price, qty_closed, _ = self._close_leg(
            f"Recovery {opt_type} exit", recovery['strike'], opt_type, recovery['qty'], "SELL", ltp)
        realized = (exit_price - recovery['avg_price']) * qty_closed
        self.realized_pnl += realized
        logger.info(f"Recovery {opt_type} leg closed at {exit_price:.2f}. Leg realized: {realized:+.2f}.")
        self._unsubscribe([recovery['id']])
        self._leg_set(opt_type, recovery=None)

    # ------------------------------------------------------------------
    # Main
    # ------------------------------------------------------------------
    def run(self):
        exit_if_market_closed(self.helper, self.dry_run)
        logger.info(f"Starting Nifty Advanced Imbalance Strategy | Mode: {self.mode} | Dry Run: {self.dry_run} | Start Time: {self.start_time}")

        while True:
            self._stop_if_requested("in outer loop")
            self.save_state(0, 0, 0, 0, status="INITIALIZING", cycle_pnl=0.0)

            # Wait for market open if closed
            self.helper.wait_for_market_open(self.dry_run, start_time=self.start_time, eod_time=EOD_EXIT_TIME,
                                             shutdown_check=self._shutdown_requested)

            # New trading day -> fresh day totals (a long-running process must not carry
            # yesterday's banked P&L into today's target / stop-loss checks).
            today = datetime.now().date()
            if today != self.pnl_date:
                logger.info(f"New trading day {today}: resetting daily P&L (was {self.daily_pnl:+.0f}).")
                self.daily_pnl = 0.0
                self.pnl_date = today

            self.reset_session()

            entry_spot = self._prepare_cycle()
            if entry_spot is None:
                continue
            if not self._wait_for_balance(entry_spot):
                continue
            if not self._enter_positions():
                continue
            self._monitor_cycle(entry_spot)


def build_parser():
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
                     Add --recovery-reweight to instead buy a fresh long option one strike
                     further OTM on a leg's SL hit (own SL via --recovery-sl-pct), betting the
                     stop-out marks a real trend rather than noise to fade. Capped at
                     --recovery-max-per-cycle attempts per side per cycle (default: 2).

Examples:
  # Dry run with value-balanced winner roll adjustment (needs a strangle)
  python strategies/value_imbalance/nifty_advanced_imbalance.py --entry-type strangle --mode winner_roll_atm

  # Live run with hedged addition adjustment, initial 2 lots
  python strategies/value_imbalance/nifty_advanced_imbalance.py --live --lots 2 --mode hedged_addition

  # Dry run with reentry straddle (independent per-leg SL + re-entry)
  python strategies/value_imbalance/nifty_advanced_imbalance.py --mode reentry_straddle --entry-type straddle
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
    parser.add_argument("--threshold-strike", type=float, default=40.0, metavar="PCT",
                        help="Premium imbalance %% (added to entry_diff_pct) that triggers a strike "
                             "shift once max-lots is reached (default: 40.0)")

    parser.add_argument("--target-profit", type=str, default="25%", metavar="AMT",
                        help="Global profit target in INR, or a percentage of entry premium collected "
                             "e.g. '25%%' (default: 25%%)")

    parser.add_argument("--stop-loss", type=str, default="25%", metavar="AMT",
                        help="Global stop loss in INR, or a percentage of entry premium collected "
                             "e.g. '25%%' (default: 25%%)")

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

    parser.add_argument("--start-time", type=str, default="09:20", metavar="TIME",
                        help="Market start monitoring time (HH:MM IST, default: 09:20)")

    parser.add_argument("--loser-ratio-lots", type=int, default=1, metavar="N",
                        help="Number of lots to add for loser ratio roll (default: 1)")

    parser.add_argument("--leg-sl-pct", type=float, default=0.20, metavar="PCT",
                        help="Per-leg stop loss as a fraction of entry premium in reentry_straddle mode "
                             "(default: 0.20 = 20%%). E.g. 0.30 triggers SL at 130%% of entry price.")
    parser.add_argument("--recovery-reweight", action="store_true", default=False,
                        help="reentry_straddle mode only: on a leg's SL hit, buy a fresh long option one "
                             "strike further OTM instead of just waiting to re-sell the same short leg "
                             "(see lib/recovery_reweight.py). Default: False (plain re-entry).")
    parser.add_argument("--recovery-sl-pct", type=float, default=0.30, metavar="PCT",
                        help="Stop loss for a recovery leg, as a fraction below its entry price "
                             "(default: 0.30 = 30%%). Only used with --recovery-reweight.")
    parser.add_argument("--recovery-max-per-cycle", type=int, default=2, metavar="N",
                        help="Max recovery-leg attempts per side per cycle (default: 2). A choppy "
                             "session can stop a recovery leg out and let the short leg resume, "
                             "then get stopped into recovery again repeatedly; once a side hits "
                             "this cap it falls back to plain re-entry-on-premium for the rest of "
                             "the cycle. Only used with --recovery-reweight.")
    parser.add_argument("--trail-start-rs", type=float, default=500.0, metavar="INR",
                        help="Activate trailing SL once MTM profit reaches this many rupees (default: 500)")
    parser.add_argument("--trail-gap-rs", type=float, default=300.0, metavar="INR",
                        help="Exit if MTM gives back this many rupees from its best level (default: 300)")

    # Scalp Lock / Multi-cycle
    parser.add_argument("--scalp-floor-pct", type=float, default=0.0, metavar="PCT",
                        help="Combined premium decay %% that triggers a scalp profit exit e.g. 30.0 (default: 0.0, disabled)")
    parser.add_argument("--multi-cycle", action="store_true", default=False,
                        help="Auto-restart with fresh ATM after scalp floor exits (default: False)")
    parser.add_argument("--cycle-cooldown", type=int, default=300, metavar="SEC",
                        help="Cooldown in seconds between scalp cycles (default: 300)")

    parser.add_argument("--instance-id", type=str, default="", metavar="ID",
                        help="Suffix for debug/state files to run a second concurrent copy of this strategy")

    parser.add_argument(
        "--broker", choices=["dhan", "zerodha", "kotak"], default="dhan",
        help="Execution broker for order placement. Market data always comes from Dhan. "
             "Zerodha/Kotak stop-loss/target exits are software-managed only (no resting "
             "broker-side stop order)."
    )
    return parser


def validate_args(args):
    """Return a list of configuration errors (empty = valid)."""
    errors = []

    # winner_roll_atm requires a strangle: in a straddle both legs share the same ATM strike,
    # so rolling the winner closer to ATM always crosses the opposite leg (inversion).
    if args.mode == "winner_roll_atm" and args.entry_type == "straddle":
        errors.append(
            "--mode winner_roll_atm is incompatible with --entry-type straddle.\n"
            "  Reason: in a straddle both legs are at the same ATM strike, so rolling the winner\n"
            "  closer to ATM immediately crosses/equals the opposite leg (strike inversion).\n"
            "  Fix: use --entry-type strangle with winner_roll_atm, OR switch to\n"
            "       --mode hedged_addition / loser_ratio_roll / legacy with straddle."
        )

    # reentry_straddle is inherently a straddle-only mode (ATM entry with per-leg SL/re-entry).
    if args.mode == "reentry_straddle" and args.entry_type != "straddle":
        errors.append(
            "--mode reentry_straddle requires --entry-type straddle.\n"
            "  Reason: this mode sells ATM CE and PE and manages each leg independently."
        )

    # --leg-sl-pct only applies to reentry_straddle
    if args.leg_sl_pct != 0.20 and args.mode != "reentry_straddle":
        errors.append(f"--leg-sl-pct {args.leg_sl_pct} has no effect in --mode {args.mode} (only used with reentry_straddle).")
    if args.leg_sl_pct <= 0:
        errors.append(f"--leg-sl-pct must be > 0, got {args.leg_sl_pct}.")

    # --recovery-* only apply to reentry_straddle
    if args.recovery_reweight and args.mode != "reentry_straddle":
        errors.append(f"--recovery-reweight has no effect in --mode {args.mode} (only used with reentry_straddle).")
    if args.recovery_sl_pct != 0.30 and not args.recovery_reweight:
        errors.append(f"--recovery-sl-pct {args.recovery_sl_pct} has no effect without --recovery-reweight.")
    if args.recovery_sl_pct <= 0 or args.recovery_sl_pct >= 1:
        errors.append(f"--recovery-sl-pct must be between 0 and 1 (exclusive), got {args.recovery_sl_pct}.")
    if args.recovery_max_per_cycle != 2 and not args.recovery_reweight:
        errors.append(f"--recovery-max-per-cycle {args.recovery_max_per_cycle} has no effect without --recovery-reweight.")
    if args.recovery_max_per_cycle < 1:
        errors.append(f"--recovery-max-per-cycle must be >= 1, got {args.recovery_max_per_cycle}.")

    # --max-lots has no effect in reentry_straddle (always re-enters at initial lot size)
    if args.mode == "reentry_straddle" and args.max_lots != 4:
        errors.append(
            f"--max-lots {args.max_lots} has no effect in --mode reentry_straddle "
            f"(this mode always re-enters at the initial lot size; lot scaling is not used)."
        )

    # --delta and --premium are mutually exclusive strike selection methods
    if args.delta and args.premium:
        errors.append("--delta and --premium are mutually exclusive.\n  Use only one strike selection method at a time.")

    # Lot sizing sanity checks
    if args.lots < 1:
        errors.append(f"--lots must be >= 1, got {args.lots}.")
    if args.max_lots < 1:
        errors.append(f"--max-lots must be >= 1, got {args.max_lots}.")
    if args.threshold_lot <= 0:
        errors.append(f"--threshold-lot must be > 0, got {args.threshold_lot}.")
    if args.threshold_strike <= 0:
        errors.append(f"--threshold-strike must be > 0, got {args.threshold_strike}.")
    if args.threshold_strike <= args.threshold_lot:
        errors.append(
            f"--threshold-strike ({args.threshold_strike}%) must be greater than "
            f"--threshold-lot ({args.threshold_lot}%). "
            "Strike shift should only trigger after lot addition is exhausted."
        )
    if args.scalp_floor_pct < 0 or args.scalp_floor_pct > 100:
        errors.append(f"--scalp-floor-pct must be between 0 and 100, got {args.scalp_floor_pct}.")
    if args.cycle_cooldown < 0:
        errors.append(f"--cycle-cooldown must be >= 0, got {args.cycle_cooldown}.")
    if args.lots > args.max_lots:
        errors.append(
            f"--lots {args.lots} exceeds --max-lots ({args.max_lots}).\n"
            "  The initial lot count cannot exceed the adjustment ceiling."
        )

    # Strangle-only flags have no effect with straddle entry
    if args.entry_type == "straddle":
        if args.delta:
            errors.append("--delta requires --entry-type strangle (straddle always enters at ATM, ignoring delta selection).")
        if args.premium:
            errors.append("--premium requires --entry-type strangle (straddle always enters at ATM, ignoring premium selection).")
        if args.ce_offset != 200:
            errors.append(f"--ce-offset {args.ce_offset} has no effect with --entry-type straddle (straddle always enters at ATM).")
        if args.pe_offset != 200:
            errors.append(f"--pe-offset {args.pe_offset} has no effect with --entry-type straddle (straddle always enters at ATM).")

    if args.loser_ratio_lots != 1 and args.mode != "loser_ratio_roll":
        errors.append(f"--loser-ratio-lots {args.loser_ratio_lots} has no effect in --mode {args.mode} (only used with loser_ratio_roll).")
    if args.target_delta != 0.20 and not args.delta:
        errors.append(f"--target-delta {args.target_delta} has no effect without --delta flag.")
    if args.target_premium != 50.0 and not args.premium:
        errors.append(f"--target-premium {args.target_premium} has no effect without --premium flag.")

    return errors


def main():
    args = build_parser().parse_args()
    state_key = f"nifty_advanced_imbalance_{args.instance_id}" if args.instance_id else "nifty_advanced_imbalance"

    try:
        target_val, target_is_pct = parse_target_spec(args.target_profit)
        stop_val, stop_is_pct = parse_target_spec(args.stop_loss)
    except ValueError as e:
        logger.error(f"[CONFIG ERROR] {e}")
        sys.exit(1)

    errors = validate_args(args)
    if errors:
        for e in errors:
            logger.error(f"[CONFIG ERROR] {e}")
        logger.error("Aborting: fix the configuration errors above and retry.")
        sys.exit(1)

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
        f"Config -> Mode: {'LIVE' if args.live else 'DRY'} | Sizing: {args.lots}L | Start Time: {args.start_time} | Entry Type: {args.entry_type} ({selection_label}) | "
        f"Adjustment Mode: {args.mode} (Loser Ratio Lots: {args.loser_ratio_lots}, Threshold Lot: {args.threshold_lot}%, Threshold Strike: {args.threshold_strike}%) | "
        f"Scalp Lock: {args.scalp_floor_pct}% | Multi-Cycle: {args.multi_cycle} (Cooldown: {args.cycle_cooldown}s) | "
        f"Profit Target: {target_label} | Stop Loss: {stop_label}"
    )

    strat = NiftyAdvancedImbalance(
        mode=args.mode,
        dry_run=not args.live,
        initial_lots=args.lots,
        max_lots=args.max_lots,
        threshold_lot=args.threshold_lot,
        threshold_strike=args.threshold_strike,
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
        recovery_reweight=args.recovery_reweight,
        recovery_sl_pct=args.recovery_sl_pct,
        recovery_max_per_cycle=args.recovery_max_per_cycle,
        trail_start_rs=args.trail_start_rs,
        trail_gap_rs=args.trail_gap_rs,
        scalp_floor_pct=args.scalp_floor_pct,
        multi_cycle=args.multi_cycle,
        cycle_cooldown=args.cycle_cooldown,
        state_key=state_key,
        broker=args.broker,
    )
    try:
        strat.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt detected. Gracefully exiting and squaring off all positions...")
        strat.exit_all_positions("KeyboardInterrupt / Manual Stop")
        sys.exit(0)


if __name__ == "__main__":
    main()
