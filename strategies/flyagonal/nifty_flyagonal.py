"""
Nifty "Flyagonal": call broken-wing butterfly (front expiry) + put diagonal (front short / back long)

Positional (multi-day carry, product MARGIN). NOT VALIDATED: the idea comes from a US-SPX video
(58/60 winners over 10 weeks, self-reported) and has no Nifty evidence. Dry-run is the default; --live places
real orders. (The vault's 20-cycle forward-test gate was waived by the owner.)
Rules, gaps and the reasoning are in strategies/flyagonal/strategy.md.

Structure, one cycle (all NIFTY index options, per-unit strikes scaled off spot):
  Front expiry F = first listed expiry with --entry-dte-min <= DTE <= --entry-dte-max (default 8-10)
  Back  expiry B = listed expiry after F with DTE in --back-dte-min..max (default 15-20), closest to 2x F's DTE
  Call BWB on F : BUY 1 call @K1 (spot + fly-lower-pct), SELL 2 calls @K2 (+ fly-body-pct),
                  BUY 1 call @K3 (+ fly-upper-pct)      wings K2-K1 < K3-K2 (broken wing, up side)
  Put diagonal  : SELL 1 put on F @Ps (spot - put-pct), BUY 1 put on B @Ps - diag-offset
                  (long strike BELOW the short so the pair is risk-defined at F's expiry)
  Entry places the 3 long legs first, then the 2 short legs; any failure unwinds what was placed.

Exit (first that fires, checked in this order each poll):
  1. total P&L <= -stop  (optional, --stop-loss; the source video states no stop)
  2. total P&L >= target (--target-profit, default 10% of entry max loss; --adjusted-target after
     an adjustment)
  3. time: DTE(F) < --exit-dte, or == --exit-dte at/after --exit-time (default 4 days, 15:15)

Adjustment (the video's is discretionary; this is ONE numeric rule, capped, --max-adjustments 0 disables):
  net position delta per lot <= -(--adjust-delta) (market ran up) -> roll the short front put UP by
  --adjust-step points (adds +delta), long back put unchanged. The reverse case has no coded rule.

Every close is confirmed before a leg is cleared; exits are sized by resolve_exit_qty_broker() (never the
raw broker net); every order call is checked; a failed step leaves the tracked state honest (UNWINDING /
FLATTENING retry states). State survives restarts via debug/<state_key>_portfolio.json.

Usage (dry run by default, no real orders without --live):
    venv/bin/python strategies/flyagonal/nifty_flyagonal.py
    venv/bin/python strategies/flyagonal/nifty_flyagonal.py --live --lots 1
"""

import argparse
import json
import logging
import os
import re
import sys
import time
import traceback
from datetime import datetime, date

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, PROJECT_ROOT)

from login import get_dhan_client                                      # noqa: E402
from lib.dhan_helper import DhanHelper                                 # noqa: E402
from lib.execution_broker import ExecutionBroker, ExecutionBrokerError  # noqa: E402
from lib.strategy_risk import resolve_exit_qty_broker                  # noqa: E402
from lib.strategy_state_helper import (                                # noqa: E402
    save_strategy_state, check_shutdown_trigger, instance_log_suffix, parse_target_spec,
)
try:
    from lib.telegram_alert import notify                              # noqa: E402
except Exception:                                                      # never block trading on alerts
    def notify(*_a, **_k):
        return None

# ── logging ──────────────────────────────────────────────────────────────────
DEBUG_DIR = os.path.join(PROJECT_ROOT, "debug")
LOG_DIR = os.path.join(DEBUG_DIR, "logs", "flyagonal")
os.makedirs(LOG_DIR, exist_ok=True)


class FlushingFileHandler(logging.FileHandler):
    """Flush on every record so the dashboard's log tail is live, not buffered."""

    def emit(self, record):
        super().emit(record)
        self.flush()


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.StreamHandler(),
        FlushingFileHandler(
            os.path.join(LOG_DIR, f"{datetime.now().strftime('%Y%m%d')}{instance_log_suffix()}.log"),
            encoding="utf-8",
        ),
    ],
    force=True,
)
logger = logging.getLogger(__name__)

STRATEGY_KEY_DEFAULT = "nifty_flyagonal"
PORTFOLIO_VERSION = 1
PRODUCT = "MARGIN"          # overnight carry: INTRADAY would be force-squared by the broker
BUY, SELL = "BUY", "SELL"

# Entry places longs first (so the shorts are always covered), exits close shorts first.
ENTRY_ORDER = ["call_lo", "call_hi", "put_long", "call_body", "put_short"]
EXIT_ORDER = ["call_body", "put_short", "call_lo", "call_hi", "put_long"]
OPEN_STATUSES = ("ENTERED", "UNWINDING", "FLATTENING")


# ── pure decision logic (no I/O, unit-tested) ────────────────────────────────
def round_to_step(x: float, step: int) -> int:
    return int(round(x / step) * step)


def build_structure(spot, step, lower_pct, body_pct, upper_pct, put_pct, diag_offset) -> dict:
    """Strikes for the whole book from spot. Raises ValueError if the shape is not a valid
    broken-wing-up butterfly with a risk-defined put diagonal below it."""
    k1 = round_to_step(spot * (1 + lower_pct / 100.0), step)
    k2 = round_to_step(spot * (1 + body_pct / 100.0), step)
    k3 = round_to_step(spot * (1 + upper_pct / 100.0), step)
    ps = round_to_step(spot * (1 - put_pct / 100.0), step)
    pl = ps - int(diag_offset)
    if not (k1 < k2 < k3):
        raise ValueError(f"call strikes not ascending: {k1}/{k2}/{k3}")
    if not (k3 - k2) > (k2 - k1):
        raise ValueError(f"not broken-wing (upper wing {k3 - k2} must exceed lower wing {k2 - k1})")
    if not (pl < ps < k1):
        raise ValueError(f"put strikes must satisfy long {pl} < short {ps} < call {k1}")
    return {"k1": k1, "k2": k2, "k3": k3, "ps": ps, "pl": pl}


def pick_expiries(expiries, today: date, dte_min: int, dte_max: int, back_dte_min: int,
                  skip_expiry=None, back_dte_max: int = None):
    """(front, back) expiry strings, or None. Front = first expiry inside the entry DTE window
    (skipping the one just cycled). Back = the later expiry inside [back_dte_min, back_dte_max]
    closest to 2x the front's DTE (the source sets the long put at double the short leg's days).
    back_dte_max None means no upper bound."""
    parsed = []
    for e in expiries or []:
        try:
            parsed.append((e, (datetime.strptime(e, "%Y-%m-%d").date() - today).days))
        except Exception:
            continue
    parsed.sort(key=lambda t: t[1])
    front = next(((e, d) for e, d in parsed if dte_min <= d <= dte_max and e != skip_expiry), None)
    if not front:
        return None
    cands = [(e, d) for e, d in parsed
             if d > front[1] and d >= back_dte_min and (back_dte_max is None or d <= back_dte_max)]
    if not cands:
        return None
    back = min(cands, key=lambda t: (abs(t[1] - 2 * front[1]), t[1]))
    return front[0], back[0]


def leg_specs(struct: dict, front: str, back: str) -> dict:
    """name -> (side, option type, strike, expiry, lot multiple)."""
    return {
        "call_lo":   (BUY,  "CE", struct["k1"], front, 1),
        "call_body": (SELL, "CE", struct["k2"], front, 2),
        "call_hi":   (BUY,  "CE", struct["k3"], front, 1),
        "put_short": (SELL, "PE", struct["ps"], front, 1),
        "put_long":  (BUY,  "PE", struct["pl"], back, 1),
    }


def net_debit_points(prices: dict) -> float:
    """Per-unit net debit (positive = paid) from leg prices keyed by leg name."""
    return (prices["call_lo"] + prices["call_hi"] + prices["put_long"]
            - 2 * prices["call_body"] - prices["put_short"])


def max_loss_points(struct: dict, debit: float) -> float:
    """Worst case at the front expiry per unit: the larger of the two one-sided tails
    (they cannot both happen) plus the net debit. Floored at 1 so a credit can't zero the base."""
    wing_gap = (struct["k3"] - struct["k2"]) - (struct["k2"] - struct["k1"])
    put_gap = struct["ps"] - struct["pl"]
    return max(max(wing_gap, put_gap) + debit, 1.0)


def leg_pnl(side: str, entry: float, last: float, qty: int) -> float:
    return (last - entry) * qty if side == BUY else (entry - last) * qty


def net_delta_per_lot(legs: dict) -> float:
    """Sum of signed leg deltas x lot multiple (position delta in units of one lot)."""
    total = 0.0
    for leg in legs.values():
        if not leg or leg.get("last_delta") is None:
            continue
        sign = 1.0 if leg["side"] == BUY else -1.0
        total += sign * leg["mult"] * float(leg["last_delta"])
    return total


def adjustment_due(net_delta: float, threshold: float, done: int, max_adjustments: int) -> bool:
    return max_adjustments > 0 and done < max_adjustments and net_delta <= -abs(threshold)


def time_exit_due(dte: int, hhmm: str, exit_dte: int, exit_time: str) -> bool:
    return dte < exit_dte or (dte == exit_dte and hhmm >= exit_time)


def resolve_spec(spec, base: float):
    """(rupees or None) from a parse_target_spec() tuple against base rupees."""
    if spec is None:
        return None
    value, is_pct = spec
    return base * value / 100.0 if is_pct else float(value)


class NiftyFlyagonal:
    def __init__(self, args, state_key: str):
        self.args = args
        self.dry_run = not args.live
        self.broker_name = args.broker
        self.state_key = state_key
        self.lots = int(args.lots)
        self.helper = None
        self.broker = None
        self.lot_size = 0

        # Persisted position state.
        self.status = "IDLE"            # IDLE | ENTERED | UNWINDING | FLATTENING | HALTED
        self.front = None
        self.back = None
        self.legs = {}                  # name -> leg dict (absent/None when not held)
        self.entry_date = None
        self.entry_spot = None
        self.max_loss_rs = 0.0
        self.realized_pnl = 0.0         # this cycle, includes an adjustment's closed put
        self.cumulative_pnl = 0.0       # closed cycles
        self.adjustments = 0
        self.last_cycle_expiry = None
        self.last_alert = ""

        # Live (not persisted).
        self.spot = 0.0
        self.total_pnl = 0.0
        self.net_delta = 0.0
        self.market_open = False

        self.target_spec = args.target_spec
        self.adjusted_target_spec = args.adjusted_target_spec
        self.stop_spec = args.stop_spec

    # ── persistence ──────────────────────────────────────────────────────────
    @property
    def portfolio_path(self) -> str:
        return os.path.join(DEBUG_DIR, f"{self.state_key}_portfolio.json")

    def save_portfolio(self) -> None:
        data = {
            "version": PORTFOLIO_VERSION, "state_key": self.state_key, "dry_run": self.dry_run,
            "status": self.status, "front": self.front, "back": self.back,
            "lots": self.lots, "lot_size": self.lot_size,
            "entry_date": self.entry_date, "entry_spot": self.entry_spot,
            "max_loss_rs": self.max_loss_rs, "realized_pnl": self.realized_pnl,
            "cumulative_pnl": self.cumulative_pnl, "adjustments": self.adjustments,
            "last_cycle_expiry": self.last_cycle_expiry, "last_alert": self.last_alert,
            "legs": {k: v for k, v in self.legs.items() if v},
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        }
        os.makedirs(DEBUG_DIR, exist_ok=True)
        tmp = self.portfolio_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, self.portfolio_path)

    def load_portfolio(self) -> None:
        path = self.portfolio_path
        if not os.path.exists(path):
            logger.info(f"No existing portfolio at {path}, starting flat (IDLE)")
            return
        try:
            with open(path, "r") as f:
                data = json.load(f)
        except Exception as e:
            logger.error(f"FATAL: portfolio file {path} is unreadable ({e}). Fix or move it "
                         f"before restarting; refusing to trade blind.")
            raise

        status = data.get("status", "IDLE")
        is_open = status in OPEN_STATUSES
        if is_open and bool(data.get("dry_run", True)) != self.dry_run:
            logger.error(f"FATAL: portfolio was written by a {'PAPER' if data.get('dry_run', True) else 'LIVE'} "
                         f"run but this is a {'PAPER' if self.dry_run else 'LIVE'} run with an open "
                         f"position. Refusing to start; close it in the original mode or delete {path}.")
            sys.exit(1)

        self.status = status
        self.front, self.back = data.get("front"), data.get("back")
        self.legs = data.get("legs", {}) or {}
        self.entry_date, self.entry_spot = data.get("entry_date"), data.get("entry_spot")
        self.max_loss_rs = float(data.get("max_loss_rs", 0) or 0)
        self.realized_pnl = float(data.get("realized_pnl", 0) or 0)
        self.cumulative_pnl = float(data.get("cumulative_pnl", 0) or 0)
        self.adjustments = int(data.get("adjustments", 0) or 0)
        self.last_cycle_expiry = data.get("last_cycle_expiry")
        self.last_alert = data.get("last_alert", "")
        if is_open:
            # Exit sizing must match what was sold, not whatever NSE's lot size is at restart.
            self.lots = int(data.get("lots", self.lots) or self.lots)
            if data.get("lot_size"):
                self.lot_size = int(data["lot_size"])
        logger.info(f"Restored portfolio: status={self.status} front={self.front} back={self.back} "
                    f"lots={self.lots} lot_size={self.lot_size} legs={sorted(self.legs)} "
                    f"realized={self.realized_pnl:.0f} cumulative={self.cumulative_pnl:.0f}")
        if is_open and not self.dry_run:
            self._reconcile_against_broker()

    def _reconcile_against_broker(self) -> None:
        """Diagnostic-only check of reloaded legs vs broker truth. Never used to size an exit."""
        mismatch = False
        for name, leg in self.legs.items():
            expected = self._leg_qty(leg) * (1 if leg["side"] == BUY else -1)
            try:
                net = self.broker.get_owned_net_qty(leg["strike"], leg["expiry"], leg["type"])
            except Exception as e:
                logger.warning(f"Reconcile: could not read broker net for {name}: {e}")
                continue
            if net != expected:
                mismatch = True
                logger.warning(f"Reconcile MISMATCH {name} {leg['type']} {leg['strike']} ({leg['expiry']}): "
                               f"portfolio expects {expected}, broker shows {net}.")
        if mismatch and not self.args.force_reconcile:
            logger.error("Reconcile mismatch. Pass --force-reconcile to continue anyway, or fix the "
                         "position manually first. Refusing to start.")
            sys.exit(1)

    # ── dashboard state ──────────────────────────────────────────────────────
    def display_status(self) -> str:
        if self.status == "ENTERED":
            return "RUNNING" if self.market_open else "HOLDING OVERNIGHT"
        if self.status == "IDLE":
            return "WAITING"
        return self.status

    def save_state(self, status_override: str = None) -> None:
        save_strategy_state(self.state_key, {
            "strategy": "Nifty Flyagonal (BWB + put diagonal)",
            "status": status_override or self.display_status(),
            "phase": self.status,
            "dry_run": self.dry_run, "broker": self.broker_name,
            "lots": self.lots, "lot_size": self.lot_size, "spot": self.spot,
            "total_pnl": round(self.total_pnl, 2), "realized_pnl": round(self.realized_pnl, 2),
            "cumulative_pnl": round(self.cumulative_pnl, 2),
            "front_expiry": self.front, "back_expiry": self.back,
            "entry_date": self.entry_date, "entry_spot": self.entry_spot,
            "legs": {k: v for k, v in self.legs.items() if v},
            "net_delta_per_lot": round(self.net_delta, 3),
            "max_loss_rs": round(self.max_loss_rs, 2),
            "target_rs": self._target_rs(), "stop_rs": self._stop_rs(),
            "adjustments": self.adjustments, "max_adjustments": self.args.max_adjustments,
            "exit_dte": self.args.exit_dte, "exit_time": self.args.exit_time,
            "alert": self.last_alert,
        })

    # ── small helpers ────────────────────────────────────────────────────────
    def _leg_qty(self, leg) -> int:
        return int(leg["mult"]) * self.lots * self.lot_size

    def _target_rs(self):
        spec = self.adjusted_target_spec if self.adjustments > 0 else self.target_spec
        return resolve_spec(spec, self.max_loss_rs)

    def _stop_rs(self):
        return resolve_spec(self.stop_spec, self.max_loss_rs)

    def _alert(self, msg: str, level=logging.INFO) -> None:
        self.last_alert = msg
        logger.log(level, msg)
        notify(f"[{self.state_key}] {msg}")

    def _dte(self, expiry: str) -> int:
        return (datetime.strptime(expiry, "%Y-%m-%d").date() - datetime.now().date()).days

    def _read_spot(self) -> float:
        try:
            v = float(self.helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX") or 0)
        except Exception as e:
            logger.warning(f"Spot read failed: {e}")
            return 0.0
        return v if v > 0 else 0.0

    @staticmethod
    def _row(chain_df, strike, opt_type):
        """(price, delta) for a strike from a chain frame, or (None, None) if absent/stale."""
        try:
            row = chain_df.loc[float(strike)]
            price = float(row[f"{opt_type.lower()}_last_price"])
            delta = row.get(f"{opt_type.lower()}_delta")
            return (price if price > 0 else None), (None if delta is None else float(delta))
        except Exception:
            return None, None

    def _chains(self) -> dict:
        out = {}
        for exp in {e for e in (self.front, self.back) if e}:
            out[exp] = self.helper.get_option_chain_df("NIFTY", exp)
        return out

    # ── orders (paper-aware, confirmed) ──────────────────────────────────────
    def _place(self, side: str, strike, expiry, opt_type, qty):
        if self.dry_run:
            logger.info(f"  [PAPER] {side} {opt_type} {strike} qty={qty} exp={expiry}")
            return "PAPER"
        fn = self.broker.sell if side == SELL else self.broker.buy
        return fn(strike, expiry, opt_type, qty, product=PRODUCT)

    def _net_before(self, strike, expiry, opt_type) -> int:
        if self.dry_run or self.broker_name == "dhan":
            return 0
        try:
            return int(self.broker.get_owned_net_qty(strike, expiry, opt_type))
        except Exception:
            return 0

    def _confirm(self, strike, expiry, opt_type, oid, signed_qty: int, net_before: int) -> bool:
        """True only when the order is confirmed filled. signed_qty: +qty for BUY, -qty for SELL."""
        if self.dry_run:
            return True
        if not oid:
            return False
        if self.broker_name == "dhan":
            return bool(self.helper.wait_for_fill(oid, timeout=15))
        expected = net_before + signed_qty
        deadline = time.time() + 15
        while time.time() < deadline:
            time.sleep(1)
            try:
                if self.broker.get_owned_net_qty(strike, expiry, opt_type) == expected:
                    return True
            except Exception:
                continue
        return False

    def _fill_price(self, oid, fallback: float) -> float:
        """Actual fill price (Dhan), else the pre-order mark. wait_for_fill returns a bool, not a price."""
        if self.dry_run or self.broker_name != "dhan" or not oid:
            return fallback
        try:
            order = self.helper.get_order_by_id(oid) or {}
            for key in ("averageTradedPrice", "avgFilledPrice", "price"):
                v = float(order.get(key) or 0)
                if v > 0:
                    return v
        except Exception as e:
            logger.warning(f"Could not read fill price for {oid}: {e}")
        return fallback

    def _close_leg(self, leg) -> tuple:
        """Buy-to-close a short / sell-to-close a long, sized off broker truth. Returns
        (closed_confirmed, fill_price_or_None). A leg the broker already shows flat counts as closed."""
        close_side = SELL if leg["side"] == BUY else BUY
        own_qty = self._leg_qty(leg)
        if self.dry_run:
            qty, net_before = own_qty, 0
        else:
            qty, net_before = resolve_exit_qty_broker(
                self.broker, leg["strike"], leg["expiry"], leg["type"], own_qty,
                BUY if leg["side"] == SELL else SELL, logger)
        if qty <= 0:
            if not self.dry_run:
                # resolve_exit_qty_broker() also returns 0 when the position lookup itself failed;
                # only call the leg flat if a second read succeeds.
                try:
                    self.broker.get_owned_net_qty(leg["strike"], leg["expiry"], leg["type"])
                except Exception as e:
                    logger.critical(f"Cannot verify {leg['type']} {leg['strike']} is flat ({e}); "
                                    f"leg stays tracked.")
                    return False, None
            return True, None
        oid = self._place(close_side, leg["strike"], leg["expiry"], leg["type"], qty)
        signed = qty if close_side == BUY else -qty
        if not self._confirm(leg["strike"], leg["expiry"], leg["type"], oid, signed, net_before):
            logger.critical(f"Close of {leg['type']} {leg['strike']} ({leg['expiry']}) did NOT confirm "
                            f"(order {oid}). Leg stays tracked; retried next poll.")
            return False, None
        return True, self._fill_price(oid, leg.get("last_price") or leg["entry_price"])

    # ── entry ────────────────────────────────────────────────────────────────
    def attempt_entry(self) -> None:
        a = self.args
        now = datetime.now()
        if a.entry_weekday is not None and now.weekday() != a.entry_weekday:
            return
        if not self.market_open or now.strftime("%H:%M") < a.entry_time:
            return
        if a.max_cumulative_loss is not None and self.cumulative_pnl <= -abs(a.max_cumulative_loss):
            self.status = "HALTED"
            self._alert(f"HALTED: cumulative P&L {self.cumulative_pnl:,.0f} breached "
                        f"-{abs(a.max_cumulative_loss):,.0f}. No further entries.", logging.CRITICAL)
            self.save_portfolio()
            return

        pair = pick_expiries(self.helper.get_expiries("NIFTY"), now.date(), a.entry_dte_min,
                             a.entry_dte_max, a.back_dte_min, skip_expiry=self.last_cycle_expiry,
                             back_dte_max=a.back_dte_max)
        if not pair:
            return
        front, back = pair
        spot = self._read_spot()
        if spot <= 0:
            logger.info("Spot unavailable, skipping entry this poll.")
            return
        try:
            struct = build_structure(spot, a.strike_step, a.fly_lower_pct, a.fly_body_pct,
                                     a.fly_upper_pct, a.put_pct, a.diag_offset)
        except ValueError as e:
            logger.error(f"Structure invalid at spot {spot:.1f}: {e}")
            return

        specs = leg_specs(struct, front, back)
        chains = {front: self.helper.get_option_chain_df("NIFTY", front),
                  back: self.helper.get_option_chain_df("NIFTY", back)}
        prices, deltas = {}, {}
        for name, (_side, typ, strike, exp, _m) in specs.items():
            p, d = self._row(chains[exp], strike, typ)
            if p is None:
                logger.info(f"No live price for {name} {typ} {strike} ({exp}), skipping entry this poll.")
                return
            prices[name], deltas[name] = p, d

        debit = net_debit_points(prices)
        if a.max_net_debit is not None and debit > a.max_net_debit:
            logger.info(f"Net debit {debit:.1f} pts exceeds --max-net-debit {a.max_net_debit}, skipping.")
            return
        lot_size = self.lot_size
        unit = self.lots * lot_size
        max_loss_rs = max_loss_points(struct, debit) * unit
        logger.info(f"ENTRY | front={front} back={back} lots={self.lots} spot={spot:.1f} "
                    f"strikes={struct} debit={debit:.1f}pts max_loss=Rs {max_loss_rs:,.0f}")

        # Persist from BEFORE the first order: a crash mid-entry must leave a tracked (UNWINDING)
        # book that a restart flattens, never live legs with no record (a restart would re-enter
        # on top). Each leg is recorded before its order so an order that lands without us seeing
        # the reply is still tracked; a leg whose order never existed closes as "already flat".
        self.front, self.back = front, back
        self.entry_date, self.entry_spot = now.date().isoformat(), spot
        self.max_loss_rs = max_loss_rs
        self.realized_pnl, self.adjustments = 0.0, 0
        self.legs = {}
        self.status = "UNWINDING"
        self.last_alert = "Entry in progress"
        self.save_portfolio()

        failed = None
        for name in ENTRY_ORDER:
            side, typ, strike, exp, mult = specs[name]
            qty = mult * unit
            self.legs[name] = {"name": name, "side": side, "type": typ, "strike": strike,
                               "expiry": exp, "mult": mult, "entry_price": prices[name],
                               "last_price": prices[name], "last_delta": deltas[name]}
            self.save_portfolio()
            net_before = self._net_before(strike, exp, typ)
            oid = self._place(side, strike, exp, typ, qty)
            signed = qty if side == BUY else -qty
            ok = bool(oid) and self._confirm(strike, exp, typ, oid, signed, net_before)
            if oid and not ok and not self.dry_run and self.broker_name == "dhan":
                # Unconfirmed: stop it filling later behind our back; the leg stays tracked so
                # the rollback sizes against broker truth (0 if it never filled).
                try:
                    self.helper.cancel_order(oid)
                except Exception as e:
                    logger.warning(f"Could not cancel unconfirmed order {oid}: {e}")
            if not oid:
                self.legs.pop(name)          # nothing was placed for this leg
            elif ok:
                self.legs[name]["entry_price"] = self._fill_price(oid, prices[name])
            if not ok:
                failed = name
                break

        if failed and not self.legs:
            logger.error(f"Entry aborted at {failed}: nothing placed, staying flat (retry next poll).")
            self.front = self.back = self.entry_date = self.entry_spot = None
            self.max_loss_rs = 0.0
            self.status = "IDLE"
            self.save_portfolio()
            return
        if failed:
            self._alert(f"Entry failed at {failed}; unwinding {sorted(self.legs)}", logging.CRITICAL)
            self.exit_all("Entry rollback")
            return
        self.status = "ENTERED"
        self._alert(f"Entered {front}/{back}: {struct}, debit {debit:.1f} pts, {self.lots} lot(s)")
        self.save_portfolio()

    # ── monitoring ───────────────────────────────────────────────────────────
    def _mark(self) -> bool:
        """Refresh every leg's price/delta and totals. False (skip the tick) if any price is stale."""
        chains = self._chains()
        marks = {}
        for name, leg in self.legs.items():
            if not leg:
                continue
            p, d = self._row(chains.get(leg["expiry"]), leg["strike"], leg["type"])
            if p is None:
                logger.warning(f"Stale/missing price for {name} {leg['strike']}, skipping this tick.")
                return False
            marks[name] = (p, d)
        for name, (p, d) in marks.items():
            self.legs[name]["last_price"] = p
            if d is not None:
                self.legs[name]["last_delta"] = d
        unreal = sum(leg_pnl(l["side"], l["entry_price"], l["last_price"], self._leg_qty(l))
                     for l in self.legs.values() if l)
        self.total_pnl = self.realized_pnl + unreal
        self.net_delta = net_delta_per_lot({k: v for k, v in self.legs.items() if v})
        return True

    def adjust_roll_put_up(self) -> None:
        leg = self.legs.get("put_short")
        if not leg:
            return
        new_strike = leg["strike"] + self.args.adjust_step
        chain = self.helper.get_option_chain_df("NIFTY", leg["expiry"])
        new_price, new_delta = self._row(chain, new_strike, "PE")
        long_leg = self.legs.get("put_long")
        if new_price is None or (long_leg and new_strike <= long_leg["strike"]) or new_strike >= self.spot:
            logger.info(f"Adjustment skipped: PE {new_strike} unusable (price {new_price}, spot {self.spot}).")
            return
        logger.info(f"ADJUST | net delta {self.net_delta:.2f}/lot: rolling short PE {leg['strike']} -> {new_strike}")
        closed, fill = self._close_leg(leg)
        if not closed:
            self.last_alert = f"UNCONFIRMED close of PE {leg['strike']} during adjustment, retrying"
            self.save_portfolio()
            return
        close_px = fill if fill is not None else leg["last_price"]
        self.realized_pnl += leg_pnl(leg["side"], leg["entry_price"], close_px, self._leg_qty(leg))
        self.legs["put_short"] = None            # flat first, booked once
        self.adjustments += 1
        qty = leg["mult"] * self.lots * self.lot_size
        net_before = self._net_before(new_strike, leg["expiry"], "PE")
        oid = self._place(SELL, new_strike, leg["expiry"], "PE", qty)
        if oid and self._confirm(new_strike, leg["expiry"], "PE", oid, -qty, net_before):
            self.legs["put_short"] = {"name": "put_short", "side": SELL, "type": "PE", "strike": new_strike,
                                      "expiry": leg["expiry"], "mult": leg["mult"],
                                      "entry_price": self._fill_price(oid, new_price),
                                      "last_price": new_price, "last_delta": new_delta}
            self._alert(f"Adjusted: short PE {leg['strike']} -> {new_strike}; target now "
                        f"{self.args.adjusted_target}")
        else:
            self._alert(f"Adjustment re-sell of PE {new_strike} failed; short put left FLAT "
                        f"(long back put remains, defined risk)", logging.ERROR)
        self.save_portfolio()

    def monitor(self) -> None:
        a = self.args
        marked = self._mark()
        if marked:
            stop, target = self._stop_rs(), self._target_rs()
            if stop is not None and self.total_pnl <= -abs(stop):
                self.exit_all(f"Stop-loss: P&L {self.total_pnl:,.0f}")
                return
            if target is not None and self.total_pnl >= target:
                self.exit_all(f"Target: P&L {self.total_pnl:,.0f} >= {target:,.0f}")
                return
        # The time exit needs no price: a dead quote on one far-OTM leg must never trap the book.
        if self.front and time_exit_due(self._dte(self.front), datetime.now().strftime("%H:%M"),
                                        a.exit_dte, a.exit_time):
            self.exit_all(f"Time exit: {self._dte(self.front)} DTE to {self.front}")
            return
        if marked and self.spot > 0 and adjustment_due(
                self.net_delta, a.adjust_delta, self.adjustments, a.max_adjustments):
            self.adjust_roll_put_up()

    # ── exit ─────────────────────────────────────────────────────────────────
    def exit_all(self, reason: str) -> bool:
        """Close every tracked leg, shorts first. True only if all confirmed flat."""
        logger.info(f"EXIT ALL | {reason}")
        all_ok = True
        for name in EXIT_ORDER:
            leg = self.legs.get(name)
            if not leg:
                continue
            closed, fill = self._close_leg(leg)
            if not closed:
                all_ok = False
                continue
            px = fill if fill is not None else (leg.get("last_price") or leg["entry_price"])
            self.realized_pnl += leg_pnl(leg["side"], leg["entry_price"], px, self._leg_qty(leg))
            self.legs[name] = None
        if not all_ok:
            self.status = "FLATTENING"
            self._alert(f"{reason}: exit INCOMPLETE, retrying every poll", logging.CRITICAL)
            self.save_portfolio()
            return False
        self.cumulative_pnl += self.realized_pnl
        self._alert(f"{reason}. Cycle P&L {self.realized_pnl:,.0f} (gross of charges), "
                    f"cumulative {self.cumulative_pnl:,.0f}")
        self.last_cycle_expiry = self.front
        self.status, self.legs = "IDLE", {}
        self.front = self.back = self.entry_date = self.entry_spot = None
        self.max_loss_rs, self.realized_pnl, self.adjustments = 0.0, 0.0, 0
        self.total_pnl, self.net_delta = 0.0, 0.0
        self.save_portfolio()
        return True

    # ── main cycle ───────────────────────────────────────────────────────────
    def loop_once(self) -> None:
        self.market_open = bool(self.helper.is_market_open())
        if self.status in ("UNWINDING", "FLATTENING"):
            if self.market_open:
                self.exit_all(self.last_alert or "Retrying incomplete exit")
            return
        if self.status == "HALTED":
            return
        if not self.market_open:
            return
        self.spot = self._read_spot() or self.spot
        if self.status == "IDLE":
            self.attempt_entry()
        elif self.status == "ENTERED":
            self.monitor()

    def sleep_with_shutdown_check(self, seconds: float) -> bool:
        end = time.time() + seconds
        while time.time() < end:
            if check_shutdown_trigger(self.state_key):
                return False
            time.sleep(min(1.0, max(0.0, end - time.time())))
        return True

    def shutdown(self, why: str) -> None:
        if self.args.keep_on_stop and self.status != "IDLE":
            logger.info(f"{why}: --keep-on-stop set, leaving the position in place (restart reconciles).")
            self.save_portfolio()
            self.save_state("STOPPED")
            return
        if (self.status != "IDLE" and not self.dry_run
                and not (self.helper and self.helper.is_market_open())):
            # A MARGIN order sent after the close would be queued as an AMO for tomorrow.
            logger.critical(f"{why}: market closed, NOT flattening (orders would queue overnight). "
                            f"Position left in place; restart during market hours to manage it.")
            self.save_portfolio()
            self.save_state("STOPPED (POSITION LEFT OPEN - MARKET CLOSED)")
            return
        done = True
        if self.status != "IDLE":
            done = self.exit_all(f"{why}: flatten on stop")
        self.save_state("STOPPED" if done else "STOPPED (EXIT INCOMPLETE - VERIFY MANUALLY)")

    def run(self) -> None:
        dhan = get_dhan_client()
        if dhan is None:
            logger.error("Dhan client unavailable (run login.py).")
            self.save_state("ERROR")
            sys.exit(1)
        self.helper = DhanHelper(dhan)
        try:
            self.broker = ExecutionBroker.create(self.broker_name, self.helper,
                                                 underlying="NIFTY", log=logger.info)
        except ExecutionBrokerError as e:
            logger.error(f"Could not start {self.broker_name} execution: {e}")
            self.save_state("ERROR")
            sys.exit(1)
        self.lot_size = self.helper.get_lot_size("NIFTY")
        if self.lot_size <= 1:
            logger.error(f"Implausible NIFTY lot size {self.lot_size}.")
            sys.exit(1)
        if self.broker_name != "dhan":
            logger.warning(f"Broker is {self.broker_name}: no resting orders, exits are software-polled "
                           f"every {self.args.poll_interval}s.")
        self.load_portfolio()
        self.save_state()

        while True:
            if check_shutdown_trigger(self.state_key):
                self.shutdown("Shutdown requested")
                return
            try:
                self.loop_once()
            except Exception:
                logger.error(f"Loop error:\n{traceback.format_exc()}")
            self.save_state()
            if not self.sleep_with_shutdown_check(self.args.poll_interval):
                self.shutdown("Shutdown requested during sleep")
                return


def _hhmm(v: str) -> str:
    datetime.strptime(v, "%H:%M")
    return v


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Nifty Flyagonal: call BWB + put diagonal (positional, NOT VALIDATED).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=r"""
Examples:
  # Dry run (default)
  venv/bin/python strategies/flyagonal/nifty_flyagonal.py

  # Dry run, no adjustment rule, 20% stop of entry max loss
  venv/bin/python strategies/flyagonal/nifty_flyagonal.py --max-adjustments 0 --stop-loss 20%

  # Live, 1 lot
  venv/bin/python strategies/flyagonal/nifty_flyagonal.py --live --lots 1
""")
    p.add_argument("--live", action="store_true", default=False, help="place real orders (default: dry run)")
    p.add_argument("--broker", choices=["dhan", "zerodha", "kotak"], default="dhan",
                   help="execution broker (market data is always Dhan)")
    p.add_argument("--instance-id", default=None,
                   help="[A-Za-z0-9_-]{1,20}; isolates state/log files (run overlapping cycles)")
    p.add_argument("--lots", type=int, default=1, help="lots per structure (default 1)")
    p.add_argument("--max-lots", type=int, default=5, help="hard cap on --lots (default 5)")
    p.add_argument("--entry-dte-min", type=int, default=8, help="front expiry min calendar DTE (default 8)")
    p.add_argument("--entry-dte-max", type=int, default=10, help="front expiry max calendar DTE (default 10)")
    p.add_argument("--back-dte-min", type=int, default=15, help="back expiry min calendar DTE (default 15: weekly expiries are 7 days apart, so front 8 DTE gives back 15)")
    p.add_argument("--back-dte-max", type=int, default=20, help="back expiry max calendar DTE (default 20)")
    p.add_argument("--entry-weekday", type=int, default=None, help="0=Mon..6=Sun; default any day in the DTE window")
    p.add_argument("--entry-time", type=_hhmm, default="09:30", metavar="HH:MM", help="earliest entry (default 09:30)")
    p.add_argument("--strike-step", type=int, default=50, help="strike spacing in points (default 50)")
    p.add_argument("--fly-lower-pct", type=float, default=2.2, help="lower call vs spot, %% (default 2.2)")
    p.add_argument("--fly-body-pct", type=float, default=3.0, help="short-call body vs spot, %% (default 3.0)")
    p.add_argument("--fly-upper-pct", type=float, default=4.1, help="upper call vs spot, %% (default 4.1)")
    p.add_argument("--put-pct", type=float, default=3.0, help="short front put below spot, %% (default 3.0)")
    p.add_argument("--diag-offset", type=int, default=50, help="long back put below the short put, points (default 50)")
    p.add_argument("--max-net-debit", type=float, default=None, help="skip entry if net debit exceeds this, points")
    p.add_argument("--target-profit", default="10%", help="INR or NN%% of entry max loss (default 10%%)")
    p.add_argument("--adjusted-target", default="5%", help="target after an adjustment, INR or NN%% (default 5%%)")
    p.add_argument("--stop-loss", default=None, help="INR or NN%% of entry max loss (default: none, as in the source)")
    p.add_argument("--exit-dte", type=int, default=4, help="close when front DTE <= this (default 4)")
    p.add_argument("--exit-time", type=_hhmm, default="15:15", metavar="HH:MM", help="time exit on the exit-dte day (default 15:15)")
    p.add_argument("--max-adjustments", type=int, default=1, help="cap on put roll-ups per cycle; 0 disables (default 1)")
    p.add_argument("--adjust-delta", type=float, default=0.10, help="roll when net delta/lot <= -this (default 0.10)")
    p.add_argument("--adjust-step", type=int, default=50, help="points to roll the short put up (default 50)")
    p.add_argument("--max-cumulative-loss", type=float, default=None, help="INR; halt new entries once cumulative P&L <= -this")
    p.add_argument("--keep-on-stop", action="store_true", help="Stop leaves the position in place instead of flattening")
    p.add_argument("--force-reconcile", action="store_true", help="continue on restart despite a broker-qty mismatch")
    p.add_argument("--poll-interval", type=int, default=60, metavar="SECS", help="seconds between polls (default 60)")
    args = p.parse_args(argv)

    errors = []
    if args.instance_id and not re.match(r"^[A-Za-z0-9_-]{1,20}$", args.instance_id):
        errors.append("--instance-id must match [A-Za-z0-9_-]{1,20}")
    if not 1 <= args.lots <= args.max_lots:
        errors.append(f"--lots must be 1..--max-lots ({args.max_lots})")
    if not 0 < args.entry_dte_min <= args.entry_dte_max:
        errors.append("need 0 < --entry-dte-min <= --entry-dte-max")
    if args.entry_dte_min <= args.exit_dte:
        errors.append("--entry-dte-min must exceed --exit-dte or the position exits on entry")
    if args.back_dte_min <= args.entry_dte_max:
        errors.append("--back-dte-min must exceed --entry-dte-max")
    if args.back_dte_max < args.back_dte_min:
        errors.append("--back-dte-max must be >= --back-dte-min")
    if args.entry_weekday is not None and not 0 <= args.entry_weekday <= 6:
        errors.append("--entry-weekday must be 0..6")
    if args.adjust_step <= 0 or args.strike_step <= 0 or args.diag_offset <= 0:
        errors.append("--adjust-step, --strike-step, --diag-offset must be > 0")
    if args.poll_interval < 5:
        errors.append("--poll-interval must be >= 5")
    args.target_spec = args.adjusted_target_spec = args.stop_spec = None
    for attr, raw in (("target_spec", args.target_profit), ("adjusted_target_spec", args.adjusted_target),
                      ("stop_spec", args.stop_loss)):
        if raw is None:
            continue
        try:
            setattr(args, attr, parse_target_spec(raw))
        except ValueError as e:
            errors.append(str(e))
    try:
        build_structure(25000.0, args.strike_step, args.fly_lower_pct, args.fly_body_pct,
                        args.fly_upper_pct, args.put_pct, args.diag_offset)
    except ValueError as e:
        errors.append(f"strike shape invalid: {e}")
    for e in errors:
        logger.error(f"[CONFIG ERROR] {e}")
    if errors:
        sys.exit(1)
    return args


def main() -> None:
    args = parse_args()
    state_key = f"{STRATEGY_KEY_DEFAULT}_{args.instance_id}" if args.instance_id else STRATEGY_KEY_DEFAULT
    logger.info("=" * 60)
    logger.info("NIFTY FLYAGONAL (call BWB + put diagonal), NOT VALIDATED")
    logger.info(f"  Mode      : {'LIVE (real orders)' if args.live else 'DRY (paper)'}")
    logger.info(f"  State key : {state_key}   Broker: {args.broker}   Lots: {args.lots}")
    logger.info(f"  Entry     : DTE {args.entry_dte_min}-{args.entry_dte_max}, back {args.back_dte_min}-{args.back_dte_max}, "
                f"from {args.entry_time}")
    logger.info(f"  Exit      : target {args.target_profit}, stop {args.stop_loss}, "
                f"DTE<={args.exit_dte} @ {args.exit_time}")
    logger.info("=" * 60)
    strat = NiftyFlyagonal(args, state_key)
    try:
        strat.run()
    except KeyboardInterrupt:
        strat.shutdown("Interrupted")
        sys.exit(0)


if __name__ == "__main__":
    main()
