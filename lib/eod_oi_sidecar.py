"""
Official end-of-day option OI for a past session, next to its OI snapshot CSV — read by the Fresh Money board.

Dhan's in-session OI is revised after the close: on 2026-11-13 the last reading (15:39) was 0-7 % above the end-of-day
figure on most NIFTY strikes (vault: dhan-observed-quirks). On the next trading day Dhan's chain carries that official
figure in `previous_oi`, so the IV snapshot collector reads it and writes:

    <previous session's csv path without .csv>_eod_oi.json
    {"date": "2026-11-13", "expiry": "2026-11-17", "fetched_at": "2026-11-16 08:25:00",
     "ce": {"25000": 2640755, ...}, "pe": {...}}

The board then shows that day's OI change / total OI from it instead of the last in-session reading.

`previous_oi` is only that session's close once Dhan has rolled it over. Before the roll (a collector started in the
early morning) and on a non-trading day it still holds the close of the session BEFORE it, which would read as a ~0
change on every strike, labelled official. `has_rolled` therefore compares the chain's `previous_oi` with the shown
session's own previous-close OI (oi − change in its last snapshot): if most strikes are equal, Dhan has not rolled yet
and nothing is written (the collector tries again later). Pure helpers + one writer; no API calls here.
"""
import json
import os
from datetime import date, timedelta

from lib.nse_holidays import is_nse_trading_day
from lib.prev_close_sidecar import strike_key

# has_rolled: the decision needs at least this many strikes known on both sides, and calls it "not rolled" when more
# than this share of them still equal the session's previous close (a real session moves almost every strike's OI).
MIN_COMPARABLE = 5
STALE_SHARE = 0.5


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
        key = strike_key(k)
        if key is None:
            continue
        for side in ('ce', 'pe'):
            v = _oi(((entry or {}).get(side) or {}).get('previous_oi'))
            if v is not None:
                out[side][key] = v
    return out


def _read_tail(csv_path: str, size: int = 65536):
    with open(csv_path, 'rb') as f:
        head = f.readline().decode('utf-8', 'replace').strip().split(',')
        f.seek(0, os.SEEK_END)
        end = f.tell()
        f.seek(max(0, end - size))
        tail = f.read().decode('utf-8', 'replace').splitlines()
    return head, tail


def last_expiry_of_csv(csv_path: str):
    """Expiry column of the CSV's last complete row (the board shows that expiry), or None."""
    try:
        head, tail = _read_tail(csv_path, 8192)
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


def session_prev_oi_from_csv(csv_path: str, expiry: str) -> dict:
    """The session's own previous-close OI per strike (OI − change_OI in its LAST snapshot of `expiry`):
    {'ce': {'25000': oi}, 'pe': {...}}; strikes without both numbers are left out. Empty when unreadable."""
    out = {'ce': {}, 'pe': {}}
    try:
        head, tail = _read_tail(csv_path)
    except OSError:
        return out
    need = ['timestamp', 'expiry', 'strike', 'CE_OI', 'CE_change_OI', 'PE_OI', 'PE_change_OI']
    if any(n not in head for n in need):
        return out
    ix = {n: head.index(n) for n in need}
    rows = [c for c in (line.split(',') for line in tail) if len(c) >= len(head) and c[ix['expiry']] == expiry]
    if not rows:
        return out
    last_ts = rows[-1][ix['timestamp']]
    for c in rows:
        if c[ix['timestamp']] != last_ts:
            continue
        key = strike_key(c[ix['strike']])
        if key is None:
            continue
        for side, oi_col, chg_col in (('ce', 'CE_OI', 'CE_change_OI'), ('pe', 'PE_OI', 'PE_change_OI')):
            try:
                oi, chg = float(c[ix[oi_col]]), float(c[ix[chg_col]])
            except ValueError:
                continue
            out[side][key] = int(round(oi - chg))
    return out


def has_rolled(fresh: dict, session_prev: dict):
    """True when the chain's `previous_oi` (`fresh`) is the shown session's close, False when it still equals that
    session's own previous close on most strikes (Dhan has not rolled it yet), None when too few strikes compare."""
    same = n = 0
    for side in ('ce', 'pe'):
        for k, v in (fresh.get(side) or {}).items():
            p = (session_prev.get(side) or {}).get(k)
            if p is None or p <= 0:
                continue
            n += 1
            same += int(v == p)
    if n < MIN_COMPARABLE:
        return None
    return same / n <= STALE_SHARE


def write_eod_oi(csv_path: str, session_date: str, expiry: str, fresh: dict, fetched_at: str) -> bool:
    """Write the side file atomically from `eod_oi_from_chain`'s result. False (nothing written) when it is empty or
    the write fails. Never raises."""
    try:
        if not fresh.get('ce') and not fresh.get('pe'):
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
