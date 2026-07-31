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
