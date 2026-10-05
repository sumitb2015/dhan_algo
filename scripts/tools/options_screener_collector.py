"""
Options Screener collector — "what changed in the last 1-30 min" across index, stock and
MCX options. Backs the dashboard's /options-screener page.

Every minute it:
  1. reads the SCOPE — the underlyings the open screener tabs are looking at
     (debug/options_screener_scope.json, written by the scan route; see read_scope()).
     Only those are scanned, so watching one asset costs one or two quote calls a minute
     instead of ~18 for the whole universe,
  2. resolves each scoped underlying's spot (index/equity LTP, or the MCX option's own future),
  3. picks ATM±N strikes (CE+PE) on the nearest `--expiries` expiries of each of them
     (NSE index + stock options, SENSEX/BANKEX, MCX options),
  4. pulls LTP / OI / day volume through Dhan's batched /marketfeed/quote (≤1000 instruments
     per call), paced through the cross-process quote lane (lib/dhan_quote_lane.py: shared
     1.1 s slots, gap doubles on a 429 for every participant),
  5. solves IV locally (Black-Scholes for NSE/BSE, Black-76 for MCX options on futures),
  6. diffs each contract against its own snapshot 1/3/5/10/15/30 minutes ago and writes the
     result to debug/options_screener_snapshot.json (atomic replace).

The dashboard route evaluates custom/preset scans over that file — this script only measures.
Nothing here places orders.

Units written to the snapshot:
  * `oi`, `v` and the window volume are in LOTS (raw quantity / LOT_SIZE). Dhan reports MCX
    quantity in lots already (master LOT_SIZE is 1 there), so the same division is correct.
  * `lot` is the order quantity per lot (what Dhan's order API wants per lot: LOT_SIZE for
    NSE/BSE, 1 for MCX). `mult` is units per lot for premium turnover (MCX contract size).

Status: debug/options_screener_status.json   Stop: debug/options_screener_stop.trigger

Usage:
    venv\\Scripts\\python.exe scripts/tools/options_screener_collector.py
    venv\\Scripts\\python.exe scripts/tools/options_screener_collector.py --once
    venv\\Scripts\\python.exe scripts/tools/options_screener_collector.py --strikes 6 --expiries 1
"""
import os
import sys
import json
import math
import time
import argparse
import logging
from collections import deque
from datetime import datetime, date
from zoneinfo import ZoneInfo

import numpy as np
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from lib import dhan_quote_lane  # noqa: E402  (needs ROOT on sys.path)
from lib.nse_holidays import is_nse_trading_day  # noqa: E402
from lib.options_pricing import RISK_FREE_RATE, implied_vols  # noqa: E402

DEBUG_DIR = os.path.join(ROOT, 'debug')
TOKEN_FILE = os.path.join(ROOT, 'access_token.json')
QUOTE_URL = 'https://api.dhan.co/v2/marketfeed/quote'
SNAPSHOT_FILE = os.path.join(DEBUG_DIR, 'options_screener_snapshot.json')
STATUS_FILE = os.path.join(DEBUG_DIR, 'options_screener_status.json')
SCOPE_FILE = os.path.join(DEBUG_DIR, 'options_screener_scope.json')
# A tab that hasn't polled the scan route for this long no longer widens the scope.
SCOPE_TAB_TTL_SEC = 120
STOP_TRIGGER = os.path.join(DEBUG_DIR, 'options_screener_stop.trigger')
LOG_FILE = os.path.join(DEBUG_DIR, 'options_screener_collector.log')

os.makedirs(DEBUG_DIR, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)s  %(message)s',
    datefmt='%H:%M:%S',
    filename=LOG_FILE,
    filemode='a',
)
log = logging.getLogger('options_screener')
_stdout = logging.StreamHandler(sys.stderr)
_stdout.setFormatter(logging.Formatter('%(asctime)s  %(levelname)s  %(message)s', '%H:%M:%S'))
log.addHandler(_stdout)

WINDOWS = (1, 3, 5, 10, 15, 30)
HISTORY_SEC = 35 * 60
QUOTE_BATCH = 1000
QUOTE_GAP_SEC = 1.1

# Index option underlyings -> spot (IDX_I security id). Option rows key on a different
# underlying id (NIFTY options = 26000), so spot is looked up here, not from the option row.
INDEX_SPOT_IDS = {
    'NIFTY': 13,
    'BANKNIFTY': 25,
    'FINNIFTY': 27,
    'MIDCPNIFTY': 442,
    'SENSEX': 51,
    'BANKEX': 69,
}

# MCX option underlyings scanned, with units per lot (for premium turnover only — Dhan's
# order quantity and reported volume/OI for MCX are already in lots).
MCX_CONTRACT_SIZE = {
    'CRUDEOIL': 100,
    'CRUDEOILM': 10,
    'NATURALGAS': 1250,
    'NATGASMINI': 250,
    'GOLD': 100,
    'GOLDM': 10,
    'SILVER': 30,
    'SILVERM': 5,
    'COPPER': 2500,
}

SESSIONS = {
    # exchange -> (open (h, m), close (h, m)) IST
    'NSE': ((9, 15), (15, 30)),
    'BSE': ((9, 15), (15, 30)),
    'MCX': ((9, 0), (23, 30)),
}
EXPIRY_CLOSE = {'NSE': (15, 30), 'BSE': (15, 30), 'MCX': (23, 30)}


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

IST = ZoneInfo('Asia/Kolkata')


def now_ist() -> datetime:
    # Naive IST wall clock, independent of the host timezone (sessions, expiry times and the
    # trading date are all IST).
    return datetime.now(IST).replace(tzinfo=None)


def today_ist() -> date:
    return now_ist().date()


def session_open(exch: str, now: datetime) -> bool:
    if now.weekday() >= 5:
        return False
    # NSE holidays close NSE and BSE; MCX keeps its own calendar (not modelled).
    if exch != 'MCX' and not is_nse_trading_day(now):
        return False
    (oh, om), (ch, cm) = SESSIONS[exch]
    mins = now.hour * 60 + now.minute
    return oh * 60 + om <= mins <= ch * 60 + cm


def minutes_since_open(exch: str, ts: float) -> float:
    dt = datetime.fromtimestamp(ts, IST).replace(tzinfo=None)
    (oh, om), _ = SESSIONS[exch]
    open_dt = dt.replace(hour=oh, minute=om, second=0, microsecond=0)
    return (dt - open_dt).total_seconds() / 60.0


def num(v, default=None):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if math.isnan(f) or math.isinf(f):
        return default
    return f


def rnd(v, nd=2):
    return None if v is None else round(float(v), nd)


def write_json_atomic(path: str, payload) -> None:
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(payload, f, separators=(',', ':'), allow_nan=False)
    os.replace(tmp, path)


def write_status(**fields) -> None:
    payload = {'pid': os.getpid(), 'updated_at': now_ist().isoformat(timespec='seconds')}
    payload.update(fields)
    try:
        write_json_atomic(STATUS_FILE, payload)
    except OSError as exc:
        log.warning('status write failed: %s', exc)


def read_scope(underlyings, force_all=False):
    """Which underlyings to scan this cycle -> (set of symbols, is_everything).

    The scan route records each open tab's segment + symbols (watchlists arrive already
    expanded to symbols) in SCOPE_FILE. The union over tabs seen in the last
    SCOPE_TAB_TTL_SEC is scanned. With no tab open, the most recent selection keeps being
    scanned, so the look-back history for it stays continuous until the collector is
    stopped. No scope file at all (collector run from the command line, page never
    opened) means everything, as does any tab showing segment "All" with no symbols.
    """
    everything = set(underlyings)
    if force_all:
        return everything, True
    try:
        with open(SCOPE_FILE, 'r', encoding='utf-8') as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return everything, True
    if not isinstance(raw, dict):
        return everything, True
    now_ms = time.time() * 1000
    tabs = raw.get('tabs') if isinstance(raw.get('tabs'), dict) else {}
    active = [t for t in tabs.values()
              if isinstance(t, dict) and now_ms - num(t.get('at'), 0) <= SCOPE_TAB_TTL_SEC * 1000]
    if not active:
        last = raw.get('last')
        active = [last] if isinstance(last, dict) else []
    if not active:
        return everything, True

    picked = set()
    for t in active:
        seg = t.get('segment') if t.get('segment') in ('index', 'stock', 'mcx') else 'all'
        syms = {str(s).upper() for s in (t.get('symbols') or []) if isinstance(s, str)}
        if seg == 'all' and not syms:
            return everything, True
        for u, m in underlyings.items():
            if (seg == 'all' or m['kind'] == seg) and (not syms or u in syms):
                picked.add(u)
    return picked, picked == everything


# ---------------------------------------------------------------------------
# universe from master_list.csv
# ---------------------------------------------------------------------------

def build_universe(df, today: date, n_expiries: int):
    """Return (underlyings, strikes_by_group, group_spot).

    underlyings: sym -> {kind, exch, spot_seg, spot_id}   (spot_id = display/"underlying %" spot)
    strikes_by_group: (sym, expiry) -> sorted list of dicts {strike, CE: row, PE: row}
    group_spot: (sym, expiry) -> (seg, id) the option expiry is priced off. Index/stock: the
        underlying itself. MCX: the first future expiring on/after the option — CRUDEOIL Nov
        options sit on the Nov future and GOLD Oct options on the Dec future, not on the nearest
        future (master_list's UNDERLYING_SECURITY_ID for MCX options is the commodity, not a future).
    """
    import pandas as pd

    today_s = today.isoformat()
    opt = df[df['INSTRUMENT'].isin(['OPTIDX', 'OPTSTK', 'OPTFUT'])].copy()
    opt = opt[opt['EXCH_ID'].isin(['NSE', 'BSE', 'MCX'])]
    opt['EXP'] = opt['SM_EXPIRY_DATE'].astype(str).str.slice(0, 10)
    opt = opt[opt['EXP'] >= today_s]
    opt = opt[opt['OPTION_TYPE'].isin(['CE', 'PE'])]

    keep = (
        ((opt['INSTRUMENT'] == 'OPTSTK') & (opt['EXCH_ID'] == 'NSE'))
        | ((opt['INSTRUMENT'] == 'OPTIDX') & opt['UNDERLYING_SYMBOL'].isin(list(INDEX_SPOT_IDS)))
        | ((opt['INSTRUMENT'] == 'OPTFUT') & (opt['EXCH_ID'] == 'MCX')
           & opt['UNDERLYING_SYMBOL'].isin(list(MCX_CONTRACT_SIZE)))
    )
    opt = opt[keep]

    eq = df[(df['EXCH_ID'] == 'NSE') & (df['INSTRUMENT'] == 'EQUITY')]
    eq_ids = {}
    for col in ('UNDERLYING_SYMBOL', 'SYMBOL_NAME'):
        if col in eq.columns:
            for sym, sid in zip(eq[col].astype(str), eq['SECURITY_ID']):
                eq_ids.setdefault(sym.upper(), int(sid))

    fut = df[(df['EXCH_ID'] == 'MCX') & (df['INSTRUMENT'] == 'FUTCOM')].copy()
    fut['EXP'] = fut['SM_EXPIRY_DATE'].astype(str).str.slice(0, 10)
    fut = fut[fut['EXP'] >= today_s].sort_values('EXP')

    tick_col = 'TICK_SIZE' if 'TICK_SIZE' in opt.columns else None

    underlyings = {}
    groups = {}
    group_spot = {}
    for sym, g in opt.groupby('UNDERLYING_SYMBOL'):
        sym = str(sym).upper()
        instr = str(g['INSTRUMENT'].iloc[0])
        exch = str(g['EXCH_ID'].iloc[0])
        if instr == 'OPTIDX':
            meta = {'kind': 'index', 'exch': exch, 'spot_seg': 'IDX_I', 'spot_id': INDEX_SPOT_IDS[sym]}
        elif instr == 'OPTSTK':
            sid = eq_ids.get(sym)
            if sid is None and 'UNDERLYING_SECURITY_ID' in g.columns:
                sid = num(g['UNDERLYING_SECURITY_ID'].iloc[0])
            if not sid:
                continue
            meta = {'kind': 'stock', 'exch': 'NSE', 'spot_seg': 'NSE_EQ', 'spot_id': int(sid)}
        else:
            f = fut[fut['UNDERLYING_SYMBOL'].astype(str).str.upper() == sym]
            if f.empty:
                continue
            meta = {'kind': 'mcx', 'exch': 'MCX', 'spot_seg': 'MCX_COMM', 'spot_id': int(f['SECURITY_ID'].iloc[0])}
        underlyings[sym] = meta

        seg = {'NSE': 'NSE_FNO', 'BSE': 'BSE_FNO', 'MCX': 'MCX_COMM'}[exch]
        for exp in sorted(g['EXP'].unique())[:n_expiries]:
            if meta['kind'] == 'mcx':
                fx = f[f['EXP'] >= exp]
                if fx.empty:
                    continue
                spot_key = ('MCX_COMM', int(fx['SECURITY_ID'].iloc[0]))
            else:
                spot_key = (meta['spot_seg'], int(meta['spot_id']))
            ge = g[g['EXP'] == exp]
            by_strike = {}
            for r in ge.itertuples(index=False):
                strike = num(getattr(r, 'STRIKE_PRICE'))
                if not strike:
                    continue
                lot_raw = num(getattr(r, 'LOT_SIZE'), 1) or 1
                lot = 1 if exch == 'MCX' else int(lot_raw)
                mult = MCX_CONTRACT_SIZE.get(sym, 1) if exch == 'MCX' else int(lot_raw)
                # master_list TICK_SIZE is in PAISE (5.0 = Rs 0.05, MCX GOLD 50.0 = Rs 0.50).
                # Using it raw made the order route round a 16.25 limit to 15 or 20.
                tick_p = num(getattr(r, tick_col)) if tick_col else None
                tick = round(tick_p / 100.0, 4) if tick_p else 0.05
                by_strike.setdefault(strike, {'strike': strike})[str(getattr(r, 'OPTION_TYPE'))] = {
                    'sid': int(getattr(r, 'SECURITY_ID')),
                    'seg': seg,
                    'lot': lot,
                    'qty_lot': int(lot_raw),
                    'mult': mult,
                    'tick': tick if tick and tick > 0 else 0.05,
                }
            ladder = [v for _, v in sorted(by_strike.items()) if 'CE' in v or 'PE' in v]
            if ladder:
                groups[(sym, exp)] = ladder
                group_spot[(sym, exp)] = spot_key
    return underlyings, groups, group_spot


# ---------------------------------------------------------------------------
# quote fetching
# ---------------------------------------------------------------------------

class QuoteClient:
    """Batched POST /v2/marketfeed/quote through the cross-process quote lane.

    Called directly rather than via the SDK: dhanhq's quote_data() collapses every HTTP
    failure into {'error_code': None, ...}, so a 429 was indistinguishable from any other
    error and could not drive a backoff. Here a 429 widens the SHARED gap
    (lib/dhan_quote_lane.py), which slows every lane participant — dashboard included.
    """

    def __init__(self):
        self.last_error = None
        self.gap_ms = dhan_quote_lane.BASE_GAP_MS
        self.rate_limited = 0          # 429s seen in the current scan

    @staticmethod
    def _credentials():
        # Re-read every call: login.py may refresh the token while the collector runs.
        with open(TOKEN_FILE, 'r', encoding='utf-8') as f:
            token = json.load(f).get('accessToken') or ''
        return os.getenv('client_id') or '', token

    def _post(self, securities):
        """One call. Returns (data | None, rate_limited, error)."""
        time.sleep(max(0.0, dhan_quote_lane.reserve(QUOTE_GAP_SEC * 1000)))
        try:
            client_id, token = self._credentials()
            res = requests.post(
                QUOTE_URL,
                json=securities,
                headers={'access-token': token, 'client-id': client_id,
                         'Content-Type': 'application/json', 'Accept': 'application/json'},
                timeout=15,
            )
        except (OSError, ValueError, requests.RequestException) as exc:
            return None, False, f'network: {exc}'
        if res.status_code == 429:
            self.gap_ms = dhan_quote_lane.report(True)
            return None, True, f'HTTP 429 rate limited (gap now {self.gap_ms / 1000:.1f}s)'
        try:
            body = res.json()
        except ValueError:
            body = {}
        if res.status_code != 200 or not isinstance(body, dict) or body.get('status') != 'success':
            err = body.get('errorMessage') or body.get('remarks') or body.get('message') if isinstance(body, dict) else None
            return None, False, f'HTTP {res.status_code}: {err or str(body)[:200]}'
        self.gap_ms = dhan_quote_lane.report(False)
        data = body.get('data', {})
        if isinstance(data, dict) and 'data' in data:
            data = data['data']
        return data, False, None

    def quote(self, instruments):
        """instruments: list of (seg, sid). Returns {(seg, sid): (quote_dict, fetch_ts)}."""
        out = {}
        # Per-scan: a batch that failed once must not keep flagging every later clean scan.
        self.last_error = None
        for i in range(0, len(instruments), QUOTE_BATCH):
            chunk = instruments[i:i + QUOTE_BATCH]
            securities = {}
            for seg, sid in chunk:
                securities.setdefault(seg, []).append(int(sid))
            data = None
            for attempt in range(3):
                data, limited, err = self._post(securities)
                if isinstance(data, dict):
                    break
                self.last_error = err
                if limited:
                    # The lane has already pushed the next slot out by the widened gap.
                    self.rate_limited += 1
                else:
                    time.sleep(2.0 * (attempt + 1))
            if not isinstance(data, dict):
                log.warning('quote batch %d failed: %s', i // QUOTE_BATCH, self.last_error)
                continue
            ts = time.time()
            for seg, rows in data.items():
                if not isinstance(rows, dict):
                    continue
                for sid, q in rows.items():
                    out[(seg, int(sid))] = (q, ts)
        return out


# ---------------------------------------------------------------------------
# history + diffs
# ---------------------------------------------------------------------------

def baseline(hist, now_ts: float, window_min: int):
    """Latest snapshot at or before (now - window), not older than a sane slack."""
    if not hist:
        return None
    target = now_ts - window_min * 60
    slack_late = 20.0            # scan jitter: a snapshot 20 s "too new" still counts
    slack_early = max(90.0, window_min * 60 * 0.5)
    best = None
    for snap in reversed(hist):
        ts = snap[0]
        if ts >= now_ts - 1:
            continue
        if ts <= target + slack_late:
            best = snap
            break
    if best is None or best[0] < target - slack_early:
        return None
    return best


def pct(now_v, then_v):
    if now_v is None or then_v is None or then_v <= 0:
        return None
    return (now_v - then_v) / then_v * 100.0


class Collector:
    def __init__(self, helper, n_strikes: int, n_expiries: int):
        self.helper = helper
        self.qc = QuoteClient()
        self.n_strikes = n_strikes
        self.n_expiries = n_expiries
        self.universe_day = None
        self.underlyings = {}
        self.groups = {}
        self.group_spot = {}
        self.hist = {}        # (seg, sid) -> deque[(ts, ltp, oi_lots, vol_lots, iv)]
        self.spot_hist = {}   # sym -> deque[(ts, spot)]
        self.exch_scan = {}   # exch -> last scan epoch
        self.scanned_today = set()   # underlyings scanned at least once today
        self.last_payload = None

    def ensure_universe(self):
        today = today_ist()
        if self.universe_day == today:
            return
        df = self.helper._load_master_list()
        self.underlyings, self.groups, self.group_spot = build_universe(df, today, self.n_expiries)
        self.universe_day = today
        # A new trading day resets day volume/OI; yesterday's history would diff against it.
        self.hist.clear()
        self.spot_hist.clear()
        self.scanned_today.clear()
        log.info('universe: %d underlyings, %d expiry groups', len(self.underlyings), len(self.groups))

    def scan(self, scope, live_exchanges):
        """Scan the underlyings in `scope` whose exchange is open. An underlying that is in
        scope but hasn't been scanned yet today is scanned once even with its exchange shut,
        so a symbol added in the evening (or an off-hours start) shows its last session."""
        self.ensure_universe()
        syms = [s for s in sorted(scope) if s in self.underlyings
                and (self.underlyings[s]['exch'] in live_exchanges or s not in self.scanned_today)]
        if not syms:
            # Nothing to fetch, but a scope that SHRANK must still drop rows from the page.
            if self.last_payload and {r['u'] for r in self.last_payload['rows']} - set(scope):
                self.write_payload(set(), scope, [], {}, {}, set(), set())
            return 0
        sym_set = set(syms)

        # 1) spots: each underlying's own spot (display / "underlying %"), plus every
        #    group's pricing spot (the MCX option's own-month future).
        spot_keys = {(self.underlyings[s]['spot_seg'], int(self.underlyings[s]['spot_id'])) for s in syms}
        gkeys = [gk for gk in self.groups if gk[0] in sym_set]
        spot_keys.update(self.group_spot[gk] for gk in gkeys)
        spot_q = self.qc.quote(sorted(spot_keys))

        def ltp_of(key):
            got = spot_q.get(key)
            if not got:
                return None
            v = num(got[0].get('last_price'))
            return (v, got[1]) if v and v > 0 else None

        spots = {}
        for s in syms:
            m = self.underlyings[s]
            got = ltp_of((m['spot_seg'], int(m['spot_id'])))
            if got:
                spots[s] = got
        gspots = {}
        for gk in gkeys:
            got = ltp_of(self.group_spot[gk])
            if got:
                gspots[gk] = got[0]

        # 2) contract selection: ATM ± n on each tracked expiry
        picked = []   # (sym, exp, strike, typ, contract_meta, offset, atm_strike)
        group_meta = {}
        for gk in gkeys:
            if gk not in gspots:
                continue
            sym, exp = gk
            ladder = self.groups[gk]
            spot = gspots[gk]
            strikes = [r['strike'] for r in ladder]
            atm_idx = min(range(len(strikes)), key=lambda i: abs(strikes[i] - spot))
            lo = max(0, atm_idx - self.n_strikes)
            hi = min(len(ladder), atm_idx + self.n_strikes + 1)
            group_meta[gk] = {'atm': strikes[atm_idx], 'spot': spot}
            for i in range(lo, hi):
                row = ladder[i]
                for typ in ('CE', 'PE'):
                    c = row.get(typ)
                    if c:
                        picked.append((sym, exp, row['strike'], typ, c, i - atm_idx, strikes[atm_idx]))

        quotes = self.qc.quote([(c['seg'], c['sid']) for (_, _, _, _, c, _, _) in picked])

        # 3) raw values + IV
        recs = []
        # Groups with a contract whose quote batch failed. Their PCR / walls / straddle would be
        # computed over a partial ladder, so they keep the previous scan's group entry instead,
        # and the missing contracts keep their last row (without diffs).
        incomplete = set()
        missing_ids = set()
        for sym, exp, strike, typ, c, off, atm in picked:
            got = quotes.get((c['seg'], c['sid']))
            if not got:
                incomplete.add((sym, exp))
                missing_ids.add(f"{c['seg']}:{c['sid']}")
                continue
            q, ts = got
            ltp = num(q.get('last_price'))
            if not ltp or ltp <= 0:
                continue
            per_lot = c['qty_lot'] if c['seg'] != 'MCX_COMM' else 1
            oi = num(q.get('oi'), 0.0) / per_lot
            vol = num(q.get('volume'), 0.0) / per_lot
            recs.append({'sym': sym, 'exp': exp, 'strike': strike, 'typ': typ, 'c': c,
                         'off': off, 'atm': atm, 'ltp': ltp, 'oi': oi, 'vol': vol, 'ts': ts})

        if not recs:
            # Every quote batch failed (rate limit / token): keep the last good snapshot on
            # screen rather than overwriting it with an empty one. The status file carries
            # last_error for the page's banner.
            log.warning('scan of %d underlyings returned no quotes (%s) — snapshot left unchanged',
                        len(syms), self.qc.last_error)
            return 0
        if incomplete:
            log.warning('%d contracts in %d groups missing quotes — their group stats kept from the last scan',
                        len(missing_ids), len(incomplete))

        now = now_ist()
        S, K, T, isc, b76, P = [], [], [], [], [], []
        for r in recs:
            exch = self.underlyings[r['sym']]['exch']
            eh, em = EXPIRY_CLOSE[exch]
            exp_dt = datetime.strptime(r['exp'], '%Y-%m-%d').replace(hour=eh, minute=em)
            t_years = max((exp_dt - now).total_seconds(), 1800.0) / (365.0 * 86400.0)
            S.append(gspots[(r['sym'], r['exp'])])
            K.append(r['strike'])
            T.append(t_years)
            isc.append(r['typ'] == 'CE')
            b76.append(exch == 'MCX')
            P.append(r['ltp'])
        ivs = implied_vols(P, S, K, T, isc, b76, RISK_FREE_RATE) * 100.0  # library returns fractions; the snapshot stores percent
        for r, iv in zip(recs, ivs):
            r['iv'] = None if np.isnan(iv) else float(iv)

        # 4) history
        for s, (spot, ts) in spots.items():
            self.spot_hist.setdefault(s, deque()).append((ts, spot))
        for r in recs:
            key = (r['c']['seg'], r['c']['sid'])
            h = self.hist.setdefault(key, deque())
            h.append((r['ts'], r['ltp'], r['oi'], r['vol'], r.get('iv')))

        # prune history
        cutoff = time.time() - HISTORY_SEC
        for store in (self.hist, self.spot_hist):
            for k in list(store):
                dq = store[k]
                while dq and dq[0][0] < cutoff:
                    dq.popleft()
                if not dq:
                    del store[k]

        scan_ts = time.time()
        for s in syms:
            self.exch_scan[self.underlyings[s]['exch']] = scan_ts
        self.scanned_today.update(syms)

        self.write_payload(sym_set, scope, recs, spots, group_meta, incomplete, missing_ids)
        return len(recs)

    def _group_window(self, rows, atm, w):
        """Group-level change over `w` minutes, measured on the SAME contracts now and then.

        Baselines come from each contract's own history, so a spot move that rolls the ATM
        strike (or slides the ATM±N band by one strike) doesn't show up as a PCR, wall,
        straddle or tilt change: the straddle/tilt compare today's ATM strike with that same
        strike's premiums w minutes ago, and PCR/walls use only contracts that have a baseline.
        """
        pairs = []  # (row, baseline)
        for r in rows:
            b = baseline(self.hist.get((r['c']['seg'], r['c']['sid'])), r['ts'], w)
            if b:
                pairs.append((r, b))
        if not pairs:
            return None

        def wall(typ, then):
            # b[2] is the contract's OI (lots) at the baseline
            cands = [(b[2] if then else r['oi'], r['strike']) for r, b in pairs if r['typ'] == typ]
            return max(cands)[1] if cands else None

        ce_now_oi = sum(r['oi'] for r, _ in pairs if r['typ'] == 'CE')
        pe_now_oi = sum(r['oi'] for r, _ in pairs if r['typ'] == 'PE')
        ce_then_oi = sum(b[2] for r, b in pairs if r['typ'] == 'CE')
        pe_then_oi = sum(b[2] for r, b in pairs if r['typ'] == 'PE')
        pcr_d = None
        if ce_now_oi > 0 and ce_then_oi > 0:
            pcr_d = pe_now_oi / ce_now_oi - pe_then_oi / ce_then_oi

        atm_ce = next(((r, b) for r, b in pairs if r['strike'] == atm and r['typ'] == 'CE'), None)
        atm_pe = next(((r, b) for r, b in pairs if r['strike'] == atm and r['typ'] == 'PE'), None)
        str_d = tilt = None
        if atm_ce and atm_pe:
            str_d = pct(atm_ce[0]['ltp'] + atm_pe[0]['ltp'], atm_ce[1][1] + atm_pe[1][1])
            ce_p, pe_p = pct(atm_ce[0]['ltp'], atm_ce[1][1]), pct(atm_pe[0]['ltp'], atm_pe[1][1])
            tilt = ce_p - pe_p if ce_p is not None and pe_p is not None else None

        return {
            'pcr': rnd(pcr_d, 3),
            # "from" = the wall among these same contracts w minutes ago; now-wall is also taken
            # over the same set so a strike that merely entered/left the band can't move it.
            'ceWallFrom': wall('CE', True),
            'peWallFrom': wall('PE', True),
            'ceWallNow': wall('CE', False),
            'peWallNow': wall('PE', False),
            'str': rnd(str_d),
            'tilt': rnd(tilt),
        }

    def write_payload(self, scanned, scope, recs, spots, group_meta, incomplete, missing_ids):
        # Underlyings still in scope but not scanned this cycle (e.g. NSE after 15:30 while MCX
        # runs on) are carried from the previous payload so the page keeps their last state.
        # Anything that left the scope is dropped.
        carried_rows, carried_groups, carried_und = [], [], {}
        prev = self.last_payload
        if prev:
            keep = lambda u: u in scope and u not in scanned  # noqa: E731
            carried_rows = [r for r in prev['rows'] if keep(r['u'])]
            # Contracts whose quote batch failed this scan keep their last values (so they stay
            # visible and tradable) but lose their diffs — no preset may fire on a stale row.
            no_diff = {str(w): None for w in WINDOWS}
            carried_rows += [dict(r, d=no_diff, stale=True) for r in prev['rows'] if r['id'] in missing_ids]
            carried_groups = [g for g in prev['groups']
                              if keep(g['u']) or (g['u'], g['e']) in incomplete]
            carried_und = {k: v for k, v in prev['underlyings'].items() if keep(k)}

        und_out = dict(carried_und)
        for s, (spot, ts) in spots.items():
            m = self.underlyings[s]
            h = self.spot_hist.get(s)
            chg = {}
            for w in WINDOWS:
                b = baseline(h, ts, w)
                chg[str(w)] = rnd(pct(spot, b[1]) if b else None, 3)
            und_out[s] = {'kind': m['kind'], 'exch': m['exch'], 'spot': rnd(spot), 'chg': chg}

        rows_out = []
        for r in recs:
            c = r['c']
            h = self.hist.get((c['seg'], c['sid']))
            exch = self.underlyings[r['sym']]['exch']
            d = {}
            for w in WINDOWS:
                b = baseline(h, r['ts'], w)
                if not b:
                    d[str(w)] = None
                    continue
                _, b_ltp, b_oi, b_vol, b_iv = b
                win_vol = r['vol'] - b_vol if r['vol'] >= b_vol else None
                rvol = None
                elapsed = minutes_since_open(exch, b[0])
                if win_vol is not None and b_vol > 0 and elapsed >= 5:
                    rate = b_vol / elapsed
                    if rate > 0:
                        rvol = win_vol / (rate * w)
                iv_chg = r['iv'] - b_iv if r.get('iv') is not None and b_iv is not None else None
                d[str(w)] = [
                    rnd(pct(r['ltp'], b_ltp)),        # 0 premium %
                    rnd(pct(r['oi'], b_oi)),          # 1 OI %
                    rnd(win_vol, 1),                   # 2 window volume (lots)
                    rnd(rvol),                         # 3 RVOL (x)
                    rnd(iv_chg),                       # 4 IV change (vol pts)
                    rnd(r['oi'] - b_oi, 1),            # 5 OI change (lots)
                    rnd(r['ltp'] - b_ltp),             # 6 premium change (pts)
                ]
            rows_out.append({
                'id': f"{c['seg']}:{c['sid']}",
                'sid': str(c['sid']),
                'xs': c['seg'],
                'x': exch,
                'u': r['sym'],
                'k': self.underlyings[r['sym']]['kind'],
                'e': r['exp'],
                's': r['strike'],
                't': r['typ'],
                'off': r['off'],
                'lot': c['lot'],
                'mult': c['mult'],
                'tick': c['tick'],
                'ltp': rnd(r['ltp']),
                'oi': rnd(r['oi'], 1),
                'v': rnd(r['vol'], 1),
                'iv': rnd(r.get('iv')),
                'ts': int(r['ts']),
                'd': d,
            })

        groups_out = list(carried_groups)
        by_group = {}
        for r in recs:
            by_group.setdefault((r['sym'], r['exp']), []).append(r)
        for gk, rows in by_group.items():
            if gk in incomplete:
                continue  # previous entry carried above; a partial ladder would skew PCR/walls
            sym, exp = gk
            atm = group_meta.get(gk, {}).get('atm')
            ce_rows = [r for r in rows if r['typ'] == 'CE']
            pe_rows = [r for r in rows if r['typ'] == 'PE']
            ce_oi = sum(r['oi'] for r in ce_rows)
            pe_oi = sum(r['oi'] for r in pe_rows)
            atm_ce = next((r['ltp'] for r in ce_rows if r['strike'] == atm), None)
            atm_pe = next((r['ltp'] for r in pe_rows if r['strike'] == atm), None)
            groups_out.append({
                'u': sym, 'e': exp, 'x': self.underlyings[sym]['exch'],
                'atm': atm,
                'pcr': rnd(pe_oi / ce_oi if ce_oi > 0 else None, 3),
                'ceWall': max(ce_rows, key=lambda r: r['oi'])['strike'] if ce_rows else None,
                'peWall': max(pe_rows, key=lambda r: r['oi'])['strike'] if pe_rows else None,
                'straddle': rnd(atm_ce + atm_pe if atm_ce is not None and atm_pe is not None else None),
                'd': {str(w): self._group_window(rows, atm, w) for w in WINDOWS},
            })

        exch_out = {}
        now = now_ist()
        for ex in ('NSE', 'BSE', 'MCX'):
            ts = self.exch_scan.get(ex)
            exch_out[ex] = {
                'last_scan': int(ts) if ts else None,
                'live': session_open(ex, now),
                'contracts': sum(1 for r in rows_out if r['x'] == ex) + sum(1 for r in carried_rows if r['x'] == ex),
            }

        payload = {
            'v': 1,
            'generated_at': now.isoformat(timespec='seconds'),
            'date': today_ist().isoformat(),
            'windows': list(WINDOWS),
            'strikes': self.n_strikes,
            'exchanges': exch_out,
            # Every scannable underlying (the page's symbol picker must offer assets that are
            # not in scope yet) and what is actually being scanned right now.
            'universe': [{'u': u, 'k': m['kind']} for u, m in sorted(self.underlyings.items())],
            'scope': {'all': set(scope) >= set(self.underlyings), 'count': len(scope),
                      'symbols': sorted(scope) if len(scope) <= 40 else []},
            'underlyings': und_out,
            'groups': groups_out,
            'rows': carried_rows + rows_out,
        }
        write_json_atomic(SNAPSHOT_FILE, payload)
        self.last_payload = payload


# ---------------------------------------------------------------------------
# main loop
# ---------------------------------------------------------------------------

def stop_requested() -> bool:
    if os.path.exists(STOP_TRIGGER):
        try:
            os.remove(STOP_TRIGGER)
        except OSError:
            pass
        return True
    return False


def main():
    ap = argparse.ArgumentParser(description='Options Screener snapshot collector')
    ap.add_argument('--strikes', type=int, default=10, help='strikes each side of ATM (default 10)')
    ap.add_argument('--expiries', type=int, default=2, help='nearest expiries per underlying (default 2)')
    ap.add_argument('--interval', type=int, default=60, help='seconds between scans (default 60)')
    ap.add_argument('--once', action='store_true', help='run a single scan and exit')
    ap.add_argument('--all', action='store_true',
                    help='scan every underlying, ignoring the page selection (debug/options_screener_scope.json)')
    args = ap.parse_args()
    if not (1 <= args.strikes <= 15) or not (1 <= args.expiries <= 3) or args.interval < 30:
        print(json.dumps({'success': False, 'error': 'strikes 1-15, expiries 1-3, interval >= 30'}))
        return

    write_status(status='STARTING')
    try:
        from login import get_dhan_client
        from lib.dhan_helper import DhanHelper
        helper = DhanHelper(get_dhan_client())
    except Exception as exc:
        log.exception('init failed')
        write_status(status='STOPPED', reason='error', error=f'init failed: {exc}')
        return

    col = Collector(helper, args.strikes, args.expiries)
    skipped = 0
    try:
        while True:
            if stop_requested():
                write_status(status='STOPPED', reason='stop_trigger')
                log.info('stop trigger — exiting')
                return
            cycle_start = time.time()
            now = now_ist()
            live = [ex for ex in ('NSE', 'BSE', 'MCX') if session_open(ex, now)]
            n = 0
            scope, scope_all = set(), False
            col.qc.rate_limited = 0
            try:
                col.ensure_universe()
                scope, scope_all = read_scope(col.underlyings, args.all)
                n = col.scan(scope, live)
            except Exception as exc:
                log.exception('scan failed')
                write_status(status='RUNNING', error=str(exc), last_error=col.qc.last_error)
            took = time.time() - cycle_start
            # A scan that overran the interval (throttled by 429s) must not be followed
            # immediately by another one: wait for the next boundary instead, which also gives
            # the shared quote lane room to recover.
            periods = max(1, math.ceil(took / args.interval))
            if periods > 1:
                skipped += periods - 1
                log.warning('scan took %.0fs (> %ds interval) — skipping %d cycle(s)',
                            took, args.interval, periods - 1)
            write_status(
                status='RUNNING',
                last_scan=now.isoformat(timespec='seconds'),
                scan_seconds=round(took, 1),
                contracts=n,
                live=live,
                scope_count=len(scope),
                scope_all=scope_all,
                quote_gap_ms=int(col.qc.gap_ms),
                rate_limited=col.qc.rate_limited,
                skipped_cycles=skipped,
                last_error=col.qc.last_error,
            )
            if n:
                log.info('scan %d underlyings%s: %d contracts in %.1fs (quote gap %.1fs)',
                         len(scope), ' (all)' if scope_all else '', n, took, col.qc.gap_ms / 1000)
            if args.once:
                write_status(status='STOPPED', reason='once')
                return
            # After the MCX close there is nothing left to measure today.
            if not live and now.hour >= 23 and now.minute > 35:
                write_status(status='STOPPED', reason='market_closed')
                return
            # Align to the next interval boundary; poll the stop trigger meanwhile.
            sleep_until = cycle_start + args.interval * periods
            while time.time() < sleep_until:
                if os.path.exists(STOP_TRIGGER):
                    break
                time.sleep(1.0)
    except KeyboardInterrupt:
        write_status(status='STOPPED', reason='interrupted')


if __name__ == '__main__':
    main()
