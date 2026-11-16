"""
Official end-of-day option OI for a past session, next to its OI snapshot CSV — read by the Fresh Money board.

Dhan's in-session OI is revised after the close: on 2026-11-13 the last reading (15:39) was 0-7 % above the end-of-day
figure on most NIFTY strikes (vault: dhan-observed-quirks). On the next trading day Dhan's chain carries that official
figure in `previous_oi` (equal to `oi` before the open), so the IV snapshot collector reads it once at startup and writes:

    <previous session's csv path without .csv>_eod_oi.json
    {"date": "2026-11-13", "expiry": "2026-11-17", "fetched_at": "2026-11-16 08:25:00",
     "ce": {"25000": 2640755, ...}, "pe": {...}}

The board then shows that day's OI change / total OI from it instead of the last in-session reading. Only the session
right before today qualifies: a later day's `previous_oi` is not that day's close. Pure helpers + one writer; no API
calls here.
"""
import json
import os
from datetime import date, timedelta

from lib.nse_holidays import is_nse_trading_day


def eod_oi_path(csv_path: str) -> str:
    base = csv_path[:-4] if csv_path.endswith('.csv') else csv_path
    return f'{base}_eod_oi.json'


def previous_trading_day(today: date) -> date:
    d = today - timedelta(days=1)
    for _ in range(15):
        if is_nse_trading_day(d):
            return d
        d -= timedelta(days=1)
    return d


def _oi(v):
    """A known OI > 0 as int; missing / zero / junk -> None (a missing previous OI must never read as 0)."""
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return int(round(f)) if f > 0 else None


def eod_oi_from_chain(oc: dict) -> dict:
    """{'ce': {'25000': oi}, 'pe': {...}} from a Dhan chain `oc` dict's `previous_oi`; strikes as plain numbers."""
    out = {'ce': {}, 'pe': {}}
    for k, entry in (oc or {}).items():
        try:
            strike = float(k)
        except (TypeError, ValueError):
            continue
        key = str(int(strike)) if strike.is_integer() else str(strike)
        for side in ('ce', 'pe'):
            v = _oi(((entry or {}).get(side) or {}).get('previous_oi'))
            if v is not None:
                out[side][key] = v
    return out


def last_expiry_of_csv(csv_path: str):
    """Expiry column of the CSV's last complete row (the board shows that expiry), or None."""
    try:
        with open(csv_path, 'rb') as f:
            head = f.readline().decode('utf-8', 'replace').strip().split(',')
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 8192))
            tail = f.read().decode('utf-8', 'replace').splitlines()
    except OSError:
        return None
    if 'expiry' not in head:
        return None
    ix = head.index('expiry')
    for line in reversed(tail):
        c = line.split(',')
        if len(c) >= len(head) and c[ix]:
            return c[ix]
    return None


def write_eod_oi(csv_path: str, session_date: str, expiry: str, oc: dict, fetched_at: str) -> bool:
    """Write the side file atomically. False (nothing written) when the chain has no previous OI. Never raises."""
    try:
        fresh = eod_oi_from_chain(oc)
        if not fresh['ce'] and not fresh['pe']:
            return False
        path = eod_oi_path(csv_path)
        data = {'date': session_date, 'expiry': expiry, 'fetched_at': fetched_at, 'ce': fresh['ce'], 'pe': fresh['pe']}
        tmp = f'{path}.{os.getpid()}.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        os.replace(tmp, path)
        return True
    except Exception:  # noqa: BLE001 — a side file is best effort; it must never stop the collector
        return False
