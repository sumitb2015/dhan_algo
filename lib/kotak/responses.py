"""
Kotak Neo response-shape helpers.

Kotak's REST responses have two traps that every caller hits, so they are
centralised here rather than re-derived per call site:

  1. **"No data" is error-shaped.** positions() / order_report() / trade_report()
     do NOT return {"data": []} when there is nothing to report — they return
     {"stat": "Not_Ok", "stCode": 5203, "errMsg": "No Data"}. Reading that as a
     failure is dangerous, not just noisy: the copy-trade margin gate would treat
     an unknown position book as "no positions held" and misclassify an exit as
     an entry, which is exactly the case the never-gate-an-exit rule exists for.
  2. **Order ids and errors live at two different depths.** The id is at
     `nOrdNo` or `data.nOrdNo`; the error at `errMsg` or `emsg`, top-level or
     nested.

Every function returns `(value, error)` and never collapses a failed call into
an empty list — callers must branch on `error is not None` and decide explicitly
which way to fail. (Same contract as lib/zerodha/margin.py.)
"""
from typing import List, Optional, Tuple

# Kotak's "nothing to report" code, returned in place of an empty data list.
NO_DATA_STCODE = 5203
# Session died (expired/invalid tokens). Distinct from any ordinary rejection:
# retrying is pointless until the session is re-established.
UNAUTHORIZED_STCODE = 100008
# Illiquid strike rejecting a MARKET order: "Last Traded Price (LTP) not
# available for this instrument. Please try placing a limit order".
NO_LTP_STCODE = 1041


def confirmed_empty(res) -> bool:
    """True when Kotak positively reported "nothing here" (vs. an actual failure)."""
    return isinstance(res, dict) and res.get('stat') == 'Not_Ok' and res.get('stCode') == NO_DATA_STCODE


def st_code(res) -> Optional[int]:
    """The stCode of a response, at either depth, or None."""
    if not isinstance(res, dict):
        return None
    code = res.get('stCode')
    if code is None and isinstance(res.get('data'), dict):
        code = res['data'].get('stCode')
    try:
        return int(code) if code is not None else None
    except (TypeError, ValueError):
        return None


def is_unauthorized(res) -> bool:
    """Has the session expired? Callers should re-login rather than retry."""
    return st_code(res) == UNAUTHORIZED_STCODE


def error_message(res) -> Optional[str]:
    """A readable error from a response, or None if it looks OK.

    Treats confirmed-empty as OK — it is a valid answer, not a failure.
    """
    if not isinstance(res, dict):
        return f'unexpected response type: {type(res).__name__}'
    if confirmed_empty(res):
        return None
    if res.get('error'):
        errs = res['error']
        if isinstance(errs, list):
            return '; '.join(str(e.get('message', e)) if isinstance(e, dict) else str(e) for e in errs)
        return str(errs)
    data = res.get('data') if isinstance(res.get('data'), dict) else {}
    msg = res.get('errMsg') or res.get('emsg') or data.get('errMsg') or data.get('emsg')
    if msg:
        return str(msg)
    if res.get('stat') == 'Not_Ok':
        return f'Not_Ok (stCode {st_code(res)})'
    return None


def unwrap_list(res) -> Tuple[Optional[List[dict]], Optional[str]]:
    """Pull the row list out of a positions/orders/trades response.

    Returns ([], None) for a confirmed-empty book and (None, error) for a real
    failure. The caller MUST distinguish these — see the module docstring.
    """
    if confirmed_empty(res):
        return [], None
    err = error_message(res)
    if err:
        return None, err
    if not isinstance(res, dict):
        return None, f'unexpected response type: {type(res).__name__}'
    rows = res.get('data')
    if rows is None:
        return [], None
    if not isinstance(rows, list):
        return None, f'unexpected data type: {type(rows).__name__}'
    return rows, None


def order_id_of(res) -> Optional[str]:
    """The broker order number from a place_order response, at either depth."""
    if not isinstance(res, dict):
        return None
    data = res.get('data') if isinstance(res.get('data'), dict) else {}
    order_id = res.get('nOrdNo') or data.get('nOrdNo')
    return str(order_id) if order_id else None


# ── order status ─────────────────────────────────────────────────────
#
# Kotak accepts an order synchronously (`stat: Ok` + `nOrdNo`) and lets RMS
# reject it in the order book a second or three later. The bridge's margin
# top-up hedge is only ever reached from a DETECTED rejection, so misreading a
# not-yet-resolved order as accepted silently desyncs the child and skips the
# hedge — which is exactly what happened on 2026-08-21.
#
# Statuses are therefore classified into three buckets and an explicit
# "unknown", never a boolean. Anything not positively rejected AND not
# positively accepted must stay `pending` so the caller keeps looking rather
# than concluding either way.
_REJECTED_STATUSES = {
    'REJECTED', 'REJECT', 'REJ', 'CANCELLED', 'CANCELED', 'CAN',
}
_ACCEPTED_STATUSES = {
    'OPEN', 'COMPLETE', 'COMPLETED', 'TRADED', 'EXECUTED', 'FILLED',
    'PARTIALLY FILLED', 'PART TRADED', 'MODIFIED', 'TRIGGER PENDING',
    'AFTER MARKET ORDER REQ RECEIVED',
}
_PENDING_STATUSES = {
    '', 'PUT ORDER REQ RECEIVED', 'VALIDATION PENDING', 'OPEN PENDING',
    'MODIFY PENDING', 'CANCEL PENDING', 'MODIFY VALIDATION PENDING',
    'PENDING',
}


def order_status_of(row) -> str:
    """The normalised (upper, single-spaced) order status of an order-book row."""
    if not isinstance(row, dict):
        return ''
    raw = row.get('ordSt') or row.get('ordStatus') or row.get('status') or ''
    return ' '.join(str(raw).upper().split())


def classify_order_status(status: str) -> str:
    """'rejected' | 'accepted' | 'pending' | 'unknown' for a normalised status.

    `unknown` is deliberately distinct from `pending`: an unrecognised status
    must never be re-placed (that would double a live position) but also must
    never be silently treated as accepted.
    """
    st = ' '.join(str(status or '').upper().split())
    if st in _REJECTED_STATUSES:
        return 'rejected'
    if st in _ACCEPTED_STATUSES:
        return 'accepted'
    if st in _PENDING_STATUSES:
        return 'pending'
    return 'unknown'


def rejection_reason(row) -> str:
    """The broker's stated reason for rejecting an order-book row."""
    if not isinstance(row, dict):
        return ''
    for key in ('rejRsn', 'ordRejRsn', 'rejReason', 'errMsg', 'emsg', 'rejectionReason'):
        val = row.get(key)
        if val:
            return str(val)
    return f'order status {order_status_of(row)}'


def filled_qty_of(row) -> int:
    """How much of an order-book row actually traded.

    Matters for CANCELLED rows: the exchange can cancel the remainder of a
    MARKET order that already partly filled, and treating that as a whole-order
    rejection would re-place the filled part on top of itself.
    """
    if not isinstance(row, dict):
        return 0
    for key in ('fldQty', 'filledQty', 'filled_qty', 'tradedQuantity'):
        val = row.get(key)
        if val in (None, ''):
            continue
        try:
            return int(float(val))
        except (TypeError, ValueError):
            continue
    return 0


def find_order_row(rows, order_id):
    """The order-book row for `order_id`, or None. Ids are compared as strings:
    Kotak returns them as 19-digit numbers that lose precision as floats."""
    target = str(order_id or '').strip()
    if not target:
        return None
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        if str(row.get('nOrdNo') or row.get('ordNo') or '').strip() == target:
            return row
    return None
