"""
Nifty Volcano Calendar — Put Butterfly + Call Calendar, monthly hold.

UNVALIDATED. Sourced from a Lemonn/Kundan Prajapati video (2026-08-18), a presenter deck slide
and an independently-run StockMock (stockmock.in) simulator screenshot (2026-09-22). No backtest
exists (the options DB is weekly-expiry-only; this is a monthly hold) and no losing-month example
has ever been shown. See strategies/volcano_calendar/strategy.md and the vault page
wiki/strategies/volcano-calendar.md (stage `analysed`) for the full research trail and open
questions this file inherits — in particular, the far calendar leg's expiry (1 month vs 2 months
out) is genuinely ambiguous in the source and is exposed here as an explicit --far-expiry choice.

--live requires --i-understand-this-is-unvalidated, same convention as intraday_equity.

Implements the standard kit from the dhan-new-strategy skill: dry-run default, state bridge,
shutdown trigger, own-quantity exits, confirmed fills, all-or-nothing entry, restart recovery.
Product is MARGIN (carry-forward) — this holds ~1 month, never INTRADAY.
"""

import argparse
import calendar as calendar_mod
import json
import logging
import os
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta


def _find_project_root(start: str) -> str:
    d = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(d, "login.py")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            raise RuntimeError("Could not locate project root (login.py)")
        d = parent


project_root = _find_project_root(os.path.dirname(__file__))
sys.path.insert(0, project_root)

from login import get_dhan_client  # noqa: E402
from lib.dhan_helper import DhanHelper  # noqa: E402
from lib.strategy_state_helper import (  # noqa: E402
    check_shutdown_trigger, exit_if_market_closed, flush_state,
    instance_log_suffix, parse_target_spec, save_strategy_state,
)
from lib.strategy_risk import resolve_exit_qty_broker  # noqa: E402
from lib.execution_broker import ExecutionBroker, ExecutionBrokerError  # noqa: E402
from lib.telegram_alert import notify  # noqa: E402

STRATEGY_KEY_DEFAULT = "nifty_volcano_calendar"   # must match strategyRegistry.ts
LOG_FOLDER = "volcano_calendar"                   # must match STRATEGY_LOG_DIRS
UNDERLYING = "NIFTY"
PRODUCT = "MARGIN"                                # carry-forward: this holds ~1 month, never INTRADAY
INDEX_ID = "13"                                   # index id for spot; option chain underlying is 26000

debug_dir = os.path.join(project_root, "debug")
log_dir = os.path.join(debug_dir, "logs", LOG_FOLDER)
os.makedirs(log_dir, exist_ok=True)


class FlushingFileHandler(logging.FileHandler):
    def emit(self, record):
        super().emit(record)
        self.flush()


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        FlushingFileHandler(os.path.join(log_dir, f"{datetime.now().strftime('%Y%m%d')}{instance_log_suffix()}.log")),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)


# ── Leg spec: name -> (side, opt_type, expiry_key, lot_multiplier) ──────────────────────────────
# Order matters for entry: all BUY (protective) legs first, then SELL legs, so exposure is never
# a naked short mid-entry.
LEG_SPECS = {
    "pe_wing_far": {"side": "BUY",  "opt_type": "PE", "expiry_key": "near", "lot_mult": 1},
    "pe_atm":      {"side": "BUY",  "opt_type": "PE", "expiry_key": "near", "lot_mult": 1},
    "ce_far":      {"side": "BUY",  "opt_type": "CE", "expiry_key": "far",  "lot_mult": 1},
    "pe_body":     {"side": "SELL", "opt_type": "PE", "expiry_key": "near", "lot_mult": 2},
    "ce_near":     {"side": "SELL", "opt_type": "CE", "expiry_key": "near", "lot_mult": 1},
}
ENTRY_ORDER = ["pe_wing_far", "pe_atm", "ce_far", "pe_body", "ce_near"]


# ── Pure decision logic: no broker, no clock, no I/O. Unit-test these. ──────────────────────────

def atm_strike(spot: float, step: int) -> int:
    """Floor to the strike at-or-below spot, not nearest. The StockMock reference example
    (spot 24049) bought its ATM put at 24000, not the nearer 24050 — this matches that empirically
    rather than the more common 'nearest strike' convention."""
    return int(spot // step) * step


def choose_strikes(spot: float, wing_points: int, ce_offset_points: int, step: int) -> dict:
    """Strikes for all 5 legs. pe_body is sold wing_points below ATM (the butterfly's body),
    pe_wing_far is bought 2x that distance below ATM (the outer wing); ce_near/ce_far share one
    strike above ATM (the calendar), differing only in expiry. Defaults (400/300) reproduce the
    StockMock reference example (spot 24049 -> 24000/23600/23200 PE, 24300 CE) exactly."""
    atm = atm_strike(spot, step)
    return {
        "pe_wing_far": atm - 2 * wing_points,
        "pe_atm": atm,
        "ce_far": atm + ce_offset_points,
        "pe_body": atm - wing_points,
        "ce_near": atm + ce_offset_points,
    }


def leg_qty(name: str, lots: int, lot_size: int) -> int:
    return LEG_SPECS[name]["lot_mult"] * lots * lot_size


def leg_pnl(side: str, entry_price: float, ltp: float, qty: int) -> float:
    return (entry_price - ltp) * qty if side == "SELL" else (ltp - entry_price) * qty


def monthly_expiries(expiries: list) -> list:
    """Group all listed expiry dates by calendar month, keep the last (actual monthly expiry)
    date in each month. Does not assume any particular weekday."""
    by_month = defaultdict(list)
    for e in expiries:
        try:
            d = datetime.strptime(e, "%Y-%m-%d").date()
        except ValueError:
            continue
        by_month[(d.year, d.month)].append(d)
    return [d.strftime("%Y-%m-%d") for d in sorted(max(v) for v in by_month.values())]


def resolve_cycle_expiries(monthly_list: list, today: date, far_mode: str):
    """(near_expiry, far_expiry) or (None, None)/(<near>, None) if data is missing.
    far_mode: 'next-month' (near+1) or 'two-months' (near+2)."""
    future = [d for d in monthly_list if datetime.strptime(d, "%Y-%m-%d").date() >= today]
    if not future:
        return None, None
    near = future[0]
    idx = monthly_list.index(near)
    offset = 1 if far_mode == "next-month" else 2
    far_idx = idx + offset
    far = monthly_list[far_idx] if far_idx < len(monthly_list) else None
    return near, far


def last_friday_of_month(year: int, month: int) -> date:
    last_day = calendar_mod.monthrange(year, month)[1]
    d = date(year, month, last_day)
    while d.weekday() != 4:      # Friday = 4
        d -= timedelta(days=1)
    return d


def resolve_entry_date(year: int, month: int, holidays: set) -> date:
    """Last Friday of the month; if that's a holiday/weekend, walk back one weekday at a time."""
    d = last_friday_of_month(year, month)
    while d.weekday() >= 5 or d.strftime("%Y-%m-%d") in holidays:
        d -= timedelta(days=1)
    return d


def in_time_window(now_hhmm: str, start_time: str, window_min: int) -> bool:
    start = datetime.strptime(start_time, "%H:%M")
    end = start + timedelta(minutes=window_min)
    now = datetime.strptime(now_hhmm, "%H:%M")
    return start.time() <= now.time() <= end.time()


def check_target_stop(total_pnl: float, target_rs, stop_rs):
    """Returns an exit reason string, or None."""
    if target_rs is not None and total_pnl >= target_rs:
        return f"Target hit: {total_pnl:+.0f} >= {target_rs:.0f}"
    if stop_rs is not None and total_pnl <= stop_rs:
        return f"Stop hit: {total_pnl:+.0f} <= {stop_rs:.0f}"
    return None


class Strategy:
    def __init__(self, dry_run=True, lots=1, wing_points=400, ce_offset_points=300, strike_step=50,
                 far_expiry_mode="next-month", target=(2.0, True), stop=(2.0, True),
                 fallback_margin_per_lot=170000.0, entry_time="15:16", entry_window_min=4,
                 eod_exit_time="15:17", max_consecutive_stops=3,
                 state_key=STRATEGY_KEY_DEFAULT, broker="dhan"):
        self.state_key = state_key
        self.broker_name = broker
        self.dry_run = dry_run
        self.lots = lots
        self.wing_points, self.ce_offset_points, self.strike_step = wing_points, ce_offset_points, strike_step
        self.far_expiry_mode = far_expiry_mode
        self.target_val, self.target_is_pct = target
        self.stop_val, self.stop_is_pct = stop
        self.fallback_margin_per_lot = fallback_margin_per_lot
        self.entry_time, self.entry_window_min, self.eod_exit_time = entry_time, entry_window_min, eod_exit_time
        self.max_consecutive_stops = max_consecutive_stops

        self.dhan = get_dhan_client()
        if not self.dhan:
            raise Exception("Failed to connect to Dhan.")
        self.helper = DhanHelper(self.dhan)
        try:
            self.broker = ExecutionBroker.create(broker, self.helper, underlying=UNDERLYING, log=logger.info)
        except ExecutionBrokerError as e:
            logger.error(f"Could not start {broker} execution: {e}")
            sys.exit(1)

        self.helper.start_websocket([("IDX_I", INDEX_ID, 15)])
        time.sleep(2)
        self.lot_size = self.helper.get_lot_size(UNDERLYING)

        self._reset_cycle_state()
        self.load_position()

    # ── position state + persistence (restart truth) ────────────────────────────────────────────

    def _reset_cycle_state(self):
        self.position_open = False
        self.status = "WAITING"
        self.entry_month = None                      # "YYYY-MM" of the last entry attempted/made
        self.near_expiry = None
        self.far_expiry = None
        self.legs = {name: None for name in LEG_SPECS}
        self.realized_pnl = 0.0
        self.target_rs = None
        self.stop_rs = None
        self.consecutive_stops = 0

    @property
    def position_path(self) -> str:
        return os.path.join(debug_dir, f"{self.state_key}_position.json")

    def save_position(self):
        """Atomic write. A torn file is what could lose a live leg."""
        data = {
            "version": 1, "dry_run": self.dry_run, "position_open": self.position_open,
            "status": self.status, "entry_month": self.entry_month,
            "near_expiry": self.near_expiry, "far_expiry": self.far_expiry,
            "lots": self.lots, "lot_size": self.lot_size, "legs": self.legs,
            "realized_pnl": self.realized_pnl, "target_rs": self.target_rs, "stop_rs": self.stop_rs,
            "consecutive_stops": self.consecutive_stops,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        }
        os.makedirs(debug_dir, exist_ok=True)
        tmp = self.position_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, self.position_path)

    def load_position(self):
        path = self.position_path
        if not os.path.exists(path):
            logger.info(f"No existing position/cycle memory at {path}; starting flat.")
            return
        try:
            with open(path) as f:
                data = json.load(f)
        except Exception as e:
            logger.error(f"FATAL: position file {path} is unreadable ({e}). Refusing to trade blind.")
            raise
        # Cycle memory (entry_month, consecutive_stops) is restored regardless of position_open —
        # it is not money-at-risk, just "did we already try this month".
        self.entry_month = data.get("entry_month")
        self.consecutive_stops = int(data.get("consecutive_stops", 0))
        if not data.get("position_open"):
            return
        if bool(data.get("dry_run")) != self.dry_run:
            logger.error(
                f"FATAL: {path} holds a {'PAPER' if data.get('dry_run') else 'LIVE'} position but this run is "
                f"{'DRY' if self.dry_run else 'LIVE'}. Move the file aside after checking the broker."
            )
            sys.exit(1)
        self.position_open = True
        self.status = data.get("status", "RUNNING")
        self.near_expiry, self.far_expiry = data.get("near_expiry"), data.get("far_expiry")
        self.lot_size = int(data.get("lot_size") or self.lot_size)
        self.legs = data.get("legs", self.legs)
        self.realized_pnl = float(data.get("realized_pnl", 0.0))
        self.target_rs, self.stop_rs = data.get("target_rs"), data.get("stop_rs")
        logger.info(f"Restored open position: near={self.near_expiry} far={self.far_expiry} "
                    f"legs={self.legs} realized={self.realized_pnl:+.2f}")
        for leg in self.legs.values():          # subscriptions are per process
            if leg:
                try:
                    self.helper.subscribe_instruments([("NSE_FNO", str(leg["id"]), 15)])
                except Exception as e:
                    logger.error(f"Resubscribe failed for {leg['id']}: {e}")
        self._reconcile_against_broker()

    def _reconcile_against_broker(self):
        """Diagnostic only; never used to size an exit. Refuses to start on a mismatch."""
        if self.dry_run:
            return
        mismatch = False
        for name, leg in self.legs.items():
            if not leg:
                continue
            expected = -leg["qty"] if leg["side"] == "SELL" else leg["qty"]
            try:
                net = self.broker.get_owned_net_qty(leg["strike"], leg["expiry"], leg["opt_type"])
            except Exception as e:
                logger.warning(f"Reconcile: could not read {name} {leg['opt_type']} {leg['strike']}: {e}")
                continue
            if net != expected:
                mismatch = True
                logger.warning(f"Reconcile MISMATCH {name}: expected {expected}, broker {net}")
        if mismatch:
            logger.error("Position does not match the broker. Fix it manually, then restart. Refusing to start.")
            sys.exit(1)

    # ── quotes, fills ───────────────────────────────────────────────────────────────────────────

    def _quote(self, strike, opt_type, expiry):
        """(security_id, last_price) or (None, 0.0). A zero or missing quote means skip."""
        sec = self.helper.find_option(UNDERLYING, expiry, strike, opt_type)
        if not sec:
            return None, 0.0
        sid = int(sec["SECURITY_ID"])
        price = self.helper.get_ltp(str(sid), exchange="NSE_FNO", instrument="OPTIDX")
        return (sid, price) if price and price > 0 else (None, 0.0)

    def _fill_price(self, order_id, fallback):
        """wait_for_fill() returns a bool, not a price; read the fill price off the order."""
        if not order_id or order_id == "PAPER":
            return fallback
        if self.helper.wait_for_fill(order_id, timeout=5):
            o = self.helper.get_order_by_id(order_id) or {}
            px = float(o.get("averageTradedPrice", 0.0) or o.get("avgFilledPrice", 0.0) or o.get("price", 0.0))
            if px > 0:
                return px
        return fallback

    def _ltp(self, leg):
        return self.helper.get_ltp(str(leg["id"]), exchange="NSE_FNO", instrument="OPTIDX")

    # ── orders (every call checked, every fill confirmed) ───────────────────────────────────────

    def _open_leg(self, name, strike, opt_type, expiry, qty, quote_price):
        """Place this leg's entry order. Returns fill price, or None if the order failed."""
        side = LEG_SPECS[name]["side"]
        if self.dry_run:
            return quote_price
        fn = self.broker.buy if side == "BUY" else self.broker.sell
        oid = fn(strike, expiry, opt_type, qty, product=PRODUCT)
        return self._fill_price(oid, quote_price) if oid else None

    def _close_leg(self, name, leg) -> tuple:
        """Returns (closed: bool, exit_price). A leg is only cleared once the broker confirms it."""
        ltp = self._ltp(leg)
        if self.dry_run:
            return True, ltp
        close_side = "SELL" if leg["side"] == "BUY" else "BUY"
        try:
            qty, _ = resolve_exit_qty_broker(self.broker, leg["strike"], leg["expiry"], leg["opt_type"],
                                              leg["qty"], close_side, logger)
            if qty <= 0:
                return True, ltp                     # broker already flat: nothing to close
            fn = self.broker.sell if close_side == "SELL" else self.broker.buy
            oid = fn(leg["strike"], leg["expiry"], leg["opt_type"], qty, product=PRODUCT)
            if not oid:
                logger.critical(f"{name} {leg['opt_type']} {leg['strike']} close order FAILED; leg stays tracked.")
                return False, ltp
            if not self.helper.wait_for_fill(oid, timeout=5):
                logger.critical(f"{name} {leg['opt_type']} {leg['strike']} close NOT confirmed; leg stays tracked.")
                return False, ltp
            return True, self._fill_price(oid, ltp)
        except Exception as e:
            logger.error(f"Close {name} {leg['opt_type']} {leg['strike']} error: {e}")
            return False, ltp

    def enter_position(self, spot, today: date):
        """All-or-nothing across 5 legs. Resolve everything first; unwind on any mid-entry failure."""
        expiries = self.helper.get_expiries(UNDERLYING)
        near, far = resolve_cycle_expiries(monthly_expiries(expiries), today, self.far_expiry_mode)
        if not near or not far:
            logger.error(f"Could not resolve near/far monthly expiries (near={near}, far={far}); "
                          "skipping entry this cycle.")
            return
        strikes = choose_strikes(spot, self.wing_points, self.ce_offset_points, self.strike_step)

        # Pre-check every quote before placing anything.
        quotes = {}
        for name in ENTRY_ORDER:
            spec = LEG_SPECS[name]
            expiry = near if spec["expiry_key"] == "near" else far
            sid, px = self._quote(strikes[name], spec["opt_type"], expiry)
            if not sid:
                logger.error(f"Missing/zero quote for {name} ({spec['opt_type']} {strikes[name]} @ {expiry}); "
                              "skipping entry this tick (no orders placed).")
                return
            quotes[name] = (sid, px, expiry)

        placed = []          # [(name, leg_dict), ...] in placement order, for rollback
        for name in ENTRY_ORDER:
            spec = LEG_SPECS[name]
            sid, px, expiry = quotes[name]
            qty = leg_qty(name, self.lots, self.lot_size)
            fill = self._open_leg(name, strikes[name], spec["opt_type"], expiry, qty, px)
            if fill is None:
                logger.critical(f"{name} {spec['side']} failed; unwinding {len(placed)} already-placed leg(s).")
                all_unwound = True
                for uname, uleg in placed:
                    closed, exit_px = self._close_leg(uname, uleg)
                    if closed:
                        self.realized_pnl += leg_pnl(uleg["side"], uleg["avg_price"], exit_px, uleg["qty"])
                    else:
                        all_unwound = False
                        self.legs[uname] = uleg
                if not all_unwound:
                    self.position_open, self.status = True, "UNWINDING"
                    self.near_expiry, self.far_expiry = near, far
                    self.save_position()
                else:
                    self.save_position()   # persists realized_pnl from the unwind + entry_month below
                return
            leg = {"id": sid, "strike": strikes[name], "opt_type": spec["opt_type"], "expiry": expiry,
                   "side": spec["side"], "avg_price": fill, "qty": qty}
            placed.append((name, leg))

        # All 5 legs filled — commit.
        for name, leg in placed:
            self.legs[name] = leg
            self.helper.subscribe_instruments([("NSE_FNO", str(leg["id"]), 15)])
        self.near_expiry, self.far_expiry = near, far
        self.entry_month = today.strftime("%Y-%m")
        self.position_open, self.status = True, "RUNNING"
        self._resolve_target_stop()
        self.save_position()
        logger.info(f"ENTERED {self.entry_month} near={near} far={far} " +
                    " ".join(f"{n}={l['strike']}({l['side']}@{l['avg_price']:.2f})" for n, l in placed))
        notify(f"[{self.state_key}] Entered volcano calendar {self.entry_month}, near={near} far={far}")

    def _resolve_target_stop(self):
        """Resolve target_rs/stop_rs ONCE at entry, against deployed margin (per the source's
        '2% on deployed capital' rule) — not against entry premium value."""
        margin = self._deployed_margin()
        if self.target_is_pct:
            self.target_rs = margin * self.target_val / 100.0
        else:
            self.target_rs = self.target_val
        if self.stop_is_pct:
            self.stop_rs = -margin * self.stop_val / 100.0
        else:
            self.stop_rs = -abs(self.stop_val)
        logger.info(f"Target/stop resolved against margin ₹{margin:,.0f}: "
                    f"target={self.target_rs:+.0f} stop={self.stop_rs:+.0f}")

    def _deployed_margin(self) -> float:
        """Real margin from Dhan's multi-leg calculator; falls back to a documented estimate
        (never blocks entry on a margin-API failure)."""
        try:
            scripts = [{
                "exchangeSegment": "NSE_FNO", "transactionType": leg["side"],
                "quantity": leg["qty"], "productType": PRODUCT,
                "securityId": str(leg["id"]), "price": 0.0,
            } for leg in self.legs.values() if leg]
            if scripts:
                summary = self.helper.get_multi_leg_margin_summary(scripts)
                final_margin = float(summary.get("final_margin", 0.0)) if summary else 0.0
                if final_margin > 0:
                    return final_margin
        except Exception as e:
            logger.warning(f"Margin lookup failed: {e}")
        fallback = self.fallback_margin_per_lot * self.lots
        logger.warning(f"Using fallback margin estimate ₹{fallback:,.0f} "
                        f"(--fallback-margin-per-lot x --lots); real margin call did not return a value.")
        return fallback

    def exit_all(self, reason) -> bool:
        """True only if every leg is confirmed closed. A leg clears only once its close is
        confirmed; on False the caller keeps a retry status and calls this again next tick."""
        logger.warning(f"!!! EXITING: {reason} !!!")
        all_closed = True
        for name, leg in list(self.legs.items()):
            if not leg:
                continue
            closed, exit_px = self._close_leg(name, leg)
            if closed:
                self.realized_pnl += leg_pnl(leg["side"], leg["avg_price"], exit_px, leg["qty"])
                try:
                    self.helper.unsubscribe_instruments([("NSE_FNO", str(leg["id"]), 15)])
                except Exception:
                    pass
                self.legs[name] = None
            else:
                all_closed = False
        if all_closed:
            was_stop = reason.startswith("Stop hit")
            self.consecutive_stops = self.consecutive_stops + 1 if was_stop else 0
            self.position_open, self.status = False, "WAITING"
            notify(f"[{self.state_key}] Exited: {reason} | realized {self.realized_pnl:+.0f}")
        else:
            self.status = "FLATTENING"
        self.save_position()
        return all_closed

    # ── P&L and state ───────────────────────────────────────────────────────────────────────────

    def total_pnl(self) -> float:
        total = self.realized_pnl
        for leg in self.legs.values():
            if leg:
                ltp = self._ltp(leg)
                if ltp > 0:
                    total += leg_pnl(leg["side"], leg["avg_price"], ltp, leg["qty"])
        return total

    def save_state(self, spot=0.0, total_pnl=0.0):
        save_strategy_state(self.state_key, {
            "strategy": STRATEGY_KEY_DEFAULT, "status": self.status, "dry_run": self.dry_run,
            "broker": self.broker_name, "lots": self.lots, "lot_size": self.lot_size,
            "near_expiry": self.near_expiry, "far_expiry": self.far_expiry, "entry_month": self.entry_month,
            "spot": spot, "position_open": self.position_open, "legs": self.legs,
            "realized_pnl": round(self.realized_pnl, 2), "total_pnl": round(total_pnl, 2),
            "target_rs": self.target_rs, "stop_rs": self.stop_rs,
            "consecutive_stops": self.consecutive_stops,
            "entries_paused": self.consecutive_stops >= self.max_consecutive_stops,
        })

    def _shutdown(self, reason):
        fully = self.exit_all(reason) if self.position_open else True
        self.status = "STOPPED" if fully else "STOPPED (EXIT INCOMPLETE - VERIFY MANUALLY)"
        self.save_state()
        if not fully:
            logger.critical("A leg did NOT confirm closed; the position file still shows it. Verify the broker.")
        flush_state()
        sys.exit(0)

    # ── main loop ───────────────────────────────────────────────────────────────────────────────

    def run(self):
        logger.info(f"Starting {self.state_key} | Mode: {'DRY' if self.dry_run else 'LIVE'} | lots={self.lots} "
                    f"| entry {self.entry_time}+{self.entry_window_min}m | far_expiry={self.far_expiry_mode} "
                    f"| broker={self.broker_name}")
        exit_if_market_closed(self.helper, self.dry_run)

        while True:
            if check_shutdown_trigger(self.state_key):
                self._shutdown("UI shutdown request")

            if not self.dry_run and not self.helper.is_market_open():
                self.status = "WAITING"
                self.save_state()
                self.helper.wait_for_market_open(self.dry_run,
                                                 shutdown_check=lambda: check_shutdown_trigger(self.state_key))
                continue

            spot = self.helper.get_ltp(UNDERLYING, exchange="IDX_I", instrument="INDEX")
            now_hhmm = datetime.now().strftime("%H:%M")
            today = date.today()

            if spot <= 0:                                  # stale quote: never act on 0
                self.save_state(spot=spot)
                time.sleep(2)
                continue

            if self.status in ("FLATTENING", "UNWINDING") and self.position_open:
                if self.exit_all(f"retry {self.status}"):
                    self.status = "WAITING"
                self.save_state(spot=spot, total_pnl=self.total_pnl())
                time.sleep(2)
                continue

            if not self.position_open:
                entry_paused = self.consecutive_stops >= self.max_consecutive_stops
                already_tried_this_month = self.entry_month == today.strftime("%Y-%m")
                entry_day = resolve_entry_date(today.year, today.month, self.helper.NSE_HOLIDAYS)
                if (not entry_paused and not already_tried_this_month and today == entry_day
                        and in_time_window(now_hhmm, self.entry_time, self.entry_window_min)):
                    self.entry_month = today.strftime("%Y-%m")   # mark tried even if this attempt fails
                    self.enter_position(spot, today)
                self.status = "WAITING"
                self.save_state(spot=spot)
                time.sleep(5)
                continue

            # ── in position ──
            pnl = self.total_pnl()
            self.status = "RUNNING"
            self.save_state(spot=spot, total_pnl=pnl)

            reason = check_target_stop(pnl, self.target_rs, self.stop_rs)
            if reason:
                self.exit_all(reason)
            elif self.near_expiry and today.strftime("%Y-%m-%d") == self.near_expiry and now_hhmm >= self.eod_exit_time:
                self.exit_all(f"Near-expiry EOD {self.eod_exit_time}")
            time.sleep(5)


def build_parser():
    p = argparse.ArgumentParser(
        description="Nifty Volcano Calendar: Put Butterfly + Call Calendar, monthly hold. UNVALIDATED.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run (default): no orders
  python strategies/volcano_calendar/nifty_volcano_calendar.py --lots 1

  # Live, 1 lot (requires the explicit unvalidated acknowledgement)
  python strategies/volcano_calendar/nifty_volcano_calendar.py --live --i-understand-this-is-unvalidated --lots 1
""")
    p.add_argument("--live", action="store_true", default=False, help="Place real orders. Default: dry run.")
    p.add_argument("--i-understand-this-is-unvalidated", action="store_true", default=False,
                   help="Required alongside --live: this strategy has no backtest and no losing-month "
                        "example in its source evidence.")
    p.add_argument("--lots", type=int, default=1, metavar="N",
                   help="Lots for the 1x legs; the put-butterfly body is always 2x this (default: 1).")
    p.add_argument("--wing-points", type=int, default=400, metavar="PTS",
                   help="Put butterfly wing spacing: body sold this far below ATM, outer wing bought "
                        "2x this far below ATM (default: 400).")
    p.add_argument("--ce-offset-points", type=int, default=300, metavar="PTS",
                   help="Call calendar strike, this far above ATM (default: 300, matching the "
                        "StockMock reference example's 24300 CE at ATM 24000).")
    p.add_argument("--strike-step", type=int, default=50, metavar="PTS", help="ATM rounding step (default: 50).")
    p.add_argument("--far-expiry", choices=["next-month", "two-months"], default="next-month",
                   help="Calendar leg's far expiry: 1 month or 2 months past the near monthly expiry. "
                        "The source deck says 'MONTHLY & BI-MONTHLY', which is ambiguous — this makes "
                        "the choice explicit rather than guessing (default: next-month).")
    p.add_argument("--target-profit", type=str, default="2%", metavar="INR|%",
                   help="Profit target in rupees or a percent of DEPLOYED MARGIN (not entry premium), "
                        "e.g. 2%% (default: 2%%, per the source's 'flat 2%% on deployed capital' rule).")
    p.add_argument("--stop-loss", type=str, default="2%", metavar="INR|%",
                   help="Max loss in rupees or a percent of DEPLOYED MARGIN (default: 2%%).")
    p.add_argument("--fallback-margin-per-lot", type=float, default=170000.0, metavar="INR",
                   help="Used to resolve target/stop-loss if the live margin-calculator call fails "
                        "(default: 170000, the midpoint of the source's Rs 1.5-1.8L/lot-combo estimate).")
    p.add_argument("--entry-time", type=str, default="15:16", metavar="HH:MM",
                   help="Entry time on the last trading Friday of the month (default: 15:16).")
    p.add_argument("--entry-window-min", type=int, default=4, metavar="MIN",
                   help="Minutes the entry window stays open past --entry-time (default: 4).")
    p.add_argument("--eod-exit-time", type=str, default="15:17", metavar="HH:MM",
                   help="Square-off time on the near-leg's expiry day only (default: 15:17).")
    p.add_argument("--max-consecutive-stops", type=int, default=3, metavar="N",
                   help="Pause new monthly entries after this many consecutive stop-outs (default: 3). "
                        "A repo-side safety default, not a source rule.")
    p.add_argument("--instance-id", type=str, default="", metavar="ID",
                   help="Suffix for state/log files to run a second concurrent copy of this strategy.")
    p.add_argument("--broker", choices=["dhan", "zerodha", "kotak"], default="dhan",
                   help="Execution broker. Market data always comes from Dhan. Zerodha/Kotak stops are "
                        "software-managed only (no resting broker-side stop order).")
    return p


def validate(args):
    errors = []
    if args.lots < 1:
        errors.append(f"--lots must be >= 1, got {args.lots}.")
    if args.wing_points <= 0:
        errors.append(f"--wing-points must be > 0, got {args.wing_points}.")
    if args.ce_offset_points <= 0:
        errors.append(f"--ce-offset-points must be > 0, got {args.ce_offset_points}.")
    if args.strike_step <= 0:
        errors.append(f"--strike-step must be > 0, got {args.strike_step}.")
    if args.entry_window_min < 1:
        errors.append(f"--entry-window-min must be >= 1, got {args.entry_window_min}.")
    if args.fallback_margin_per_lot <= 0:
        errors.append(f"--fallback-margin-per-lot must be > 0, got {args.fallback_margin_per_lot}.")
    if args.max_consecutive_stops < 1:
        errors.append(f"--max-consecutive-stops must be >= 1, got {args.max_consecutive_stops}.")
    for flag in ("entry_time", "eod_exit_time"):
        try:
            datetime.strptime(getattr(args, flag), "%H:%M")
        except ValueError:
            errors.append(f"--{flag.replace('_', '-')} must be HH:MM, got {getattr(args, flag)!r}.")
    if args.live and not args.i_understand_this_is_unvalidated:
        errors.append("--live requires --i-understand-this-is-unvalidated: this strategy has no "
                       "backtest and no losing-month example in its source evidence.")
    return errors


def main():
    args = build_parser().parse_args()
    state_key = f"{STRATEGY_KEY_DEFAULT}_{args.instance_id}" if args.instance_id else STRATEGY_KEY_DEFAULT
    errors = validate(args)
    try:
        target, stop = parse_target_spec(args.target_profit), parse_target_spec(args.stop_loss)
    except ValueError as e:
        errors.append(str(e))
    if errors:
        for e in errors:
            logger.error(f"[CONFIG ERROR] {e}")
        logger.error("Aborting: fix the configuration errors above and retry.")
        sys.exit(1)

    strat = Strategy(dry_run=not args.live, lots=args.lots, wing_points=args.wing_points,
                     ce_offset_points=args.ce_offset_points, strike_step=args.strike_step,
                     far_expiry_mode=args.far_expiry, target=target, stop=stop,
                     fallback_margin_per_lot=args.fallback_margin_per_lot,
                     entry_time=args.entry_time, entry_window_min=args.entry_window_min,
                     eod_exit_time=args.eod_exit_time, max_consecutive_stops=args.max_consecutive_stops,
                     state_key=state_key, broker=args.broker)
    try:
        strat.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt: squaring off and exiting.")
        strat._shutdown("KeyboardInterrupt / manual stop")


if __name__ == "__main__":
    main()
