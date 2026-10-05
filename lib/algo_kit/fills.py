"""Confirmed fill prices."""
import logging

logger = logging.getLogger(__name__)

PAPER_ORDER_ID = "PAPER"


def read_order_fill_price(helper, order_id, fallback: float, log=None, raise_errors: bool = False,
                          paper_id=PAPER_ORDER_ID) -> float:
    """Average fill price off the order record WITHOUT waiting, or `fallback`.

    For callers that already confirmed the fill by another route (put_condor confirms first, then
    reads the price). Dhan order ids only: a Zerodha/Kotak order id is meaningless to the Dhan helper.

    raise_errors=False (default) turns a failed order lookup into the fallback price: the fill is
    already confirmed, so carrying on with the expected price beats raising past the bookkeeping that
    tracks a live leg. Pass True to propagate the exception, which is what several older strategies did.
    paper_id: an order id that means "paper fill, nothing to read" (None to disable the shortcut).
    """
    if not order_id or (paper_id is not None and order_id == paper_id):
        return fallback
    log = log or logger
    try:
        order = helper.get_order_by_id(order_id) or {}
        px = float(order.get("averageTradedPrice", 0.0) or order.get("avgFilledPrice", 0.0)
                   or order.get("price", 0.0))
    except Exception as e:
        if raise_errors:
            raise
        log.warning(f"Could not read fill price for {order_id}: {e}")
        return fallback
    if px > 0:
        log.info(f"Order {order_id} execution price confirmed: {px:.2f}")
        return px
    return fallback


def confirmed_fill_price(helper, order_id, fallback: float, timeout: int = 5, log=None,
                         raise_errors: bool = False, paper_id=PAPER_ORDER_ID) -> float:
    """Wait for the fill, then return its average price, or `fallback` if it cannot be confirmed.

    helper.wait_for_fill() returns a BOOL, not a price. Booking that bool as the entry price put a
    Rs 1 entry on the books and tripped the stop instantly (466e225), so the price is read off the
    order record. `fallback` is the LTP you expected; a paper/empty id returns it untouched.
    Dhan order ids only: for Zerodha/Kotak, confirm via that broker's own net position instead and
    do not call this (the Dhan helper would wait `timeout` seconds on an id it has never seen).
    `raise_errors` and `paper_id` are as for read_order_fill_price.
    """
    if not order_id or (paper_id is not None and order_id == paper_id):
        return fallback
    if helper.wait_for_fill(order_id, timeout=timeout):
        return read_order_fill_price(helper, order_id, fallback, log=log, raise_errors=raise_errors,
                                     paper_id=paper_id)
    return fallback
