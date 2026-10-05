"""Quote validity, field extraction and batched LTPs."""
from typing import Callable, Dict, NamedTuple, Optional, Tuple


class QuoteFields(NamedTuple):
    """Unpacks like the legacy 5-tuple: security_id, ltp, expiry, lot_size, symbol."""
    security_id: Optional[int]
    ltp: float
    expiry: Optional[str]
    lot_size: Optional[int]
    symbol: Optional[str]


def _price(quote: dict) -> float:
    return float(quote.get("last_price", 0) or quote.get("LTP", 0) or 0)


def is_quote_invalid(quote, strict: bool = False) -> bool:
    """True when a helper.option() quote must not be traded on: missing, or a zero price.

    strict=True also rejects anything that is not the CONTRACT_INFO shape (the chain-fallback
    format has no security id to order with). The default is lenient: a non-CONTRACT_INFO dict
    passes through, as the spread strategies always allowed.
    """
    if not quote:
        return True
    if isinstance(quote, dict) and "CONTRACT_INFO" in quote:
        return _price(quote) == 0
    return bool(strict)


def extract_quote_fields(quote, default_lot_size: Optional[int] = None, default_expiry: Optional[str] = None,
                         default_symbol: Optional[str] = None) -> QuoteFields:
    """Pull (security_id, ltp, expiry, lot_size, symbol) out of a helper.option() quote.

    A missing or unrecognised quote gives QuoteFields(None, 0.0, None, default_lot_size, None);
    callers test `security_id is None` / `ltp <= 0` and skip the tick, never act on a zero price.
    """
    if not quote or not isinstance(quote, dict) or "CONTRACT_INFO" not in quote:
        return QuoteFields(None, 0.0, None, default_lot_size, None)
    ci = quote["CONTRACT_INFO"]
    lot = ci.get("LOT_SIZE", default_lot_size)
    return QuoteFields(
        int(ci["SECURITY_ID"]),
        _price(quote),
        ci.get("SM_EXPIRY_DATE") or default_expiry,
        int(lot) if lot is not None else None,
        ci.get("SYMBOL_NAME", default_symbol),
    )


def extract_flat_chain_fields(quote, option_type: str, default_lot_size=None, default_expiry=None,
                              default_symbol=None, lot_lookup: Optional[Callable[[str], Optional[dict]]] = None
                              ) -> Optional[QuoteFields]:
    """Fields from a FLAT option-chain row (a DataFrame row's to_dict()), or None if it has no security id.

    Keys tried: `<ce|pe>_security_id` then `security_id`; `<ce|pe>_last_price` then `last_price`.
    `lot_lookup(security_id_str)` (e.g. `lambda s: helper.get_security_id(symbol=s)`) may refine the lot
    size from the master list; any failure keeps `default_lot_size`. The expiry and symbol are the
    defaults, since a chain row carries neither.
    """
    ot = option_type.lower()
    sid = quote.get(f"{ot}_security_id") or quote.get("security_id")
    price = quote.get(f"{ot}_last_price") or quote.get("last_price", 0.0)
    if not sid:
        return None
    lot_size = default_lot_size
    if lot_lookup is not None:
        try:
            sec = lot_lookup(str(int(sid)))
            if sec:
                lot_size = int(sec.get("LOT_SIZE", default_lot_size))
        except Exception:
            pass
    return QuoteFields(int(sid), float(price), default_expiry, lot_size, default_symbol)


def fetch_named_ltps(helper, legs: Dict[str, Tuple[str, object]]) -> Dict[str, float]:
    """One batched LTP call for several legs, returned by name (0.0 when a price is missing).

        px = fetch_named_ltps(helper, {"ce": ("NSE_FNO", ce_id), "pe": ("NSE_FNO", pe_id),
                                       "spot": ("IDX_I", "13")})
        if min(px.values()) <= 0: continue        # stale tick, skip

    helper.get_ltps() serves from the WebSocket and makes at most one REST call, which keeps the
    loop inside the ~1 req/s account-wide quote limit.
    """
    ltps = helper.get_ltps([(seg, sid) for seg, sid in legs.values()])
    return {name: float(ltps.get(str(sid), 0.0) or 0.0) for name, (_seg, sid) in legs.items()}
