"""
Nifty Overnight Fly — hedged short straddle held past the daily close.

Source: Nilesh Kadam's "overnight Iron Fly" (Trading with Groww, 2026-08-29;
see the strategy-framework report / "Hedged Overnight Fly" proposal). Sell an
ATM straddle the trading day before expiry, buy a far-OTM call+put as a hedge
(~2x the straddle's own premium out), hold it through the close, and square
off on expiry day.

This is the ONLY options strategy in this repo that holds overnight — every
other one flattens at the 15:17 intraday auto-exit. Two things follow from
that, both load-bearing:

  1. Every order here uses product="MARGIN" (carry-forward), never
     "INTRADAY"/MIS. An MIS order gets force-squared by the broker's own RMS
     near the close regardless of what this script's loop does — using the
     wrong product type would silently defeat the entire strategy.
  2. Position state survives a process restart via debug/<state_key>_position.json
     (same atomic-write pattern as momentum_investing/nifty500_momentum.py's
     portfolio file) — a strategy that forgot it was short a hedged straddle
     overnight would either re-enter a second position on top of the live one,
     or worse, lose track of the hedge that makes it a hedged strategy at all.

Adjustment logic (v1, deliberately bounded):
  - Each short leg carries its own stop-loss (--leg-sl-pct, default 40%).
  - On a short leg's SL hit: buy it back, drag its hedge one strike closer to
    the new ATM, and sell a fresh short leg at the new ATM — capped at
    --max-rolls-per-leg (default 2) rolls per side per cycle. Past the cap,
    that side is left flat (protected by whatever hedge remains) instead of
    rolling indefinitely into a trend.
  - A rupee-MTM trailing stop across the whole position (reusing the same
    trail_start_rs/trail_gap_rs idea as nifty_advanced_imbalance.py's
    reentry_straddle mode) can close everything early if it's given back
    too much from its best level.
  - No richer re-entry/rotation logic than that in v1 — see the report for
    what a v2 could add.
"""

import argparse
import json
import logging
import os
import sys
import time
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib.strategy_state_helper import (
    check_shutdown_trigger,
    exit_if_market_closed,
    instance_log_suffix,
    save_strategy_state,
)
from lib.strategy_risk import resolve_exit_qty_broker
from lib.execution_broker import ExecutionBroker, ExecutionBrokerError

STRIKE_STEP = 50
# Carry-forward product — see the module docstring. NEVER "INTRADAY" in this file.
PRODUCT = "MARGIN"
STRATEGY_KEY_DEFAULT = "nifty_overnight_fly"

project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
debug_dir = os.path.join(project_root, "debug")
os.makedirs(debug_dir, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(os.path.join(debug_dir, f"nifty_overnight_fly{instance_log_suffix()}.log")),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)


class NiftyOvernightFly:
    def __init__(self, dry_run=True, lots=1, hedge_multiplier=2.0, leg_sl_pct=0.40,
                 max_rolls_per_leg=2, trail_start_rs=3000.0, trail_gap_rs=1500.0,
                 entry_time="09:15", entry_window_min=15, eod_exit_time="15:17",
                 entry_dte=1, state_key=STRATEGY_KEY_DEFAULT, broker="dhan"):
        self.state_key = state_key
        self.broker_name = broker
        self.dry_run = dry_run
        self.lots = lots
        self.hedge_multiplier = hedge_multiplier
        self.leg_sl_pct = leg_sl_pct
        self.max_rolls_per_leg = max_rolls_per_leg
        self.trail_start_rs = trail_start_rs
        self.trail_gap_rs = trail_gap_rs
        self.entry_time = entry_time
        self.entry_window_min = entry_window_min
        self.eod_exit_time = eod_exit_time
        self.entry_dte = entry_dte

        self.dhan = get_dhan_client()
        if not self.dhan:
            raise Exception("Failed to connect to Dhan.")
        self.helper = DhanHelper(self.dhan)

        try:
            self.broker = ExecutionBroker.create(broker, self.helper, underlying="NIFTY", log=logger.info)
        except ExecutionBrokerError as e:
            logger.error(f"Could not start {broker} execution: {e}")
            sys.exit(1)

        logger.info("Starting WebSocket for NIFTY Index...")
        self.helper.start_websocket([("IDX_I", "13", 15)])
        time.sleep(2)

        self.nifty_lot_size = self.helper.get_lot_size("NIFTY")

        self._reset_position_state()
        self.load_position()

    # ── position state ──────────────────────────────────────────────────

    def _reset_position_state(self):
        self.position_open = False
        self.expiry = None
        self.entry_date = None
        self.realized_pnl = 0.0
        self.trail_active = False
        self.best_pnl = 0.0
        # Each leg: {'id', 'strike', 'avg_price', 'qty'} — short legs additionally
        # carry 'sl' and 'roll_count'.
        self.ce_short = None
        self.pe_short = None
        self.ce_hedge = None
        self.pe_hedge = None

    @property
    def position_path(self) -> str:
        return os.path.join(debug_dir, f"{self.state_key}_position.json")

    def save_position(self):
        """Atomic write — same pattern as nifty500_momentum.py's portfolio file.
        A torn position file is the one thing that could lose track of a live
        overnight hedge."""
        data = {
            'version': 1,
            'position_open': self.position_open,
            'expiry': self.expiry,
            'entry_date': self.entry_date,
            'realized_pnl': self.realized_pnl,
            'trail_active': self.trail_active,
            'best_pnl': self.best_pnl,
            'ce_short': self.ce_short,
            'pe_short': self.pe_short,
            'ce_hedge': self.ce_hedge,
            'pe_hedge': self.pe_hedge,
            'lots': self.lots,
            'nifty_lot_size': self.nifty_lot_size,
            'updated_at': datetime.now().isoformat(timespec='seconds'),
        }
        os.makedirs(debug_dir, exist_ok=True)
        tmp = self.position_path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, self.position_path)

    def load_position(self):
        """Restore an open overnight position after a process restart. Refuses to
        trade blind on a corrupt file rather than silently starting flat — that
        would either re-enter a second straddle on top of the live one, or lose
        track of the hedge that makes this strategy defined-risk at all."""
        path = self.position_path
        if not os.path.exists(path):
            logger.info(f"No existing position at {path} — starting flat.")
            return
        try:
            with open(path) as f:
                data = json.load(f)
        except Exception as e:
            logger.error(
                f"FATAL: position file {path} is unreadable ({e}). "
                f"Fix or move it before restarting; refusing to trade blind."
            )
            raise

        self.position_open = bool(data.get('position_open'))
        self.expiry = data.get('expiry')
        self.entry_date = data.get('entry_date')
        self.realized_pnl = float(data.get('realized_pnl', 0.0))
        self.trail_active = bool(data.get('trail_active'))
        self.best_pnl = float(data.get('best_pnl', 0.0))
        self.ce_short = data.get('ce_short')
        self.pe_short = data.get('pe_short')
        self.ce_hedge = data.get('ce_hedge')
        self.pe_hedge = data.get('pe_hedge')

        if self.position_open:
            logger.info(
                f"Restored open position: expiry={self.expiry} entered={self.entry_date} | "
                f"CE short {self.ce_short['strike'] if self.ce_short else 'CLOSED'} | "
                f"PE short {self.pe_short['strike'] if self.pe_short else 'CLOSED'} | "
                f"CE hedge {self.ce_hedge['strike'] if self.ce_hedge else 'MISSING'} | "
                f"PE hedge {self.pe_hedge['strike'] if self.pe_hedge else 'MISSING'} | "
                f"realized so far: {self.realized_pnl:+.2f}"
            )
            # WS subscriptions are per-process; a restart loses them even though the
            # broker position is still live, so resubscribe every leg we're holding.
            for leg in (self.ce_short, self.pe_short, self.ce_hedge, self.pe_hedge):
                if leg:
                    try:
                        self.helper.subscribe_instruments([("NSE_FNO", str(leg['id']), 15)])
                    except Exception as e:
                        logger.error(f"Resubscribe failed for {leg['id']}: {e}")

    # ── quotes / execution ───────────────────────────────────────────────

    def _get_quote(self, strike, opt_type):
        """(security_id, last_price) for one NIFTY option, or (None, 0.0)."""
        q = self.helper.option("NIFTY", strike, opt_type)
        if not q or not isinstance(q, dict) or 'CONTRACT_INFO' not in q:
            return None, 0.0
        price = float(q.get('last_price', 0.0) or q.get('LTP', 0.0))
        if price <= 0:
            return None, 0.0
        return int(q['CONTRACT_INFO']['SECURITY_ID']), price

    def get_execution_price(self, order_id, fallback_price):
        """Wait for fill and get the average execution price, or return fallback."""
        if not order_id:
            return fallback_price
        if self.helper.wait_for_fill(order_id, timeout=5):
            order_details = self.helper.get_order_by_id(order_id)
            if order_details:
                fill_price = float(
                    order_details.get('averageTradedPrice', 0.0)
                    or order_details.get('avgFilledPrice', 0.0)
                    or order_details.get('price', 0.0)
                )
                if fill_price > 0:
                    return fill_price
        return fallback_price

    # ── P&L ──────────────────────────────────────────────────────────────

    def _calculate_pnl(self):
        total = self.realized_pnl
        for leg in (self.ce_short, self.pe_short):
            if not leg:
                continue
            ltp = self.helper.get_ltp(str(leg['id']), exchange="NSE_FNO", instrument="OPTIDX")
            if ltp > 0:
                total += (leg['avg_price'] - ltp) * leg['qty']  # short: entry - current
        for leg in (self.ce_hedge, self.pe_hedge):
            if not leg:
                continue
            ltp = self.helper.get_ltp(str(leg['id']), exchange="NSE_FNO", instrument="OPTIDX")
            if ltp > 0:
                total += (ltp - leg['avg_price']) * leg['qty']  # long: current - entry
        return total

    # ── entry ────────────────────────────────────────────────────────────

    def enter_position(self, spot):
        atm = int(round(spot / STRIKE_STEP) * STRIKE_STEP)
        self.expiry = self.helper.get_nearest_expiry("NIFTY")
        if not self.expiry:
            logger.error("Could not resolve nearest expiry. Skipping entry this tick.")
            return

        ce_id, ce_price = self._get_quote(atm, "CE")
        pe_id, pe_price = self._get_quote(atm, "PE")
        if not ce_id or not pe_id:
            logger.error(f"Could not get valid ATM quotes at {atm}. Skipping entry this tick.")
            return

        qty = self.lots * self.nifty_lot_size
        ce_entry, pe_entry = ce_price, pe_price
        if not self.dry_run:
            ce_oid = self.broker.sell(atm, self.expiry, "CE", qty, product=PRODUCT)
            pe_oid = self.broker.sell(atm, self.expiry, "PE", qty, product=PRODUCT)
            if not ce_oid or not pe_oid:
                logger.error("Straddle entry failed. Rolling back any successful leg.")
                if ce_oid and not pe_oid:
                    self.broker.buy(atm, self.expiry, "CE", qty, product=PRODUCT)
                elif pe_oid and not ce_oid:
                    self.broker.buy(atm, self.expiry, "PE", qty, product=PRODUCT)
                return
            ce_entry = self.get_execution_price(ce_oid, ce_price)
            pe_entry = self.get_execution_price(pe_oid, pe_price)
        else:
            logger.info(f"[DRY RUN] Would sell {atm} CE/PE @ ~{ce_price:.2f}/{pe_price:.2f}")

        self.ce_short = {'id': ce_id, 'strike': atm, 'avg_price': ce_entry, 'qty': qty}
        self.pe_short = {'id': pe_id, 'strike': atm, 'avg_price': pe_entry, 'qty': qty}

        # Hedge distance derives from what we actually collected, not the quote
        # we saw before placing the order.
        combined_premium = ce_entry + pe_entry
        hedge_pts = max(STRIKE_STEP, round((self.hedge_multiplier * combined_premium) / STRIKE_STEP) * STRIKE_STEP)
        ce_hedge_strike = atm + hedge_pts
        pe_hedge_strike = atm - hedge_pts

        ce_hedge_id, ce_hedge_price = self._get_quote(ce_hedge_strike, "CE")
        pe_hedge_id, pe_hedge_price = self._get_quote(pe_hedge_strike, "PE")
        if not ce_hedge_id or not pe_hedge_id:
            logger.critical(
                "Could not get hedge quotes — EMERGENCY UNWIND of the straddle just "
                "sold. This strategy must never run unhedged."
            )
            self.exit_all_positions("Hedge quotes unavailable at entry — emergency unwind")
            return

        ce_hedge_entry, pe_hedge_entry = ce_hedge_price, pe_hedge_price
        if not self.dry_run:
            ce_hedge_oid = self.broker.buy(ce_hedge_strike, self.expiry, "CE", qty, product=PRODUCT)
            pe_hedge_oid = self.broker.buy(pe_hedge_strike, self.expiry, "PE", qty, product=PRODUCT)
            if not ce_hedge_oid or not pe_hedge_oid:
                logger.critical(
                    "Hedge leg order FAILED — EMERGENCY UNWIND of everything placed "
                    "so far. This strategy must never run unhedged."
                )
                if ce_hedge_oid:
                    self.ce_hedge = {'id': ce_hedge_id, 'strike': ce_hedge_strike, 'avg_price': ce_hedge_price, 'qty': qty}
                if pe_hedge_oid:
                    self.pe_hedge = {'id': pe_hedge_id, 'strike': pe_hedge_strike, 'avg_price': pe_hedge_price, 'qty': qty}
                self.exit_all_positions("Hedge order failed at entry — emergency unwind")
                return
            ce_hedge_entry = self.get_execution_price(ce_hedge_oid, ce_hedge_price)
            pe_hedge_entry = self.get_execution_price(pe_hedge_oid, pe_hedge_price)
        else:
            logger.info(
                f"[DRY RUN] Would buy hedge {ce_hedge_strike} CE / {pe_hedge_strike} PE "
                f"@ ~{ce_hedge_price:.2f}/{pe_hedge_price:.2f} ({hedge_pts} pts out)"
            )

        self.ce_hedge = {'id': ce_hedge_id, 'strike': ce_hedge_strike, 'avg_price': ce_hedge_entry, 'qty': qty}
        self.pe_hedge = {'id': pe_hedge_id, 'strike': pe_hedge_strike, 'avg_price': pe_hedge_entry, 'qty': qty}

        self.ce_short['sl'] = round(ce_entry * (1 + self.leg_sl_pct), 2)
        self.ce_short['roll_count'] = 0
        self.pe_short['sl'] = round(pe_entry * (1 + self.leg_sl_pct), 2)
        self.pe_short['roll_count'] = 0

        try:
            self.helper.subscribe_instruments([
                ("NSE_FNO", str(ce_id), 15), ("NSE_FNO", str(pe_id), 15),
                ("NSE_FNO", str(ce_hedge_id), 15), ("NSE_FNO", str(pe_hedge_id), 15),
            ])
        except Exception as e:
            logger.error(f"WebSocket subscribe failed: {e}")

        self.position_open = True
        self.entry_date = date.today().isoformat()
        self.save_position()
        logger.info(
            f"Overnight Fly ENTERED | Expiry {self.expiry} | "
            f"Short {atm} CE {ce_entry:.2f} / PE {pe_entry:.2f} (combined {combined_premium:.2f}) | "
            f"Hedge {ce_hedge_strike} CE {ce_hedge_entry:.2f} / {pe_hedge_strike} PE {pe_hedge_entry:.2f} "
            f"({hedge_pts} pts out) | Qty {qty}"
        )

    # ── roll / adjustment ────────────────────────────────────────────────

    def roll_leg(self, opt_type, ltp):
        """A short leg's SL hit: buy it back, drag its hedge one step toward the
        new ATM, and sell a fresh short leg there — capped at
        --max-rolls-per-leg. Past the cap, the leg is left flat for the rest
        of the cycle; its hedge stays on, still bounding risk on that side."""
        leg = self.ce_short if opt_type == "CE" else self.pe_short
        hedge = self.ce_hedge if opt_type == "CE" else self.pe_hedge
        qty = leg['qty']

        actual_exit = ltp
        if not self.dry_run:
            qty_to_buy, net_qty = resolve_exit_qty_broker(
                self.broker, leg['strike'], self.expiry, opt_type, qty, "BUY", logger)
            if qty_to_buy <= 0:
                logger.warning(f"{opt_type} short net qty {net_qty} — nothing to close.")
            else:
                oid = self.broker.buy(leg['strike'], self.expiry, opt_type, qty_to_buy, product=PRODUCT)
                if oid:
                    actual_exit = self.get_execution_price(oid, ltp)
                else:
                    logger.critical(f"{opt_type} short SL exit FAILED (buy returned None). Verify {opt_type} position manually!")
        else:
            logger.info(f"[DRY RUN] {opt_type} short SL exit at {actual_exit:.2f}")

        self.realized_pnl += (leg['avg_price'] - actual_exit) * qty
        next_roll = leg['roll_count'] + 1
        logger.warning(
            f"{opt_type} short leg SL hit at {actual_exit:.2f} (sold at {leg['avg_price']:.2f}). "
            f"Roll {next_roll}/{self.max_rolls_per_leg}."
        )

        try:
            self.helper.unsubscribe_instruments([("NSE_FNO", str(leg['id']), 15)])
        except Exception:
            pass

        if leg['roll_count'] >= self.max_rolls_per_leg:
            logger.warning(f"{opt_type} roll cap reached — leaving {opt_type} short flat for the rest of this cycle (hedge stays on).")
            if opt_type == "CE":
                self.ce_short = None
            else:
                self.pe_short = None
            self.save_position()
            return

        # Resolve the new ATM strike and drag the hedge one step toward it.
        spot = self.helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")
        new_strike = int(round(spot / STRIKE_STEP) * STRIKE_STEP) if spot > 0 else leg['strike']

        new_hedge_strike = hedge['strike'] - STRIKE_STEP if opt_type == "CE" else hedge['strike'] + STRIKE_STEP
        # Never drag the hedge past (or onto) the new short strike — that would
        # invert the wing into a debit spread with no protective distance left.
        if (opt_type == "CE" and new_hedge_strike <= new_strike) or (opt_type == "PE" and new_hedge_strike >= new_strike):
            logger.warning(f"{opt_type} hedge drag would invert past the new strike — leaving hedge at {hedge['strike']}.")
            new_hedge_strike = hedge['strike']

        if new_hedge_strike != hedge['strike']:
            self._drag_hedge(opt_type, hedge, new_hedge_strike, qty)
            hedge = self.ce_hedge if opt_type == "CE" else self.pe_hedge
            if hedge is None:
                # _drag_hedge already logged CRITICAL — that side is unhedged.
                # Still try to re-sell the short below rather than leaving it
                # doubly flat, but the operator must fix the hedge manually.
                pass

        # Sell a fresh short leg at the new ATM strike.
        new_id, new_price = self._get_quote(new_strike, opt_type)
        if not new_id:
            logger.error(f"Could not resolve new {opt_type} strike {new_strike} quote — {opt_type} stays flat this tick.")
            if opt_type == "CE":
                self.ce_short = None
            else:
                self.pe_short = None
            self.save_position()
            return

        entry_price = new_price
        if not self.dry_run:
            oid = self.broker.sell(new_strike, self.expiry, opt_type, qty, product=PRODUCT)
            if oid:
                entry_price = self.get_execution_price(oid, new_price)
                try:
                    self.helper.subscribe_instruments([("NSE_FNO", str(new_id), 15)])
                except Exception as e:
                    logger.error(f"WebSocket subscribe failed for {new_id}: {e}")
            else:
                logger.critical(f"{opt_type} re-sell after roll FAILED — {opt_type} side stays flat. Verify manually!")
                if opt_type == "CE":
                    self.ce_short = None
                else:
                    self.pe_short = None
                self.save_position()
                return
        else:
            logger.info(f"[DRY RUN] Re-sell {opt_type} at {new_strike} @ ~{new_price:.2f}")

        new_leg = {
            'id': new_id, 'strike': new_strike, 'avg_price': entry_price, 'qty': qty,
            'sl': round(entry_price * (1 + self.leg_sl_pct), 2), 'roll_count': next_roll,
        }
        if opt_type == "CE":
            self.ce_short = new_leg
        else:
            self.pe_short = new_leg
        self.save_position()
        logger.info(
            f"{opt_type} rolled to {new_strike} @ {entry_price:.2f} | "
            f"New SL: {new_leg['sl']:.2f} | Roll {next_roll}/{self.max_rolls_per_leg}"
        )

    def _drag_hedge(self, opt_type, hedge, new_hedge_strike, qty):
        """Close the old hedge leg and open a new one one strike closer to ATM.
        Sets self.ce_hedge/pe_hedge to None (and logs CRITICAL) if the new
        hedge can't be resolved or bought — the short leg re-sold right after
        this is then temporarily UNHEDGED until an operator intervenes."""
        hedge_exit = self._get_quote(hedge['strike'], opt_type)[1] or 0.0
        if not self.dry_run:
            qty_to_sell, net_qty = resolve_exit_qty_broker(
                self.broker, hedge['strike'], self.expiry, opt_type, qty, "SELL", logger)
            if qty_to_sell > 0:
                oid = self.broker.sell(hedge['strike'], self.expiry, opt_type, qty_to_sell, product=PRODUCT)
                if oid:
                    hedge_exit = self.get_execution_price(oid, hedge_exit)
                else:
                    logger.error(f"{opt_type} hedge close-out at {hedge['strike']} FAILED — old hedge may still be live, verify manually.")
        else:
            logger.info(f"[DRY RUN] Drag {opt_type} hedge {hedge['strike']} -> {new_hedge_strike}")
        self.realized_pnl += (hedge_exit - hedge['avg_price']) * qty
        try:
            self.helper.unsubscribe_instruments([("NSE_FNO", str(hedge['id']), 15)])
        except Exception:
            pass

        new_hedge_id, new_hedge_price = self._get_quote(new_hedge_strike, opt_type)
        if not new_hedge_id:
            logger.critical(f"Could not resolve new {opt_type} hedge quote at {new_hedge_strike} — {opt_type} side is UNHEDGED. Verify manually!")
            if opt_type == "CE":
                self.ce_hedge = None
            else:
                self.pe_hedge = None
            return

        hedge_entry = new_hedge_price
        if not self.dry_run:
            oid = self.broker.buy(new_hedge_strike, self.expiry, opt_type, qty, product=PRODUCT)
            if oid:
                hedge_entry = self.get_execution_price(oid, new_hedge_price)
                try:
                    self.helper.subscribe_instruments([("NSE_FNO", str(new_hedge_id), 15)])
                except Exception as e:
                    logger.error(f"WebSocket subscribe failed for {new_hedge_id}: {e}")
            else:
                logger.critical(f"{opt_type} hedge re-buy FAILED after drag — {opt_type} side is UNHEDGED. Verify manually!")
                if opt_type == "CE":
                    self.ce_hedge = None
                else:
                    self.pe_hedge = None
                return

        new_hedge = {'id': new_hedge_id, 'strike': new_hedge_strike, 'avg_price': hedge_entry, 'qty': qty}
        if opt_type == "CE":
            self.ce_hedge = new_hedge
        else:
            self.pe_hedge = new_hedge

    # ── exit ─────────────────────────────────────────────────────────────

    def exit_all_positions(self, reason):
        """Closes whichever of the four legs are currently set — safe to call
        as a full exit, or as an emergency unwind mid-entry when only some
        legs got placed."""
        logger.warning(f"!!! EXITING OVERNIGHT FLY: {reason} !!!")
        for opt_type, leg in (("CE", self.ce_short), ("PE", self.pe_short)):
            if not leg:
                continue
            try:
                qty_to_buy, net_qty = resolve_exit_qty_broker(
                    self.broker, leg['strike'], self.expiry, opt_type, leg['qty'], "BUY", logger)
                if qty_to_buy > 0:
                    if not self.dry_run:
                        oid = self.broker.buy(leg['strike'], self.expiry, opt_type, qty_to_buy, product=PRODUCT)
                        logger.info(f"{opt_type} short {leg['strike']} exit placed for {qty_to_buy} qty (own {leg['qty']}, broker net {net_qty}): {oid}")
                        if oid:
                            self.helper.wait_for_fill(oid, timeout=5)
                    else:
                        logger.info(f"[DRY RUN] {opt_type} short {leg['strike']} exit simulated")
            except Exception as e:
                logger.error(f"Exit {opt_type} short leg {leg['strike']} error: {e}")

        for opt_type, leg in (("CE", self.ce_hedge), ("PE", self.pe_hedge)):
            if not leg:
                continue
            try:
                qty_to_sell, net_qty = resolve_exit_qty_broker(
                    self.broker, leg['strike'], self.expiry, opt_type, leg['qty'], "SELL", logger)
                if qty_to_sell > 0:
                    if not self.dry_run:
                        oid = self.broker.sell(leg['strike'], self.expiry, opt_type, qty_to_sell, product=PRODUCT)
                        logger.info(f"{opt_type} hedge {leg['strike']} exit placed for {qty_to_sell} qty (own {leg['qty']}, broker net {net_qty}): {oid}")
                        if oid:
                            self.helper.wait_for_fill(oid, timeout=5)
                    else:
                        logger.info(f"[DRY RUN] {opt_type} hedge {leg['strike']} exit simulated")
            except Exception as e:
                logger.error(f"Exit {opt_type} hedge leg {leg['strike']} error: {e}")

        for leg in (self.ce_short, self.pe_short, self.ce_hedge, self.pe_hedge):
            if leg:
                try:
                    self.helper.unsubscribe_instruments([("NSE_FNO", str(leg['id']), 15)])
                except Exception:
                    pass

        self._reset_position_state()
        self.save_position()

    # ── dashboard state ──────────────────────────────────────────────────

    def save_state(self, status="RUNNING", spot=0.0, total_pnl=None):
        total_pnl = self._calculate_pnl() if total_pnl is None else total_pnl
        state_dict = {
            "strategy": STRATEGY_KEY_DEFAULT,
            "status": status,
            "broker": self.broker_name,
            "dry_run": self.dry_run,
            "lots": self.lots,
            "expiry": self.expiry,
            "entry_date": self.entry_date,
            "spot": spot,
            "position_open": self.position_open,
            "ce_short": self.ce_short,
            "pe_short": self.pe_short,
            "ce_hedge": self.ce_hedge,
            "pe_hedge": self.pe_hedge,
            "realized_pnl": round(self.realized_pnl, 2),
            "total_pnl": round(total_pnl, 2),
            "leg_sl_pct": self.leg_sl_pct,
            "max_rolls_per_leg": self.max_rolls_per_leg,
            "hedge_multiplier": self.hedge_multiplier,
            "trail_active": self.trail_active,
            "trail_start_rs": self.trail_start_rs,
            "trail_gap_rs": self.trail_gap_rs,
            "best_pnl": round(self.best_pnl, 2),
        }
        save_strategy_state(self.state_key, state_dict)

    # ── main loop ────────────────────────────────────────────────────────

    def run(self):
        logger.info(
            f"Starting Nifty Overnight Fly | Dry Run: {self.dry_run} | Lots: {self.lots} | "
            f"Entry: {self.entry_time} (+{self.entry_window_min}m window, DTE={self.entry_dte}) | "
            f"EOD exit: {self.eod_exit_time} | Leg SL: {self.leg_sl_pct*100:.0f}% | "
            f"Max rolls/leg: {self.max_rolls_per_leg} | Hedge: {self.hedge_multiplier}x straddle premium"
        )
        exit_if_market_closed(self.helper, self.dry_run)

        while True:
            if check_shutdown_trigger(self.state_key):
                logger.info("UI Shutdown Request.")
                if self.position_open:
                    self.exit_all_positions("UI Shutdown Request")
                self.save_state(status="STOPPED")
                sys.exit(0)

            if not self.dry_run and not self.helper.is_market_open():
                self.save_state(status="HOLDING OVERNIGHT" if self.position_open else "WAITING")
                self.helper.wait_for_market_open(
                    self.dry_run, shutdown_check=lambda: check_shutdown_trigger(self.state_key)
                )
                continue

            now = datetime.now()
            current_time_str = now.strftime("%H:%M")

            dte = self.helper.days_to_expiry("NIFTY")
            spot = self.helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")

            if not self.position_open:
                entry_window_end = (
                    datetime.strptime(self.entry_time, "%H:%M") + timedelta(minutes=self.entry_window_min)
                ).strftime("%H:%M")
                if dte == self.entry_dte and self.entry_time <= current_time_str <= entry_window_end and spot > 0:
                    logger.info(f"Entry window open (DTE={dte}, spot={spot:.2f}). Entering overnight fly.")
                    self.enter_position(spot)
                else:
                    self.save_state(status="WAITING", spot=spot, total_pnl=0.0)
                time.sleep(15)
                continue

            # --- Position is open: monitor ---
            total_pnl = self._calculate_pnl()
            self.save_state(status="RUNNING", spot=spot, total_pnl=total_pnl)

            for opt_type in ("CE", "PE"):
                leg = self.ce_short if opt_type == "CE" else self.pe_short
                if not leg:
                    continue
                ltp = self.helper.get_ltp(str(leg['id']), exchange="NSE_FNO", instrument="OPTIDX")
                if ltp > 0 and ltp >= leg['sl']:
                    self.roll_leg(opt_type, ltp)

            # Trailing stop — rupee MTM basis, continuous across rolls (total_pnl
            # already folds in realized_pnl, so a roll's booked loss/gain is
            # absorbed automatically).
            if not self.trail_active and total_pnl >= self.trail_start_rs:
                self.trail_active = True
                self.best_pnl = total_pnl
                logger.info(f"Trail SL activated at {total_pnl:+.0f} (arm {self.trail_start_rs:.0f}, gap {self.trail_gap_rs:.0f})")
            if self.trail_active:
                if total_pnl > self.best_pnl:
                    self.best_pnl = total_pnl
                trail_exit = self.best_pnl - self.trail_gap_rs
                if total_pnl < trail_exit:
                    self.exit_all_positions(
                        f"Trailing SL hit! PnL {total_pnl:+.0f} < exit {trail_exit:+.0f} (best {self.best_pnl:+.0f})"
                    )
                    self.save_state(status="WAITING", spot=spot, total_pnl=0.0)

            # Expiry-day close — the ONE day this position squares off, unlike
            # every other intraday strategy's daily 15:17 rule.
            if self.position_open and dte == 0 and current_time_str >= self.eod_exit_time:
                self.exit_all_positions(f"Expiry day close at {current_time_str}")
                self.save_state(status="WAITING", spot=spot, total_pnl=0.0)

            time.sleep(2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Nifty Overnight Fly — hedged short straddle held past the close",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
This strategy enters the trading day before expiry and exits ON expiry day —
it deliberately does NOT square off at the usual 15:17 intraday cutoff. Every
order uses the MARGIN (carry-forward) product, never INTRADAY/MIS.

Examples:
  # Dry run, default sizing (1 lot, 40% leg SL, 2 rolls/leg, 2x hedge)
  python strategies/overnight_fly/nifty_overnight_fly.py

  # Live, 2 lots, wider 3x hedge, on Zerodha
  python strategies/overnight_fly/nifty_overnight_fly.py --live --lots 2 --hedge-multiplier 3.0 --broker zerodha
""",
    )
    parser.add_argument("--live", action="store_true", default=False,
                        help="Place real orders. Default: dry run (simulated).")
    parser.add_argument("--lots", type=int, default=1, metavar="N",
                        help="Lots per leg (default: 1).")
    parser.add_argument("--hedge-multiplier", type=float, default=2.0, metavar="X",
                        help="Hedge distance as a multiple of the straddle's own combined "
                             "premium, rounded to the nearest strike step (default: 2.0).")
    parser.add_argument("--leg-sl-pct", type=float, default=0.40, metavar="PCT",
                        help="Per-leg stop loss as a fraction of entry premium (default: 0.40 = 40%%).")
    parser.add_argument("--max-rolls-per-leg", type=int, default=2, metavar="N",
                        help="Max times a short leg rolls to a fresh ATM strike per cycle "
                             "before it's left flat instead (default: 2).")
    parser.add_argument("--trail-start-rs", type=float, default=3000.0, metavar="INR",
                        help="Activate trailing SL once MTM profit reaches this many rupees (default: 3000).")
    parser.add_argument("--trail-gap-rs", type=float, default=1500.0, metavar="INR",
                        help="Exit if MTM gives back this many rupees from its best level (default: 1500).")
    parser.add_argument("--entry-time", type=str, default="09:15", metavar="HH:MM",
                        help="Start of the entry window on the day before expiry (default: 09:15).")
    parser.add_argument("--entry-window-min", type=int, default=15, metavar="MIN",
                        help="Length of the entry window in minutes (default: 15).")
    parser.add_argument("--entry-dte", type=int, default=1, metavar="N",
                        help="Enter when the nearest expiry is this many days out (default: 1 = "
                             "the trading day before expiry). Raise this if a holiday means the "
                             "trading day before expiry isn't exactly 1 calendar day out.")
    parser.add_argument("--eod-exit-time", type=str, default="15:17", metavar="HH:MM",
                        help="Square-off time on expiry day (default: 15:17).")
    parser.add_argument("--instance-id", type=str, default="", metavar="ID",
                        help="Suffix for debug/state files to run a second concurrent copy of this strategy.")
    parser.add_argument(
        "--broker", choices=["dhan", "zerodha", "kotak"], default="dhan",
        help="Execution broker for order placement. Market data always comes from Dhan. "
             "Zerodha/Kotak stop-loss/roll exits are software-managed only (no resting "
             "broker-side stop order)."
    )

    args = parser.parse_args()
    STATE_KEY = f"{STRATEGY_KEY_DEFAULT}_{args.instance_id}" if args.instance_id else STRATEGY_KEY_DEFAULT

    _errors = []
    if args.lots < 1:
        _errors.append(f"--lots must be >= 1, got {args.lots}.")
    if args.hedge_multiplier <= 0:
        _errors.append(f"--hedge-multiplier must be > 0, got {args.hedge_multiplier}.")
    if args.leg_sl_pct <= 0 or args.leg_sl_pct >= 1:
        _errors.append(f"--leg-sl-pct must be between 0 and 1 (exclusive), got {args.leg_sl_pct}.")
    if args.max_rolls_per_leg < 0:
        _errors.append(f"--max-rolls-per-leg must be >= 0, got {args.max_rolls_per_leg}.")
    if args.trail_gap_rs <= 0:
        _errors.append(f"--trail-gap-rs must be > 0, got {args.trail_gap_rs}.")
    if args.trail_start_rs < 0:
        _errors.append(f"--trail-start-rs must be >= 0, got {args.trail_start_rs}.")
    if args.entry_window_min <= 0:
        _errors.append(f"--entry-window-min must be > 0, got {args.entry_window_min}.")
    if args.entry_dte < 0:
        _errors.append(f"--entry-dte must be >= 0, got {args.entry_dte}.")
    try:
        datetime.strptime(args.entry_time, "%H:%M")
    except ValueError:
        _errors.append(f"--entry-time must be HH:MM, got {args.entry_time!r}.")
    try:
        datetime.strptime(args.eod_exit_time, "%H:%M")
    except ValueError:
        _errors.append(f"--eod-exit-time must be HH:MM, got {args.eod_exit_time!r}.")

    if _errors:
        for e in _errors:
            logger.error(f"[CONFIG ERROR] {e}")
        logger.error("Aborting: fix the configuration errors above and retry.")
        sys.exit(1)

    logger.info(
        f"Config -> Mode: {'LIVE' if args.live else 'DRY'} | Lots: {args.lots} | "
        f"Hedge: {args.hedge_multiplier}x | Leg SL: {args.leg_sl_pct*100:.0f}% | "
        f"Max rolls/leg: {args.max_rolls_per_leg} | Trail: +{args.trail_start_rs:.0f}/-{args.trail_gap_rs:.0f} | "
        f"Entry: {args.entry_time} (DTE={args.entry_dte}) | EOD exit: {args.eod_exit_time}"
    )

    strat = NiftyOvernightFly(
        dry_run=not args.live,
        lots=args.lots,
        hedge_multiplier=args.hedge_multiplier,
        leg_sl_pct=args.leg_sl_pct,
        max_rolls_per_leg=args.max_rolls_per_leg,
        trail_start_rs=args.trail_start_rs,
        trail_gap_rs=args.trail_gap_rs,
        entry_time=args.entry_time,
        entry_window_min=args.entry_window_min,
        eod_exit_time=args.eod_exit_time,
        entry_dte=args.entry_dte,
        state_key=STATE_KEY,
        broker=args.broker,
    )
    try:
        strat.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt detected. Gracefully exiting and squaring off all positions...")
        if strat.position_open:
            strat.exit_all_positions("KeyboardInterrupt / Manual Stop")
        strat.save_state(status="STOPPED")
