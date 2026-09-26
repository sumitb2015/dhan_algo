"""
IV Snapshot Collector — runs from 09:15 to 15:40 IST, polling the NIFTY, BANKNIFTY,
and SENSEX option chains every 30 seconds and writing a full snapshot of ATM±10
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

ATM_RANGE   = 10          # ATM ± 10 strikes = 21 total
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

    # Wait for market open
    if not args.ignore_market_hours:
        while is_before_open(ist_now()):
            now = ist_now()
            wait_mins = (MARKET_OPEN[0] * 60 + MARKET_OPEN[1]) - minutes_since_midnight(now)
            log.info('Market not open yet — sleeping %d min', wait_mins)
            time.sleep(min(wait_mins * 60, 60))

    # Resolve expiries, spots, and strikes for each active underlying
    today = date.today()
    underlying_states = {}

    for u in active_underlyings:
        cfg = TARGETS[u]
        # Resolve expiry
        exp = args.expiry if (len(active_underlyings) == 1 and args.expiry) else None
        if not exp:
            try:
                exps = helper.get_expiry_list(under_security_id=cfg['chain_id'], under_exchange_segment=cfg['chain_seg'])
                exp = exps[0] if exps else None
            except Exception as e:
                log.error('Failed to get expiry for %s: %s', u, e)
                exp = None

        if not exp:
            log.warning('Skipping %s due to missing expiry', u)
            continue

        # Spot & ATM
        try:
            spot = helper.get_ltp(cfg['spot_id'], exchange='IDX_I', instrument='INDEX') or 0.0
        except Exception as e:
            log.error('Failed to get spot for %s: %s', u, e)
            spot = 0.0

        if not spot or spot <= 0:
            log.warning('Skipping %s due to zero spot price', u)
            continue

        step = cfg['step']
        atm = int(round(spot / step) * step)
        strikes = [atm + i * step for i in range(-ATM_RANGE, ATM_RANGE + 1)]

        out_paths = get_csv_paths(today, u)
        need_header = any(not os.path.exists(p) or os.path.getsize(p) == 0 for p in out_paths)

        underlying_states[u] = {
            'cfg': cfg,
            'expiry': exp,
            'spot': spot,
            'last_good_spot': spot,
            'atm': atm,
            'strikes': strikes,
            'out_paths': out_paths,
            'need_header': need_header,
        }
        log.info('[%s] Spot=%.2f  ATM=%d  strikes=%d–%d  expiry=%s',
                 u, spot, atm, strikes[0], strikes[-1], exp)

    if not underlying_states:
        log.error('No underlying could be initialized — exiting')
        sys.exit(1)

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

        for u, state in underlying_states.items():
            cfg = state['cfg']
            try:
                # Refresh spot
                fetched_spot = helper.get_ltp(cfg['spot_id'], exchange='IDX_I', instrument='INDEX')
                if fetched_spot and fetched_spot > 0:
                    state['last_good_spot'] = fetched_spot
                live_spot = state['last_good_spot']

                chain_data = helper.get_option_chain(cfg['chain_id'], state['expiry'], exchange_segment=cfg['chain_seg'])
                oc = chain_data.get('oc', {}) if chain_data else {}

                if not oc:
                    log.warning('[%s %s] Empty option chain response', u, ts)
                else:
                    rows = build_rows(ts, live_spot, state['expiry'], state['strikes'], oc)
                    if args.dry_run:
                        log.info('[%s %s] DRY RUN: %d rows (spot=%.2f)', u, ts, len(rows), live_spot)
                    else:
                        for out_path in state['out_paths']:
                            write_rows(out_path, rows, write_header=(state['need_header'] and iteration == 0))
                        state['need_header'] = False
                        log.info('[%s %s] Wrote %d rows (spot=%.2f)', u, ts, len(rows), live_spot)

                # Pace between underlying chain calls to avoid 429
                time.sleep(1.0)

            except Exception as exc:
                consecutive_failures += 1
                log.error('[%s %s] Error: %s', u, ts, exc)

        iteration += 1

        if consecutive_failures and consecutive_failures % 15 == 0:
            fresh = rebuild_helper(f'{consecutive_failures} consecutive poll failures')
            if fresh:
                helper = fresh

        time.sleep(max(5, POLL_SEC - (len(underlying_states) * 1.5)))


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        log.info('Interrupted — exiting')
