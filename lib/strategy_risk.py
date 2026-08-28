"""Shared risk / exit helpers for live strategies.

The Dhan account nets every position by security ID. Two strategy instances short
of the same strike therefore share ONE broker position, so sizing an exit from
`helper.get_net_quantity()` makes whichever instance exits first flatten the other
one's leg too. On 2026-07-30 that cost real money: an instance holding 2 lots
(130 qty) placed a 260-qty buy-to-close and squared off a sibling strategy's
straddle leg, which then found itself flat while still tracking a live position.

`resolve_exit_qty()` is the correct primitive: exit what THIS strategy opened,
clamped by what the broker actually still shows in our direction.
"""

import logging

logger = logging.getLogger(__name__)


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
