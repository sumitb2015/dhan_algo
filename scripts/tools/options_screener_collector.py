"""
Options Screener collector — "what changed in the last 1-30 min" across index, stock and
MCX options. Backs the dashboard's /options-screener page.

Every minute it:
  1. resolves each underlying's spot (index/equity LTP, or the nearest MCX future),
  2. picks ATM±N strikes (CE+PE) on the nearest `--expiries` expiries of every option
     underlying in master_list.csv (NSE index + stock options, SENSEX/BANKEX, MCX options),
  3. pulls LTP / OI / day volume for all of them through Dhan's batched
     /marketfeed/quote (≤1000 instruments per call, paced 1.1 s — the bucket is account-wide),
  4. solves IV locally (Black-Scholes for NSE/BSE, Black-76 for MCX options on futures),
  5. diffs each contract against its own snapshot 1/3/5/10/15/30 minutes ago and writes the
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

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

DEBUG_DIR = os.path.join(ROOT, 'debug')
SNAPSHOT_FILE = os.path.join(DEBUG_DIR, 'options_screener_snapshot.json')
STATUS_FILE = os.path.join(DEBUG_DIR, 'options_screener_status.json')
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
RISK_FREE = 0.065

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


# ---------------------------------------------------------------------------
# IV — vectorised bisection (Black-Scholes / Black-76)
# ---------------------------------------------------------------------------

def _norm_cdf(x: np.ndarray) -> np.ndarray:
    # Abramowitz-Stegun 7.1.26 erf, |error| < 1.5e-7 — plenty for an IV display.
    z = np.abs(x) / math.sqrt(2.0)
    t = 1.0 / (1.0 + 0.3275911 * z)
    poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
    erf = 1.0 - poly * np.exp(-z * z)
    return 0.5 * (1.0 + np.sign(x) * erf)


def _price(S, K, T, sigma, is_call, black76):
    """Vectorised premium; `black76` picks Black-76 (options on futures) per element."""
    sq = sigma * np.sqrt(T)
    disc = np.exp(-RISK_FREE * T)
    with np.errstate(divide='ignore', invalid='ignore'):
        # Black-76 on F is Black-Scholes on S = F*disc with the same strike and rate.
        S_eff = np.where(black76, S * disc, S)
        d1 = (np.log(S_eff / K) + (RISK_FREE + 0.5 * sigma * sigma) * T) / sq
        d2 = d1 - sq
        call = S_eff * _norm_cdf(d1) - K * disc * _norm_cdf(d2)
        put = K * disc * _norm_cdf(-d2) - S_eff * _norm_cdf(-d1)
    return np.where(is_call, call, put)


def implied_vols(price, S, K, T, is_call, black76) -> np.ndarray:
    """IV in percent, NaN where the premium sits outside no-arbitrage bounds."""
    price = np.asarray(price, float)
    S = np.asarray(S, float)
    K = np.asarray(K, float)
    T = np.asarray(T, float)
    is_call = np.asarray(is_call, bool)
    black76 = np.asarray(black76, bool)
    n = len(price)
    if n == 0:
        return np.array([])
    lo = np.full(n, 0.005)
    hi = np.full(n, 5.0)
    p_lo = _price(S, K, T, lo, is_call, black76)
    p_hi = _price(S, K, T, hi, is_call, black76)
    valid = (price > 0) & (S > 0) & (K > 0) & (T > 0) & (price > p_lo) & (price < p_hi)
    for _ in range(48):
        mid = 0.5 * (lo + hi)
        pm = _price(S, K, T, mid, is_call, black76)
        up = pm < price
        lo = np.where(up, mid, lo)
        hi = np.where(up, hi, mid)
    iv = 0.5 * (lo + hi) * 100.0
    return np.where(valid, iv, np.nan)


# ---------------------------------------------------------------------------
# universe from master_list.csv
# ---------------------------------------------------------------------------

def build_universe(df, today: date, n_expiries: int):
    """Return (underlyings, strikes_by_group).

    underlyings: sym -> {kind, exch, spot_seg, spot_id}
    strikes_by_group: (sym, expiry) -> sorted list of dicts {strike, CE: row, PE: row}
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
            ge = g[g['EXP'] == exp]
            by_strike = {}
            for r in ge.itertuples(index=False):
                strike = num(getattr(r, 'STRIKE_PRICE'))
                if not strike:
                    continue
                lot_raw = num(getattr(r, 'LOT_SIZE'), 1) or 1
                lot = 1 if exch == 'MCX' else int(lot_raw)
                mult = MCX_CONTRACT_SIZE.get(sym, 1) if exch == 'MCX' else int(lot_raw)
                tick = num(getattr(r, tick_col), 0.05) if tick_col else 0.05
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
    return underlyings, groups


# ---------------------------------------------------------------------------
# quote fetching
# ---------------------------------------------------------------------------

class QuoteClient:
    def __init__(self, dhan):
        self.dhan = dhan
        self._last = 0.0
        self.last_error = None

    def _pace(self):
        wait = self._last + QUOTE_GAP_SEC - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    def quote(self, instruments):
        """instruments: list of (seg, sid). Returns {(seg, sid): (quote_dict, fetch_ts)}."""
        out = {}
        for i in range(0, len(instruments), QUOTE_BATCH):
            chunk = instruments[i:i + QUOTE_BATCH]
            securities = {}
            for seg, sid in chunk:
                securities.setdefault(seg, []).append(int(sid))
            data = None
            for attempt in range(3):
                self._pace()
                try:
                    res = self.dhan.quote_data(securities=securities)
                except Exception as exc:  # network / SDK error
                    res = {'status': 'failure', 'remarks': str(exc)}
                if isinstance(res, dict) and res.get('status') == 'success':
                    data = res.get('data', {})
                    if isinstance(data, dict) and 'data' in data:
                        data = data['data']
                    break
                remark = res.get('remarks') if isinstance(res, dict) else str(res)
                self.last_error = str(remark)[:300]
                # Rate-limited or transient: back off harder than the pacer before retrying.
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
        self.qc = QuoteClient(helper.dhan)
        self.n_strikes = n_strikes
        self.n_expiries = n_expiries
        self.universe_day = None
        self.underlyings = {}
        self.groups = {}
        self.hist = {}        # (seg, sid) -> deque[(ts, ltp, oi_lots, vol_lots, iv)]
        self.spot_hist = {}   # sym -> deque[(ts, spot)]
        self.group_hist = {}  # (sym, exp) -> deque[(ts, pcr, ce_wall, pe_wall, straddle, atm_ce, atm_pe)]
        self.exch_scan = {}   # exch -> last scan epoch
        self.last_payload = None

    def ensure_universe(self):
        today = today_ist()
        if self.universe_day == today:
            return
        df = self.helper._load_master_list()
        self.underlyings, self.groups = build_universe(df, today, self.n_expiries)
        self.universe_day = today
        # A new trading day resets day volume/OI; yesterday's history would diff against it.
        self.hist.clear()
        self.spot_hist.clear()
        self.group_hist.clear()
        log.info('universe: %d underlyings, %d expiry groups', len(self.underlyings), len(self.groups))

    def scan(self, exchanges):
        self.ensure_universe()
        syms = [s for s, m in self.underlyings.items() if m['exch'] in exchanges]
        if not syms:
            return 0

        # 1) spots
        spot_req = [(self.underlyings[s]['spot_seg'], self.underlyings[s]['spot_id']) for s in syms]
        spot_q = self.qc.quote(spot_req)
        spots = {}
        for s in syms:
            m = self.underlyings[s]
            got = spot_q.get((m['spot_seg'], int(m['spot_id'])))
            if got:
                ltp = num(got[0].get('last_price'))
                if ltp and ltp > 0:
                    spots[s] = (ltp, got[1])

        # 2) contract selection: ATM ± n on each tracked expiry
        picked = []   # (sym, exp, strike, typ, contract_meta, offset, atm_strike)
        group_meta = {}
        for (sym, exp), ladder in self.groups.items():
            if sym not in spots:
                continue
            spot = spots[sym][0]
            strikes = [r['strike'] for r in ladder]
            atm_idx = min(range(len(strikes)), key=lambda i: abs(strikes[i] - spot))
            lo = max(0, atm_idx - self.n_strikes)
            hi = min(len(ladder), atm_idx + self.n_strikes + 1)
            group_meta[(sym, exp)] = {'atm': strikes[atm_idx], 'spot': spot}
            for i in range(lo, hi):
                row = ladder[i]
                for typ in ('CE', 'PE'):
                    c = row.get(typ)
                    if c:
                        picked.append((sym, exp, row['strike'], typ, c, i - atm_idx, strikes[atm_idx]))

        quotes = self.qc.quote([(c['seg'], c['sid']) for (_, _, _, _, c, _, _) in picked])

        # 3) raw values + IV
        recs = []
        for sym, exp, strike, typ, c, off, atm in picked:
            got = quotes.get((c['seg'], c['sid']))
            if not got:
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
            log.warning('scan %s returned no quotes (%s) — snapshot left unchanged',
                        ','.join(exchanges), self.qc.last_error)
            return 0

        now = now_ist()
        if recs:
            S, K, T, isc, b76, P = [], [], [], [], [], []
            for r in recs:
                exch = self.underlyings[r['sym']]['exch']
                eh, em = EXPIRY_CLOSE[exch]
                exp_dt = datetime.strptime(r['exp'], '%Y-%m-%d').replace(hour=eh, minute=em)
                t_years = max((exp_dt - now).total_seconds(), 1800.0) / (365.0 * 86400.0)
                S.append(spots[r['sym']][0])
                K.append(r['strike'])
                T.append(t_years)
                isc.append(r['typ'] == 'CE')
                b76.append(exch == 'MCX')
                P.append(r['ltp'])
            ivs = implied_vols(P, S, K, T, isc, b76)
            for r, iv in zip(recs, ivs):
                r['iv'] = None if np.isnan(iv) else float(iv)

        # 4) history + diffs
        for s, (spot, ts) in spots.items():
            self.spot_hist.setdefault(s, deque()).append((ts, spot))
        for r in recs:
            key = (r['c']['seg'], r['c']['sid'])
            h = self.hist.setdefault(key, deque())
            h.append((r['ts'], r['ltp'], r['oi'], r['vol'], r.get('iv')))

        # group-level (PCR / walls / ATM straddle) from this scan's records
        by_group = {}
        for r in recs:
            by_group.setdefault((r['sym'], r['exp']), []).append(r)
        group_now = {}
        for gk, rows in by_group.items():
            ce_oi = sum(r['oi'] for r in rows if r['typ'] == 'CE')
            pe_oi = sum(r['oi'] for r in rows if r['typ'] == 'PE')
            ce_rows = [r for r in rows if r['typ'] == 'CE']
            pe_rows = [r for r in rows if r['typ'] == 'PE']
            ce_wall = max(ce_rows, key=lambda r: r['oi'])['strike'] if ce_rows else None
            pe_wall = max(pe_rows, key=lambda r: r['oi'])['strike'] if pe_rows else None
            atm_ce = next((r['ltp'] for r in ce_rows if r['off'] == 0), None)
            atm_pe = next((r['ltp'] for r in pe_rows if r['off'] == 0), None)
            straddle = atm_ce + atm_pe if atm_ce is not None and atm_pe is not None else None
            pcr = pe_oi / ce_oi if ce_oi > 0 else None
            ts = max(r['ts'] for r in rows)
            snap = (ts, pcr, ce_wall, pe_wall, straddle, atm_ce, atm_pe)
            self.group_hist.setdefault(gk, deque()).append(snap)
            group_now[gk] = snap

        # prune history
        cutoff = time.time() - HISTORY_SEC
        for store in (self.hist, self.spot_hist, self.group_hist):
            for k in list(store):
                dq = store[k]
                while dq and dq[0][0] < cutoff:
                    dq.popleft()
                if not dq:
                    del store[k]

        scan_ts = time.time()
        for ex in exchanges:
            self.exch_scan[ex] = scan_ts

        self.write_payload(exchanges, recs, spots, group_meta, group_now)
        return len(recs)

    def write_payload(self, exchanges, recs, spots, group_meta, group_now):
        # Rows from exchanges not scanned this cycle (e.g. NSE after 15:30 while MCX runs on)
        # are carried from the previous payload so the page keeps showing their last state.
        carried_rows, carried_groups, carried_und = [], [], {}
        prev = self.last_payload
        if prev:
            carried_rows = [r for r in prev['rows'] if r['x'] not in exchanges]
            carried_groups = [g for g in prev['groups'] if g['x'] not in exchanges]
            carried_und = {k: v for k, v in prev['underlyings'].items() if v['exch'] not in exchanges}

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
        for gk, snap in group_now.items():
            sym, exp = gk
            h = self.group_hist.get(gk)
            ts, pcr, ce_wall, pe_wall, straddle, atm_ce, atm_pe = snap
            d = {}
            for w in WINDOWS:
                b = baseline(h, ts, w)
                if not b:
                    d[str(w)] = None
                    continue
                _, b_pcr, b_cew, b_pew, b_str, b_ce, b_pe = b
                ce_p, pe_p = pct(atm_ce, b_ce), pct(atm_pe, b_pe)
                d[str(w)] = {
                    'pcr': rnd(pcr - b_pcr, 3) if pcr is not None and b_pcr is not None else None,
                    'ceWallFrom': b_cew,
                    'peWallFrom': b_pew,
                    'str': rnd(pct(straddle, b_str)),
                    'tilt': rnd(ce_p - pe_p) if ce_p is not None and pe_p is not None else None,
                }
            groups_out.append({
                'u': sym, 'e': exp, 'x': self.underlyings[sym]['exch'],
                'atm': group_meta.get(gk, {}).get('atm'),
                'pcr': rnd(pcr, 3), 'ceWall': ce_wall, 'peWall': pe_wall,
                'straddle': rnd(straddle), 'd': d,
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
    first = True
    try:
        while True:
            if stop_requested():
                write_status(status='STOPPED', reason='stop_trigger')
                log.info('stop trigger — exiting')
                return
            cycle_start = time.time()
            now = now_ist()
            live = [ex for ex in ('NSE', 'BSE', 'MCX') if session_open(ex, now)]
            # The first scan always runs so an off-hours start still shows the last session.
            exchanges = ('NSE', 'BSE', 'MCX') if first else tuple(live)
            n = 0
            if exchanges:
                try:
                    n = col.scan(exchanges)
                    first = False
                except Exception as exc:
                    log.exception('scan failed')
                    write_status(status='RUNNING', error=str(exc), last_error=col.qc.last_error)
            took = time.time() - cycle_start
            write_status(
                status='RUNNING',
                last_scan=now.isoformat(timespec='seconds'),
                scan_seconds=round(took, 1),
                contracts=n,
                live=live,
                last_error=col.qc.last_error,
            )
            if n:
                log.info('scan %s: %d contracts in %.1fs', ','.join(exchanges), n, took)
            if args.once:
                write_status(status='STOPPED', reason='once')
                return
            # After the MCX close there is nothing left to measure today.
            if not live and now.hour >= 23 and now.minute > 35:
                write_status(status='STOPPED', reason='market_closed')
                return
            # Align to the next interval boundary; poll the stop trigger meanwhile.
            sleep_until = cycle_start + args.interval
            while time.time() < sleep_until:
                if os.path.exists(STOP_TRIGGER):
                    break
                time.sleep(1.0)
    except KeyboardInterrupt:
        write_status(status='STOPPED', reason='interrupted')


if __name__ == '__main__':
    main()
