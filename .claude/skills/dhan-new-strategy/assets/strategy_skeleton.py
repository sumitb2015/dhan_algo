"""
TODO(strategy): <Strategy name> — one paragraph: the edge, the source, and its VALIDATION STATUS
(backtested? sessions? result?). If unvalidated, say so here, in strategy.md and gate --live.

Copy this file to strategies/<family>/<name>.py. It implements the standard kit from the
dhan-new-strategy skill (dry-run default, state bridge, shutdown trigger, own-quantity exits,
confirmed fills, all-or-nothing entry, restart recovery, guards). Fill in the TODO(strategy) hooks
and keep the plumbing. The example position is a short strangle (one CE + one PE sold).

Product is INTRADAY (flat at --eod-time). For a position held past the close use "MARGIN" and read
references/state-and-recovery.md; for delivery use "CNC".
"""

import argparse
import json
import logging
import os
import sys
import time
from datetime import datetime


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

STRATEGY_KEY_DEFAULT = "nifty_my_strategy"     # TODO(strategy): must match strategyRegistry.ts
LOG_FOLDER = "my_strategy"                     # TODO(strategy): must match STRATEGY_LOG_DIRS
UNDERLYING = "NIFTY"
PRODUCT = "INTRADAY"                           # explicit and constant; see docstring
STRIKE_STEP = 50
INDEX_ID = "13"                                # index id for spot; option chain underlying is 26000

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


# ── Pure decision logic: no broker, no clock, no I/O. Unit-test these. ──────────────────────────

def in_entry_window(now_hhmm: str, start_time: str, eod_time: str) -> bool:
    return start_time <= now_hhmm < eod_time


def atm_strike(spot: float, step: int = STRIKE_STEP) -> int:
    return int(round(spot / step) * step)


def choose_strikes(spot: float) -> tuple:
    """TODO(strategy): return (ce_strike, pe_strike). Must satisfy ce_strike > pe_strike."""
    atm = atm_strike(spot)
    return atm + 2 * STRIKE_STEP, atm - 2 * STRIKE_STEP


def leg_sl_level(entry_price: float, sl_pct: float) -> float:
    """Short-leg stop: premium rising to entry * (1 + sl_pct) is a loss."""
    return entry_price * (1.0 + sl_pct)


def update_trail(total_pnl: float, best_pnl: float, active: bool, start_rs: float, gap_rs: float) -> tuple:
    """Rupee-MTM trailing stop. Returns (active, best_pnl, exit_now). Reads total_pnl, which already
    folds in realized P&L, so it is continuous across rolls."""
    if not active and total_pnl >= start_rs:
        active, best_pnl = True, total_pnl
    if active:
        best_pnl = max(best_pnl, total_pnl)
        if total_pnl < best_pnl - gap_rs:
            return active, best_pnl, True
    return active, best_pnl, False


def inverted(ce_strike: int, pe_strike: int) -> bool:
    return ce_strike <= pe_strike


class Strategy:
    def __init__(self, dry_run=True, lots=1, target=(4000.0, False), stop=(4000.0, False),
                 leg_sl_pct=0.5, trail_start_rs=2000.0, trail_gap_rs=1000.0,
                 start_time="09:20", eod_time="15:17", cooldown_minutes=5,
                 state_key=STRATEGY_KEY_DEFAULT, broker="dhan"):
        self.state_key = state_key
        self.broker_name = broker
        self.dry_run = dry_run
        self.lots = lots
        self.target_val, self.target_is_pct = target
        self.stop_val, self.stop_is_pct = stop
        self.leg_sl_pct = leg_sl_pct
        self.trail_start_rs, self.trail_gap_rs = trail_start_rs, trail_gap_rs
        self.start_time, self.eod_time = start_time, eod_time
        self.cooldown_seconds = cooldown_minutes * 60

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

        self._reset_position_state()
        self.load_position()

    # ── position state + persistence (restart truth) ────────────────────────────────────────────

    def _reset_position_state(self):
        self.position_open = False
        self.status = "WAITING"
        self.expiry = None
        self.legs = {"CE": None, "PE": None}       # leg: {id, strike, avg_price, qty, sl}
        self.realized_pnl = 0.0
        self.trail_active, self.best_pnl = False, 0.0
        self.target_rs = None if self.target_is_pct else self.target_val
        self.stop_rs = None if self.stop_is_pct else -abs(self.stop_val)
        self.pause_until = 0.0                     # epoch seconds; new entries blocked until then

    @property
    def position_path(self) -> str:
        return os.path.join(debug_dir, f"{self.state_key}_position.json")

    def save_position(self):
        """Atomic write. A torn file is what could lose a live leg."""
        data = {
            "version": 1, "dry_run": self.dry_run, "position_open": self.position_open,
            "status": self.status, "expiry": self.expiry, "lots": self.lots, "lot_size": self.lot_size,
            "legs": self.legs, "realized_pnl": self.realized_pnl,
            "trail_active": self.trail_active, "best_pnl": self.best_pnl,
            "target_rs": self.target_rs, "stop_rs": self.stop_rs,
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
            logger.info(f"No existing position at {path}; starting flat.")
            return
        try:
            with open(path) as f:
                data = json.load(f)
        except Exception as e:
            logger.error(f"FATAL: position file {path} is unreadable ({e}). Refusing to trade blind.")
            raise
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
        self.lot_size = int(data.get("lot_size") or self.lot_size)   # what was actually sold
        self.legs = data.get("legs", self.legs)
        self.realized_pnl = float(data.get("realized_pnl", 0.0))
        self.trail_active = bool(data.get("trail_active"))
        self.best_pnl = float(data.get("best_pnl", 0.0))
        self.target_rs, self.stop_rs = data.get("target_rs"), data.get("stop_rs")
        logger.info(f"Restored open position: expiry={self.expiry} legs={self.legs} realized={self.realized_pnl:+.2f}")
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
        for opt_type, leg in self.legs.items():
            if not leg:
                continue
            try:
                net = self.broker.get_owned_net_qty(leg["strike"], self.expiry, opt_type)
            except Exception as e:
                logger.warning(f"Reconcile: could not read {opt_type} {leg['strike']}: {e}")
                continue
            if net != -leg["qty"]:
                mismatch = True
                logger.warning(f"Reconcile MISMATCH {opt_type} {leg['strike']}: expected {-leg['qty']}, broker {net}")
        if mismatch:
            logger.error("Position does not match the broker. Fix it manually, then restart. Refusing to start.")
            sys.exit(1)

    # ── quotes, fills ───────────────────────────────────────────────────────────────────────────

    def _get_quote(self, strike, opt_type):
        """(security_id, last_price) or (None, 0.0). A zero or missing quote means skip the tick."""
        q = self.helper.option(UNDERLYING, strike, opt_type)
        if not q or not isinstance(q, dict) or "CONTRACT_INFO" not in q:
            return None, 0.0
        price = float(q.get("last_price", 0.0) or q.get("LTP", 0.0))
        return (int(q["CONTRACT_INFO"]["SECURITY_ID"]), price) if price > 0 else (None, 0.0)

    def _fill_price(self, order_id, fallback):
        """wait_for_fill() returns a bool, not a price; read the price off the order."""
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

    def _sell_leg(self, strike, opt_type, qty, quote_price):
        """Return the fill price, or None if the order failed (caller must undo)."""
        if self.dry_run:
            return quote_price
        oid = self.broker.sell(strike, self.expiry, opt_type, qty, product=PRODUCT)
        return self._fill_price(oid, quote_price) if oid else None

    def _buy_to_close(self, opt_type, leg):
        """Returns (closed: bool, exit_price). A leg is only closed if the broker confirms it."""
        ltp = self._ltp(leg)
        if self.dry_run:
            return True, ltp
        try:
            qty, net = resolve_exit_qty_broker(self.broker, leg["strike"], self.expiry, opt_type,
                                               leg["qty"], "BUY", logger)
            if qty <= 0:
                return True, ltp                     # broker already flat: nothing to close
            oid = self.broker.buy(leg["strike"], self.expiry, opt_type, qty, product=PRODUCT)
            if not oid:
                logger.critical(f"{opt_type} {leg['strike']} close order FAILED; leg stays tracked.")
                return False, ltp
            if not self.helper.wait_for_fill(oid, timeout=5):
                logger.critical(f"{opt_type} {leg['strike']} close NOT confirmed; leg stays tracked.")
                return False, ltp
            return True, self._fill_price(oid, ltp)
        except Exception as e:
            logger.error(f"Close {opt_type} {leg['strike']} error: {e}")
            return False, ltp

    def enter_position(self, spot):
        """All-or-nothing. Resolve everything first, commit to self only once the legs are real."""
        self.expiry = self.helper.get_nearest_expiry(UNDERLYING)
        if not self.expiry:
            logger.error("Could not resolve expiry; skipping entry this tick.")
            return
        ce_strike, pe_strike = choose_strikes(spot)
        if inverted(ce_strike, pe_strike):
            logger.warning(f"Inverted strikes CE {ce_strike} <= PE {pe_strike}; skipping entry.")
            return
        ce_id, ce_px = self._get_quote(ce_strike, "CE")
        pe_id, pe_px = self._get_quote(pe_strike, "PE")
        if not ce_id or not pe_id:
            logger.error("Missing/zero quote for a leg; skipping entry this tick (no orders placed).")
            return

        qty = self.lots * self.lot_size
        ce_fill = self._sell_leg(ce_strike, "CE", qty, ce_px)
        if ce_fill is None:
            logger.error("CE sell failed; nothing placed. Staying flat.")
            return
        pe_fill = self._sell_leg(pe_strike, "PE", qty, pe_px)
        if pe_fill is None:
            logger.critical("PE sell failed; rolling back the CE leg.")
            leg = {"id": ce_id, "strike": ce_strike, "avg_price": ce_fill, "qty": qty}
            closed, _ = self._buy_to_close("CE", leg)
            if not closed:                           # naked short is live: track it and retry
                self.legs["CE"] = {**leg, "sl": leg_sl_level(ce_fill, self.leg_sl_pct)}
                self.position_open, self.status = True, "UNWINDING"
                self.save_position()
            return

        # Commit in one block, and mark open as soon as any short leg exists.
        self.legs["CE"] = {"id": ce_id, "strike": ce_strike, "avg_price": ce_fill, "qty": qty,
                           "sl": leg_sl_level(ce_fill, self.leg_sl_pct)}
        self.legs["PE"] = {"id": pe_id, "strike": pe_strike, "avg_price": pe_fill, "qty": qty,
                           "sl": leg_sl_level(pe_fill, self.leg_sl_pct)}
        self.position_open, self.status = True, "RUNNING"
        entry_value = (ce_fill + pe_fill) * qty
        if self.target_is_pct and self.target_rs is None:          # resolve % once, on the first entry
            self.target_rs = entry_value * self.target_val / 100.0
        if self.stop_is_pct and self.stop_rs is None:
            self.stop_rs = -entry_value * self.stop_val / 100.0
        for leg in self.legs.values():
            self.helper.subscribe_instruments([("NSE_FNO", str(leg["id"]), 15)])
        self.save_position()
        logger.info(f"ENTERED CE {ce_strike}@{ce_fill:.2f} PE {pe_strike}@{pe_fill:.2f} qty={qty}")
        notify(f"[{self.state_key}] Entered CE {ce_strike} / PE {pe_strike} x{qty}")

    def exit_all(self, reason) -> bool:
        """True only if every leg is confirmed closed. A leg is cleared only after its close is
        confirmed; on False the caller keeps a retry status and calls this again next tick."""
        logger.warning(f"!!! EXITING: {reason} !!!")
        all_closed = True
        for opt_type in ("CE", "PE"):
            leg = self.legs[opt_type]
            if not leg:
                continue
            closed, exit_px = self._buy_to_close(opt_type, leg)
            if closed:
                self.realized_pnl += (leg["avg_price"] - exit_px) * leg["qty"]    # book once, at fill
                try:
                    self.helper.unsubscribe_instruments([("NSE_FNO", str(leg["id"]), 15)])
                except Exception:
                    pass
                self.legs[opt_type] = None
            else:
                all_closed = False
        if all_closed:
            self.position_open, self.status = False, "WAITING"
            self.trail_active, self.best_pnl = False, 0.0
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
                    total += (leg["avg_price"] - ltp) * leg["qty"]                # short: entry - now
        return total

    def save_state(self, status=None, spot=0.0, total_pnl=0.0):
        save_strategy_state(self.state_key, {
            "strategy": STRATEGY_KEY_DEFAULT, "status": status or self.status, "dry_run": self.dry_run,
            "broker": self.broker_name, "lots": self.lots, "lot_size": self.lot_size, "expiry": self.expiry,
            "spot": spot, "position_open": self.position_open,
            "ce": self.legs["CE"], "pe": self.legs["PE"],
            "ce_strike": (self.legs["CE"] or {}).get("strike"), "pe_strike": (self.legs["PE"] or {}).get("strike"),
            "realized_pnl": round(self.realized_pnl, 2), "total_pnl": round(total_pnl, 2),
            "target_rs": self.target_rs, "stop_rs": self.stop_rs,
            "trail_active": self.trail_active, "best_pnl": round(self.best_pnl, 2),
            "trail_start_rs": self.trail_start_rs, "trail_gap_rs": self.trail_gap_rs,
        })

    def _shutdown(self, reason):
        fully = self.exit_all(reason) if self.position_open else True
        self.save_state(status="STOPPED" if fully else "STOPPED (EXIT INCOMPLETE - VERIFY MANUALLY)")
        if not fully:
            logger.critical("A leg did NOT confirm closed; the position file still shows it. Verify the broker.")
        flush_state()
        sys.exit(0)

    # ── main loop ───────────────────────────────────────────────────────────────────────────────

    def run(self):
        logger.info(f"Starting {self.state_key} | Mode: {'DRY' if self.dry_run else 'LIVE'} | lots={self.lots} "
                    f"| {self.start_time}-{self.eod_time} | broker={self.broker_name}")
        exit_if_market_closed(self.helper, self.dry_run)

        while True:
            if check_shutdown_trigger(self.state_key):
                self._shutdown("UI shutdown request")

            if not self.dry_run and not self.helper.is_market_open():
                self.save_state(status="WAITING")
                self.helper.wait_for_market_open(self.dry_run,
                                                 shutdown_check=lambda: check_shutdown_trigger(self.state_key))
                continue

            spot = self.helper.get_ltp(UNDERLYING, exchange="IDX_I", instrument="INDEX")
            now_hhmm = datetime.now().strftime("%H:%M")

            if spot <= 0:                                  # stale quote: never act on 0
                self.save_state(spot=spot)
                time.sleep(2)
                continue

            # Retry states: only try to get flat; do nothing else.
            if self.status in ("FLATTENING", "UNWINDING") and self.position_open:
                if self.exit_all(f"retry {self.status}"):
                    self.save_state(status="WAITING", spot=spot)
                else:
                    self.save_state(spot=spot, total_pnl=self.total_pnl())
                time.sleep(2)
                continue

            if not self.position_open:
                if in_entry_window(now_hhmm, self.start_time, self.eod_time) and time.time() >= self.pause_until:
                    self.enter_position(spot)                # TODO(strategy): add your entry gate here
                self.save_state(spot=spot)
                time.sleep(5)
                continue

            # ── in position ──
            pnl = self.total_pnl()
            self.save_state(status="RUNNING", spot=spot, total_pnl=pnl)

            for opt_type, leg in list(self.legs.items()):    # per-leg SL: TODO(strategy) roll instead?
                if leg and (ltp := self._ltp(leg)) > 0 and ltp >= leg["sl"]:
                    self.exit_all(f"{opt_type} leg SL hit ({ltp:.2f} >= {leg['sl']:.2f})")
                    self.pause_until = time.time() + self.cooldown_seconds
                    break
            if not self.position_open:
                continue

            pnl = self.total_pnl()                          # re-derive after anything that could book P&L
            self.trail_active, self.best_pnl, trail_hit = update_trail(
                pnl, self.best_pnl, self.trail_active, self.trail_start_rs, self.trail_gap_rs)
            if trail_hit:
                self.exit_all(f"Trailing SL: pnl {pnl:+.0f} < best {self.best_pnl:+.0f} - {self.trail_gap_rs:.0f}")
            elif self.target_rs is not None and pnl >= self.target_rs:
                self.exit_all(f"Target hit: {pnl:+.0f}")
            elif self.stop_rs is not None and pnl <= self.stop_rs:
                self.exit_all(f"Stop hit: {pnl:+.0f}")
            elif now_hhmm >= self.eod_time:
                self.exit_all(f"EOD {self.eod_time}")
            time.sleep(2)


def build_parser():
    p = argparse.ArgumentParser(
        description="TODO(strategy): one-line description",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run (default): no orders
  python strategies/<family>/<name>.py --lots 1

  # Live, 2 lots, on Zerodha
  python strategies/<family>/<name>.py --live --lots 2 --broker zerodha
""")
    p.add_argument("--live", action="store_true", default=False, help="Place real orders. Default: dry run.")
    p.add_argument("--lots", type=int, default=1, metavar="N", help="Lots per leg (default: 1).")
    p.add_argument("--target-profit", type=str, default="4000", metavar="INR|%",
                   help="Profit target in rupees or a percent of entry value, e.g. 4000 or 25%% (default: 4000).")
    p.add_argument("--stop-loss", type=str, default="4000", metavar="INR|%",
                   help="Max loss in rupees or a percent of entry value (default: 4000).")
    p.add_argument("--leg-sl-pct", type=float, default=0.5, metavar="FRAC",
                   help="Per-leg stop as a fraction of entry premium (default: 0.5 = 50%%).")
    p.add_argument("--trail-start-rs", type=float, default=2000.0, metavar="INR",
                   help="Arm the trailing stop at this MTM profit (default: 2000).")
    p.add_argument("--trail-gap-rs", type=float, default=1000.0, metavar="INR",
                   help="Exit on this giveback from the best MTM (default: 1000).")
    p.add_argument("--start-time", type=str, default="09:20", metavar="HH:MM", help="Entry not before (default: 09:20).")
    p.add_argument("--eod-time", type=str, default="15:17", metavar="HH:MM", help="Square-off time (default: 15:17).")
    p.add_argument("--cooldown-minutes", type=int, default=5, metavar="MIN",
                   help="Pause new entries after an emergency/SL exit (default: 5).")
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
    if not 0 < args.leg_sl_pct < 5:
        errors.append(f"--leg-sl-pct must be in (0, 5), got {args.leg_sl_pct}.")
    if args.trail_gap_rs <= 0:
        errors.append(f"--trail-gap-rs must be > 0, got {args.trail_gap_rs}.")
    if args.trail_start_rs < 0:
        errors.append(f"--trail-start-rs must be >= 0, got {args.trail_start_rs}.")
    if args.cooldown_minutes < 0:
        errors.append(f"--cooldown-minutes must be >= 0, got {args.cooldown_minutes}.")
    for flag in ("start_time", "eod_time"):
        try:
            datetime.strptime(getattr(args, flag), "%H:%M")
        except ValueError:
            errors.append(f"--{flag.replace('_', '-')} must be HH:MM, got {getattr(args, flag)!r}.")
    if not errors and args.start_time >= args.eod_time:
        errors.append("--start-time must be earlier than --eod-time.")
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

    strat = Strategy(dry_run=not args.live, lots=args.lots, target=target, stop=stop,
                     leg_sl_pct=args.leg_sl_pct, trail_start_rs=args.trail_start_rs,
                     trail_gap_rs=args.trail_gap_rs, start_time=args.start_time, eod_time=args.eod_time,
                     cooldown_minutes=args.cooldown_minutes, state_key=state_key, broker=args.broker)
    try:
        strat.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt: squaring off and exiting.")
        strat._shutdown("KeyboardInterrupt / manual stop")


if __name__ == "__main__":
    main()
