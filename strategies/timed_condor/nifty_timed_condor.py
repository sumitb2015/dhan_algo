"""
Nifty timed iron condor: sell a defined-risk condor once a day, manage it on total P&L, flat by the close.

At --start-time (default 09:30) it buys two protective wings and sells two short strikes --short-offset points
either side of the money, then exits on a target, a stop, a trailing stop on total P&L, or at --eod-time. One
entry per day; a restart never re-enters a day it already traded.

VALIDATION STATUS: UNVALIDATED. There is no backtest and no forward test; the offsets, the 50% target and the 100%
stop are placeholders. Dry-run is the default and --live additionally requires --i-understand-this-is-unvalidated.

THIS FILE IS A WORKED EXAMPLE OF THE KIT. Everything that is not the idea itself comes from lib/algo_kit
(docs/ALGO_KIT.md): LegExecutor (confirmed entry, rollback, close sized by broker truth, restart reconcile),
PositionStore, TrailingStop, TargetSpec, the CLI flag groups, logging, quote parsing, batched LTPs and
shutdown-aware sleeps. What is left here is the strike choice, the entry gate and the exit rules.

Not registered in the dashboard (strategyRegistry.ts, the logs route's STRATEGY_LOG_DIRS): run it from a terminal.
Product is INTRADAY (flat at --eod-time).
"""

import argparse
import os
import sys
import time
from datetime import date
from typing import Dict, Optional


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
from lib.execution_broker import ExecutionBroker, ExecutionBrokerError  # noqa: E402
from lib.telegram_alert import notify  # noqa: E402
from lib.algo_kit import (  # noqa: E402
    LegExecutor, PositionFileError, PositionStore, TargetSpec, TrailingStop, cli, extract_quote_fields,
    fetch_named_ltps, hhmm_now, in_window, interruptible_sleep, is_quote_invalid, leg_pnl, past_time,
    setup_strategy_logging,
)

STRATEGY_KEY_DEFAULT = "nifty_timed_condor"
LOG_FOLDER = "timed_condor"
UNDERLYING = "NIFTY"
PRODUCT = "INTRADAY"
STRIKE_STEP = 50
INDEX_ID = "13"                                # index id for spot; the option chain underlying is 26000

# Protective legs first, so exposure is never a naked short while the entry is half built.
LEG_ORDER = ("long_ce", "long_pe", "short_ce", "short_pe")
LEG_SIDE = {"long_ce": ("BUY", "CE"), "long_pe": ("BUY", "PE"), "short_ce": ("SELL", "CE"), "short_pe": ("SELL", "PE")}

debug_dir = os.path.join(project_root, "debug")
logger = setup_strategy_logging(project_root, LOG_FOLDER, instance_log_suffix(), name=__name__)


# ── Pure decision logic: no broker, no clock, no I/O. Unit-test these. ──────────────────────────────────────

def atm_strike(spot: float, step: int = STRIKE_STEP) -> int:
    return int(round(spot / step) * step)


def condor_strikes(spot: float, short_offset: int, wing_width: int, step: int = STRIKE_STEP) -> Dict[str, int]:
    """Strikes for the four legs. The shorts sit short_offset points either side of the money, the wings
    wing_width points beyond them. All four are rounded to the strike step."""
    atm = atm_strike(spot, step)
    short_ce = atm + short_offset
    short_pe = atm - short_offset
    return {"long_ce": short_ce + wing_width, "short_ce": short_ce, "short_pe": short_pe, "long_pe": short_pe - wing_width}


def net_credit(prices: Dict[str, float]) -> float:
    """Premium collected per unit: what the shorts bring in minus what the wings cost."""
    return prices["short_ce"] + prices["short_pe"] - prices["long_ce"] - prices["long_pe"]


def max_loss_per_unit(wing_width: int, credit: float) -> float:
    """Defined risk: the wider wing's width less the credit (only one side can finish in the money)."""
    return wing_width - credit


def valid_condor(strikes: Dict[str, int]) -> bool:
    return strikes["long_pe"] < strikes["short_pe"] < strikes["short_ce"] < strikes["long_ce"]


class TimedCondor:
    def __init__(self, dry_run=True, lots=1, short_offset=200, wing_width=200,
                 target=(50.0, True), stop=(100.0, True), trail_start_rs=1500.0, trail_gap_rs=750.0,
                 start_time="09:30", eod_time="15:17", state_key=STRATEGY_KEY_DEFAULT, broker="dhan"):
        self.state_key, self.broker_name, self.dry_run, self.lots = state_key, broker, dry_run, lots
        self.short_offset, self.wing_width = short_offset, wing_width
        self.target_spec, self.stop_spec = TargetSpec.from_parsed(target), TargetSpec.from_parsed(stop)
        self.trail = TrailingStop(trail_start_rs, trail_gap_rs)
        self.start_time, self.eod_time = start_time, eod_time

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

        self.exec = LegExecutor(self.broker, self.helper, broker, PRODUCT, dry_run=dry_run, ltp_fn=self._ltp, log=logger)
        self.store = PositionStore(os.path.join(debug_dir, f"{state_key}_position.json"), dry_run, log=logger)

        self.position_open, self.status = False, "WAITING"
        self.legs: Dict[str, Optional[dict]] = {n: None for n in LEG_ORDER}
        self.expiry, self.entered_on = None, None
        self.realized_pnl, self.entry_credit_rs = 0.0, 0.0
        self.target_rs = self.stop_rs = None
        self.load_position()

    # ── persistence ─────────────────────────────────────────────────────────────────────────────────────────

    def save_position(self):
        self.store.save({
            "position_open": self.position_open, "status": self.status, "expiry": self.expiry,
            "entered_on": self.entered_on, "lots": self.lots, "lot_size": self.lot_size, "legs": self.legs,
            "realized_pnl": self.realized_pnl, "entry_credit_rs": self.entry_credit_rs,
            "target_rs": self.target_rs, "stop_rs": self.stop_rs, **self.trail.to_dict(),
        })

    def load_position(self):
        # PositionFileError (unreadable file, paper/live mismatch, expired live position) must stop the run.
        data = self.store.load(expiry_field="expiry")
        if data is None:
            return
        self.entered_on = data.get("entered_on")        # remembered even when flat: one entry per day
        if not data.get("position_open"):
            return
        self.position_open, self.status = True, data.get("status", "RUNNING")
        self.expiry = data.get("expiry")
        self.lot_size = int(data.get("lot_size") or self.lot_size)   # what was actually traded
        self.legs = {n: (data.get("legs") or {}).get(n) for n in LEG_ORDER}
        self.realized_pnl = float(data.get("realized_pnl", 0.0))
        self.entry_credit_rs = float(data.get("entry_credit_rs", 0.0))
        self.target_rs, self.stop_rs = data.get("target_rs"), data.get("stop_rs")
        self.trail.restore(data)
        logger.info(f"Restored open position: status={self.status} expiry={self.expiry} "
                    f"legs={ {n: (l or {}).get('strike') for n, l in self.legs.items()} } realized={self.realized_pnl:+.2f}")
        for leg in self.legs.values():                   # subscriptions are per process
            if leg:
                self.helper.subscribe_instruments([("NSE_FNO", str(leg["id"]), 15)])
        if self.status in ("UNWINDING", "FLATTENING"):
            logger.warning(f"Resuming {self.status}: will flatten the tracked legs against broker truth.")
            return
        problems = self.exec.reconcile(self.legs)        # a restart onto a position the broker does not show
        if problems:
            logger.error(f"Position does not match the broker: {problems}. Fix it manually, then restart.")
            sys.exit(1)

    # ── quotes and P&L ──────────────────────────────────────────────────────────────────────────────────────

    def _ltp(self, leg) -> float:
        return self.helper.get_ltp(str(leg["id"]), exchange="NSE_FNO", instrument="OPTIDX")

    def _quote(self, strike, opt_type):
        """(security_id, price) or (None, 0.0). A zero or missing quote means skip the tick."""
        q = self.helper.option(UNDERLYING, strike, opt_type)
        if is_quote_invalid(q, strict=True):
            return None, 0.0
        f = extract_quote_fields(q)
        return (f.security_id, f.ltp) if f.ltp > 0 else (None, 0.0)

    def total_pnl(self, prices: Optional[Dict[str, float]] = None) -> float:
        """Realised plus open P&L, continuous across the whole session. Targets, stops and the trail all read this."""
        total = self.realized_pnl
        for name, leg in self.legs.items():
            if leg:
                px = (prices or {}).get(name) or self._ltp(leg)
                if px > 0:
                    total += leg_pnl(leg["side"], leg["avg_price"], px, leg["qty"])
        return total

    # ── entry ───────────────────────────────────────────────────────────────────────────────────────────────

    def enter_position(self, spot: float, today: str):
        self.expiry = self.helper.get_nearest_expiry(UNDERLYING)
        if not self.expiry:
            logger.error("Could not resolve expiry; skipping entry this tick.")
            return
        strikes = condor_strikes(spot, self.short_offset, self.wing_width)
        if not valid_condor(strikes):
            logger.error(f"Strikes do not form a condor ({strikes}); skipping entry.")
            return
        ids, prices = {}, {}
        for name in LEG_ORDER:
            ids[name], prices[name] = self._quote(strikes[name], LEG_SIDE[name][1])
        if not all(ids.values()):
            logger.error("Missing/zero quote for a leg; skipping entry this tick (no orders placed).")
            return
        if net_credit(prices) <= 0:
            logger.warning(f"Net credit {net_credit(prices):.2f} is not positive; skipping entry.")
            return

        qty = self.lots * self.lot_size
        specs = [{"name": n, "side": LEG_SIDE[n][0], "opt_type": LEG_SIDE[n][1], "strike": strikes[n],
                  "expiry": self.expiry, "qty": qty, "avg_price": prices[n], "id": ids[n]} for n in LEG_ORDER]
        self.entered_on = today                          # an attempt counts as the day's entry, success or not
        res = self.exec.open_all(specs, checkpoint=self._checkpoint_entry)
        if not res.ok:
            for _n, leg, px, closed_qty in res.unwound:  # book what the rollback had to close
                self.realized_pnl += leg_pnl(leg["side"], leg["avg_price"], px, closed_qty)
            self.legs = {n: res.stuck.get(n) for n in LEG_ORDER}
            self.position_open = bool(res.stuck)
            self.status = "UNWINDING" if res.stuck else "WAITING"
            (logger.critical if res.stuck else logger.error)(
                f"Entry failed at {res.failed}; " + (f"{sorted(res.stuck)} could not be closed and stay tracked." if res.stuck
                                                      else "everything placed was closed. Done for the day."))
            self.save_position()
            return

        self.legs = {n: res.opened[n] for n in LEG_ORDER}
        credit = net_credit({n: l["avg_price"] for n, l in self.legs.items()})
        self.entry_credit_rs = credit * qty
        self.target_rs = self.target_spec.resolve(self.entry_credit_rs)
        stop = self.stop_spec.resolve(self.entry_credit_rs)
        self.stop_rs = -abs(stop) if stop is not None else None
        self.trail.reset()
        self.position_open, self.status = True, "RUNNING"
        for leg in self.legs.values():
            self.helper.subscribe_instruments([("NSE_FNO", str(leg["id"]), 15)])
        self.save_position()
        logger.info(f"ENTERED {strikes} credit={credit:.2f}/unit (Rs {self.entry_credit_rs:,.0f}) "
                    f"max loss Rs {max_loss_per_unit(self.wing_width, credit) * qty:,.0f} | "
                    f"target={self.target_rs} stop={self.stop_rs}")
        notify(f"[{self.state_key}] Entered condor {strikes['short_pe']}/{strikes['short_ce']} credit Rs {self.entry_credit_rs:,.0f}")

    def _checkpoint_entry(self, tracked):
        """Runs BEFORE each order: a crash mid-entry leaves a tracked UNWINDING book a restart can flatten."""
        self.legs = {n: tracked.get(n) for n in LEG_ORDER}
        self.position_open, self.status = True, "UNWINDING"
        self.save_position()

    # ── exit ────────────────────────────────────────────────────────────────────────────────────────────────

    def exit_all(self, reason: str) -> bool:
        """True only when every leg is confirmed closed; otherwise the legs stay tracked and it is retried."""
        logger.warning(f"!!! EXITING: {reason} !!!")

        def book(name, leg, exit_px, closed_qty):        # runs right after each CONFIRMED close
            self.realized_pnl += leg_pnl(leg["side"], leg["avg_price"], exit_px, closed_qty)
            try:
                self.helper.unsubscribe_instruments([("NSE_FNO", str(leg["id"]), 15)])
            except Exception:
                pass
            self.legs[name] = None
            self.save_position()

        done = self.exec.close_all({n: l for n, l in self.legs.items() if l}, on_closed=book).all_closed
        if done:
            self.position_open, self.status = False, "WAITING"
            notify(f"[{self.state_key}] Exited: {reason} | realized {self.realized_pnl:+.0f}")
        else:
            self.status = "FLATTENING"
        self.save_position()
        return done

    def exit_reason(self, pnl: float, now_hhmm: str) -> Optional[str]:
        """The first exit rule that fires, or None. Pure given its inputs apart from the trail's own state."""
        if self.trail.update(pnl):
            return f"Trailing stop: pnl {pnl:+.0f} gave back {self.trail.gap_rs:.0f} from best {self.trail.best_pnl:+.0f}"
        if self.target_rs is not None and pnl >= self.target_rs:
            return f"Target hit: {pnl:+.0f}"
        if self.stop_rs is not None and pnl <= self.stop_rs:
            return f"Stop hit: {pnl:+.0f}"
        if past_time(now_hhmm, self.eod_time):
            return f"EOD {self.eod_time}"
        return None

    # ── state bridge and main loop ──────────────────────────────────────────────────────────────────────────

    def save_state(self, status=None, spot=0.0, total_pnl=0.0):
        save_strategy_state(self.state_key, {
            "strategy": STRATEGY_KEY_DEFAULT, "status": status or self.status, "dry_run": self.dry_run,
            "broker": self.broker_name, "lots": self.lots, "lot_size": self.lot_size, "expiry": self.expiry,
            "spot": spot, "position_open": self.position_open, "legs": self.legs,
            "realized_pnl": round(self.realized_pnl, 2), "total_pnl": round(total_pnl, 2),
            "entry_credit_rs": round(self.entry_credit_rs, 2), "target_rs": self.target_rs, "stop_rs": self.stop_rs,
            "trail_active": self.trail.active, "best_pnl": round(self.trail.best_pnl, 2),
            "trail_start_rs": self.trail.start_rs, "trail_gap_rs": self.trail.gap_rs,
        })

    def _shutdown(self, reason):
        fully = self.exit_all(reason) if self.position_open else True
        self.save_state(status="STOPPED" if fully else "STOPPED (EXIT INCOMPLETE - VERIFY MANUALLY)")
        if not fully:
            logger.critical("A leg did NOT confirm closed; the position file still shows it. Verify the broker.")
        flush_state()
        sys.exit(0)

    def _wait(self, seconds) -> None:
        """Shutdown-aware sleep: the dashboard's Stop must not hang for the length of a wait."""
        if not interruptible_sleep(seconds, lambda: check_shutdown_trigger(self.state_key)):
            self._shutdown("UI shutdown request")

    def run(self):
        logger.info(f"Starting {self.state_key} | Mode: {'DRY' if self.dry_run else 'LIVE'} | lots={self.lots} "
                    f"| shorts +/-{self.short_offset} wings {self.wing_width} | {self.start_time}-{self.eod_time}")
        exit_if_market_closed(self.helper, self.dry_run)
        while True:
            if check_shutdown_trigger(self.state_key):
                self._shutdown("UI shutdown request")
            if not self.dry_run and not self.helper.is_market_open():
                self.save_state(status="WAITING")
                self.helper.wait_for_market_open(self.dry_run, shutdown_check=lambda: check_shutdown_trigger(self.state_key))
                continue

            spot = self.helper.get_ltp(UNDERLYING, exchange="IDX_I", instrument="INDEX")
            now_hhmm, today = hhmm_now(), date.today().isoformat()
            if spot <= 0:                                # stale quote: never act on 0
                self.save_state(spot=spot)
                self._wait(2)
                continue

            if self.position_open and self.status in ("UNWINDING", "FLATTENING"):
                if self.exit_all(f"retry {self.status}"):
                    self.save_state(status="WAITING", spot=spot)
                else:
                    self.save_state(spot=spot, total_pnl=self.total_pnl())
                self._wait(2)
                continue

            if not self.position_open:
                if self.entered_on != today and in_window(now_hhmm, self.start_time, self.eod_time):
                    self.enter_position(spot, today)
                self.save_state(spot=spot)
                self._wait(5)
                continue

            prices = fetch_named_ltps(self.helper, {n: ("NSE_FNO", l["id"]) for n, l in self.legs.items() if l})
            pnl = self.total_pnl(prices)
            self.save_state(status="RUNNING", spot=spot, total_pnl=pnl)
            reason = self.exit_reason(pnl, now_hhmm)
            if reason:
                self.exit_all(reason)
            self._wait(2)


def build_parser():
    p = argparse.ArgumentParser(
        description="Nifty timed iron condor (UNVALIDATED): sell a defined-risk condor once a day, manage it on total P&L.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry run (default): no orders
  python strategies/timed_condor/nifty_timed_condor.py --lots 1

  # Live (unvalidated: needs the acknowledgement), 1 lot, on Zerodha
  python strategies/timed_condor/nifty_timed_condor.py --live --i-understand-this-is-unvalidated --broker zerodha
""")
    cli.add_execution_args(p)
    cli.add_exit_args(p, target="50%", stop="100%", trail_start=1500.0, trail_gap=750.0)
    cli.add_window_args(p, start="09:30", eod="15:17")
    p.add_argument("--short-offset", type=int, default=200, metavar="POINTS",
                   help="Distance of each short strike from the money, in index points (default: 200).")
    p.add_argument("--wing-width", type=int, default=200, metavar="POINTS",
                   help="Distance of each protective wing beyond its short strike, in points (default: 200).")
    p.add_argument("--i-understand-this-is-unvalidated", action="store_true", default=False,
                   help="Required with --live: this strategy has no backtest and no forward test.")
    return p


def validate(args):
    errors = cli.validate_execution(args) + cli.validate_exit(args) + cli.validate_window(args)
    if args.short_offset < STRIKE_STEP or args.short_offset % STRIKE_STEP:
        errors.append(f"--short-offset must be a positive multiple of {STRIKE_STEP}, got {args.short_offset}.")
    if args.wing_width < STRIKE_STEP or args.wing_width % STRIKE_STEP:
        errors.append(f"--wing-width must be a positive multiple of {STRIKE_STEP}, got {args.wing_width}.")
    if args.live and not args.i_understand_this_is_unvalidated:
        errors.append("--live needs --i-understand-this-is-unvalidated: this strategy has no backtest and no forward test.")
    return errors


def main():
    args = build_parser().parse_args()
    state_key = cli.build_state_key(STRATEGY_KEY_DEFAULT, args.instance_id)
    cli.exit_on_errors(validate(args), logger)
    try:
        strat = TimedCondor(dry_run=not args.live, lots=args.lots, short_offset=args.short_offset,
                            wing_width=args.wing_width, target=parse_target_spec(args.target_profit),
                            stop=parse_target_spec(args.stop_loss), trail_start_rs=args.trail_start_rs,
                            trail_gap_rs=args.trail_gap_rs, start_time=args.start_time, eod_time=args.eod_time,
                            state_key=state_key, broker=args.broker)
    except PositionFileError as e:                       # unreadable / wrong-mode / expired position file: never trade blind
        logger.critical(f"Refusing to run: {e}")
        sys.exit(1)
    try:
        strat.run()
    except KeyboardInterrupt:
        logger.warning("KeyboardInterrupt: squaring off and exiting.")
        strat._shutdown("KeyboardInterrupt / manual stop")


if __name__ == "__main__":
    main()
