"""
IV Snapshot Collector — runs from 09:15 to 15:40 IST, polling the NIFTY, BANKNIFTY,
and SENSEX option chains every 30 seconds and writing a full snapshot of ATM±20
strikes to daily CSV files in debug/.

Usage:
    python scripts/tools/iv_snapshot_collector.py                    # Collects NIFTY, BANKNIFTY, SENSEX
    python scripts/tools/iv_snapshot_collector.py --underlying NIFTY # Collects only NIFTY
    python scripts/tools/iv_snapshot_collector.py --dry-run          # prints rows, no file write

Stop gracefully by writing debug/iv_snapshots_stop.trigger, or wait until 15:40.
"""
import sys
import os
import csv
import time
import argparse
import logging
from datetime import datetime, date

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib.prev_close_sidecar import write_prev_closes
from lib.eod_oi_sidecar import (
    eod_oi_from_chain, eod_oi_path, has_rolled, last_expiry_of_csv, previous_trading_day, session_prev_oi_from_csv,
    write_eod_oi,
)

_LOG_FILE = os.path.join(ROOT, 'debug', 'iv_snapshot_collector.log')
os.makedirs(os.path.join(ROOT, 'debug'), exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)s  %(message)s',
    datefmt='%H:%M:%S',
    filename=_LOG_FILE,
    filemode='a',
)
log = logging.getLogger(__name__)

TARGETS = {
    'NIFTY': {
        'spot_id': '13',
        'seg': 'IDX_I',
        'step': 50,
        'chain_id': 13,
        'chain_seg': 'IDX_I',
    },
    'BANKNIFTY': {
        'spot_id': '25',
        'seg': 'IDX_I',
        'step': 100,
        'chain_id': 25,
        'chain_seg': 'IDX_I',
    },
    'SENSEX': {
        'spot_id': '51',
        'seg': 'IDX_I',
        'step': 100,
        'chain_id': 1,
        'chain_seg': 'BSE_FNO',
    },
}

ATM_RANGE   = 20          # ATM ± 20 strikes = 41 total (the cumulative-OI PCR re-centres on spot inside this band)
POLL_SEC    = 30
MARKET_OPEN = (9, 15)     # HH, MM
MARKET_CLOSE = (15, 40)   # HH, MM — F&O close post-SEBI-CAS

CSV_COLUMNS = [
    'timestamp', 'spot', 'expiry', 'strike',
    'CE_LTP', 'CE_IV', 'CE_OI', 'CE_change_OI', 'CE_volume',
    'CE_bid', 'CE_ask', 'CE_delta', 'CE_gamma', 'CE_theta', 'CE_vega',
    'PE_LTP', 'PE_IV', 'PE_OI', 'PE_change_OI', 'PE_volume',
    'PE_bid', 'PE_ask', 'PE_delta', 'PE_gamma', 'PE_theta', 'PE_vega',
]


def ist_now() -> datetime:
    return datetime.now()


def minutes_since_midnight(dt: datetime) -> int:
    return dt.hour * 60 + dt.minute


# The collector gets ready this long before the open (expiry, spot, strike window), so the first chain read starts AT
# the open instead of after the setup calls. No EOD chain call is made inside this lead either: DhanHelper spaces
# option-chain calls 3 s apart, and that slot must be free at 09:15:00 (the Fresh Money board takes no order until
# today's first snapshot exists).
PREP_LEAD_S = 45


# The first snapshot of the day unlocks orders on the Fresh Money board and is the day's OI baseline, so it must be
# today's session, not what the chain still showed before the open. A pre-open reading of the chain is kept per index
# (chain_signature); at the open the first row is written once the chain differs from it, re-reading for at most
# FIRST_SNAPSHOT_WAIT_S and then writing anyway with a warning (never blocked for good). DhanHelper caches a chain for
# 5 s, so a re-read waits CHAIN_CACHE_S, and the pre-open reading is never taken inside the last BASELINE_MIN_LEAD_S
# (the 09:15:00 read would otherwise be served that cached pre-open chain).
FIRST_SNAPSHOT_WAIT_S = 11
CHAIN_CACHE_S = 5.2
BASELINE_MIN_LEAD_S = 9


def chain_signature(oc: dict) -> dict:
    """Per strike: (CE volume, CE last price, PE volume, PE last price) over the WHOLE chain. Any trade changes it."""
    sig = {}
    for k, v in (oc or {}).items():
        ce, pe = (v or {}).get('ce') or {}, (v or {}).get('pe') or {}
        sig[k] = (ce.get('volume'), ce.get('last_price'), pe.get('volume'), pe.get('last_price'))
    return sig


def first_live_chain(fetch, oc, baseline, wait_s=FIRST_SNAPSHOT_WAIT_S, retry_s=CHAIN_CACHE_S,
                     sleep=time.sleep, clock=time.monotonic):
    """The chain to write as the day's FIRST snapshot: `oc` when it already differs from the pre-open `baseline` (or
    there is none: started after the open, or the pre-open read failed); otherwise re-read until it differs or `wait_s`
    has passed. Returns (oc, live) — live False = still the pre-open picture, written anyway."""
    if not baseline:
        return oc, True
    deadline = clock() + wait_s
    while chain_signature(oc) == baseline:
        if clock() + retry_s > deadline:
            return oc, False
        sleep(retry_s)
        try:
            nxt = fetch()
        except Exception as e:  # noqa: BLE001 — a failed re-read is tried again until the deadline
            log.warning('First-snapshot re-read failed: %s', e)
            nxt = None
        if nxt:
            oc = nxt
    return oc, True


def recentre(state: dict, spot: float) -> bool:
    """Centre the strike window on `spot` (used once, before the day's first write: the window was built from a
    pre-open price). True when it moved."""
    step = state['cfg']['step']
    atm = int(round(spot / step) * step)
    if atm == state['atm']:
        return False
    state['atm'] = atm
    state['strikes'] = [atm + i * step for i in range(-ATM_RANGE, ATM_RANGE + 1)]
    return True


def chain_oc(helper, state) -> dict:
    cfg = state['cfg']
    data = helper.get_option_chain(cfg['chain_id'], state['expiry'], exchange_segment=cfg['chain_seg'])
    return data.get('oc', {}) if data else {}


def seconds_to_open(now: datetime) -> float:
    """Seconds (not whole minutes) until MARKET_OPEN today; <= 0 once the market is open."""
    open_dt = now.replace(hour=MARKET_OPEN[0], minute=MARKET_OPEN[1], second=0, microsecond=0)
    return (open_dt - now).total_seconds()


def prepare_for_open(helper, active, args, today, eod_tick, now=None, sleep=time.sleep):
    """Wait for the open, with every index initialised BEFORE it: returns (states, pending).

    1. More than PREP_LEAD_S to go: the EOD-OI task ticks, then sleep (at most a minute at a time).
    2. Inside the lead (or at once when started late / with --ignore-market-hours): expiry, spot and strike window per
       index. One that cannot start yet goes to `pending` and is retried by the poll loop; it is never dropped.
    3. Sleep exactly to the open. Nothing is written here: no snapshot row ever carries a pre-open time.
    """
    now = now or ist_now
    wait = not args.ignore_market_hours
    while wait:
        left = seconds_to_open(now())
        if left <= PREP_LEAD_S:
            break
        eod_tick()
        left = seconds_to_open(now())
        if left > PREP_LEAD_S:
            log.info('Market not open yet — %d s to go', int(left))
            sleep(min(60.0, left - PREP_LEAD_S))
    states, pending = {}, []
    for u in active:
        st = init_underlying(helper, u, TARGETS[u], args, len(active), today, sleep=sleep)
        if st:
            states[u] = st
        else:
            pending.append(u)
    if wait:
        # A pre-open reading of each chain, to tell today's session from it at the open (see first_live_chain).
        for u, st in states.items():
            if seconds_to_open(now()) < BASELINE_MIN_LEAD_S:
                break
            try:
                oc = chain_oc(helper, st)
                if oc:
                    st['pre_open_sig'] = chain_signature(oc)
            except Exception as e:  # noqa: BLE001 — no baseline = the first snapshot is written without the check
                log.warning('[%s] Pre-open chain read failed: %s', u, e)
        left = seconds_to_open(now())
        if left > 0:
            log.info('Ready for the open — first snapshot in %.1f s', left)
            sleep(left)
    return states, pending


def is_before_open(dt: datetime) -> bool:
    open_mins = MARKET_OPEN[0] * 60 + MARKET_OPEN[1]
    return minutes_since_midnight(dt) < open_mins


def is_after_close(dt: datetime) -> bool:
    close_mins = MARKET_CLOSE[0] * 60 + MARKET_CLOSE[1]
    return minutes_since_midnight(dt) >= close_mins


def is_trading_day(d: date) -> bool:
    if d.weekday() >= 5:  # 5=Sat, 6=Sun
        return False
    return d.isoformat() not in DhanHelper.NSE_HOLIDAYS


def get_csv_paths(today: date, underlying: str) -> list[str]:
    debug_dir = os.path.join(ROOT, 'debug')
    os.makedirs(debug_dir, exist_ok=True)
    d_str = today.isoformat()
    if underlying == 'NIFTY':
        return [
            os.path.join(debug_dir, f'iv_snapshots_{d_str}.csv'),
            os.path.join(debug_dir, f'iv_snapshots_NIFTY_{d_str}.csv'),
        ]
    return [os.path.join(debug_dir, f'iv_snapshots_{underlying}_{d_str}.csv')]


EOD_RETRY_SEC = 120   # official close OI: wait between tries while Dhan has not rolled `previous_oi` / a fetch failed


def eod_oi_step(helper, u, today: date) -> str:
    """One try at the previous session's official close OI for `u` (the chain's `previous_oi` today) into a side file
    next to that session's CSV, for the Fresh Money board. Returns:
      'done'  written (or already there),
      'skip'  nothing to do today (no CSV for the session right before today, or its expiry has expired: no chain),
      'retry' try again later (fetch failed / empty, or Dhan has not rolled `previous_oi` to that session yet).
    Never raises."""
    prev = previous_trading_day(today)
    try:
        paths = [p for p in get_csv_paths(prev, u) if os.path.exists(p)]
        if not paths:
            return 'skip'
        if all(os.path.exists(eod_oi_path(p)) for p in paths):
            return 'done'
        expiry = last_expiry_of_csv(paths[-1])
        if not expiry or expiry < today.isoformat():
            return 'skip'
        cfg = TARGETS[u]
        chain = helper.get_option_chain(cfg['chain_id'], expiry, exchange_segment=cfg['chain_seg'])
        fresh = eod_oi_from_chain(chain.get('oc', {}) if chain else {})
        rolled = has_rolled(fresh, session_prev_oi_from_csv(paths[-1], expiry))
        if not rolled:
            log.info('[%s] official close OI for %s: %s — retrying in %ds', u, prev.isoformat(),
                     'too few strikes to compare' if rolled is None else 'Dhan has not rolled previous_oi yet',
                     EOD_RETRY_SEC)
            return 'retry'
        fetched = ist_now().strftime('%Y-%m-%d %H:%M:%S')
        ok = all([write_eod_oi(p, prev.isoformat(), expiry, fresh, fetched) for p in paths])
        log.info('[%s] official close OI for %s (exp %s): %s', u, prev.isoformat(), expiry, 'written' if ok else 'write failed')
        return 'done' if ok else 'retry'
    except Exception as exc:  # noqa: BLE001 — best effort; collection must go on
        log.warning('[%s] official close OI for the previous session failed: %s', u, exc)
        return 'retry'


class EodOiTask:
    """Spreads the official-close fetches over the day: at most ONE chain call per `due()` slot, the next slot after
    EOD_RETRY_SEC, so a collector start or restart never delays a snapshot by more than one call."""

    def __init__(self, underlyings, today: date, clock=time.monotonic):
        self.pending = list(underlyings)
        self.today = today
        self.clock = clock
        self.next_at = 0.0

    def tick(self, helper) -> None:
        if not self.pending or self.clock() < self.next_at:
            return
        u = self.pending.pop(0)
        if eod_oi_step(helper, u, self.today) == 'retry':
            self.pending.append(u)
            self.next_at = self.clock() + EOD_RETRY_SEC
        else:
            self.next_at = self.clock() + 3.0   # Dhan option chain: one call per ~3 s


def stop_trigger_path() -> str:
    return os.path.join(ROOT, 'debug', 'iv_snapshots_stop.trigger')


def extract_side(side: dict) -> dict:
    greeks = side.get('greeks', {}) or {}
    oi = side.get('oi', '')
    previous_oi = side.get('previous_oi', '')
    change_oi = (oi - previous_oi) if isinstance(oi, (int, float)) and isinstance(previous_oi, (int, float)) else ''
    return {
        'LTP':       side.get('last_price', ''),
        'IV':        side.get('implied_volatility') or greeks.get('iv', ''),
        'OI':        oi,
        'change_OI': change_oi,
        'volume':    side.get('volume', ''),
        'bid':       side.get('bid_price', ''),
        'ask':       side.get('ask_price', ''),
        'delta':     greeks.get('delta', ''),
        'gamma':     greeks.get('gamma', ''),
        'theta':     greeks.get('theta', ''),
        'vega':      greeks.get('vega', ''),
    }


def build_oc_lookup(oc: dict) -> dict:
    lookup = {}
    for k, v in oc.items():
        try:
            lookup[float(k)] = v
        except (ValueError, TypeError):
            pass
    return lookup


def build_rows(ts: str, spot: float, expiry: str, strikes: list, oc: dict) -> list:
    oc_lookup = build_oc_lookup(oc)
    rows = []
    for strike in strikes:
        entry = oc_lookup.get(float(strike)) or {}
        ce = extract_side(entry.get('ce') or {})
        pe = extract_side(entry.get('pe') or {})
        row = {
            'timestamp':    ts,
            'spot':         round(spot, 2),
            'expiry':       expiry,
            'strike':       int(strike),
            'CE_LTP':       ce['LTP'],
            'CE_IV':        ce['IV'],
            'CE_OI':        ce['OI'],
            'CE_change_OI': ce['change_OI'],
            'CE_volume':    ce['volume'],
            'CE_bid':       ce['bid'],
            'CE_ask':       ce['ask'],
            'CE_delta':     ce['delta'],
            'CE_gamma':     ce['gamma'],
            'CE_theta':     ce['theta'],
            'CE_vega':      ce['vega'],
            'PE_LTP':       pe['LTP'],
            'PE_IV':        pe['IV'],
            'PE_OI':        pe['PE_OI'] if 'PE_OI' in pe else pe['OI'],
            'PE_change_OI': pe['change_OI'],
            'PE_volume':    pe['volume'],
            'PE_bid':       pe['bid'],
            'PE_ask':       pe['ask'],
            'PE_delta':     pe['delta'],
            'PE_gamma':     pe['gamma'],
            'PE_theta':     pe['theta'],
            'PE_vega':      pe['vega'],
        }
        rows.append(row)
    return rows


def rebuild_helper(reason: str):
    log.info('Attempting to rebuild DhanHelper: %s', reason)
    try:
        dhan = get_dhan_client()
        if dhan:
            h = DhanHelper(dhan)
            log.info('DhanHelper rebuilt successfully')
            return h
    except Exception as exc:
        log.warning('Rebuild attempt failed: %s', exc)
    return None


def write_rows(path: str, rows: list, write_header: bool) -> None:
    mode = 'a' if os.path.exists(path) and not write_header else 'w'
    with open(path, mode, newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        if mode == 'w':
            writer.writeheader()
        writer.writerows(rows)


SPOT_TRIES = 4
SPOT_RETRY_WAIT_S = 1.5


def spot_with_retry(fetch, tries=SPOT_TRIES, wait_s=SPOT_RETRY_WAIT_S, sleep=time.sleep) -> float:
    """A spot price, retried: Dhan's quote API is ~1 req/s per account and answers an empty 'failure' when busy (a
    dashboard restart makes a burst of quote calls exactly when this collector starts). 0.0 after `tries` failures."""
    for i in range(tries):
        try:
            v = fetch()
            if v and v > 0:
                return float(v)
        except Exception as e:  # noqa: BLE001 — a failed read is retried like an empty one
            log.warning('Spot read failed (try %d/%d): %s', i + 1, tries, e)
        if i < tries - 1:
            sleep(wait_s)
    return 0.0


def init_underlying(helper, u, cfg, args, n_active, today, sleep=time.sleep, tries=SPOT_TRIES):
    """Expiry, spot, ATM strike window and output paths for one index; None when the expiry or spot is not known yet
    (the caller keeps it pending and tries again on a later cycle — an index is never dropped for the day)."""
    exp = args.expiry if (n_active == 1 and args.expiry) else None
    if not exp:
        try:
            exps = helper.get_expiry_list(under_security_id=cfg['chain_id'], under_exchange_segment=cfg['chain_seg'])
            exp = exps[0] if exps else None
        except Exception as e:  # noqa: BLE001
            log.error('Failed to get expiry for %s: %s', u, e)
            exp = None
    if not exp:
        log.warning('%s: no expiry yet — will retry', u)
        return None
    spot = spot_with_retry(lambda: helper.get_ltp(cfg['spot_id'], exchange='IDX_I', instrument='INDEX'),
                           tries=tries, sleep=sleep)
    if not spot or spot <= 0:
        log.warning('%s: no spot price yet — will retry next cycle', u)
        return None
    step = cfg['step']
    atm = int(round(spot / step) * step)
    strikes = [atm + i * step for i in range(-ATM_RANGE, ATM_RANGE + 1)]
    out_paths = get_csv_paths(today, u)
    need_header = any(not os.path.exists(p) or os.path.getsize(p) == 0 for p in out_paths)
    log.info('[%s] Spot=%.2f  ATM=%d  strikes=%d–%d  expiry=%s', u, spot, atm, strikes[0], strikes[-1], exp)
    return {
        'cfg': cfg, 'expiry': exp, 'spot': spot, 'last_good_spot': spot, 'atm': atm, 'strikes': strikes,
        'out_paths': out_paths, 'need_header': need_header,
    }


def retry_pending(helper, pending, states, args, today, sleep=time.sleep):
    """One more try (a single spot read each, so the poll is not stalled) for indexes that could not start yet;
    those that start move from `pending` into `states`."""
    for u in list(pending):
        st = init_underlying(helper, u, TARGETS[u], args, len(pending) + len(states), today, sleep=sleep, tries=1)
        if st:
            states[u] = st
            pending.remove(u)
            log.info('%s joined the collection', u)


def main():
    parser = argparse.ArgumentParser(description='Multi-Underlying IV Snapshot Collector')
    parser.add_argument('--underlying', default='ALL', help='NIFTY, BANKNIFTY, SENSEX, or ALL')
    parser.add_argument('--expiry',     default='', help='Expiry date YYYY-MM-DD; auto-detects if omitted')
    parser.add_argument('--dry-run',    action='store_true', help='Print rows to stdout, do not write CSV')
    parser.add_argument('--ignore-market-hours', action='store_true', help='Ignore market open/close times')
    args = parser.parse_args()

    req_u = args.underlying.upper()
    if req_u == 'ALL':
        active_underlyings = ['NIFTY', 'BANKNIFTY', 'SENSEX']
    elif req_u in TARGETS:
        active_underlyings = [req_u]
    else:
        log.error('Unsupported underlying: %s', req_u)
        sys.exit(1)

    if not args.ignore_market_hours and not is_trading_day(ist_now().date()):
        log.info('Not a trading day (%s) — exiting without collecting', ist_now().date().isoformat())
        return

    dhan = None
    while not dhan:
        try:
            dhan = get_dhan_client()
        except Exception:
            dhan = None
        if not dhan:
            if not args.ignore_market_hours and is_after_close(ist_now()):
                log.error('Market closed before valid auth token was provided — exiting')
                sys.exit(1)
            log.warning('Auth failed / token expired — waiting for login.py / dashboard login (retrying in 15s)...')
            time.sleep(15)

    helper = DhanHelper(dhan)

    # The previous session's official close OI for the Fresh Money board (Dhan revises in-session OI after the close).
    # Tried during the pre-open wait and between polls, one chain call at a time, until Dhan has rolled it.
    eod_task = EodOiTask([] if args.dry_run else active_underlyings, date.today())

    # Wait for the open with expiries, spots and strikes already resolved, so the first snapshot starts at 09:15:00
    # (see prepare_for_open). One index that cannot start yet stays pending and is retried every cycle — it is never
    # dropped for the day.
    today = date.today()
    underlying_states, pending = prepare_for_open(helper, active_underlyings, args, today, lambda: eod_task.tick(helper))
    if pending:
        log.warning('Not started yet (retried every cycle): %s', pending)

    log.info('Starting snapshot collection for %s', list(underlying_states.keys()))

    # Main collection loop
    iteration = 0
    consecutive_failures = 0

    while True:
        now = ist_now()

        if not args.ignore_market_hours and is_after_close(now):
            log.info('Market closed (15:40) — exiting')
            break

        if os.path.exists(stop_trigger_path()):
            os.remove(stop_trigger_path())
            log.info('Stop trigger detected — exiting')
            break

        ts = now.strftime('%Y-%m-%d %H:%M:%S')

        for u, state in list(underlying_states.items()):
            cfg = state['cfg']
            try:
                # Refresh spot
                fetched_spot = helper.get_ltp(cfg['spot_id'], exchange='IDX_I', instrument='INDEX')
                if fetched_spot and fetched_spot > 0:
                    state['last_good_spot'] = fetched_spot
                live_spot = state['last_good_spot']

                oc = chain_oc(helper, state)

                if oc and not state.get('written'):
                    # The day's first snapshot: today's session only, on a strike window centred on the live price.
                    oc, live = first_live_chain(lambda st=state: chain_oc(helper, st), oc, state.get('pre_open_sig'))
                    if not live:
                        log.warning('[%s] Chain still shows the pre-open picture after %d s — writing it anyway', u, FIRST_SNAPSHOT_WAIT_S)
                    ts = ist_now().strftime('%Y-%m-%d %H:%M:%S')
                    if state.get('pre_open_sig') is not None:
                        fresh = helper.get_ltp(cfg['spot_id'], exchange='IDX_I', instrument='INDEX')
                        if fresh and fresh > 0:
                            state['last_good_spot'] = live_spot = fresh
                        if recentre(state, live_spot):
                            log.info('[%s] Strike window re-centred on the opening price: ATM=%d', u, state['atm'])

                if not oc:
                    log.warning('[%s %s] Empty option chain response', u, ts)
                else:
                    rows = build_rows(ts, live_spot, state['expiry'], state['strikes'], oc)
                    if args.dry_run:
                        log.info('[%s %s] DRY RUN: %d rows (spot=%.2f)', u, ts, len(rows), live_spot)
                    else:
                        for out_path in state['out_paths']:
                            write_rows(out_path, rows, write_header=(state['need_header'] and iteration == 0))
                            # Option previous closes for the Fresh Money board's buildup tags (side file, CSV unchanged).
                            write_prev_closes(out_path, state['expiry'], oc)
                        state['need_header'] = False
                        log.info('[%s %s] Wrote %d rows (spot=%.2f)', u, ts, len(rows), live_spot)

                    state['written'] = True   # the first-snapshot check runs once (a dry run counts)

                # Pace between underlying chain calls to avoid 429
                time.sleep(1.0)

            except Exception as exc:
                consecutive_failures += 1
                log.error('[%s %s] Error: %s', u, ts, exc)

        # After the reads, never before them: a retry's expiry lookup shares DhanHelper's 3 s option-chain slot, which
        # must be free for the first read at the open.
        if pending:
            retry_pending(helper, pending, underlying_states, args, today)

        iteration += 1
        eod_task.tick(helper)

        if consecutive_failures and consecutive_failures % 15 == 0:
            fresh = rebuild_helper(f'{consecutive_failures} consecutive poll failures')
            if fresh:
                helper = fresh

        time.sleep(max(5, POLL_SEC - (max(1, len(underlying_states)) * 1.5)))


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        log.info('Interrupted — exiting')
