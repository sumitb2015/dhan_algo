"""Multi-leg option execution: all-or-nothing entry with rollback, and a close that never lies.

Every multi-leg strategy used to carry its own copy of this logic, and it is where the money has been lost:
an order that failed and was walked past, an exit sized off the wrong quantity, a leg dropped from tracking
before its close was confirmed. LegExecutor holds the careful version (put_condor's) in one place.

Legs are plain dicts so existing strategies keep their own shape. A leg needs: side ("BUY"/"SELL"), opt_type,
strike, expiry, qty, avg_price; `id` (the Dhan security id) is carried through untouched.

    ex = LegExecutor(broker, helper, broker_name, product="MARGIN", dry_run=dry, ltp_fn=lambda leg: ltp(leg["id"]))

    res = ex.open_all(specs, checkpoint=lambda legs: self.save_position(legs))
    if res.failed:                      # nothing, or a partly built book, was unwound for you
        book(res.unwound)               # realised P&L of the legs it had to close
        if res.stuck: self.status = "UNWINDING"; self.legs = res.stuck      # a leg could not be closed: retry
        return

    out = ex.close_all(self.legs, on_closed=lambda name, leg, px, qty: book_and_persist(name, leg, px, qty))
    if not out.all_closed: self.status = "FLATTENING"                       # remaining legs stay tracked

Rules it enforces (each exists because of a past loss or near miss):
  * every order call is checked: a falsy order id means stop and undo, never log-and-continue
  * a fill is confirmed with confirm_order_fill (Dhan status, or the broker's own net for Zerodha/Kotak)
  * an unconfirmed Dhan order is cancelled; only a REJECTED one is known to have filled nothing
  * `checkpoint` runs BEFORE each order with that leg already tracked, so a crash mid-entry leaves a tracked,
    restartable book and never live legs with no record
  * exits are sized by resolve_exit_qty_broker (exit what THIS strategy opened, clamped by broker truth)
  * a leg is "flat" only if a direct broker read succeeds; a failed lookup keeps it tracked
  * shorts close before hedges, and a hedge is held while any short remains
"""
import logging
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

from lib.strategy_risk import resolve_exit_qty_broker

from .confirm import confirm_order_fill
from .fills import PAPER_ORDER_ID, read_order_fill_price

logger = logging.getLogger(__name__)

BUY, SELL = "BUY", "SELL"


def leg_pnl(side: str, entry_price: float, exit_price: float, qty: int) -> float:
    """Rupee P&L of one leg: a short gains when the premium falls, a long when it rises."""
    return (entry_price - exit_price) * qty if side == SELL else (exit_price - entry_price) * qty


@dataclass
class CloseResult:
    confirmed: bool
    exit_price: float = 0.0
    qty_closed: int = 0          # may be less than asked (broker clamp) or 0 (broker already flat)


@dataclass
class ExitResult:
    all_closed: bool
    closed: List[Tuple[str, dict, float, int]] = field(default_factory=list)   # (name, leg, exit_price, qty_closed)
    remaining: Dict[str, dict] = field(default_factory=dict)                   # legs still tracked


@dataclass
class OpenResult:
    opened: Dict[str, dict] = field(default_factory=dict)      # every leg confirmed filled (success only)
    failed: Optional[str] = None                               # name of the leg that failed, else None
    unwound: List[Tuple[str, dict, float, int]] = field(default_factory=list)  # legs closed during rollback
    stuck: Dict[str, dict] = field(default_factory=dict)       # legs rollback could not close: still tracked

    @property
    def ok(self) -> bool:
        return self.failed is None

    @property
    def flat(self) -> bool:
        """Nothing is left at the broker that this entry created (only meaningful after a failure)."""
        return not self.stuck


class LegExecutor:
    def __init__(self, broker, helper, broker_name: str, product: str, dry_run: bool = False,
                 ltp_fn: Optional[Callable[[dict], float]] = None, log=None, confirm_timeout: int = 15,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.time):
        self.broker, self.helper, self.broker_name = broker, helper, broker_name
        self.product, self.dry_run, self.ltp_fn = product, dry_run, ltp_fn
        self.log = log or logger
        self.confirm_timeout, self._sleep, self._clock = confirm_timeout, sleep, clock

    # ── primitives ──────────────────────────────────────────────────────────────────────────────────

    def place(self, side: str, leg: dict, qty: int):
        """Order id, PAPER_ORDER_ID in a paper run, or None if the order failed (the caller must undo)."""
        if self.dry_run:
            return PAPER_ORDER_ID
        fn = self.broker.buy if side == BUY else self.broker.sell
        try:
            return fn(leg["strike"], leg["expiry"], leg["opt_type"], qty, product=self.product)
        except Exception as e:
            self.log.error(f"{side} {leg['opt_type']} {leg['strike']} order raised: {e}")
            return None

    def _net_now(self, leg: dict) -> int:
        """Broker net before an order, needed only to confirm a non-Dhan order (Dhan confirms by status)."""
        if self.dry_run or self.broker_name == "dhan":
            return 0
        try:
            return int(self.broker.get_owned_net_qty(leg["strike"], leg["expiry"], leg["opt_type"]))
        except Exception:
            return 0

    def _confirm(self, leg: dict, oid, signed_qty: int, net_before: int, timeout: Optional[int] = None) -> bool:
        return confirm_order_fill(
            self.helper, self.broker, self.broker_name, oid, leg["strike"], leg["expiry"], leg["opt_type"],
            signed_qty, net_before, dry_run=self.dry_run, timeout=timeout or self.confirm_timeout,
            sleep=self._sleep, clock=self._clock, log=self.log)

    def fill_price(self, oid, fallback: float) -> float:
        """The real average fill (Dhan only), else the price you expected. Never waits: confirm first."""
        if self.dry_run or self.broker_name != "dhan" or not oid:
            return fallback
        return read_order_fill_price(self.helper, oid, fallback, log=self.log, paper_id=PAPER_ORDER_ID)

    # ── entry ───────────────────────────────────────────────────────────────────────────────────────

    def open_leg(self, side: str, leg: dict) -> Tuple[bool, object]:
        """Place and confirm one leg. Returns (confirmed, oid); oid is None when nothing can have filled."""
        net_before = self._net_now(leg)
        oid = self.place(side, leg, leg["qty"])
        signed = leg["qty"] if side == BUY else -leg["qty"]
        ok = bool(oid) and self._confirm(leg, oid, signed, net_before)
        if oid and not ok and not self.dry_run and self.broker_name == "dhan":
            try:
                self.helper.cancel_order(oid)
            except Exception as e:
                self.log.warning(f"Could not cancel unconfirmed order {oid}: {e}")
            if self.helper.get_order_status(oid) == "REJECTED":
                oid = None                    # definitely nothing filled; any other status may have filled
        return ok, oid

    def open_all(self, specs: List[dict], checkpoint: Optional[Callable[[Dict[str, dict]], None]] = None,
                 rollback: bool = True) -> OpenResult:
        """Open legs in the order given (buy the protective legs first, so exposure is never a naked short).

        `specs` are leg dicts with a "name" key plus the leg fields; avg_price is the expected (quote) price
        and becomes the real fill price once confirmed. `checkpoint(tracked_legs)` is called before each order
        and after each leg resolves. On a failure, with rollback=True, the legs already placed (and the
        uncertain one, which may have filled) are closed; read .unwound and .stuck.
        """
        tracked: Dict[str, dict] = {}
        failed = None
        for spec in specs:
            leg = {k: v for k, v in spec.items() if k != "name"}
            name = spec["name"]
            tracked[name] = leg
            if checkpoint:
                checkpoint(tracked)           # BEFORE the order: a crash now leaves a tracked book
            ok, oid = self.open_leg(leg["side"], leg)
            if not oid:
                tracked.pop(name)             # nothing was placed or it was rejected
            elif ok:
                leg["avg_price"] = self.fill_price(oid, leg["avg_price"])
            if checkpoint:
                checkpoint(tracked)
            if not ok:
                failed = name
                break
        if failed is None:
            return OpenResult(opened=tracked)

        self.log.critical(f"Entry failed at {failed}; {len(tracked)} leg(s) tracked "
                          f"({'unwinding them' if rollback else 'left for the caller'}).")
        if not rollback:
            return OpenResult(failed=failed, stuck=dict(tracked))
        ex = self.close_all(tracked)
        return OpenResult(failed=failed, unwound=ex.closed, stuck=ex.remaining)

    # ── restart ─────────────────────────────────────────────────────────────────────────────────────

    def reconcile(self, legs: Dict[str, dict], shortfall_only: bool = True) -> List[str]:
        """Cross-check tracked legs against the broker after a restart. Returns the mismatches (empty = ok).

        Diagnostic only: it never sizes an exit (close_leg does that off broker truth). With
        shortfall_only=True a mismatch is only "the broker holds LESS than we track", because a sibling
        instance on the same strike legitimately adds to the broker's net; shortfall_only=False demands an
        exact match. A leg whose position cannot be read is skipped, not called a mismatch. Skip reconcile
        while the book is UNWINDING/FLATTENING: a tracked leg may never have been placed, and close_leg
        already calls a missing leg flat.
        """
        if self.dry_run:
            return []
        problems = []
        for name, leg in legs.items():
            if not leg:
                continue
            expected = -leg["qty"] if leg["side"] == SELL else leg["qty"]
            try:
                net = int(self.broker.get_owned_net_qty(leg["strike"], leg["expiry"], leg["opt_type"]))
            except Exception as e:
                self.log.warning(f"Reconcile: could not read {name} {leg['opt_type']} {leg['strike']}: {e}")
                continue
            short = (net > expected) if leg["side"] == SELL else (net < expected)
            if (shortfall_only and short) or (not shortfall_only and net != expected):
                problems.append(f"{name} {leg['opt_type']} {leg['strike']}: tracked {expected}, broker {net}")
        return problems

    # ── exit ────────────────────────────────────────────────────────────────────────────────────────

    def close_leg(self, leg: dict, qty: Optional[int] = None, name: str = "") -> CloseResult:
        """Close up to `qty` (default: all tracked) of one leg. confirmed=False keeps the leg tracked.

        confirmed with qty_closed < qty (the broker clamp: a sibling or a manual square-off already closed
        part) or 0 (already flat) is still confirmed; the caller books only what this call actually closed.
        """
        qty = leg["qty"] if qty is None else qty
        label = f"{name} {leg['opt_type']} {leg['strike']}".strip()
        ltp = float(self.ltp_fn(leg) or 0.0) if self.ltp_fn else 0.0
        if self.dry_run:
            if ltp <= 0:
                self.log.warning(f"[PAPER] no quote for {label}; close deferred.")
                return CloseResult(False)
            return CloseResult(True, ltp, qty)
        close_side = SELL if leg["side"] == BUY else BUY
        try:
            to_close, net_before = resolve_exit_qty_broker(
                self.broker, leg["strike"], leg["expiry"], leg["opt_type"], qty, close_side, self.log)
            if to_close <= 0:
                # resolve_exit_qty_broker also returns 0 when the lookup itself failed: only call the leg flat
                # if a direct read succeeds.
                try:
                    self.broker.get_owned_net_qty(leg["strike"], leg["expiry"], leg["opt_type"])
                except Exception as e:
                    self.log.critical(f"Cannot verify {label} is flat ({e}); leg stays tracked.")
                    return CloseResult(False)
                return CloseResult(True, leg["avg_price"], 0)
            oid = self.place(close_side, leg, to_close)
            signed = to_close if close_side == BUY else -to_close
            if not self._confirm(leg, oid, signed, net_before):
                self.log.critical(f"{label} close NOT confirmed (order {oid}); leg stays tracked, retry next tick.")
                return CloseResult(False)
            return CloseResult(True, self.fill_price(oid, ltp if ltp > 0 else leg["avg_price"]), to_close)
        except Exception as e:
            self.log.error(f"Close {label} error: {e}")
            return CloseResult(False)

    def close_all(self, legs: Dict[str, dict],
                  on_closed: Optional[Callable[[str, dict, float, int], None]] = None) -> ExitResult:
        """Close every leg. Shorts first; a protective (BUY) leg is held while any short is still open.

        Does not mutate `legs`. `on_closed(name, leg, exit_price, qty_closed)` runs right after each confirmed
        close, so the caller can book P&L, unsubscribe and persist per leg (a crash between legs then loses
        nothing). all_closed is True only when every leg is confirmed closed.
        """
        remaining = {n: l for n, l in legs.items() if l}
        closed: List[Tuple[str, dict, float, int]] = []

        def run(side: str) -> None:
            for name in [n for n, l in remaining.items() if l["side"] == side]:
                leg = remaining[name]
                res = self.close_leg(leg, name=name)
                if not res.confirmed:
                    continue
                if res.qty_closed < leg["qty"]:
                    self.log.warning(f"{name}: closed {res.qty_closed} of tracked {leg['qty']}; the rest was already "
                                     "closed elsewhere and its P&L is not booked here.")
                closed.append((name, leg, res.exit_price, res.qty_closed))
                del remaining[name]
                if on_closed:
                    on_closed(name, leg, res.exit_price, res.qty_closed)

        run(SELL)
        if not any(l["side"] == SELL for l in remaining.values()):
            run(BUY)                          # hedges only once no short is left
        return ExitResult(all_closed=not remaining, closed=closed, remaining=remaining)
