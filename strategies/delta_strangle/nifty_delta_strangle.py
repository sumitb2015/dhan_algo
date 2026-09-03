"""
Nifty Weekly Delta-Managed Short Strangle

Positional (multi-day carry) strangle sold on the "next" NIFTY weekly expiry —
i.e. the expiry AFTER the soonest one listed — every Wednesday, closed every
Tuesday (one week before that expiry), then re-entered the following Wednesday.

Entry (Wednesday, no open position):
  expiry = helper.get_expiries("NIFTY")[1]   (skip the soonest listed expiry)
  CE strike = closest-to-but-under --entry-delta (default 0.15) delta, OTM above spot
  PE strike = closest-to-but-under --entry-delta delta, OTM below spot
  Both legs picked INDEPENDENTLY by delta, then gated:
    - CE strike must be > PE strike (inversion guard)
    - min(ce_premium, pe_premium) / max(...) >= --premium-symmetry-min (default 0.80)
  Either gate failing skips this week's entry — no alternate-strike search, just
  retry on the next poll.
  Lot count is sized from margin: helper.get_multi_leg_margin_summary() for a
  1-lot combined SELL/SELL strangle, lots = floor(--target-capital / margin_per_lot),
  clamped to --min-lots and to available funds. --lots overrides this entirely.

Rolling (checked every --poll-interval seconds while a position is open, always
on the SAME expiry selected at entry — the expiry is never re-selected mid-week):
  abs(delta) >= --roll-up-delta (default 0.35)  -> leg has run too far ITM
  abs(delta) <  --roll-down-delta (default 0.08) -> leg has decayed too far OTM
  Either condition closes that leg and re-sells a fresh leg at --entry-delta on
  the same expiry. No premium-symmetry re-check on a roll (only at entry). After
  a roll, the CE>PE inversion guard is re-checked against the OTHER leg's current
  strike; a violation flattens BOTH legs and pauses new entries for 5 minutes
  (EMERGENCY_FLATTENED, per CLAUDE.md's documented inversion-guard convention).

Exit: both legs closed on --exit-weekday (default Tuesday) at/after --exit-time
(default 15:15 IST) — not the universal 15:17 intraday trigger, since this
strategy carries MARGIN product overnight and isn't racing broker EOD square-off.

Order product is MARGIN (overnight carry), NOT the ExecutionBroker default of
INTRADAY — every buy()/sell() call here passes product="MARGIN" explicitly.

Every buy-to-close is confirmed filled (helper.wait_for_fill on Dhan; polled
broker.get_owned_net_qty() on Zerodha/Kotak) before its leg is cleared, rolled,
or reused — an unconfirmed close leaves the leg tracked and the strategy in a
dedicated UNWINDING (naked leg from a failed entry) or FLATTENING (partial
exit_all) status, so a stuck close can never be papered over by opening a
fresh leg on top of it.

State survives restarts via debug/<state_key>_portfolio.json (expiry, strikes,
lots, lot size, SL order ids, roll counts) — reloaded before the loop starts;
an open position is resumed directly into monitoring, never blindly re-entered.

Usage (dry run by default — no real orders without --live):
    venv\\Scripts\\python.exe strategies/delta_strangle/nifty_delta_strangle.py
    venv\\Scripts\\python.exe strategies/delta_strangle/nifty_delta_strangle.py --live --lots 3
"""

import argparse
import json
import logging
import math
import os
import sys
import time
import traceback
from datetime import datetime, timedelta

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, PROJECT_ROOT)

from login import get_dhan_client                                      # noqa: E402
from lib.dhan_helper import DhanHelper                                 # noqa: E402
from lib.execution_broker import ExecutionBroker, ExecutionBrokerError  # noqa: E402
from lib.strategy_risk import resolve_exit_qty_broker                  # noqa: E402
from lib.strategy_state_helper import (                                # noqa: E402
    save_strategy_state, check_shutdown_trigger, instance_log_suffix,
)

# ── logging ──────────────────────────────────────────────────────────────────
DEBUG_DIR = os.path.join(PROJECT_ROOT, "debug")
LOG_DIR = os.path.join(DEBUG_DIR, "logs", "delta_strangle")
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

PORTFOLIO_VERSION = 1


def pick_leg(chain_df, prefix, target_delta):
    """Strike with delta magnitude closest-to-but-under target_delta on the given side.

    Returns (strike, premium, delta) or (None, None, None) if no strike in the
    chain has a qualifying delta (e.g. an unusually thin/extreme-vol chain).
    """
    col = f"{prefix}_delta"
    price_col = f"{prefix}_last_price"
    if col not in chain_df.columns or price_col not in chain_df.columns:
        return None, None, None
    df = chain_df[chain_df[col].notna() & (chain_df[col] != 0)].copy()
    if df.empty:
        return None, None, None
    df["abs_delta"] = df[col].abs()
    candidates = df[df["abs_delta"] <= target_delta]
    if candidates.empty:
        return None, None, None
    best = candidates.sort_values("abs_delta", ascending=False).iloc[0]
    try:
        strike = int(float(best.name))
        premium = float(best[price_col])
        delta = float(best[col])
    except Exception:
        return None, None, None
    return strike, premium, delta


class NiftyDeltaStrangle:
    def __init__(
        self,
        dry_run: bool = True,
        broker_name: str = "dhan",
        state_key: str = "nifty_delta_strangle",
        target_capital: float = 400_000.0,
        lots_override: int = None,
        min_lots: int = 1,
        entry_delta: float = 0.15,
        roll_up_delta: float = 0.35,
        roll_down_delta: float = 0.08,
        premium_symmetry_min: float = 0.80,
        entry_weekday: int = 2,   # Wednesday
        entry_time: str = "09:20",
        exit_weekday: int = 1,    # Tuesday
        exit_time: str = "15:15",
        poll_interval: int = 60,
        hard_sl_multiple: float = 3.0,
        no_hard_sl: bool = False,
        force_reconcile: bool = False,
    ):
        self.dry_run = dry_run
        self.broker_name = broker_name
        self.state_key = state_key
        self.target_capital = target_capital
        self.lots_override = lots_override
        self.min_lots = min_lots
        self.entry_delta = entry_delta
        self.roll_up_delta = roll_up_delta
        self.roll_down_delta = roll_down_delta
        self.premium_symmetry_min = premium_symmetry_min
        self.entry_weekday = entry_weekday
        self.entry_time = entry_time
        self.exit_weekday = exit_weekday
        self.exit_time = exit_time
        self.poll_interval = poll_interval
        self.hard_sl_multiple = hard_sl_multiple
        self.hard_sl_enabled = not no_hard_sl
        self.force_reconcile = force_reconcile

        self.helper = None
        self.broker = None
        self.lot_size = 0

        # Position state (persisted).
        # IDLE: flat. ENTERED: normal open position. UNWINDING: a naked leg left by a
        # failed second-leg entry, being closed. FLATTENING: exit_all() closed at least
        # one leg but not all — retrying the rest; monitor()'s refill logic never runs
        # in this status so a stuck leg can't be "fixed" by reopening the other side.
        self.status = "IDLE"
        self.expiry = None
        self.lots = 0
        self.entry_date = None
        self.legs = {"ce": None, "pe": None}   # each: {strike, entry_premium, entry_delta, sl_order_id, last_delta}
        self.roll_count = {"ce": 0, "pe": 0}
        self.last_alert = ""
        # Set after an emergency flatten (post-roll inversion). CLAUDE.md's documented
        # strangle inversion-guard convention is "emergency exit + 5-minute pause + fresh
        # cycle" — attempt_entry() honors this so a chain that's still misbehaving isn't
        # re-entered on the very next poll.
        self.cooldown_until = None

    # ── portfolio persistence ───────────────────────────────────────────────
    @property
    def portfolio_path(self) -> str:
        return os.path.join(DEBUG_DIR, f"{self.state_key}_portfolio.json")

    def load_portfolio(self) -> None:
        path = self.portfolio_path
        if not os.path.exists(path):
            logger.info(f"No existing portfolio at {path} — starting flat (IDLE)")
            return
        try:
            with open(path, "r") as f:
                data = json.load(f)
        except Exception as e:
            logger.error(f"FATAL: portfolio file {path} is unreadable ({e}). "
                         f"Fix or move it before restarting; refusing to trade blind.")
            raise

        self.status = data.get("status", "IDLE")
        self.expiry = data.get("expiry")
        self.lots = int(data.get("lots", 0) or 0)
        self.legs = data.get("legs", {"ce": None, "pe": None})
        self.roll_count = data.get("roll_count", {"ce": 0, "pe": 0})
        self.entry_date = data.get("entry_date")

        if self.status in ("ENTERED", "UNWINDING", "FLATTENING"):
            # Exit sizing (own_qty = lots * lot_size) must match what was actually sold
            # at entry, not whatever NSE's lot size happens to be at restart time — a
            # mid-week lot-size revision would otherwise silently corrupt exit qty math.
            # A fresh entry always re-fetches the live lot size in run(), before this
            # call, so this only overrides while an existing position is open.
            persisted_lot_size = data.get("lot_size")
            if persisted_lot_size:
                self.lot_size = int(persisted_lot_size)

        logger.info(f"Restored portfolio: status={self.status} expiry={self.expiry} "
                    f"lots={self.lots} lot_size={self.lot_size} "
                    f"ce={self.legs.get('ce')} pe={self.legs.get('pe')}")

        if self.status in ("ENTERED", "UNWINDING", "FLATTENING") and not self.dry_run:
            self._reconcile_against_broker()

    def save_portfolio(self) -> None:
        data = {
            "version": PORTFOLIO_VERSION,
            "state_key": self.state_key,
            "dry_run": self.dry_run,
            "status": self.status,
            "expiry": self.expiry,
            "lots": self.lots,
            "lot_size": self.lot_size,
            "entry_date": self.entry_date,
            "legs": self.legs,
            "roll_count": self.roll_count,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        }
        os.makedirs(DEBUG_DIR, exist_ok=True)
        tmp = self.portfolio_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, self.portfolio_path)

    def _reconcile_against_broker(self) -> None:
        """Diagnostic-only cross-check of reloaded legs against broker truth.
        Never used to size an exit — resolve_exit_qty_broker() owns that."""
        mismatch = False
        for side, leg in self.legs.items():
            if not leg or not leg.get("strike"):
                continue
            expected = -(self.lots * self.lot_size)
            try:
                net = self.broker.get_owned_net_qty(leg["strike"], self.expiry, side.upper())
            except Exception as e:
                logger.warning(f"Reconcile: could not read broker net for {side.upper()} "
                                f"{leg['strike']}: {e}")
                continue
            if net != expected:
                mismatch = True
                logger.warning(f"Reconcile MISMATCH: {side.upper()} {leg['strike']} "
                                f"({self.expiry}) — portfolio expects {expected}, broker shows {net}. "
                                f"Position may have been squared off manually while this process was down.")
        if mismatch and not self.force_reconcile:
            logger.error("Reconcile mismatch detected. Pass --force-reconcile to continue "
                          "anyway, or fix the position manually first. Refusing to start.")
            sys.exit(1)

    # ── dashboard state ──────────────────────────────────────────────────────
    def save_state(self) -> None:
        save_strategy_state(self.state_key, {
            "strategy": "Nifty Delta Strangle (Weekly)",
            "status": self.status,
            "dry_run": self.dry_run,
            "broker": self.broker_name,
            "expiry": self.expiry,
            "lots": self.lots,
            "lot_size": self.lot_size,
            "target_capital": self.target_capital,
            "entry_date": self.entry_date,
            "ce": self.legs.get("ce"),
            "pe": self.legs.get("pe"),
            "roll_count": self.roll_count,
            "entry_delta": self.entry_delta,
            "roll_up_delta": self.roll_up_delta,
            "roll_down_delta": self.roll_down_delta,
            "exit_weekday": self.exit_weekday,
            "exit_time": self.exit_time,
            "alert": self.last_alert,
        })

    # ── order placement (paper-aware) ────────────────────────────────────────
    def _place(self, side: str, strike: int, opt_type: str, qty: int):
        if self.dry_run:
            logger.info(f"  [PAPER] {side} {opt_type} {strike} qty={qty} exp={self.expiry}")
            return "PAPER"
        fn = self.broker.sell if side == "SELL" else self.broker.buy
        return fn(strike, self.expiry, opt_type, qty, product="MARGIN")

    def _resolve_close(self, side: str) -> tuple:
        """(qty, net_before) to buy-to-close this leg. qty is clamped by broker
        truth (live) or trusted at face value (dry run, where the broker has no
        paper position). net_before is the broker's net qty just before the
        close order, used by _confirm_close() to verify the fill actually landed."""
        leg = self.legs.get(side)
        if not leg or not leg.get("strike"):
            return 0, 0
        own_qty = self.lots * self.lot_size
        if self.dry_run:
            return own_qty, 0
        qty, net_before = resolve_exit_qty_broker(
            self.broker, leg["strike"], self.expiry, side.upper(), own_qty, "BUY", logger)
        return qty, net_before

    def _confirm_close(self, side: str, strike: int, oid, qty_closed: int, net_before: int) -> bool:
        """Block until a buy-to-close order is actually confirmed filled.

        A closing order's return value is just an order id — treating that as
        "closed" and moving on (clearing the leg, rolling into a new strike, or
        going flat) would leave a real short live and untracked the moment the
        order is rejected, partially filled, or still pending. Every caller that
        clears/overwrites a leg after a close MUST gate on this returning True.
        """
        if self.dry_run:
            return True
        if not oid:
            return False
        if self.broker_name == "dhan":
            return self.helper.wait_for_fill(oid, timeout=15)
        # Zerodha/Kotak have no generic wait_for_fill; poll the broker's own net
        # qty for this leg until it reflects the close. Comparing against
        # net_before + qty_closed (not a blind ==0) keeps this correct even
        # when another instance shares the same strike.
        expected_after = net_before + qty_closed
        deadline = time.time() + 15
        while time.time() < deadline:
            time.sleep(1)
            try:
                net_after = self.broker.get_owned_net_qty(strike, self.expiry, side.upper())
            except Exception:
                continue
            if net_after == expected_after:
                return True
        return False

    def _cancel_sl(self, side: str) -> None:
        leg = self.legs.get(side)
        if not leg or not leg.get("sl_order_id") or self.dry_run:
            return
        try:
            self.helper.cancel_order(leg["sl_order_id"])
        except Exception as e:
            logger.warning(f"Could not cancel SL order {leg['sl_order_id']} for {side.upper()}: {e}")

    def _place_hard_sl(self, side: str, strike: int, entry_premium: float, qty: int):
        if not self.hard_sl_enabled or self.dry_run or self.broker_name != "dhan":
            return None
        contract = self.helper.find_option("NIFTY", self.expiry, strike, side.upper())
        if not contract:
            logger.warning(f"Could not resolve {side.upper()} {strike} for hard-SL placement")
            return None
        trigger = entry_premium * self.hard_sl_multiple
        try:
            return self.helper.place_sl_market(
                str(contract["SECURITY_ID"]), qty, trigger, "BUY", product_type="MARGIN")
        except Exception as e:
            logger.warning(f"Hard-SL placement failed for {side.upper()} {strike}: {e}")
            return None

    # ── sizing ────────────────────────────────────────────────────────────────
    def _compute_lots(self, ce_strike: int, pe_strike: int) -> int:
        if self.lots_override:
            return self.lots_override
        try:
            scripts = self.helper.resolve_option_legs_to_margin_scripts(
                [
                    {"strike": ce_strike, "type": "CE", "side": "SELL", "qtyLots": 1, "price": 0.0},
                    {"strike": pe_strike, "type": "PE", "side": "SELL", "qtyLots": 1, "price": 0.0},
                ],
                underlying="NIFTY", expiry=self.expiry, product_type="MARGIN",
            )
            summary = self.helper.get_multi_leg_margin_summary(scripts)
        except Exception as e:
            logger.error(f"Margin sizing failed: {e}")
            return 0
        if not summary:
            logger.error("Margin summary call returned empty — cannot size position this poll.")
            return 0

        margin_per_lot = float(summary.get("final_margin", 0.0))
        available = float(summary.get("available_funds", 0.0))
        if margin_per_lot <= 0:
            logger.error(f"Invalid margin_per_lot ({margin_per_lot}) — cannot size position.")
            return 0

        lots = max(self.min_lots, math.floor(self.target_capital / margin_per_lot))
        while lots > self.min_lots and lots * margin_per_lot > available:
            lots -= 1
        if lots * margin_per_lot > available:
            logger.error(f"Even {self.min_lots} lot(s) needs Rs {lots * margin_per_lot:,.0f} "
                         f"margin but only Rs {available:,.0f} available. Skipping entry.")
            return 0
        logger.info(f"Sizing: margin/lot Rs {margin_per_lot:,.0f}, available Rs {available:,.0f}, "
                    f"target Rs {self.target_capital:,.0f} -> {lots} lot(s)")
        return lots

    # ── entry ────────────────────────────────────────────────────────────────
    def attempt_entry(self) -> None:
        now = datetime.now()
        if self.cooldown_until and now < self.cooldown_until:
            logger.info(f"In post-emergency-flatten cooldown until {self.cooldown_until:%H:%M:%S} — skipping.")
            return
        self.cooldown_until = None
        if now.weekday() != self.entry_weekday:
            return
        if not self.helper.is_market_open():
            return
        if now.strftime("%H:%M") < self.entry_time:
            return

        expiries = self.helper.get_expiries("NIFTY")
        if len(expiries) < 2:
            logger.warning(f"Only {len(expiries)} expiry(ies) listed — cannot skip to 'next' expiry yet.")
            return
        expiry = expiries[1]

        chain_df = self.helper.get_option_chain_df("NIFTY", expiry)
        if chain_df.empty:
            logger.warning("Empty option chain — retrying next poll.")
            return

        ce_strike, ce_premium, ce_delta = pick_leg(chain_df, "ce", self.entry_delta)
        pe_strike, pe_premium, pe_delta = pick_leg(chain_df, "pe", self.entry_delta)
        if ce_strike is None or pe_strike is None:
            logger.info(f"No strike qualifies under {self.entry_delta} delta on one side "
                        f"(CE={ce_strike}, PE={pe_strike}) — skipping this week, retry next poll.")
            return
        if ce_strike <= pe_strike:
            logger.error(f"Inverted strikes at entry: CE {ce_strike} <= PE {pe_strike}. Skipping.")
            return

        lo, hi = sorted([ce_premium, pe_premium])
        ratio = (lo / hi) if hi else 0.0
        if hi <= 0 or ratio < self.premium_symmetry_min:
            logger.warning(f"Premium symmetry gate failed: CE {ce_premium:.2f} / PE {pe_premium:.2f} "
                            f"(ratio {ratio:.2f} < {self.premium_symmetry_min}). "
                            f"Skipping entry this week; will retry next check.")
            return

        self.expiry = expiry
        lots = self._compute_lots(ce_strike, pe_strike)
        if lots <= 0:
            self.expiry = None
            return

        logger.info(f"ENTRY | expiry={expiry} lots={lots} lot_size={self.lot_size} | "
                    f"CE {ce_strike} (delta {ce_delta:.3f}, prem {ce_premium:.2f}) | "
                    f"PE {pe_strike} (delta {pe_delta:.3f}, prem {pe_premium:.2f})")

        qty = lots * self.lot_size
        ce_oid = self._place("SELL", ce_strike, "CE", qty)
        if not ce_oid:
            logger.error("CE leg placement failed — aborting entry, nothing else placed.")
            return
        pe_oid = self._place("SELL", pe_strike, "PE", qty)
        if not pe_oid:
            logger.critical(f"PE leg placement FAILED after CE leg was sold ({ce_strike}). "
                             f"Marking CE as an unwind-pending naked leg — NOT a normal position.")
            # Record the naked CE leg and switch to UNWINDING *before* attempting the
            # close, so a crash or a failed/unconfirmed close is never silently lost —
            # it stays tracked as an open leg rather than vanishing from state while
            # still live on the broker. UNWINDING is deliberately distinct from ENTERED:
            # loop_once() routes it to retry_unwind() only, so monitor()'s flat-leg
            # refill logic never mistakes the missing PE for a leg to re-sell.
            self.expiry = expiry
            self.lots = lots
            self.legs = {"ce": {"strike": ce_strike, "entry_premium": ce_premium,
                                 "entry_delta": ce_delta, "last_delta": ce_delta, "sl_order_id": None},
                         "pe": None}
            self.status = "UNWINDING"
            self.last_alert = f"PE leg failed after CE {ce_strike} sold — unwinding naked CE"
            self.save_portfolio()
            self.retry_unwind()
            return

        self.lots = lots
        self.entry_date = now.date().isoformat()
        ce_sl_id = self._place_hard_sl("ce", ce_strike, ce_premium, qty)
        pe_sl_id = self._place_hard_sl("pe", pe_strike, pe_premium, qty)
        self.legs = {
            "ce": {"strike": ce_strike, "entry_premium": ce_premium, "entry_delta": ce_delta,
                   "last_delta": ce_delta, "sl_order_id": ce_sl_id},
            "pe": {"strike": pe_strike, "entry_premium": pe_premium, "entry_delta": pe_delta,
                   "last_delta": pe_delta, "sl_order_id": pe_sl_id},
        }
        self.roll_count = {"ce": 0, "pe": 0}
        self.status = "ENTERED"
        self.last_alert = f"Entered {expiry} strangle: CE {ce_strike} / PE {pe_strike}, {lots} lot(s)"
        self.save_portfolio()

    # ── monitoring / rolling ─────────────────────────────────────────────────
    def roll_leg(self, side: str, chain_df) -> None:
        leg = self.legs[side]
        opt_type = side.upper()
        old_strike = leg["strike"]
        logger.info(f"ROLL {opt_type} {old_strike} (delta {leg.get('last_delta')}) — closing and re-selecting.")

        close_qty, net_before = self._resolve_close(side)
        if close_qty > 0:
            oid = self._place("BUY", old_strike, opt_type, close_qty)
            if not self._confirm_close(side, old_strike, oid, close_qty, net_before):
                # The old short is still live and untracked-risk if we proceed to sell a
                # NEW leg or clear this one now — leave it exactly as-is (still tracked
                # at old_strike) so the next poll's monitor() retries the same roll,
                # instead of doubling up on this side.
                logger.critical(f"Roll of {opt_type} {old_strike}: buy-to-close did NOT confirm "
                                 f"(order {oid}). Leaving leg tracked at {old_strike} — will retry "
                                 f"next poll rather than risk a second short on top of it.")
                self.last_alert = f"UNCONFIRMED close on {opt_type} {old_strike} during roll — retrying"
                self.save_portfolio()
                return
        self._cancel_sl(side)

        new_strike, new_premium, new_delta = pick_leg(chain_df, side, self.entry_delta)
        if new_strike is None:
            logger.error(f"No qualifying strike to roll {opt_type} into — leg left FLAT. "
                         f"Will retry re-filling it every poll.")
            self.legs[side] = None
            self.save_portfolio()
            return

        other_side = "pe" if side == "ce" else "ce"
        other_leg = self.legs.get(other_side)
        if other_leg and other_leg.get("strike"):
            other_strike = other_leg["strike"]
            inverted = (side == "ce" and new_strike <= other_strike) or \
                       (side == "pe" and new_strike >= other_strike)
            if inverted:
                logger.critical(f"Post-roll inversion: new {opt_type} {new_strike} vs "
                                 f"{other_side.upper()} {other_strike}. EMERGENCY FLATTEN.")
                self.legs[side] = None
                self.exit_all("EMERGENCY_FLATTENED — post-roll inversion")
                self.cooldown_until = datetime.now() + timedelta(minutes=5)
                return

        qty = self.lots * self.lot_size
        oid = self._place("SELL", new_strike, opt_type, qty)
        if not oid:
            logger.error(f"Failed to re-sell {opt_type} {new_strike} after roll — leg left FLAT.")
            self.legs[side] = None
            self.save_portfolio()
            return

        sl_id = self._place_hard_sl(side, new_strike, new_premium, qty)
        self.legs[side] = {"strike": new_strike, "entry_premium": new_premium,
                            "entry_delta": new_delta, "last_delta": new_delta, "sl_order_id": sl_id}
        self.roll_count[side] = self.roll_count.get(side, 0) + 1
        self.last_alert = f"Rolled {opt_type} {old_strike} -> {new_strike}"
        self.save_portfolio()

    def monitor(self) -> None:
        if not self.expiry:
            return
        chain_df = self.helper.get_option_chain_df("NIFTY", self.expiry)
        if chain_df.empty:
            logger.warning("Empty option chain during monitoring — skipping this poll.")
            return

        for side in ("ce", "pe"):
            # roll_leg() below can call exit_all()/EMERGENCY_FLATTEN mid-loop (post-roll
            # inversion on the FIRST side processed) or leave a close unconfirmed and
            # awaiting retry — either way self.status is no longer ENTERED and self.expiry/
            # self.lots may now be None/0. Stop rather than process the other side against
            # now-stale/nonexistent position state (e.g. selling qty=0*lot_size, or
            # resolving strikes against an expiry we've already gone flat on).
            if self.status != "ENTERED":
                return

            leg = self.legs.get(side)
            if not leg or not leg.get("strike"):
                # Leg was left flat by a failed roll — try to refill it now.
                new_strike, new_premium, new_delta = pick_leg(chain_df, side, self.entry_delta)
                if new_strike is None:
                    continue
                other_side = "pe" if side == "ce" else "ce"
                other_leg = self.legs.get(other_side)
                if other_leg and other_leg.get("strike"):
                    other_strike = other_leg["strike"]
                    inverted = (side == "ce" and new_strike <= other_strike) or \
                               (side == "pe" and new_strike >= other_strike)
                    if inverted:
                        continue
                qty = self.lots * self.lot_size
                oid = self._place("SELL", new_strike, side.upper(), qty)
                if oid:
                    sl_id = self._place_hard_sl(side, new_strike, new_premium, qty)
                    self.legs[side] = {"strike": new_strike, "entry_premium": new_premium,
                                        "entry_delta": new_delta, "last_delta": new_delta,
                                        "sl_order_id": sl_id}
                    self.roll_count[side] = self.roll_count.get(side, 0) + 1
                    self.save_portfolio()
                continue

            strike = leg["strike"]
            if float(strike) not in chain_df.index:
                logger.warning(f"{side.upper()} {strike} missing from current chain — skipping this poll.")
                continue
            row = chain_df.loc[float(strike)]
            delta = row.get(f"{side}_delta")
            if delta is None:
                continue
            abs_delta = abs(float(delta))
            leg["last_delta"] = float(delta)

            if abs_delta >= self.roll_up_delta or abs_delta < self.roll_down_delta:
                self.roll_leg(side, chain_df)

    # ── exit ─────────────────────────────────────────────────────────────────
    def exit_all(self, reason: str) -> None:
        logger.info(f"EXIT ALL | reason={reason}")
        all_confirmed = True
        for side in ("ce", "pe"):
            leg = self.legs.get(side)
            if not leg or not leg.get("strike"):
                continue
            qty, net_before = self._resolve_close(side)
            if qty > 0:
                oid = self._place("BUY", leg["strike"], side.upper(), qty)
                if not self._confirm_close(side, leg["strike"], oid, qty, net_before):
                    logger.critical(f"Exit-all: buy-to-close for {side.upper()} {leg['strike']} did "
                                     f"NOT confirm (order {oid}). Leaving that leg tracked so the "
                                     f"next poll retries it, rather than going flat while it's still live.")
                    all_confirmed = False
                    continue
            self._cancel_sl(side)
            self.legs[side] = None

        self.last_alert = reason
        if not all_confirmed:
            # FLATTENING is a dedicated status (distinct from ENTERED) precisely so
            # monitor()'s "leg is None -> refill it" logic can never run while a leg
            # here is still stuck open awaiting a retry — refilling the confirmed-closed
            # side here would recreate the very imbalance/inversion this exit was meant
            # to resolve, while the stuck side is still live. loop_once() routes
            # FLATTENING straight back into another exit_all() attempt, nothing else.
            self.status = "FLATTENING"
            self.save_portfolio()
            return

        self.status = "IDLE"
        self.expiry = None
        self.lots = 0
        self.entry_date = None
        self.roll_count = {"ce": 0, "pe": 0}
        self.save_portfolio()

    def check_scheduled_exit(self) -> None:
        now = datetime.now()
        if now.weekday() == self.exit_weekday and now.strftime("%H:%M") >= self.exit_time:
            self.exit_all("Scheduled Tuesday exit")

    def retry_unwind(self) -> None:
        """UNWINDING-only: keep trying to close the single naked leg left behind
        by a failed second-leg entry. Never touches the other (already-None) side."""
        side = "ce" if self.legs.get("ce") else ("pe" if self.legs.get("pe") else None)
        if side is None:
            logger.warning("retry_unwind() called with no naked leg tracked — going IDLE.")
            self.status = "IDLE"
            self.expiry = None
            self.lots = 0
            self.save_portfolio()
            return
        self.exit_all(self.last_alert or f"Unwinding naked {side.upper()}")
        if self.status == "IDLE":
            self.last_alert = f"Unwind of naked {side.upper()} confirmed flat."

    # ── main cycle ───────────────────────────────────────────────────────────
    def loop_once(self) -> None:
        if self.status == "IDLE":
            self.attempt_entry()
        elif self.status == "UNWINDING":
            self.retry_unwind()
        elif self.status == "FLATTENING":
            self.exit_all(self.last_alert or "Retrying incomplete exit")
        elif self.status == "ENTERED":
            self.monitor()
            if self.status == "ENTERED":   # monitor() may have emergency-flattened us
                self.check_scheduled_exit()

    def sleep_with_shutdown_check(self, seconds: float) -> bool:
        end = time.time() + seconds
        while time.time() < end:
            if check_shutdown_trigger(self.state_key):
                return False
            time.sleep(min(1.0, max(0.0, end - time.time())))
        return True

    def run(self) -> None:
        self.helper = DhanHelper(get_dhan_client())
        try:
            self.broker = ExecutionBroker.create(self.broker_name, self.helper,
                                                  underlying="NIFTY", log=logger.info)
        except ExecutionBrokerError as e:
            logger.error(f"Could not start {self.broker_name} execution: {e}")
            sys.exit(1)

        self.lot_size = self.helper.get_lot_size("NIFTY")
        if self.broker_name != "dhan":
            logger.warning(f"Broker is {self.broker_name} — no resting hard-SL backstop is "
                            f"possible (software-managed only). --poll-interval "
                            f"({self.poll_interval}s) is the real protection window.")

        self.load_portfolio()
        self.save_state()

        while True:
            if check_shutdown_trigger(self.state_key):
                logger.info("Shutdown requested — exiting cleanly "
                            "(open legs, if any, are preserved and will be reconciled on restart)")
                self.save_state()
                return
            try:
                self.loop_once()
            except Exception:
                logger.error(f"Loop error:\n{traceback.format_exc()}")
            self.save_state()
            if not self.sleep_with_shutdown_check(self.poll_interval):
                logger.info("Shutdown requested during sleep — exiting cleanly")
                self.save_state()
                return


def main() -> None:
    p = argparse.ArgumentParser(
        description="Nifty weekly delta-managed short strangle (positional).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=r"""
Examples:
  # Dry run (default), auto-sized from margin against a Rs 4L target
  venv\Scripts\python.exe strategies/delta_strangle/nifty_delta_strangle.py

  # Live, explicit 1-lot size (recommended for a first live run)
  venv\Scripts\python.exe strategies/delta_strangle/nifty_delta_strangle.py --live --lots 1

  # Live, auto-sized, via Zerodha execution
  venv\Scripts\python.exe strategies/delta_strangle/nifty_delta_strangle.py --live --broker zerodha
""",
    )
    p.add_argument("--live", action="store_true", default=False,
                   help="place real orders (default: dry run)")
    p.add_argument("--broker", choices=["dhan", "zerodha", "kotak"], default="dhan",
                   help="execution broker for order placement (market data is always Dhan)")
    p.add_argument("--instance-id", default=None,
                   help="run a second independent instance under its own state files")
    p.add_argument("--target-capital", type=float, default=400_000.0,
                   help="INR capital to deploy when auto-sizing (default 400000; ignored if --lots given)")
    p.add_argument("--lots", type=int, default=None,
                   help="fixed lot count — bypasses margin-based sizing entirely")
    p.add_argument("--min-lots", type=int, default=1)
    p.add_argument("--entry-delta", type=float, default=0.15)
    p.add_argument("--roll-up-delta", type=float, default=0.35)
    p.add_argument("--roll-down-delta", type=float, default=0.08)
    p.add_argument("--premium-symmetry-min", type=float, default=0.80)
    p.add_argument("--entry-weekday", type=int, default=2, help="0=Mon .. 6=Sun (default 2=Wed)")
    p.add_argument("--entry-time", default="09:20", metavar="HH:MM",
                   help="no entry attempted before this time on the entry weekday")
    p.add_argument("--exit-weekday", type=int, default=1, help="0=Mon .. 6=Sun (default 1=Tue)")
    p.add_argument("--exit-time", default="15:15", metavar="HH:MM")
    p.add_argument("--poll-interval", type=int, default=60, metavar="SECS")
    p.add_argument("--hard-sl-multiple", type=float, default=3.0,
                   help="Dhan-only backstop SL-M trigger = entry_premium * multiple")
    p.add_argument("--no-hard-sl", action="store_true", help="disable the backstop SL-M order")
    p.add_argument("--force-reconcile", action="store_true",
                   help="continue even if reloaded legs don't match broker net qty on restart")
    args = p.parse_args()

    state_key = f"nifty_delta_strangle_{args.instance_id}" if args.instance_id else "nifty_delta_strangle"

    logger.info("=" * 60)
    logger.info("NIFTY DELTA-MANAGED SHORT STRANGLE")
    logger.info(f"  Mode        : {'LIVE (real orders)' if args.live else 'PAPER (dry run)'}")
    logger.info(f"  State key   : {state_key}")
    logger.info(f"  Broker      : {args.broker}")
    logger.info(f"  Sizing      : {'fixed ' + str(args.lots) + ' lot(s)' if args.lots else f'auto (target Rs {args.target_capital:,.0f})'}")
    logger.info(f"  Entry delta : {args.entry_delta}  Roll up/down: {args.roll_up_delta}/{args.roll_down_delta}")
    logger.info(f"  Schedule    : entry weekday {args.entry_weekday} @ {args.entry_time}, exit weekday {args.exit_weekday} @ {args.exit_time}")
    logger.info("=" * 60)

    strat = NiftyDeltaStrangle(
        dry_run=not args.live,
        broker_name=args.broker,
        state_key=state_key,
        target_capital=args.target_capital,
        lots_override=args.lots,
        min_lots=args.min_lots,
        entry_delta=args.entry_delta,
        roll_up_delta=args.roll_up_delta,
        roll_down_delta=args.roll_down_delta,
        premium_symmetry_min=args.premium_symmetry_min,
        entry_weekday=args.entry_weekday,
        entry_time=args.entry_time,
        exit_weekday=args.exit_weekday,
        exit_time=args.exit_time,
        poll_interval=args.poll_interval,
        hard_sl_multiple=args.hard_sl_multiple,
        no_hard_sl=args.no_hard_sl,
        force_reconcile=args.force_reconcile,
    )
    try:
        strat.run()
    except KeyboardInterrupt:
        logger.info("Interrupted — portfolio is saved; positions are NOT exited")
        strat.save_portfolio()
        strat.save_state()
        sys.exit(0)


if __name__ == "__main__":
    main()
