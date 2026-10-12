"""Pure rules for Dhan Super Orders (entry + resting target + stop-loss + optional trail).

Mirror of rs_dashboard/lib/superOrder.ts - keep the two in step. UNCONFIRMED against a
live account (written without docs access): verify with one minimal order first.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

SUPER_PRODUCTS = {"INTRADAY", "MARGIN", "CNC"}
# Derivatives only: equity is excluded so a super order cannot bypass equity-order's rupee cap / no-shorting rules.
SUPER_SEGMENTS = {"NSE_FNO", "BSE_FNO", "MCX_COMM"}
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


def validate_modify(leg_name: str, order_type: Optional[str] = None, **fields: Any) -> Optional[str]:
    if leg_name not in _MODIFY_FIELDS:
        return f"Invalid leg_name: {leg_name}"
    if leg_name == "ENTRY_LEG" and str(order_type).upper() not in ("LIMIT", "MARKET"):
        return "ENTRY_LEG modify needs order_type LIMIT or MARKET"
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
                        price: Optional[float] = None, trailing_jump: float = 0,
                        ref_price: Optional[float] = None) -> Dict[str, Any]:
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
        # Dhan's SDK refuses price 0, so a MARKET entry carries the reference price.
        "price": price if ot == "LIMIT" else ref_price,
        "targetPrice": target_price,
        "stopLossPrice": stop_loss_price,
        "trailingJump": trailing_jump or 0,
    }


def check_list_shape(rows: Any, order_id: str, correlation_id: str, security_id: str) -> list:
    """
    Compare a real GET /super/orders payload with what this repo's code assumes of it. Returns
    [(ok, message), ...]. Used by scripts/tools/super_order_smoke.py against a live account, and unit-tested
    here with canned rows. Every assumption listed is one the code actually relies on:
      - rows are dicts carrying orderId                      (route reconcile, legsToCancel)
      - top-level securityId matches the order's contract    (legsToCancel: a row without it is skipped)
      - correlationId is echoed                              (unknown-outcome reconcile after a timeout)
      - legDetails is a list of {legName, orderStatus}       (which legs are still live)
    """
    out: list = []
    if not isinstance(rows, list):
        return [(False, f"list response is {type(rows).__name__}, expected a list of rows")]
    row = next((r for r in rows if isinstance(r, dict) and str(r.get("orderId", "")) == str(order_id)), None)
    if row is None:
        return [(False, f"order {order_id} not present in GET /super/orders ({len(rows)} rows)")]
    out.append((True, f"row found; keys: {sorted(row.keys())}"))
    out.append((str(row.get("securityId", "")) == str(security_id),
                f"top-level securityId = {row.get('securityId')!r} (expected {security_id!r})"))
    out.append((str(row.get("correlationId", "")) == str(correlation_id),
                f"correlationId = {row.get('correlationId')!r} (expected {correlation_id!r})"))
    legs = row.get("legDetails")
    if not isinstance(legs, list) or not legs:
        out.append((False, f"legDetails = {legs!r}, expected a non-empty list"))
        return out
    names = [str(l.get("legName", "")).upper() for l in legs if isinstance(l, dict)]
    out.append((all(n in SUPER_LEGS for n in names) and len(names) == len(legs),
                f"leg names = {names} (expected members of {list(SUPER_LEGS)})"))
    statuses = {str(l.get("legName")): l.get("orderStatus") for l in legs if isinstance(l, dict)}
    out.append((all(s is not None for s in statuses.values()), f"leg statuses = {statuses}"))
    return out
