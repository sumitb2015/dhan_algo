"""Shared risk / exit helpers for live strategies.

The Dhan account nets every position by security ID. Two strategy instances short
of the same strike therefore share ONE broker position, so sizing an exit from
`helper.get_net_quantity()` makes whichever instance exits first flatten the other
one's leg too. On 2026-07-30 that cost real money: an instance holding 2 lots
(130 qty) placed a 260-qty buy-to-close and squared off a sibling strategy's
straddle leg, which then found itself flat while still tracking a live position.

`resolve_exit_qty()` is the correct primitive: exit what THIS strategy opened,
clamped by what the broker actually still shows in our direction.

That incident's own follow-up review flagged an open weakness: `resolve_exit_qty()`
only protects the EXITING instance. The VICTIM instance — the one whose leg just got
flattened by someone else's exit (a sibling strategy, or a manual square-off from the
dashboard's exit-all/pnl-exit/scalper terminals) — has no way to notice mid-loop that
its tracked leg no longer exists at the broker. It keeps running against phantom
internal state until its own next exit attempt happens to get clamped to 0.
`detect_phantom_leg()` / `detect_phantom_leg_broker()` are that missing check: a
periodic (not per-tick) call from the strategy's own loop, reusing the exact same
broker-truth lookup `resolve_exit_qty()` already trusts, that tells the strategy "the
broker no longer shows this leg open — stop believing you hold it." It never places or
sizes an order; it only corrects the strategy's own belief to match broker truth.
"""

import logging

logger = logging.getLogger(__name__)

# How often a strategy's main loop should call detect_phantom_leg(_broker) — it's a
# real broker API call, so every 1s tick would be wasteful; every 30s catches drift
# quickly without adding meaningful load. Strategies check `time.time() - last >=
# PHANTOM_CHECK_INTERVAL_SEC`, matching the existing time-based throttle idiom already
# used for periodic logging in these files (not a tick-count modulo).
PHANTOM_CHECK_INTERVAL_SEC = 30


def resolve_exit_qty(helper, security_id, own_qty, side, log=None):
    """Quantity to trade to close THIS strategy's leg — never the whole account net.

    Args:
        helper: DhanHelper instance.
        security_id: Security ID of the leg being closed.
        own_qty: Quantity this strategy believes it holds (lots * lot_size).
        side: "BUY" to close a short leg, "SELL" to close a long leg.
        log: Optional logger for the strategy (falls back to this module's).

    Returns:
        (qty, net_qty) where qty is the quantity to trade (0 = nothing to do) and
        net_qty is the raw broker net, for logging/diagnostics.
    """
    _log = log or logger
    side = str(side).upper()

    own_qty = int(own_qty or 0)
    if own_qty <= 0:
        return 0, 0

    try:
        net_qty = int(helper.get_net_quantity(str(security_id)))
    except Exception as e:
        _log.error(f"resolve_exit_qty: net quantity lookup failed for {security_id}: {e}")
        return 0, 0

    # Quantity available to close in our direction.
    available = -net_qty if side == "BUY" else net_qty
    if available <= 0:
        _log.info(
            f"Leg {security_id} already flat or reversed (broker net {net_qty}, "
            f"own {own_qty}). Skipping {side.lower()}-to-close."
        )
        return 0, net_qty

    qty = min(own_qty, available)
    if qty < own_qty:
        _log.warning(
            f"Leg {security_id}: broker shows only {available} qty available but this "
            f"strategy tracks {own_qty}. Exiting {qty} — the rest was closed elsewhere "
            f"(another instance, manual square-off, or broker auto-square-off)."
        )
    return qty, net_qty


def resolve_exit_qty_broker(broker, strike, expiry, opt_type, own_qty, side, log=None):
    """Like resolve_exit_qty(), but sized against an ExecutionBroker's own
    position truth instead of DhanHelper.get_net_quantity(). Used by
    strategies wired for broker-selectable execution (lib/execution_broker.py):
    on Kotak/Zerodha this reads that broker's own positions_rows(), so two
    instances sharing the SAME non-Dhan account are protected by the same
    "exit only what I opened" invariant that already covers Dhan.

    Args:
        broker: ExecutionBroker instance.
        strike, expiry, opt_type: the leg being closed.
        own_qty: quantity this strategy believes it holds (lots * lot_size).
        side: "BUY" to close a short leg, "SELL" to close a long leg.
        log: optional logger for the strategy (falls back to this module's).

    Returns:
        (qty, net_qty) where qty is the quantity to trade (0 = nothing to do)
        and net_qty is the raw broker net, for logging/diagnostics.
    """
    _log = log or logger
    side = str(side).upper()

    own_qty = int(own_qty or 0)
    if own_qty <= 0:
        return 0, 0

    try:
        net_qty = int(broker.get_owned_net_qty(strike, expiry, opt_type))
    except Exception as e:
        _log.error(f"resolve_exit_qty_broker: net quantity lookup failed for "
                   f"{opt_type} {strike} ({expiry}): {e}")
        return 0, 0

    available = -net_qty if side == "BUY" else net_qty
    if available <= 0:
        _log.info(
            f"Leg {opt_type} {strike} ({expiry}) already flat or reversed "
            f"(broker net {net_qty}, own {own_qty}). Skipping {side.lower()}-to-close."
        )
        return 0, net_qty

    qty = min(own_qty, available)
    if qty < own_qty:
        _log.warning(
            f"Leg {opt_type} {strike} ({expiry}): broker shows only {available} qty "
            f"available but this strategy tracks {own_qty}. Exiting {qty} — the rest "
            f"was closed elsewhere (another instance, manual square-off, or broker "
            f"auto-square-off)."
        )
    return qty, net_qty


def detect_phantom_leg(helper, security_id, own_qty, side, log=None):
    """True if this strategy still believes it holds `own_qty` of `security_id` but
    the broker no longer shows it available in `side`'s direction — i.e. the leg was
    closed elsewhere (a sibling instance's exit or a manual dashboard square-off) and
    this strategy's internal state is now phantom.

    Call this periodically from the main loop (not every tick — it's a real API call,
    the same one resolve_exit_qty() makes at exit time), while the strategy still
    believes the leg is open. Never places or sizes an order — the caller's job on a
    True result is only to correct its own state (mark the leg inactive, zero its
    tracked qty) so downstream logic already gated on that flag stops acting on a
    position that no longer exists.
    """
    _log = log or logger
    if int(own_qty or 0) <= 0:
        return False
    side = str(side).upper()
    try:
        net_qty = int(helper.get_net_quantity(str(security_id)))
    except Exception as e:
        # Fails closed like resolve_exit_qty() — an API hiccup must never be read as
        # "confirmed gone" and clear real tracked state. Only a successful lookup
        # that actually shows the leg flat/reversed counts as phantom.
        _log.error(f"detect_phantom_leg: net quantity lookup failed for {security_id}: {e}")
        return False
    available = -net_qty if side == "BUY" else net_qty
    return available <= 0


def detect_phantom_leg_broker(broker, strike, expiry, opt_type, own_qty, side, log=None):
    """Like detect_phantom_leg(), sourced from an ExecutionBroker instead of
    DhanHelper — for strategies wired for broker-selectable execution."""
    _log = log or logger
    if int(own_qty or 0) <= 0:
        return False
    side = str(side).upper()
    try:
        net_qty = int(broker.get_owned_net_qty(strike, expiry, opt_type))
    except Exception as e:
        _log.error(f"detect_phantom_leg_broker: net quantity lookup failed for "
                   f"{opt_type} {strike} ({expiry}): {e}")
        return False
    available = -net_qty if side == "BUY" else net_qty
    return available <= 0
