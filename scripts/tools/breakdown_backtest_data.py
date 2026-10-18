"""
One NIFTY session of 1-minute option bars for the Breakdown Scalper backtest (rs_dashboard/lib/breakdownBacktest.ts).

Read-only. Spawned by rs_dashboard/scripts/breakdown-backtest.ts once per missing session; the result is cached in
debug/breakdown_backtest/data/<date>.json (session data never changes, so it is fetched once). Dhan is the only source:

  1. Options Data/nifty_options.db (the expired-options store) when it already holds the session.
  2. Dhan's expired-options API when the session's weekly contract has expired but the DB does not hold it yet.
     Fetched once per expiry (21 relative strikes x CE/PE) into debug/breakdown_backtest/expired/<expiry>.json, with
     the downloader's window guard (_safe_from_date: never start on the previous weekly expiry's own date).
     This does NOT write the tracked Options Data/NIFTY/*.csv files; the dashboard's options refresh still owns those.
  3. Dhan's intraday API (oi=True) when the contract is still live: NIFTY spot plus every strike within ATM +-10 of
     the session's spot range.

Every source yields the same shape: the session's bars plus the previous regular session of the SAME contracts
(WARMUP_SESSIONS), so Supertrend / EMA20 are warm from 09:15 (the live page fetches 2 days, HISTORY_DAYS in
app/api/bearish-strikes/bars; one is ample). A strike the DB did not hold the previous day has no warm-up bars and
starts cold: each trade records its contract's previous-session bar count (warmupBars). The DB and the "near week" expired fetch only hold a weekly contract from the day after
the previous expiry, so warm-up sessions on or before that expiry come from the expired-options API with
expiry_code=2 ("next week" as of those dates = this contract), cached in debug/breakdown_backtest/expired/<expiry>.warm.json.

The expired-options API answers in ~25 s per call and sometimes times out at 30 s with an empty body. Calls run one at a
time (4 in parallel tripped DH-904, and that limit is account-wide, shared with the live pages) with 3 attempts and a
60/120/180 s back-off on DH-904; each finished series is saved so an interrupted fetch resumes. A cold window is ~18 min.
Progress is written to debug/breakdown_backtest/data_progress.json.

Output (last stdout line): {"ok": true, "source": "...", "path": "...", "contracts": N}
                       or {"ok": false, "error": "...", "retry": true|false}

Usage: python scripts/tools/breakdown_backtest_data.py --date 2026-10-14 [--force]
"""
import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'downloader'))

from lib.nse_holidays import is_regular_session  # noqa: E402

DB_PATHS = {
    'dhan': os.path.join(ROOT, 'Options Data', 'nifty_options.db'),
    'breeze': os.path.join(ROOT, 'Options Data', 'breeze_nifty_options.db'),
}
DB_PATH = DB_PATHS['dhan']  # main() repoints this for --source breeze
SOURCE = 'dhan'
OUT_DIR = os.path.join(ROOT, 'debug', 'breakdown_backtest')
DATA_DIR = os.path.join(OUT_DIR, 'data')
EXPIRED_DIR = os.path.join(OUT_DIR, 'expired')
IST = timezone(timedelta(hours=5, minutes=30))
STEP = 50
# Indicator warm-up: the previous regular session only. It holds 75+ bars even on 5m, ample for EMA20 / Supertrend(10),
# and older days must not be stitched on: the DB stores only ATM+-10 strikes per minute, so a strike missing from the
# previous day would otherwise jump straight from two sessions back to today.
WARMUP_SESSIONS = 1
REL_STRIKES = ['ATM'] + [f'ATM{s}{i}' for i in range(1, 11) for s in ('+', '-')]
CALL_GAP_S = 0.3
EXPIRED_ATTEMPTS = 3
RATE_BACKOFF_S = (60, 120, 180)
PROGRESS = os.path.join(OUT_DIR, 'data_progress.json')

# NIFTY option lot size by first session it applies to (newest first).
# Historical NSE lot sizes: 65 (2025+), 75 (Nov 2024 - Dec 2024), 25 (May 2024 - Nov 2024), 50 (July 2021 - April 2024), 75 (pre-July 2021)
NIFTY_LOT_SIZES = [
    ('2025-01-01', 65),
    ('2024-11-20', 75),
    ('2024-04-26', 25),
    ('2021-07-01', 50),
    ('2020-01-01', 75),
]
# Bump when the payload's meaning changes (3 = previous session only as warm-up): older cached day files are rebuilt.
FORMAT_VERSION = 3


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


def prior_sessions(day: str, n: int, after: str | None) -> list[str]:
    """Up to n regular sessions before `day`, newest last, strictly after `after` (the previous weekly expiry)."""
    out, d = [], datetime.strptime(day, '%Y-%m-%d').date()
    while len(out) < n:
        d -= timedelta(days=1)
        iso = d.isoformat()
        if after and iso <= after:
            break
        if (date.fromisoformat(day) - d).days > 14:
            break
        if is_regular_session(iso):
            out.append(iso)
    return sorted(out)


def progress(day: str, step: str, done: int = 0, total: int = 0):
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
        with open(PROGRESS + '.tmp', 'w') as f:
            json.dump({'date': day, 'step': step, 'done': done, 'total': total, 'at': datetime.now(IST).isoformat()}, f)
        os.replace(PROGRESS + '.tmp', PROGRESS)
    except OSError:
        pass


def warm_sessions(day: str) -> list[str]:
    """The 2 regular sessions before `day` (indicator warm-up), whatever expiry they fall in."""
    return prior_sessions(day, WARMUP_SESSIONS, None)


def fill_spot(spot: dict, contracts: dict, day: str) -> dict:
    """Breeze stores spot on only some days/rows. Real spot is kept as is; a missing minute takes the last real spot
    (the first real one for leading minutes). A day with no real spot at all (early Breeze downloads) is built from
    put-call parity instead: K + CE - PE at the strike whose CE and PE closes are nearest, carried over minutes with
    no complete pair. Parity is the forward, not spot: measured against real spot on 8 Breeze days it is off by
    5-35 pts (a per-day offset no flat carry rate removed), so it only seeds days that have no feed."""
    pair_est: dict[str, dict[int, dict[str, float]]] = {}
    for e in contracts.values():
        for b in e['bars']:
            if b[0][:10] != day or b[4] is None:
                continue
            hm = b[0][11:16]
            slot = pair_est.setdefault(hm, {}).setdefault(e['strike'], {})
            slot[e['option']] = b[4]
    minutes = sorted(set(pair_est) | set(spot))
    out: dict[str, float] = {}
    if spot:
        known = sorted(spot)
        last = spot[known[0]]
        for hm in minutes:
            last = spot.get(hm, last)
            out[hm] = last
        return out
    last = None
    for hm in minutes:
        best = None
        for k, v in pair_est.get(hm, {}).items():
            if 'CE' in v and 'PE' in v:
                gap = abs(v['CE'] - v['PE'])
                if best is None or gap < best[0]:
                    best = (gap, k + v['CE'] - v['PE'])
        if best is not None:
            last = best[1]
        if last is not None:
            out[hm] = last
    return out


def build_payload(day: str, expiry: str, source: str, rows: list[tuple]) -> dict:
    """rows: (datetime 'YYYY-MM-DD HH:MM', option_type, strike, o, h, l, c, v, oi, spot); earlier rows win on duplicates."""
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
    if SOURCE == 'breeze':
        spot = fill_spot(spot, contracts, day)
    return {
        'v': FORMAT_VERSION, 'date': day, 'expiry': expiry, 'source': source, 'lotSize': lot_size_for(day),
        'spot': sorted(spot.items()), 'contracts': contracts,
    }


# ── 1. Local options DB ─────────────────────────────────────────────────────
def from_db(day: str):
    """(expiry, rows) for the session from the local store, or None. Rows cover the contract's life in the store."""
    if not os.path.exists(DB_PATH):
        return None
    con = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
    try:
        d0 = datetime.strptime(day, '%Y-%m-%d').date()
        expiry = None
        for i in range(0, 10):
            e = (d0 + timedelta(days=i)).isoformat()
            hit = con.execute(
                'SELECT 1 FROM option_prices WHERE expiry=? AND datetime BETWEEN ? AND ? LIMIT 1',
                (e, f'{day} 09:15:00', f'{day} 15:29:59')).fetchone()
            if hit:
                expiry = e
                break
        if not expiry:
            return None
        prev = con.execute('SELECT MAX(expiry) FROM option_prices WHERE expiry < ?', (expiry,)).fetchone()[0]
        start = (warm_sessions(day) or [day])[0]
        rows = con.execute(
            'SELECT substr(datetime,1,16), option_type, strike, open, high, low, close, volume, oi, spot '
            'FROM option_prices WHERE expiry=? AND datetime BETWEEN ? AND ?',
            (expiry, f'{start} 09:15:00', f'{day} 15:29:59')).fetchall()
        return expiry, rows, prev
    finally:
        con.close()


# ── Dhan session (only when the DB does not have the day) ───────────────────
_helper = None


def helper():
    global _helper
    if _helper is None:
        from login import get_dhan_client
        from lib.dhan_helper import DhanHelper
        dhan = get_dhan_client()
        if not dhan:
            emit({'ok': False, 'error': 'Dhan login failed: run login.py to refresh the access token', 'retry': True})
        _helper = DhanHelper(dhan)
    return _helper


def expiry_list() -> list[str]:
    from download_expired_options import generate_historical_expiries, get_expiries_from_master_list
    today = datetime.now(IST).replace(tzinfo=None)
    hist = generate_historical_expiries('NIFTY', today - timedelta(days=120), today)
    return sorted(set(hist) | set(get_expiries_from_master_list(helper(), 'NIFTY')))


def api_error(h, fallback: str) -> str:
    err = h.last_api_error or {}
    return f"{err.get('code') or ''} {err.get('message') or fallback}".strip()


# ── 2. Expired-options API (contract already expired; also the warm-up before the previous expiry) ───────────
def _fetch_one(h, rel: str, o_type: str, code: int, from_date: str, to_date: str):
    """(rows, fatal_error). Retries the API's empty/timeout replies; backs off on DH-904; other fatal errors stop."""
    rate_waits = 0
    attempt = 0
    while attempt < EXPIRED_ATTEMPTS:
        df = h.get_expired_options_data(
            security_id=13, exchange_segment='NSE_FNO', instrument_type='OPTIDX', expiry_flag='WEEK',
            expiry_code=code, strike=rel, drv_option_type=o_type,
            required_data=['open', 'high', 'low', 'close', 'volume', 'oi', 'strike', 'spot'],
            from_date=from_date, to_date=to_date, interval=1)
        if df is not None and not df.empty:
            ot = 'CE' if o_type == 'CALL' else 'PE'
            rows = []
            for r in df.itertuples(index=False):
                dt = getattr(r, 'datetime', None)
                k = getattr(r, 'strike', None)
                if dt is None or k is None or k != k:
                    continue
                rows.append((str(dt)[:16], ot, float(k), float(r.open), float(r.high), float(r.low), float(r.close),
                             float(getattr(r, 'volume', 0) or 0), float(getattr(r, 'oi', 0) or 0),
                             float(getattr(r, 'spot', 0) or 0)))
            return rows, None
        err = h.last_api_error or {}
        code_s = str(err.get('code', '')).upper()
        if code_s in ('DH-904', '904', '805') or 'too many requests' in str(err.get('message', '')).lower():
            # The limit is account-wide (shared with the live pages): wait it out rather than push through.
            rate_waits += 1
            if rate_waits > len(RATE_BACKOFF_S):
                return [], api_error(h, 'rate limited')
            time.sleep(RATE_BACKOFF_S[rate_waits - 1])
            continue
        if h.is_fatal_error(err):
            return [], api_error(h, 'expired options API failed')
        attempt += 1
        time.sleep(CALL_GAP_S * 3 * attempt)
    return [], None  # persistent empty reply for this series: that strike had no data in the window


def empty_parts(cache: str) -> list[str]:
    """Series of a fetch whose saved reply was empty (the API's timeout / empty-body replies): retried by a later pass."""
    parts = cache + '.parts'
    if not os.path.isdir(parts):
        return []
    out = []
    for name in sorted(os.listdir(parts)):
        if name.endswith('.json'):
            with open(os.path.join(parts, name)) as f:
                if not json.load(f):
                    out.append(name[:-5])
    return out


def fetch_expired(day: str, label: str, code: int, from_date: str, to_date: str, cache: str, retry_empty: bool = False):
    """All 21 relative strikes x CE/PE for one window. One call at a time; every finished series is saved under
    <cache>.parts/ so an interrupted fetch resumes. The parts are kept after the merged <cache> is written, so a later
    pass with retry_empty=True re-asks only the series that came back empty and rewrites <cache>. Returns (rows, error)."""
    if os.path.exists(cache) and not (retry_empty and empty_parts(cache)):
        with open(cache) as f:
            return [tuple(r) for r in json.load(f)], None
    parts = cache + '.parts'
    os.makedirs(parts, exist_ok=True)
    tasks = [(rel, o) for rel in REL_STRIKES for o in ('CALL', 'PUT')]
    rows = []
    h = None
    calls = 0
    for i, (rel, o) in enumerate(tasks):
        progress(day, label, i, len(tasks))
        part = os.path.join(parts, f'{rel}_{o}.json')
        if os.path.exists(part):
            with open(part) as f:
                saved = json.load(f)
            if saved or not retry_empty:
                rows.extend(tuple(r) for r in saved)
                continue
        if calls:
            time.sleep(CALL_GAP_S * 3)
        h = h or helper()
        calls += 1
        got, err = _fetch_one(h, rel, o, code, from_date, to_date)
        if err:
            return [], err
        with open(part + '.tmp', 'w') as f:
            json.dump(got, f)
        os.replace(part + '.tmp', part)
        rows.extend(got)
    progress(day, label, len(tasks), len(tasks))
    if not rows:
        return [], f'expired options API returned no rows ({label})'
    # The same (minute, type, strike) can appear under two relative-strike series as ATM moves: keep one.
    rows = list({(r[0], r[1], r[2]): r for r in rows}.values())
    with open(cache + '.tmp', 'w') as f:
        json.dump(rows, f)
    os.replace(cache + '.tmp', cache)
    return rows, None


def expired_main_rows(day: str, expiry: str, expiries: list[str]):
    from download_expired_options import _safe_from_date
    from_date = _safe_from_date(expiry, sorted(expiries, reverse=True))
    return fetch_expired(day, f'expired contract {expiry}', 1, from_date, expiry,
                         os.path.join(EXPIRED_DIR, f'{expiry}.json'))


def warm_cache_path(expiry: str) -> str:
    return os.path.join(EXPIRED_DIR, f'{expiry}.warm.json')


def contract_first_session(prev: str) -> str | None:
    """The first regular session after the previous weekly expiry: where the DB's near-week data for a contract starts."""
    d = date.fromisoformat(prev)
    for i in range(1, 10):
        iso = (d + timedelta(days=i)).isoformat()
        if is_regular_session(iso):
            return iso
    return None


def warm_rows(day: str, expiry: str, prev: str | None, retry_empty: bool = False):
    """Warm-up rows for sessions on/before the previous expiry (not in the near-week data). ([], None) if none needed.
    Fetched with expiry_code=2: on those dates "next week" is this contract (on the previous expiry day itself, code 1
    is the expiring contract). With WARMUP_SESSIONS = 1 this is just the previous expiry day, needed by the contract's
    first session (normally a Wednesday)."""
    need = [d for d in warm_sessions(day) if prev and d <= prev]
    if not need:
        return [], None
    first_own = contract_first_session(prev)
    window = warm_sessions(first_own) if first_own else need
    frm, to = min(window + need), max(window + need)
    return fetch_expired(day, f'warm-up for {expiry} ({frm}..{to})', 2, frm, to, warm_cache_path(expiry), retry_empty)


def cached_warm_rows(expiry: str) -> tuple[list[tuple], float | None]:
    """Offline: the warm-up rows a separate --fetch-warm run cached for this contract, and the cache's mtime (None
    when there is none). Never calls Dhan."""
    path = warm_cache_path(expiry)
    if not os.path.exists(path):
        return [], None
    with open(path) as f:
        return [tuple(r) for r in json.load(f)], os.path.getmtime(path)


def fetch_warm_all(frm: str, to: str, retry_empty: bool):
    """--fetch-warm: for every contract in the options DB whose first session falls in [frm, to], fetch and cache its
    previous-expiry-day bars (expiry_code=2). Newest first, one call at a time, resumable; safe to re-run."""
    con = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
    try:
        expiries = [e for (e,) in con.execute('SELECT DISTINCT expiry FROM option_prices ORDER BY expiry')]
    finally:
        con.close()
    todo = []
    for prev, expiry in zip(expiries, expiries[1:]):
        first = contract_first_session(prev)
        if first and frm <= first <= to:
            todo.append((expiry, prev, first))
    todo.reverse()
    done, failed = 0, []
    for expiry, prev, first in todo:
        cache = warm_cache_path(expiry)
        if os.path.exists(cache) and not (retry_empty and empty_parts(cache)):
            done += 1
            continue
        print(json.dumps({'expiry': expiry, 'warm_day': prev, 'first_session': first}), flush=True)
        rows, err = warm_rows(first, expiry, prev, retry_empty)
        if err:
            failed.append({'expiry': expiry, 'error': err})
            print(json.dumps({'expiry': expiry, 'error': err}), flush=True)
            if 'rate' in err.lower() or 'login' in err.lower() or 'DH-9' in err:
                break
            continue
        done += 1
        print(json.dumps({'expiry': expiry, 'rows': len(rows), 'empty_series': empty_parts(cache)}), flush=True)
    emit({'ok': not failed, 'contracts': len(todo), 'done': done, 'failed': failed,
          'empty_series': {e: empty_parts(warm_cache_path(e)) for e, _, _ in todo if empty_parts(warm_cache_path(e))}})


# ── 3. Intraday API (contract still live) ───────────────────────────────────
def _frame_rows(df):
    """Dhan intraday frame -> [(IST 'YYYY-MM-DD HH:MM', o, h, l, c, v, oi)]."""
    out = []
    ts = next((c for c in ('timestamp', 'start_Time', 'time', 'date') if c in df.columns), df.columns[0])
    oi_col = next((c for c in ('open_interest', 'oi', 'OI') if c in df.columns), None)
    for r in df.to_dict('records'):
        raw = r[ts]
        try:
            v = float(raw)
            dt = datetime.fromtimestamp(v / 1000 if v > 1.5e12 else v, tz=IST)
        except (TypeError, ValueError):
            dt = datetime.strptime(str(raw).replace('T', ' ')[:16], '%Y-%m-%d %H:%M')
        out.append((dt.strftime('%Y-%m-%d %H:%M'), float(r['open']), float(r['high']), float(r['low']),
                    float(r['close']), float(r.get('volume') or 0), float(r[oi_col]) if oi_col and r.get(oi_col) is not None else None))
    return out


def from_intraday_api(day: str, expiry: str, expiries: list[str]):
    h = helper()
    nxt = (date.fromisoformat(day) + timedelta(days=1)).isoformat()
    spot_df = h.get_intraday_minute_data('13', 'IDX_I', 'INDEX', '1', day, nxt)
    if spot_df is None or spot_df.empty:
        return {'error': f'no NIFTY spot bars for {day}: {api_error(h, "empty response")}', 'retry': True}
    spot = {t[11:16]: c for t, _o, _h, _l, c, _v, _oi in _frame_rows(spot_df) if t[:10] == day and in_session(t[11:16])}
    if not spot:
        return {'error': f'no NIFTY spot bars for {day}', 'retry': True}
    lo, hi = min(spot.values()), max(spot.values())
    strikes = range(int(round(lo / STEP)) * STEP - 10 * STEP, int(round(hi / STEP)) * STEP + 10 * STEP + 1, STEP)
    warm = warm_sessions(day)  # same contract by security id: earlier days are available from the intraday API
    frm = (warm or [day])[0]
    rows = []
    total = len(strikes) * 2
    for i, k in enumerate(strikes):
        progress(day, f'intraday contract {expiry}', i * 2, total)
        for ot in ('CE', 'PE'):
            if i or ot == 'PE':
                time.sleep(CALL_GAP_S)
            opt = h.find_option('NIFTY', expiry, float(k), ot, exchange='NSE', instrument='OPTIDX')
            if opt is None:
                continue
            df = h.get_intraday_minute_data(str(int(opt['SECURITY_ID'])), 'NSE_FNO', 'OPTIDX', '1', frm, nxt, oi=True)
            if df is None or df.empty:
                err = h.last_api_error or {}
                if str(err.get('code', '')).upper() in ('DH-904', '904', '805') or h.is_fatal_error(err):
                    return {'error': f'Dhan intraday API: {api_error(h, "rate limited")}', 'retry': True}
                continue
            for t, o, hh, ll, c, v, oi in _frame_rows(df):
                rows.append((t, ot, float(k), o, hh, ll, c, v, oi, spot.get(t[11:16]) if t[:10] == day else None))
    if not rows:
        return {'error': f'no option bars for NIFTY {expiry} on {day}', 'retry': True}
    payload = build_payload(day, expiry, 'intraday_api', rows)
    payload['spot'] = sorted(spot.items())
    return payload


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date')
    ap.add_argument('--source', choices=sorted(DB_PATHS), default='dhan',
                    help='options DB to read: dhan (nifty_options.db) or breeze (breeze_nifty_options.db)')
    ap.add_argument('--force', action='store_true', help='rebuild even if cached')
    ap.add_argument('--offline', action='store_true',
                    help='options DB only, no Dhan calls: warm-up is whatever the DB holds for the contract (Wed/Thu partial)')
    ap.add_argument('--db-latest', action='store_true', help='print the latest session in the options DB and exit')
    ap.add_argument('--db-range', action='store_true', help='print earliest and latest session in the options DB and exit')
    ap.add_argument('--fetch-warm', action='store_true',
                    help='fetch + cache the previous-expiry-day warm-up bars (expiry_code=2) of every DB contract whose '
                         'first session is in --from..--to; the offline backtest then merges them')
    ap.add_argument('--from', dest='frm')
    ap.add_argument('--to')
    ap.add_argument('--retry-empty', action='store_true', help='with --fetch-warm: re-ask series that came back empty')
    args = ap.parse_args()
    global DB_PATH, SOURCE, DATA_DIR
    SOURCE = args.source
    DB_PATH = DB_PATHS[SOURCE]
    if SOURCE == 'breeze':
        DATA_DIR = os.path.join(DATA_DIR, 'breeze')
    if args.fetch_warm:
        if SOURCE != 'dhan':
            emit({'ok': False, 'error': '--fetch-warm caches Dhan expired-API bars: --source dhan only', 'retry': False})
        if not args.frm or not args.to:
            emit({'ok': False, 'error': '--fetch-warm needs --from and --to', 'retry': False})
        fetch_warm_all(args.frm, args.to, args.retry_empty)
    if args.db_latest or args.db_range:
        con = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
        try:
            min_exp = con.execute('SELECT MIN(expiry) FROM option_prices').fetchone()[0]
            max_exp = con.execute('SELECT MAX(expiry) FROM option_prices').fetchone()[0]
            first = con.execute('SELECT MIN(datetime) FROM option_prices WHERE expiry=?', (min_exp,)).fetchone()[0]
            last = con.execute('SELECT MAX(datetime) FROM option_prices WHERE expiry=?', (max_exp,)).fetchone()[0]
        finally:
            con.close()
        emit({'ok': True, 'latest': (last or '')[:10], 'earliest': (first or '')[:10], 'expiry': max_exp, 'min_expiry': min_exp})
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
        emit({'ok': False, 'error': f'no NIFTY lot size on record for {day} (see NIFTY_LOT_SIZES)', 'retry': False})

    os.makedirs(DATA_DIR, exist_ok=True)
    out = os.path.join(DATA_DIR, f'{day}.json')
    cached = None
    if os.path.exists(out) and not args.force:
        with open(out) as f:
            cached = json.load(f)
    # An offline build may lack warm-up sessions: only an offline run may reuse it; online rebuilds it in full. A day that
    # needs the previous expiry day's warm-up is rebuilt when that cache appears or changes (a --fetch-warm run).
    def warm_mtime(expiry):
        path = warm_cache_path(expiry) if expiry else None
        return os.path.getmtime(path) if path and os.path.exists(path) else None
    warm_current = (not cached or not cached.get('warmNeeded')
                    or cached.get('warmMtime') == warm_mtime(cached.get('expiry')))
    if cached and cached.get('v') == FORMAT_VERSION and warm_current and (
            args.offline or cached.get('warmupSessions', 0) >= WARMUP_SESSIONS):
        emit({'ok': True, 'source': cached.get('source'), 'path': out, 'contracts': len(cached.get('contracts', {})), 'cached': True})

    now = datetime.now(IST)
    today = now.date().isoformat()
    _expiries = None

    def expiries():
        nonlocal _expiries
        if _expiries is None:
            _expiries = expiry_list()
        return _expiries

    db = from_db(day)
    if db is None:
        emit({'ok': False, 'error': f'{day} is not in {os.path.basename(DB_PATH)} (offline backtest)', 'retry': False})
    expiry, rows, prev = db
    source = 'db' if SOURCE == 'dhan' else 'breeze_db'
    # The contract's first session (normally Wednesday) has no previous day in the DB: merge the previous expiry day
    # from the --fetch-warm cache when one exists (DB rows come first, so they win any duplicate minute).
    warm_needed = SOURCE == 'dhan' and any(prev and d <= prev for d in warm_sessions(day))
    warm_m = None
    if warm_needed:
        extra, warm_m = cached_warm_rows(expiry)
        rows = list(rows) + extra
    payload = build_payload(day, expiry, source, rows)
    payload['warmNeeded'] = warm_needed
    payload['warmMtime'] = warm_m
    if 'error' in payload:
        emit({'ok': False, 'error': payload['error'], 'retry': False})
    have = {b[0][:10] for c in payload['contracts'].values() for b in c['bars']} - {day}
    payload['warmupSessions'] = len(set(warm_sessions(day)) & have)
    if not payload['contracts'] or not payload['spot']:
        emit({'ok': False, 'error': f'{payload["source"]}: no usable bars for {day} in options DB', 'retry': False})

    with open(out + '.tmp', 'w') as f:
        json.dump(payload, f, separators=(',', ':'))
    os.replace(out + '.tmp', out)
    emit({'ok': True, 'source': payload['source'], 'path': out, 'contracts': len(payload['contracts'])})


if __name__ == '__main__':
    main()
