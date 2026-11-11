"""
Option previous closes next to an OI snapshot CSV — read by the Fresh Money board's buildup tags
(rs_dashboard/lib/freshMoney.ts buildupOf: OI change sign x option price change sign).

The snapshot CSVs (iv_snapshot_collector.py, crudeoil_oi_collector.py) carry each option's LTP and OI change but not its
previous close, and their column layout is read by other code, so the previous closes go in a side file instead:

    <csv path without .csv>_prev_close.json
    {"expiry": "2026-11-17", "updated_at": "2026-11-11 10:15:30", "ce": {"25000": 112.3, ...}, "pe": {...}}

Values come from Dhan's chain field `previous_close_price` (NOT `previous_close`, which silently returns nothing —
docs/API_GOTCHAS.md). Merged across polls (the collector's ATM window can drift), written atomically. Pure helpers + one
writer; no API calls.
"""
import json
import os
from datetime import datetime


def sidecar_path(csv_path: str) -> str:
    base = csv_path[:-4] if csv_path.endswith('.csv') else csv_path
    return f'{base}_prev_close.json'


def _price(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def prev_closes_from_chain(oc: dict) -> dict:
    """{'ce': {'25000': px}, 'pe': {...}} from a Dhan chain `oc` dict; strikes as plain numbers, missing/zero skipped."""
    out = {'ce': {}, 'pe': {}}
    for k, entry in (oc or {}).items():
        try:
            strike = float(k)
        except (TypeError, ValueError):
            continue
        key = str(int(strike)) if strike.is_integer() else str(strike)
        for side in ('ce', 'pe'):
            px = _price(((entry or {}).get(side) or {}).get('previous_close_price'))
            if px is not None:
                out[side][key] = px
    return out


def merge(existing, expiry: str, fresh: dict) -> dict:
    """Merge fresh values into an existing side file for the same expiry (a different expiry starts over)."""
    base = existing if isinstance(existing, dict) and existing.get('expiry') == expiry else {'ce': {}, 'pe': {}}
    out = {'expiry': expiry, 'ce': dict(base.get('ce') or {}), 'pe': dict(base.get('pe') or {})}
    for side in ('ce', 'pe'):
        out[side].update(fresh.get(side) or {})
    return out


def write_prev_closes(csv_path: str, expiry: str, oc: dict) -> None:
    """Update the side file of `csv_path` with this poll's previous closes. Never raises (a side file is best effort)."""
    try:
        fresh = prev_closes_from_chain(oc)
        if not fresh['ce'] and not fresh['pe']:
            return
        path = sidecar_path(csv_path)
        try:
            with open(path, encoding='utf-8') as f:
                existing = json.load(f)
        except (OSError, ValueError):
            existing = None
        data = merge(existing, expiry, fresh)
        data['updated_at'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        tmp = f'{path}.{os.getpid()}.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except Exception:  # noqa: BLE001 — never let a side file break the collector's CSV writes
        pass
