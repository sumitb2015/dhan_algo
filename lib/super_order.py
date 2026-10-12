"""Pure rules for Dhan Super Orders (entry + resting target + stop-loss + optional trail).

Mirror of rs_dashboard/lib/superOrder.ts - keep the two in step. UNCONFIRMED against a
live account (written without docs access): verify with one minimal order first.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

SUPER_PRODUCTS = {"INTRADAY", "MARGIN", "CNC"}
SUPER_SEGMENTS = {"NSE_EQ", "BSE_EQ", "NSE_FNO", "BSE_FNO", "MCX_COMM"}
SUPER_LEGS = ("ENTRY_LEG", "TARGET_LEG", "STOP_LOSS_LEG")
SUPER_MAX_QTY = 3750

_MODIFY_FIELDS = {
    "ENTRY_LEG": ("quantity", "price", "targetPrice", "stopLossPrice", "trailingJump"),
    "TARGET_LEG": ("targetPrice",),
    "STOP_LOSS_LEG": ("stopLossPrice", "trailingJump"),
}


def _pos(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0


def validate_super_order(*, security_id: Any, exchange_segment: str, side: str, product_type: str,
                         quantity: int, target_price: float, stop_loss_price: float,
                         order_type: str = "LIMIT", price: Optional[float] = None,
                         trailing_jump: float = 0, ref_price: Optional[float] = None) -> Optional[str]:
    """Error string, or None when acceptable. ref_price is only used to validate a MARKET entry."""
    if not str(security_id).isdigit():
        return "security_id must be a numeric id"
    if exchange_segment not in SUPER_SEGMENTS:
        return f"Unsupported exchange_segment: {exchange_segment}"
    if product_type not in SUPER_PRODUCTS:
        return f"Unsupported product_type: {product_type} (expected {sorted(SUPER_PRODUCTS)})"
    side = str(side).upper()
    if side not in ("BUY", "SELL"):
        return f"Invalid side: {side}"
    if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity <= 0:
        return f"Invalid quantity: {quantity} (positive integer required)"
    if quantity > SUPER_MAX_QTY:
        return f"Quantity {quantity} exceeds the super-order cap of {SUPER_MAX_QTY}"
    ot = str(order_type).upper()
    if ot not in ("LIMIT", "MARKET"):
        return f"Invalid order_type: {order_type}"
    entry = price if ot == "LIMIT" else ref_price
    if not _pos(entry):
        return "LIMIT entry needs a positive price" if ot == "LIMIT" else "MARKET entry needs ref_price (current LTP) to validate target/stop"
    if not _pos(target_price):
        return f"Invalid target_price: {target_price}"
    if not _pos(stop_loss_price):
        return f"Invalid stop_loss_price: {stop_loss_price}"
    if side == "BUY" and not (stop_loss_price < entry < target_price):
        return f"BUY needs stop < entry < target (got {stop_loss_price} / {entry} / {target_price})"
    if side == "SELL" and not (target_price < entry < stop_loss_price):
        return f"SELL needs target < entry < stop (got {target_price} / {entry} / {stop_loss_price})"
    if not isinstance(trailing_jump, (int, float)) or trailing_jump < 0:
        return f"Invalid trailing_jump: {trailing_jump}"
    if trailing_jump > 0 and trailing_jump >= abs(entry - stop_loss_price):
        return f"trailing_jump {trailing_jump} must be smaller than the entry-to-stop distance {abs(entry - stop_loss_price)}"
    return None


def validate_modify(leg_name: str, **fields: Any) -> Optional[str]:
    if leg_name not in _MODIFY_FIELDS:
        return f"Invalid leg_name: {leg_name}"
    given = {k: v for k, v in fields.items() if v is not None}
    if not given:
        return "Nothing to modify"
    bad = [k for k in given if k not in _MODIFY_FIELDS[leg_name]]
    if bad:
        return f"{leg_name} cannot change {', '.join(bad)}"
    for k, v in given.items():
        if not isinstance(v, (int, float)) or isinstance(v, bool) or (v < 0 if k == "trailingJump" else v <= 0):
            return f"Invalid {k}: {v}"
    if "quantity" in given and (not isinstance(given["quantity"], int) or given["quantity"] > SUPER_MAX_QTY):
        return f"Invalid quantity: {given['quantity']}"
    return None


def build_place_payload(client_id: str, correlation_id: str, *, security_id: Any, exchange_segment: str,
                        side: str, product_type: str, quantity: int, target_price: float,
                        stop_loss_price: float, order_type: str = "LIMIT",
                        price: Optional[float] = None, trailing_jump: float = 0) -> Dict[str, Any]:
    ot = str(order_type).upper()
    return {
        "dhanClientId": client_id,
        "correlationId": correlation_id,
        "transactionType": str(side).upper(),
        "exchangeSegment": exchange_segment,
        "productType": product_type,
        "orderType": ot,
        "securityId": str(security_id),
        "quantity": quantity,
        "price": price if ot == "LIMIT" else 0,
        "targetPrice": target_price,
        "stopLossPrice": stop_loss_price,
        "trailingJump": trailing_jump or 0,
    }
