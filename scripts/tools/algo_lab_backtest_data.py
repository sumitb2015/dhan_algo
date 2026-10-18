"""
One NIFTY session of 1-minute option bars for the Algo Lab backtest (rs_dashboard/lib/algoLab/simulator.ts).

Read-only and offline: the only source is Options Data/nifty_options.db (the expired-options store, ATM +-10 strikes
per minute). Spawned by rs_dashboard/scripts/algo-lab-backtest.ts once per missing session; the result is cached in
debug/algo_lab/data/<date>.json and shared by every strategy (session data never changes).

Each payload carries the session plus the previous regular session of the SAME contracts (indicator warm-up). The DB
holds a weekly contract only from the day after the previous expiry, so that contract's first session (normally a
Wednesday) has no warm-up bars and starts cold; the simulator records every trade's warm-up bar count.

Output (last stdout line): {"ok": true, "source": "db", "path": "...", "contracts": N}
                       or {"ok": false, "error": "...", "retry": false}

Usage: python scripts/tools/algo_lab_backtest_data.py --date 2026-10-14 [--force]
       python scripts/tools/algo_lab_backtest_data.py --db-range
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import date, datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from lib.nse_holidays import is_regular_session  # noqa: E402

DB_PATH = os.path.join(ROOT, 'Options Data', 'nifty_options.db')
DATA_DIR = os.path.join(ROOT, 'debug', 'algo_lab', 'data')
WARMUP_SESSIONS = 1
FORMAT_VERSION = 1

# NIFTY option lot size by first session it applies to (newest first); same table as breakdown_backtest_data.py.
NIFTY_LOT_SIZES = [
    ('2025-01-01', 65),
    ('2024-11-20', 75),
    ('2024-04-26', 25),
    ('2021-07-01', 50),
    ('2020-01-01', 75),
]


def lot_size_for(day: str):
    for start, lot in NIFTY_LOT_SIZES:
        if day >= start:
            return lot
    return None


def emit(obj):
    print(json.dumps(obj))
    sys.exit(0)


def in_session(hm: str) -> bool:
    return '09:15' <= hm <= '15:29'


def warm_sessions(day: str) -> list[str]:
    """The WARMUP_SESSIONS regular sessions before `day`, oldest first (within 14 calendar days)."""
    out, d = [], date.fromisoformat(day)
    while len(out) < WARMUP_SESSIONS and (date.fromisoformat(day) - d).days <= 14:
        d -= timedelta(days=1)
        if is_regular_session(d.isoformat()):
            out.append(d.isoformat())
    return sorted(out)


def from_db(day: str):
    """(expiry, rows) for the nearest weekly expiry on/after `day`, or None."""
    if not os.path.exists(DB_PATH):
        return None
    con = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
    try:
        d0 = date.fromisoformat(day)
        expiry = None
        for i in range(0, 10):
            e = (d0 + timedelta(days=i)).isoformat()
            if con.execute('SELECT 1 FROM option_prices WHERE expiry=? AND datetime BETWEEN ? AND ? LIMIT 1',
                           (e, f'{day} 09:15:00', f'{day} 15:29:59')).fetchone():
                expiry = e
                break
        if not expiry:
            return None
        start = (warm_sessions(day) or [day])[0]
        rows = con.execute(
            'SELECT substr(datetime,1,16), option_type, strike, open, high, low, close, volume, oi, spot '
            'FROM option_prices WHERE expiry=? AND datetime BETWEEN ? AND ?',
            (expiry, f'{start} 09:15:00', f'{day} 15:29:59')).fetchall()
        return expiry, rows
    finally:
        con.close()


def build_payload(day: str, expiry: str, rows: list[tuple]) -> dict:
    keep_days = set(warm_sessions(day)) | {day}
    contracts: dict[str, dict] = {}
    spot: dict[str, float] = {}
    for dt, ot, k, o, h, l, c, v, oi, sp in rows:
        d, hm = dt[:10], dt[11:16]
        if d not in keep_days or not in_session(hm) or k is None or c is None:
            continue
        key = f'{int(round(k))}{ot}'
        entry = contracts.setdefault(key, {'strike': int(round(k)), 'option': ot, 'bars': {}})
        entry['bars'].setdefault(f'{d} {hm}', [f'{d} {hm}', o, h, l, c, v or 0, oi])
        if d == day and sp:
            spot[hm] = sp
    for e in contracts.values():
        e['bars'] = [e['bars'][t] for t in sorted(e['bars'])]
    contracts = {k: v for k, v in contracts.items() if any(b[0][:10] == day for b in v['bars'])}
    have = {b[0][:10] for c in contracts.values() for b in c['bars']} - {day}
    return {
        'v': FORMAT_VERSION, 'date': day, 'expiry': expiry, 'source': 'db', 'lotSize': lot_size_for(day),
        'warmupSessions': len(set(warm_sessions(day)) & have),
        'spot': sorted(spot.items()), 'contracts': contracts,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date')
    ap.add_argument('--force', action='store_true', help='rebuild even if cached')
    ap.add_argument('--db-range', action='store_true', help='print earliest and latest session in the options DB and exit')
    args = ap.parse_args()

    if args.db_range:
        if not os.path.exists(DB_PATH):
            emit({'ok': False, 'error': 'Options Data/nifty_options.db not found', 'retry': False})
        con = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
        try:
            min_exp = con.execute('SELECT MIN(expiry) FROM option_prices').fetchone()[0]
            max_exp = con.execute('SELECT MAX(expiry) FROM option_prices').fetchone()[0]
            first = con.execute('SELECT MIN(datetime) FROM option_prices WHERE expiry=?', (min_exp,)).fetchone()[0]
            last = con.execute('SELECT MAX(datetime) FROM option_prices WHERE expiry=?', (max_exp,)).fetchone()[0]
        finally:
            con.close()
        emit({'ok': True, 'earliest': (first or '')[:10], 'latest': (last or '')[:10]})

    day = args.date
    if not day:
        emit({'ok': False, 'error': '--date is required', 'retry': False})
    try:
        datetime.strptime(day, '%Y-%m-%d')
    except ValueError:
        emit({'ok': False, 'error': f'bad date {day}', 'retry': False})
    if not is_regular_session(day):
        emit({'ok': False, 'error': f'{day} is not a regular NSE session', 'retry': False})
    if lot_size_for(day) is None:
        emit({'ok': False, 'error': f'no NIFTY lot size on record for {day}', 'retry': False})

    os.makedirs(DATA_DIR, exist_ok=True)
    out = os.path.join(DATA_DIR, f'{day}.json')
    if os.path.exists(out) and not args.force:
        try:
            with open(out) as f:
                cached = json.load(f)
            if cached.get('v') == FORMAT_VERSION:
                emit({'ok': True, 'source': 'db', 'path': out, 'contracts': len(cached.get('contracts', {})), 'cached': True})
        except (OSError, ValueError):
            pass

    db = from_db(day)
    if db is None:
        emit({'ok': False, 'error': f'{day} is not in Options Data/nifty_options.db', 'retry': False})
    payload = build_payload(day, *db)
    if not payload['contracts'] or not payload['spot']:
        emit({'ok': False, 'error': f'no usable bars for {day} in the options DB', 'retry': False})

    with open(out + '.tmp', 'w') as f:
        json.dump(payload, f, separators=(',', ':'))
    os.replace(out + '.tmp', out)
    emit({'ok': True, 'source': 'db', 'path': out, 'contracts': len(payload['contracts'])})


if __name__ == '__main__':
    main()
