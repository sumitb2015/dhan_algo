"""Recovery Reweight — after a Harvest-family short leg stops out, flip it to a
directional long option one strike further OTM, betting the stop-out marks the
start of a real trend rather than noise to fade.

Source: Nilesh Kadam's "Recovery" logic (Trading with Groww, 2026-08-29) — sell
ATM call+put, and when one leg's stop-loss hits, buy a fresh OTM option on that
same side instead of walking away. The untouched opposite short leg keeps
running unchanged.

This module is opt-in plumbing only: a strategy calls enter_recovery_leg() from
its own stop-loss-hit handler. It places one order and hands back what it did —
it does not poll, does not manage the position, and does not know the caller's
state-file shape. The calling strategy still owns tracking/exiting the recovery
leg exactly like it tracks/exits every other leg it holds (its own SL, its own
state-file field, its own EOD square-off).

Deliberately NOT wired into any strategy yet — see the "Hedged Overnight Fly" /
"Recovery Reweight" write-up. Wiring this into a live strategy's real
order-placement path is a separate, explicit step.
"""

import logging

logger = logging.getLogger(__name__)


def next_otm_strike(strike: float, opt_type: str, strike_step: float) -> float:
    """One strike further OTM than `strike`, in the direction away from the money.

    CE: further OTM = higher strike. PE: further OTM = lower strike.

    Args:
        strike: the stopped-out short leg's strike.
        opt_type: 'CE' or 'PE' — same side as the stopped leg.
        strike_step: the underlying's exchange strike interval (e.g. 50 for
            NIFTY). Callers already hardcode this per-underlying elsewhere in
            the codebase (see nifty_advanced_imbalance.py) — not re-derived here.
    """
    opt_type = str(opt_type).upper()
    if opt_type == 'CE':
        return strike + strike_step
    if opt_type == 'PE':
        return strike - strike_step
    raise ValueError(f"Unknown opt_type: {opt_type!r} (expected 'CE' or 'PE')")


def recovery_stop_price(entry_price: float, sl_pct: float = 0.30) -> float:
    """Stop-loss price for the recovery leg — a % *below* entry.

    The recovery leg is a long option, so it loses value on a stall/reversal,
    not on staying flat — the opposite sign from the short leg's own stop.
    """
    return round(entry_price * (1 - sl_pct), 2)


def enter_recovery_leg(broker, underlying, expiry, stopped_strike, opt_type, qty,
                       strike_step, product='INTRADAY', log=None):
    """Buy a fresh long option one strike further OTM than a just-stopped-out
    short leg.

    Args:
        broker: an ExecutionBroker instance (lib/execution_broker.py) — dhan is
            a pass-through, so this works unchanged for Zerodha/Kotak too.
        underlying, expiry: as passed to broker.buy().
        stopped_strike: strike of the short leg whose stop-loss just hit.
        opt_type: 'CE' or 'PE' — same side as the stopped leg.
        qty: quantity to buy (lots * lot_size). Sized to match the stopped
            leg's own quantity by convention — same exposure the loss was
            booked on, not a fresh sizing decision.
        strike_step: the underlying's exchange strike interval.
        product: order product type, forwarded to broker.buy().
        log: optional logger (falls back to this module's).

    Returns:
        {'strike', 'expiry', 'opt_type', 'qty', 'order_id'} on success, or None
        if the recovery strike could not be resolved or the order failed.
        Placing the order is all this does — the caller must track and exit
        this leg itself, the same way it already tracks every other leg.
    """
    _log = log or logger
    try:
        recovery_strike = next_otm_strike(stopped_strike, opt_type, strike_step)
    except ValueError as e:
        _log.error(f"Recovery Reweight: {e}")
        return None

    order_id = broker.buy(recovery_strike, expiry, opt_type, qty, product=product)
    if not order_id:
        _log.error(
            f"Recovery Reweight: failed to buy {opt_type} {recovery_strike} "
            f"({expiry}) — recovery leg NOT opened, stopped leg stays flat."
        )
        return None

    _log.info(
        f"Recovery Reweight: bought {opt_type} {recovery_strike} qty={qty} "
        f"(stopped leg was {opt_type} {stopped_strike}) order_id={order_id}"
    )
    return {
        'strike': recovery_strike,
        'expiry': expiry,
        'opt_type': opt_type,
        'qty': qty,
        'order_id': order_id,
    }
