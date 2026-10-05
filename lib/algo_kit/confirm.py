"""Broker-aware order confirmation.

helper.wait_for_fill() polls DHAN order status, so it can only confirm a Dhan order id. With
--broker zerodha|kotak the order id belongs to that broker; asking Dhan about it can only time out
and report "not filled", which strands a leg that did close (the strategy keeps tracking it and never
reaches flat). For a non-Dhan broker the truth is that broker's own net position moving by the
order's signed quantity.
"""
import logging
import time
from typing import Callable

logger = logging.getLogger(__name__)


def confirm_order_fill(helper, broker, broker_name: str, order_id, strike, expiry, opt_type,
                       signed_qty: int, net_before: int, dry_run: bool = False, timeout: int = 15,
                       poll_s: float = 1.0, sleep: Callable[[float], None] = time.sleep,
                       clock: Callable[[], float] = time.time, log=None) -> bool:
    """True only when the order is confirmed filled.

    dry_run: always True (paper fills). Missing order id: False.
    Dhan: helper.wait_for_fill(order_id, timeout).
    Zerodha/Kotak: poll broker.get_owned_net_qty(strike, expiry, opt_type) until it equals
    net_before + signed_qty (BUY positive, SELL negative), or `timeout` seconds pass. Read
    `net_before` BEFORE placing the order (resolve_exit_qty_broker returns it as its second value).
    """
    if dry_run:
        return True
    if not order_id:
        return False
    if broker_name == "dhan":
        return bool(helper.wait_for_fill(order_id, timeout=timeout))
    log = log or logger
    expected = net_before + signed_qty
    deadline = clock() + timeout
    while clock() < deadline:
        sleep(poll_s)
        try:
            if broker.get_owned_net_qty(strike, expiry, opt_type) == expected:
                return True
        except Exception as e:
            log.warning(f"net-position confirm read failed: {e}")
    return False
