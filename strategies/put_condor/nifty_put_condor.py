"""
Nifty Put Condor (Double Bear Put Spread) — puts-only, monthly hold.

UNVALIDATED. Sourced from a single pasted video summary (2026-09-28, no title/channel captured)
describing "two stacked bear put spreads": buy a near-the-money bear put spread, sell a second bear
put spread further out of the money. By strike, high to low, that is BUY / SELL / SELL / BUY — a
standard 4-leg put condor. No backtest exists and the source shows one static worked example (spot
26,188) with no multi-month track record. See strategies/put_condor/strategy.md for the full spec.

--live requires --i-understand-this-is-unvalidated, same convention as intraday_equity/volcano_calendar.

Implements the standard kit from the dhan-new-strategy skill: dry-run default, state bridge,
shutdown trigger, own-quantity exits, confirmed fills (per broker), all-or-nothing entry persisted
before every order, shorts-before-longs exits, restart recovery.
Product is MARGIN (carry-forward) — this holds ~1 month, never INTRADAY.
"""

import argparse
import json
import logging
import math
import os
import sys
import time
from collections import defaultdict
from datetime import date, datetime


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
    check_shutdown_trigger, flush_state, instance_log_suffix, parse_target_spec, save_strategy_state,
)
from lib.strategy_risk import resolve_exit_qty_broker  # noqa: E402
from lib.execution_broker import ExecutionBroker, ExecutionBrokerError  # noqa: E402
from lib.telegram_alert import notify  # noqa: E402

STRATEGY_KEY_DEFAULT = "nifty_put_condor"   # must match strategyRegistry.ts
LOG_FOLDER = "put_condor"                   # must match STRATEGY_LOG_DIRS
UNDERLYING = "NIFTY"
PRODUCT = "MARGIN"                          # carry-forward: this holds ~1 month, never INTRADAY
INDEX_ID = "13"                             # index id for spot; option chain underlying is 26000
MAX_ENTRY_ATTEMPTS = 3                      # per cycle, only for attempts where nothing filled
CONFIRM_TIMEOUT_SEC = 15

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


LEG_SPECS = {
    "pe_long_upper":  {"side": "BUY",  "opt_type": "PE"},
    "pe_short_upper": {"side": "SELL", "opt_type": "PE"},
    "pe_short_lower": {"side": "SELL", "opt_type": "PE"},
    "pe_long_lower":  {"side": "BUY",  "opt_type": "PE"},
}
# Longs first on entry so a short is never naked mid-entry; shorts first on exit for the same reason.
ENTRY_ORDER = ["pe_long_upper", "pe_long_lower", "pe_short_upper", "pe_short_lower"]
EXIT_ORDER = ["pe_short_upper", "pe_short_lower", "pe_long_upper", "pe_long_lower"]
STRIKE_ORDER = ["pe_long_upper", "pe_short_upper", "pe_short_lower", "pe_long_lower"]  # high to low
SHORT_LEGS = [n for n in EXIT_ORDER if LEG_SPECS[n]["side"] == "SELL"]


# ── Pure decision logic: no broker, no clock, no I/O. Unit-test these. ──────────────────────────

def choose_strikes(spot: float, upper_long_offset: int, upper_short_offset: int,
                   lower_short_offset: int, lower_long_offset: int, step: int) -> dict:
    """Each leg is spot minus its point offset, rounded half-up to the nearest step. Offsets whose
    gaps are >= step (enforced by validate()) can never round onto the same strike."""
    def strike_below(offset):
        return int(math.floor((spot - offset) / step + 0.5)) * step
    return {
        "pe_long_upper": strike_below(upper_long_offset),
        "pe_short_upper": strike_below(upper_short_offset),
        "pe_short_lower": strike_below(lower_short_offset),
        "pe_long_lower": strike_below(lower_long_offset),
    }


def strikes_strictly_decreasing(strikes: dict) -> bool:
    ordered = [strikes[name] for name in STRIKE_ORDER]
    return all(ordered[i] > ordered[i + 1] for i in range(len(ordered) - 1))


def payoff_summary(strikes: dict, prices: dict, qty: int) -> dict:
    """Expiry payoff of the condor in rupees. P&L is -debit above the upper long strike, reaches
    upper_width - debit across the short body, and settles at upper_width - lower_width - debit
    below the lower long strike. With upper_width >= lower_width the book is never worth less than
    zero (even before expiry), so the worst case is simply the debit paid."""
    debit = (prices["pe_long_upper"] + prices["pe_long_lower"]
             - prices["pe_short_upper"] - prices["pe_short_lower"])
    upper_w = strikes["pe_long_upper"] - strikes["pe_short_upper"]
    lower_w = strikes["pe_short_lower"] - strikes["pe_long_lower"]
    rally, body, crash = -debit, upper_w - debit, upper_w - lower_w - debit
    return {
        "net_debit_pts": round(debit, 2),
        "max_profit_rs": round(max(rally, body, crash) * qty, 2),
        "max_loss_rs": round(-min(rally, body, crash) * qty, 2),
        "crash_pnl_rs": round(crash * qty, 2),
        "breakeven": round(strikes["pe_long_upper"] - debit, 2) if 0 < debit < upper_w else None,
    }


def leg_pnl(side: str, entry_price: float, exit_price: float, qty: int) -> float:
    return (entry_price - exit_price) * qty if side == "SELL" else (exit_price - entry_price) * qty


def monthly_expiries(expiries: list) -> list:
    """Last listed expiry in each calendar month (the monthly contract). No weekday assumed."""
    by_month = defaultdict(list)
    for e in expiries or []:
        try:
            d = datetime.strptime(e, "%Y-%m-%d").date()
        except (ValueError, TypeError):
            continue
        by_month[(d.year, d.month)].append(d)
    return [d.strftime("%Y-%m-%d") for d in sorted(max(v) for v in by_month.values())]


def pick_cycle_expiry(expiries: list, today: date, min_dte: int, max_dte: int, skip_expiry=None):
    """First monthly expiry whose calendar DTE is inside [min_dte, max_dte], skipping the cycle
    already traded. A fixed entry weekday can land 2 days before a monthly expiry (NIFTY's monthly
    is the last Tuesday, so the last Friday is sometimes just before it); a DTE window cannot."""
    for e in monthly_expiries(expiries):
        if e == skip_expiry:
            continue
        dte = (datetime.strptime(e, "%Y-%m-%d").date() - today).days
        if min_dte <= dte <= max_dte:
            return e
    return None


def resolve_levels(margin: float, partial, target, stop):
    """(partial_rs, target_rs, stop_rs) from (value, is_pct) specs. Stop is always negative."""
    def rs(spec):
        val, is_pct = spec
        return margin * abs(val) / 100.0 if is_pct else abs(val)
    return rs(partial), rs(target), -rs(stop)


def check_exit(total_pnl: float, target_rs, stop_rs):
    if target_rs is not None and total_pnl >= target_rs:
        return f"Target hit: {total_pnl:+.0f} >= {target_rs:.0f}"
    if stop_rs is not None and total_pnl <= stop_rs:
        return f"Stop hit: {total_pnl:+.0f} <= {stop_rs:.0f}"
    return None


class Strategy:
    def __init__(self, dry_run=True, lots=1, strike_step=50,
                 upper_long_offset=150, upper_short_offset=350,
                 lower_short_offset=550, lower_long_offset=700,
                 partial=(2.5, True), target=(10.0, True), stop=(4.0, True),
                 fallback_margin_per_lot=80000.0, min_dte=20, max_dte=38,
                 entry_time="09:45", entry_end="15:00", eod_exit_time="15:17",
                 max_consecutive_stops=3, state_key=STRATEGY_KEY_DEFAULT, broker="dhan"):
        self.state_key = state_key
        self.broker_name = broker
        self.dry_run = dry_run
        self.lots = lots
        self.strike_step = strike_step
        self.offsets = (upper_long_offset, upper_short_offset, lower_short_offset, lower_long_offset)
        self.partial_spec, self.target_spec, self.stop_spec = partial, target, stop
        self.fallback_margin_per_lot = fallback_margin_per_lot
        self.min_dte, self.max_dte = min_dte, max_dte
        self.entry_time, self.entry_end, self.eod_exit_time = entry_time, entry_end, eod_exit_time
        self.max_consecutive_stops = max_consecutive_stops
        self._last_note = None

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

        self.position_open = False
        self.status = "WAITING"
        self.expiry = None
        self.last_cycle_expiry = None
        self.entry_attempts = 0
        self.entry_lots = lots
        self.legs = {name: None for name in LEG_SPECS}
        self.realized_pnl = 0.0          # this cycle only; reset at every entry
        self.lifetime_realized = 0.0     # all completed cycles
        self.last_pnl = 0.0
        self.partial_booked = False
        self.partial_rs = self.target_rs = self.stop_rs = None
        self.margin = None
        self.payoff = None
        self.exit_reason = None
        self.consecutive_stops = 0
        self.load_position()

    def _note(self, msg, level=logging.INFO):
        """Log a recurring idle message only when it changes, so a 5s loop doesn't flood the log."""
        if msg != self._last_note:
            logger.log(level, msg)
            self._last_note = msg

    # ── persistence (restart truth) ─────────────────────────────────────────────────────────────

    @property
    def position_path(self) -> str:
        return os.path.join(debug_dir, f"{self.state_key}_position.json")

    def save_position(self):
        data = {
            "version": 2, "dry_run": self.dry_run, "position_open": self.position_open,
            "status": self.status, "expiry": self.expiry, "last_cycle_expiry": self.last_cycle_expiry,
            "entry_attempts": self.entry_attempts, "entry_lots": self.entry_lots,
            "lot_size": self.lot_size, "legs": self.legs,
            "realized_pnl": self.realized_pnl, "lifetime_realized": self.lifetime_realized,
            "partial_booked": self.partial_booked, "partial_rs": self.partial_rs,
            "target_rs": self.target_rs, "stop_rs": self.stop_rs, "margin": self.margin, "payoff": self.payoff,
            "exit_reason": self.exit_reason, "consecutive_stops": self.consecutive_stops,
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
        self.last_cycle_expiry = data.get("last_cycle_expiry")
        self.entry_attempts = int(data.get("entry_attempts", 0))
        self.consecutive_stops = int(data.get("consecutive_stops", 0))
        self.lifetime_realized = float(data.get("lifetime_realized", 0.0))
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
        self.expiry = data.get("expiry")
        self.entry_lots = int(data.get("entry_lots") or self.lots)
        self.lot_size = int(data.get("lot_size") or self.lot_size)
        self.legs = {name: (data.get("legs") or {}).get(name) for name in LEG_SPECS}
        self.realized_pnl = float(data.get("realized_pnl", 0.0))
        self.partial_booked = bool(data.get("partial_booked", False))
        self.partial_rs, self.target_rs, self.stop_rs = data.get("partial_rs"), data.get("target_rs"), data.get("stop_rs")
        self.margin = data.get("margin")
        self.payoff = data.get("payoff")
        self.exit_reason = data.get("exit_reason")

        if self.expiry and self.expiry < date.today().strftime("%Y-%m-%d"):
            if self.dry_run:
                logger.warning(f"Paper position for expiry {self.expiry} has already expired; discarding it.")
                self.position_open, self.status = False, "WAITING"
                self.legs = {name: None for name in LEG_SPECS}
                self.save_position()
                return
            logger.error(f"FATAL: {path} holds a LIVE position whose expiry {self.expiry} has passed. The "
                         "contracts have settled; verify the broker, then move the file aside.")
            sys.exit(1)

        logger.info(f"Restored open position: status={self.status} expiry={self.expiry} legs={self.legs} "
                    f"realized={self.realized_pnl:+.2f} partial_booked={self.partial_booked}")
        for leg in self.legs.values():          # subscriptions are per process
            if leg:
                try:
                    self.helper.subscribe_instruments([("NSE_FNO", str(leg["id"]), 15)])
                except Exception as e:
                    logger.error(f"Resubscribe failed for {leg['id']}: {e}")
        if self.status in ("UNWINDING", "FLATTENING"):
            # Mid-entry/mid-exit crash: an unconfirmed leg may not exist at the broker at all. The
            # retry path sizes every close off broker truth, so reconciling here would only block it.
            logger.warning(f"Resuming {self.status}: will flatten the tracked legs against broker truth.")
        else:
            self._reconcile_against_broker()

    def _reconcile_against_broker(self):
        """Diagnostic only; never sizes an exit. The broker net may include a sibling instance on the
        same strike, so only a SHORTFALL (broker holds less than we track) is a mismatch."""
        if self.dry_run:
            return
        mismatch = False
        for name, leg in self.legs.items():
            if not leg:
                continue
            try:
                net = self.broker.get_owned_net_qty(leg["strike"], leg["expiry"], leg["opt_type"])
            except Exception as e:
                logger.warning(f"Reconcile: could not read {name} {leg['opt_type']} {leg['strike']}: {e}")
                continue
            available = -net if leg["side"] == "SELL" else net
            if available < leg["qty"]:
                mismatch = True
                logger.warning(f"Reconcile MISMATCH {name}: tracking {leg['side']} {leg['qty']}, broker net {net}")
        if mismatch:
            logger.error("Position does not match the broker. Fix it manually, then restart. Refusing to start.")
            sys.exit(1)

    # ── quotes, orders, fills ───────────────────────────────────────────────────────────────────

    def _ltps(self, sids) -> dict:
        """str(security_id) -> LTP, one batched call at most (WebSocket first)."""
        if not sids:
            return {}
        return self.helper.get_ltps([("NSE_FNO", int(s)) for s in sids]) or {}

    def _place(self, side, leg, qty):
        if self.dry_run:
            return "PAPER"
        fn = self.broker.buy if side == "BUY" else self.broker.sell
        return fn(leg["strike"], leg["expiry"], leg["opt_type"], qty, product=PRODUCT)

    def _net_now(self, leg) -> int:
        if self.dry_run or self.broker_name == "dhan":
            return 0
        try:
            return int(self.broker.get_owned_net_qty(leg["strike"], leg["expiry"], leg["opt_type"]))
        except Exception:
            return 0

    def _confirm(self, leg, oid, signed_qty: int, net_before: int) -> bool:
        """True only when the order is confirmed filled. Dhan: order status. Zerodha/Kotak order ids
        are not Dhan ids, so there we wait for that broker's own net to move by signed_qty."""
        if self.dry_run:
            return True
        if not oid:
            return False
        if self.broker_name == "dhan":
            return bool(self.helper.wait_for_fill(oid, timeout=CONFIRM_TIMEOUT_SEC))
        expected = net_before + signed_qty
        deadline = time.time() + CONFIRM_TIMEOUT_SEC
        while time.time() < deadline:
            time.sleep(1)
            try:
                if self.broker.get_owned_net_qty(leg["strike"], leg["expiry"], leg["opt_type"]) == expected:
                    return True
            except Exception:
                continue
        return False

    def _fill_price(self, oid, fallback: float) -> float:
        """Actual fill price (Dhan only), else fallback. wait_for_fill returns a bool, not a price."""
        if self.dry_run or self.broker_name != "dhan" or not oid:
            return fallback
        try:
            o = self.helper.get_order_by_id(oid) or {}
            for key in ("averageTradedPrice", "avgFilledPrice", "price"):
                v = float(o.get(key) or 0)
                if v > 0:
                    return v
        except Exception as e:
            logger.warning(f"Could not read fill price for {oid}: {e}")
        return fallback

    def _close_qty(self, name, leg, qty) -> tuple:
        """Close up to `qty` of this leg. Returns (confirmed, exit_price, qty_closed). qty_closed may be
        less than asked (broker clamp) or 0 (broker already flat) — both count as confirmed."""
        ltp = self._ltps([leg["id"]]).get(str(leg["id"]), 0.0)
        if self.dry_run:
            if ltp <= 0:
                logger.warning(f"[PAPER] no quote for {name} {leg['strike']}; close deferred.")
                return False, 0.0, 0
            return True, ltp, qty
        close_side = "SELL" if leg["side"] == "BUY" else "BUY"
        try:
            to_close, net_before = resolve_exit_qty_broker(self.broker, leg["strike"], leg["expiry"],
                                                           leg["opt_type"], qty, close_side, logger)
            if to_close <= 0:
                # resolve_exit_qty_broker() also returns 0 when the lookup itself failed: only call the
                # leg flat if a direct read succeeds.
                try:
                    self.broker.get_owned_net_qty(leg["strike"], leg["expiry"], leg["opt_type"])
                except Exception as e:
                    logger.critical(f"Cannot verify {name} {leg['strike']} is flat ({e}); leg stays tracked.")
                    return False, 0.0, 0
                return True, leg["avg_price"], 0
            oid = self._place(close_side, leg, to_close)
            signed = to_close if close_side == "BUY" else -to_close
            if not self._confirm(leg, oid, signed, net_before):
                logger.critical(f"{name} {leg['opt_type']} {leg['strike']} close NOT confirmed (order {oid}); "
                                "leg stays tracked, retried next tick.")
                return False, 0.0, 0
            return True, self._fill_price(oid, ltp if ltp > 0 else leg["avg_price"]), to_close
        except Exception as e:
            logger.error(f"Close {name} {leg['opt_type']} {leg['strike']} error: {e}")
            return False, 0.0, 0

    def _deployed_margin(self, scripts) -> float:
        """Portfolio-netted margin of the 4 legs as a standalone basket (existing positions and orders
        excluded, so it is neither netted against nor doubled by what is already open)."""
        try:
            summary = self.helper.get_multi_leg_margin_summary(
                scripts, include_position=False, include_orders=False, include_available_funds=False)
            final_margin = float(summary.get("final_margin", 0.0)) if summary else 0.0
            if final_margin > 0:
                return final_margin
        except Exception as e:
            logger.warning(f"Margin lookup failed: {e}")
        fallback = self.fallback_margin_per_lot * self.lots
        logger.warning(f"Using fallback margin estimate Rs {fallback:,.0f} (--fallback-margin-per-lot x --lots).")
        return fallback

    # ── entry ───────────────────────────────────────────────────────────────────────────────────

    def enter_position(self, spot, today: date):
        expiry = pick_cycle_expiry(self.helper.get_expiries(UNDERLYING), today, self.min_dte,
                                   self.max_dte, skip_expiry=self.last_cycle_expiry)
        if not expiry:
            self._note(f"No monthly expiry inside DTE [{self.min_dte}, {self.max_dte}] (last cycle "
                       f"{self.last_cycle_expiry}); waiting.")
            return
        strikes = choose_strikes(spot, *self.offsets, self.strike_step)
        if not strikes_strictly_decreasing(strikes):
            self._note(f"Rounded strikes collapsed ({strikes}); skipping entry.", logging.ERROR)
            return

        sids = {}
        for name in ENTRY_ORDER:
            sec = self.helper.find_option(UNDERLYING, expiry, strikes[name], LEG_SPECS[name]["opt_type"])
            if not sec:
                self._note(f"No contract for {name} PE {strikes[name]} @ {expiry}; skipping entry.", logging.ERROR)
                return
            sids[name] = int(sec["SECURITY_ID"])
        self.helper.subscribe_instruments([("NSE_FNO", str(s), 15) for s in sids.values()])
        time.sleep(2)
        ltps = self._ltps(list(sids.values()))
        prices = {name: float(ltps.get(str(sid), 0.0) or 0.0) for name, sid in sids.items()}
        missing = [n for n, p in prices.items() if p <= 0]
        if missing:
            self._note(f"Missing/zero quotes for {missing} (last_api_error={self.helper.last_api_error}); "
                       "skipping entry this tick, no orders placed.", logging.WARNING)
            try:
                self.helper.unsubscribe_instruments([("NSE_FNO", str(s), 15) for s in sids.values()])
            except Exception:
                pass
            return

        qty = self.lots * self.lot_size
        margin = self._deployed_margin([{
            "exchangeSegment": "NSE_FNO", "transactionType": LEG_SPECS[n]["side"], "quantity": qty,
            "productType": PRODUCT, "securityId": str(sids[n]), "price": 0.0} for n in ENTRY_ORDER])

        # Persist BEFORE the first order, and each leg before its own order: a crash mid-entry leaves
        # a tracked UNWINDING book that a restart flattens, never live legs with no record.
        prev_cycle = self.last_cycle_expiry
        self.expiry, self.last_cycle_expiry = expiry, expiry
        self.entry_lots, self.realized_pnl, self.partial_booked = self.lots, 0.0, False
        self.exit_reason, self.margin, self.last_pnl, self.payoff = None, margin, 0.0, None
        self.partial_rs = self.target_rs = self.stop_rs = None
        self.legs = {name: None for name in LEG_SPECS}
        self.position_open, self.status = True, "UNWINDING"
        self.save_position()
        logger.info(f"ENTRY {expiry} spot={spot:.1f} lots={self.lots} strikes={strikes} "
                    f"prices={prices} margin=Rs {margin:,.0f}")

        failed = None
        for name in ENTRY_ORDER:
            side = LEG_SPECS[name]["side"]
            leg = {"id": sids[name], "strike": strikes[name], "opt_type": "PE", "expiry": expiry,
                   "side": side, "avg_price": prices[name], "qty": qty, "partial_done": False}
            self.legs[name] = leg
            self.save_position()
            net_before = self._net_now(leg)
            oid = self._place(side, leg, qty)
            ok = bool(oid) and self._confirm(leg, oid, qty if side == "BUY" else -qty, net_before)
            if oid and not ok and not self.dry_run and self.broker_name == "dhan":
                try:
                    self.helper.cancel_order(oid)
                except Exception as e:
                    logger.warning(f"Could not cancel unconfirmed order {oid}: {e}")
                if self.helper.get_order_status(oid) == "REJECTED":
                    oid = None                       # definitely nothing filled
            if not oid:
                self.legs[name] = None
            elif ok:
                leg["avg_price"] = self._fill_price(oid, prices[name])
            if not ok:
                failed = name
                break
        self.save_position()

        if failed:
            if not any(self.legs.values()):
                self.entry_attempts += 1
                self.position_open, self.status, self.expiry = False, "WAITING", None
                if self.entry_attempts < MAX_ENTRY_ATTEMPTS:
                    self.last_cycle_expiry = prev_cycle      # nothing filled: allow a retry
                    logger.error(f"Entry aborted at {failed}, nothing filled "
                                 f"(attempt {self.entry_attempts}/{MAX_ENTRY_ATTEMPTS}).")
                else:
                    self.entry_attempts = 0
                    logger.critical(f"Entry failed {MAX_ENTRY_ATTEMPTS} times; skipping the {expiry} cycle.")
                    notify(f"[{self.state_key}] Entry failed {MAX_ENTRY_ATTEMPTS}x, skipping {expiry} cycle")
                self.save_position()
                return
            logger.critical(f"Entry failed at {failed}; unwinding the legs already placed. "
                            f"The {expiry} cycle is skipped.")
            self.entry_attempts = 0
            self.exit_all(f"Entry failed at {failed}")
            return

        self.entry_attempts = 0
        self.partial_rs, self.target_rs, self.stop_rs = resolve_levels(
            margin, self.partial_spec, self.target_spec, self.stop_spec)
        self.payoff = payoff_summary(strikes, {n: l["avg_price"] for n, l in self.legs.items()}, qty)
        self.status = "RUNNING"
        self.save_position()
        logger.info(f"Payoff at expiry: {self.payoff}")
        logger.info(f"ENTERED expiry={expiry} " +
                    " ".join(f"{n}={l['strike']}({l['side']}@{l['avg_price']:.2f})" for n, l in self.legs.items())
                    + f" | partial={self.partial_rs:+.0f} target={self.target_rs:+.0f} stop={self.stop_rs:+.0f}")
        notify(f"[{self.state_key}] Entered put condor, expiry={expiry}, margin Rs {margin:,.0f}")

    # ── exits ───────────────────────────────────────────────────────────────────────────────────

    def _shorts_open(self, names=None) -> bool:
        return any(self.legs[n] for n in (names or SHORT_LEGS))

    def book_partial(self):
        """Close half of the entry lots on every leg, shorts first, each leg once. A leg that fails
        keeps its qty and is retried next tick; longs are never reduced while a short's partial close
        is still pending, so the book is never short-heavy."""
        half = self.entry_lots // 2
        if half < 1:
            logger.info("Partial-booking level reached but entry lots < 2; nothing to halve.")
            self.partial_booked = True
            self.save_position()
            return
        close_qty = half * self.lot_size
        for name in EXIT_ORDER:
            leg = self.legs[name]
            if not leg or leg.get("partial_done"):
                continue
            if leg["side"] == "BUY" and any(self.legs[s] and not self.legs[s].get("partial_done")
                                            for s in SHORT_LEGS):
                return
            confirmed, px, closed = self._close_qty(name, leg, min(close_qty, leg["qty"]))
            if not confirmed:
                logger.critical(f"Partial close of {name} failed; retrying next tick.")
                return
            if closed < close_qty:
                logger.warning(f"Partial close of {name}: closed {closed} of {close_qty} (broker holds less).")
            self.realized_pnl += leg_pnl(leg["side"], leg["avg_price"], px, closed)
            leg["qty"] -= closed
            leg["partial_done"] = True
            if leg["qty"] <= 0:
                self.legs[name] = None
            self.save_position()
        self.partial_booked = True
        self.save_position()
        logger.info(f"Partial booking done: closed {half}/{self.entry_lots} lot(s); realized {self.realized_pnl:+.0f}")
        notify(f"[{self.state_key}] Partial-booked {half} lot(s), realized {self.realized_pnl:+.0f}")

    def exit_all(self, reason) -> bool:
        """True only when every leg is confirmed closed. Shorts close first; longs are held as the
        hedge until no short remains. On False the caller retries (status FLATTENING/UNWINDING)."""
        if self.exit_reason is None:
            self.exit_reason = reason
        logger.warning(f"!!! EXITING: {reason} !!!")
        for name in EXIT_ORDER:
            leg = self.legs[name]
            if not leg:
                continue
            if leg["side"] == "BUY" and self._shorts_open():
                break
            confirmed, px, closed = self._close_qty(name, leg, leg["qty"])
            if not confirmed:
                continue
            if closed < leg["qty"]:
                logger.warning(f"{name}: closed {closed} of tracked {leg['qty']}; the rest was already "
                               "closed elsewhere and its P&L is not booked here.")
            self.realized_pnl += leg_pnl(leg["side"], leg["avg_price"], px, closed)
            try:
                self.helper.unsubscribe_instruments([("NSE_FNO", str(leg["id"]), 15)])
            except Exception:
                pass
            self.legs[name] = None
            self.save_position()

        if any(self.legs.values()):
            if self.status != "UNWINDING":
                self.status = "FLATTENING"
            self.save_position()
            return False

        was_stop = (self.exit_reason or "").startswith("Stop hit")
        self.consecutive_stops = self.consecutive_stops + 1 if was_stop else 0
        self.lifetime_realized += self.realized_pnl
        notify(f"[{self.state_key}] Exited: {self.exit_reason} | cycle {self.realized_pnl:+.0f} "
               f"| lifetime {self.lifetime_realized:+.0f}")
        self.position_open, self.status, self.exit_reason = False, "WAITING", None
        self.last_pnl = self.realized_pnl
        self.save_position()
        return True

    # ── P&L and state ───────────────────────────────────────────────────────────────────────────

    def total_pnl(self):
        """Cycle P&L (realized + unrealized), or None if any open leg has no quote — a leg missing
        from the sum would fake a target or stop."""
        open_legs = [l for l in self.legs.values() if l]
        ltps = self._ltps([l["id"] for l in open_legs])
        total = self.realized_pnl
        for leg in open_legs:
            ltp = float(ltps.get(str(leg["id"]), 0.0) or 0.0)
            if ltp <= 0:
                return None
            total += leg_pnl(leg["side"], leg["avg_price"], ltp, leg["qty"])
        return total

    def save_state(self, spot=0.0):
        open_qty = max((l["qty"] for l in self.legs.values() if l), default=0)
        save_strategy_state(self.state_key, {
            "strategy": STRATEGY_KEY_DEFAULT, "status": self.status, "dry_run": self.dry_run,
            "broker": self.broker_name, "lots": self.lots, "entry_lots": self.entry_lots,
            "open_lots": open_qty // self.lot_size if self.lot_size else 0, "lot_size": self.lot_size,
            "expiry": self.expiry, "last_cycle_expiry": self.last_cycle_expiry,
            "spot": spot, "position_open": self.position_open, "legs": self.legs,
            "realized_pnl": round(self.realized_pnl, 2), "total_pnl": round(self.last_pnl, 2),
            "lifetime_realized": round(self.lifetime_realized, 2), "margin": self.margin, "payoff": self.payoff,
            "partial_booked": self.partial_booked, "partial_rs": self.partial_rs,
            "target_rs": self.target_rs, "stop_rs": self.stop_rs,
            "consecutive_stops": self.consecutive_stops,
            "entries_paused": self.consecutive_stops >= self.max_consecutive_stops,
        })

    def _shutdown(self, reason):
        fully = self.exit_all(reason) if self.position_open else True
        if fully:
            self.status = "STOPPED"
        else:
            # The position file keeps FLATTENING so a restart finishes the exit instead of resuming.
            self.status = "FLATTENING"
            self.save_position()
            self.status = "STOPPED (EXIT INCOMPLETE - VERIFY MANUALLY)"
        self.save_state()
        if not fully:
            logger.critical("A leg did NOT confirm closed; the position file still shows it. Verify the broker.")
        flush_state()
        sys.exit(0)

    def _is_trading_day(self, today: date) -> bool:
        return today.weekday() < 5 and today.strftime("%Y-%m-%d") not in self.helper.NSE_HOLIDAYS

    # ── main loop ───────────────────────────────────────────────────────────────────────────────

    def run(self):
        logger.info(f"Starting {self.state_key} | Mode: {'DRY' if self.dry_run else 'LIVE'} | lots={self.lots} "
                    f"| DTE [{self.min_dte},{self.max_dte}] | entry {self.entry_time}-{self.entry_end} "
                    f"| broker={self.broker_name}")
        # No exit_if_market_closed(): this holds for a month, so a restart outside market hours must
        # wait and keep supervising rather than exit.
        while True:
            if check_shutdown_trigger(self.state_key):
                self._shutdown("UI shutdown request")

            if not self.dry_run and not self.helper.is_market_open():
                if self.status not in ("FLATTENING", "UNWINDING"):
                    self.status = "HOLDING OVERNIGHT" if self.position_open else "WAITING"
                self.save_state()
                self.helper.wait_for_market_open(self.dry_run,
                                                 shutdown_check=lambda: check_shutdown_trigger(self.state_key))
                continue

            spot = self.helper.get_ltp(UNDERLYING, exchange="IDX_I", instrument="INDEX")
            now_hhmm = datetime.now().strftime("%H:%M")
            today = date.today()
            today_str = today.strftime("%Y-%m-%d")

            if self.position_open and self.expiry and today_str > self.expiry:
                logger.critical(f"Position for expiry {self.expiry} is still tracked after expiry; the contracts "
                                "have settled. Verify the broker, then move the position file aside.")
                notify(f"[{self.state_key}] Position still tracked after expiry {self.expiry} - verify manually")
                self.status = "ERROR"
                self.save_state(spot=spot)
                flush_state()
                sys.exit(1)

            if spot <= 0:
                self.save_state(spot=spot)
                time.sleep(2)
                continue

            if self.position_open and self.status in ("FLATTENING", "UNWINDING"):
                self.exit_all(self.exit_reason or f"retry {self.status}")
                self.save_state(spot=spot)
                time.sleep(2)
                continue

            if not self.position_open:
                self.status = "WAITING"
                if self.consecutive_stops >= self.max_consecutive_stops:
                    self._note(f"Entries paused after {self.consecutive_stops} consecutive stops. Set "
                               f"consecutive_stops to 0 in {self.position_path} to resume.", logging.WARNING)
                elif self._is_trading_day(today) and self.entry_time <= now_hhmm <= self.entry_end:
                    self.enter_position(spot, today)
                self.save_state(spot=spot)
                time.sleep(5)
                continue

            pnl = self.total_pnl()
            if pnl is None:
                self._note("A leg has no quote; holding decisions this tick.", logging.WARNING)
                self.save_state(spot=spot)
                time.sleep(2)
                continue
            self.last_pnl = pnl
            self.status = "RUNNING"
            self.save_state(spot=spot)

            partial_started = any(l and l.get("partial_done") for l in self.legs.values())
            reason = check_exit(pnl, self.target_rs, self.stop_rs)
            if reason:
                self.exit_all(reason)
            elif today_str == self.expiry and now_hhmm >= self.eod_exit_time:
                self.exit_all(f"Expiry-day EOD {self.eod_exit_time}")
            elif not self.partial_booked and (partial_started or
                                              (self.partial_rs is not None and pnl >= self.partial_rs)):
                self.book_partial()
            time.sleep(5)


def build_parser():
    p = argparse.ArgumentParser(
        description="Nifty Put Condor (Double Bear Put Spread): puts-only, monthly hold. UNVALIDATED.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run (default): no orders
  python strategies/put_condor/nifty_put_condor.py --lots 2

  # Live, 2 lots (requires the explicit unvalidated acknowledgement; >=2 lots for partial booking)
  python strategies/put_condor/nifty_put_condor.py --live --i-understand-this-is-unvalidated --lots 2
""")
    p.add_argument("--live", action="store_true", default=False, help="Place real orders. Default: dry run.")
    p.add_argument("--i-understand-this-is-unvalidated", action="store_true", default=False,
                   help="Required alongside --live: no backtest, one static worked example in the source.")
    p.add_argument("--lots", type=int, default=1, metavar="N",
                   help="Lots for all four legs (default: 1). Partial booking needs >= 2.")
    p.add_argument("--strike-step", type=int, default=50, metavar="PTS", help="Strike rounding step (default: 50).")
    p.add_argument("--upper-long-offset", type=int, default=150, metavar="PTS",
                   help="Upper long put, points below spot (default: 150).")
    p.add_argument("--upper-short-offset", type=int, default=350, metavar="PTS",
                   help="Upper short put, points below spot (default: 350).")
    p.add_argument("--lower-short-offset", type=int, default=550, metavar="PTS",
                   help="Lower short put, points below spot (default: 550).")
    p.add_argument("--lower-long-offset", type=int, default=700, metavar="PTS",
                   help="Lower long put, points below spot (default: 700).")
    p.add_argument("--min-dte", type=int, default=20, metavar="DAYS",
                   help="Enter only a monthly expiry at least this many calendar days away (default: 20).")
    p.add_argument("--max-dte", type=int, default=38, metavar="DAYS",
                   help="...and at most this many (default: 38). After an expiry the next monthly is "
                        "27-35 days out, so a new cycle starts the next trading day.")
    p.add_argument("--partial-booking-profit", type=str, default="2.5%", metavar="INR|%",
                   help="Close half the entry lots (>= 2 lots only) at this cycle P&L, rupees or percent of "
                        "DEPLOYED MARGIN (default: 2.5%%, the source's '2-3%% on margin').")
    p.add_argument("--target-profit", type=str, default="10%", metavar="INR|%",
                   help="Full exit at this cycle P&L, rupees or percent of DEPLOYED MARGIN (default: 10%%).")
    p.add_argument("--stop-loss", type=str, default="4%", metavar="INR|%",
                   help="Full exit at this cycle loss, rupees or percent of DEPLOYED MARGIN (default: 4%%). "
                        "A backstop: with the upper spread wider than the lower, the worst case is the "
                        "net debit (~2-3%% of margin), so this normally cannot fire.")
    p.add_argument("--fallback-margin-per-lot", type=float, default=80000.0, metavar="INR",
                   help="Margin estimate if the live margin call fails (default: 80000, source example).")
    p.add_argument("--entry-time", type=str, default="09:45", metavar="HH:MM",
                   help="Earliest entry time on an eligible day (default: 09:45).")
    p.add_argument("--entry-end", type=str, default="15:00", metavar="HH:MM",
                   help="Latest entry time on an eligible day (default: 15:00).")
    p.add_argument("--eod-exit-time", type=str, default="15:17", metavar="HH:MM",
                   help="Square-off time on the position's own expiry day (default: 15:17).")
    p.add_argument("--max-consecutive-stops", type=int, default=3, metavar="N",
                   help="Pause new entries after this many consecutive stop-outs (default: 3).")
    p.add_argument("--instance-id", type=str, default="", metavar="ID",
                   help="Suffix for state/log files to run a second concurrent copy of this strategy.")
    p.add_argument("--broker", choices=["dhan", "zerodha", "kotak"], default="dhan",
                   help="Execution broker. Market data always comes from Dhan. Stops are software-managed.")
    return p


def validate(args):
    errors = []
    if args.lots < 1:
        errors.append(f"--lots must be >= 1, got {args.lots}.")
    if args.strike_step <= 0:
        errors.append(f"--strike-step must be > 0, got {args.strike_step}.")
    offsets = [args.upper_long_offset, args.upper_short_offset, args.lower_short_offset, args.lower_long_offset]
    if any(o < 0 for o in offsets):
        errors.append(f"Offsets must be >= 0, got {offsets}.")
    if args.strike_step > 0 and not all(offsets[i + 1] - offsets[i] >= args.strike_step for i in range(3)):
        errors.append(f"Offsets must increase by at least --strike-step ({args.strike_step}) each "
                      f"(upper-long < upper-short < lower-short < lower-long), got {offsets}.")
    if args.min_dte < 1 or args.max_dte < args.min_dte:
        errors.append(f"Need 1 <= --min-dte <= --max-dte, got {args.min_dte}/{args.max_dte}.")
    if args.fallback_margin_per_lot <= 0:
        errors.append(f"--fallback-margin-per-lot must be > 0, got {args.fallback_margin_per_lot}.")
    if args.max_consecutive_stops < 1:
        errors.append(f"--max-consecutive-stops must be >= 1, got {args.max_consecutive_stops}.")
    times_ok = True
    for flag in ("entry_time", "entry_end", "eod_exit_time"):
        try:
            # Normalise "9:45" -> "09:45": the loop compares these as strings.
            setattr(args, flag, datetime.strptime(getattr(args, flag), "%H:%M").strftime("%H:%M"))
        except ValueError:
            times_ok = False
            errors.append(f"--{flag.replace('_', '-')} must be HH:MM, got {getattr(args, flag)!r}.")
    if times_ok and args.entry_time > args.entry_end:
        errors.append(f"--entry-time {args.entry_time} is after --entry-end {args.entry_end}.")
    specs = {}
    for flag in ("partial_booking_profit", "target_profit", "stop_loss"):
        try:
            specs[flag] = parse_target_spec(getattr(args, flag))
            if specs[flag][0] == 0:
                errors.append(f"--{flag.replace('_', '-')} must be non-zero.")
        except ValueError as e:
            errors.append(str(e))
    if len(specs) == 3:
        (pv, pp), (tv, tp) = specs["partial_booking_profit"], specs["target_profit"]
        if pp == tp and abs(pv) >= abs(tv):
            errors.append("--partial-booking-profit must be below --target-profit.")
    if args.live and not args.i_understand_this_is_unvalidated:
        errors.append("--live requires --i-understand-this-is-unvalidated.")
    if offsets[3] - offsets[2] > offsets[1] - offsets[0]:
        logger.warning("Lower spread is wider than the upper spread: a crash below the lower long strike "
                       "now LOSES money and the loss is no longer capped at the net debit.")
    return errors, specs


def main():
    args = build_parser().parse_args()
    state_key = f"{STRATEGY_KEY_DEFAULT}_{args.instance_id}" if args.instance_id else STRATEGY_KEY_DEFAULT
    errors, specs = validate(args)
    if errors:
        for e in errors:
            logger.error(f"[CONFIG ERROR] {e}")
        logger.error("Aborting: fix the configuration errors above and retry.")
        sys.exit(1)

    strat = Strategy(dry_run=not args.live, lots=args.lots, strike_step=args.strike_step,
                     upper_long_offset=args.upper_long_offset, upper_short_offset=args.upper_short_offset,
                     lower_short_offset=args.lower_short_offset, lower_long_offset=args.lower_long_offset,
                     partial=specs["partial_booking_profit"], target=specs["target_profit"],
                     stop=specs["stop_loss"], fallback_margin_per_lot=args.fallback_margin_per_lot,
                     min_dte=args.min_dte, max_dte=args.max_dte, entry_time=args.entry_time,
                     entry_end=args.entry_end, eod_exit_time=args.eod_exit_time,
                     max_consecutive_stops=args.max_consecutive_stops, state_key=state_key, broker=args.broker)
    try:
        strat.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt: squaring off and exiting.")
        strat._shutdown("KeyboardInterrupt / manual stop")


if __name__ == "__main__":
    main()
