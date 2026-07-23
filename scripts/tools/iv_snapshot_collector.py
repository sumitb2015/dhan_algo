"""
IV Snapshot Collector — runs from 09:15 to 15:30 IST, polling the NIFTY option chain
every 30 seconds and writing a full snapshot of ATM±10 strikes to a daily CSV file.

The ATM is locked at market open (first poll after 09:15) so the strike list stays
constant throughout the day, making the CSV suitable for multi-strike IV charts.

Usage:
    python scripts/tools/iv_snapshot_collector.py
    python scripts/tools/iv_snapshot_collector.py --expiry 2026-07-03
    python scripts/tools/iv_snapshot_collector.py --dry-run   # prints rows, no file write

Stop gracefully by writing debug/iv_snapshots_stop.trigger, or wait until 15:30.
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

UNDERLYING_IDS = {'NIFTY': 13, 'BANKNIFTY': 25, 'FINNIFTY': 27}
STRIKE_STEP = 50
ATM_RANGE   = 10          # ATM ± 10 strikes = 21 total
POLL_SEC    = 30
MARKET_OPEN = (9, 15)     # HH, MM
MARKET_CLOSE = (15, 30)   # HH, MM

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


def csv_path(today: date) -> str:
    debug_dir = os.path.join(ROOT, 'debug')
    os.makedirs(debug_dir, exist_ok=True)
    return os.path.join(debug_dir, f'iv_snapshots_{today.isoformat()}.csv')


def stop_trigger_path() -> str:
    return os.path.join(ROOT, 'debug', 'iv_snapshots_stop.trigger')


def extract_side(side: dict) -> dict:
    """Extract all useful fields from a CE or PE option side dict."""
    greeks = side.get('greeks', {}) or {}
    return {
        'LTP':       side.get('last_price', ''),
        'IV':        side.get('implied_volatility') or greeks.get('iv', ''),
        'OI':        side.get('oi', ''),
        'change_OI': side.get('change_in_open_interest') or side.get('oi_change', ''),
        'volume':    side.get('volume', ''),
        'bid':       side.get('bid_price', ''),
        'ask':       side.get('ask_price', ''),
        'delta':     greeks.get('delta', ''),
        'gamma':     greeks.get('gamma', ''),
        'theta':     greeks.get('theta', ''),
        'vega':      greeks.get('vega', ''),
    }


def build_oc_lookup(oc: dict) -> dict:
    """Convert the raw oc dict to a float-keyed lookup, handling any numeric string format."""
    lookup = {}
    for k, v in oc.items():
        try:
            lookup[float(k)] = v
        except (ValueError, TypeError):
            pass
    return lookup


def build_rows(ts: str, spot: float, expiry: str, strikes: list, oc: dict,
               _logged_keys: list = None) -> list:
    """Build one CSV row per strike from the raw `oc` dict."""
    oc_lookup = build_oc_lookup(oc)

    # One-time diagnostic: log actual key samples when nothing matches
    if _logged_keys is not None and not _logged_keys and not oc_lookup:
        sample = list(oc.keys())[:5]
        log.warning('OC dict has %d keys but none are numeric. Sample keys: %s', len(oc), sample)
        _logged_keys.append(True)
    elif _logged_keys is not None and not _logged_keys and oc_lookup:
        sample_keys = list(oc.keys())[:5]
        log.info('OC key format sample (first 5): %s', sample_keys)
        _logged_keys.append(True)

    rows = []
    missed = []
    for strike in strikes:
        entry = oc_lookup.get(float(strike))
        if not entry:
            missed.append(strike)
            entry = {}
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
            'PE_OI':        pe['OI'],
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
    if missed:
        log.warning('Strikes not found in OC response: %d/%d missing', len(missed), len(strikes))
    return rows


def write_rows(path: str, rows: list, write_header: bool) -> None:
    mode = 'a' if os.path.exists(path) and not write_header else 'w'
    with open(path, mode, newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        if mode == 'w':
            writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description='IV Snapshot Collector')
    parser.add_argument('--underlying', default='NIFTY')
    parser.add_argument('--expiry',     default='', help='Expiry date YYYY-MM-DD; auto-detects nearest if omitted')
    parser.add_argument('--dry-run',    action='store_true', help='Print rows to stdout, do not write CSV')
    parser.add_argument('--ignore-market-hours', action='store_true', help='Ignore market open/close times')
    args = parser.parse_args()

    underlying = args.underlying.upper()

    dhan = get_dhan_client()
    if not dhan:
        log.error('Auth failed — run login.py to refresh the access token')
        sys.exit(1)

    helper = DhanHelper(dhan)

    # ── Wait for market open ──────────────────────────────────────────
    if not args.ignore_market_hours:
        while is_before_open(ist_now()):
            now = ist_now()
            wait_mins = (MARKET_OPEN[0] * 60 + MARKET_OPEN[1]) - minutes_since_midnight(now)
            log.info('Market not open yet — sleeping %d min', wait_mins)
            time.sleep(min(wait_mins * 60, 60))

    # ── Resolve expiry ────────────────────────────────────────────────
    # Retried: the Dhan API is prone to transient hiccups in the first minute
    # after market open, and a one-shot failure here used to kill the whole
    # day's collection since nothing restarts this process until the next
    # server boot.
    expiry = args.expiry
    if not expiry:
        uid = UNDERLYING_IDS.get(underlying)
        expiries = []
        for attempt in range(5):
            expiries = helper.get_expiry_list(under_security_id=uid, under_exchange_segment='IDX_I')
            if expiries:
                break
            log.warning('Expiry list fetch attempt %d/5 failed — retrying in 10s', attempt + 1)
            time.sleep(10)
        if not expiries:
            log.error('Could not fetch expiry list after 5 attempts — check auth token')
            sys.exit(1)
        expiry = expiries[0]
        log.info('Auto-selected expiry: %s', expiry)

    # ── Lock ATM from market-open spot ───────────────────────────────
    spot = 0
    for attempt in range(5):
        spot = helper.get_ltp(underlying, exchange='IDX_I', instrument='INDEX') or 0
        if spot > 0:
            break
        log.warning('Spot price fetch attempt %d/5 failed — retrying in 10s', attempt + 1)
        time.sleep(10)
    if spot <= 0:
        log.error('Could not fetch spot price for %s after 5 attempts', underlying)
        sys.exit(1)

    atm     = round(spot / STRIKE_STEP) * STRIKE_STEP
    strikes = [atm + i * STRIKE_STEP for i in range(-ATM_RANGE, ATM_RANGE + 1)]
    log.info('Spot=%.2f  ATM=%d  strikes=%d–%d  expiry=%s',
             spot, atm, strikes[0], strikes[-1], expiry)

    # ── CSV setup ─────────────────────────────────────────────────────
    today    = date.today()
    out_path = csv_path(today)
    need_header = not os.path.exists(out_path) or os.path.getsize(out_path) == 0

    if not args.dry_run:
        log.info('Writing to %s', out_path)
    else:
        log.info('DRY RUN — output goes to stdout')

    # ── Main loop ─────────────────────────────────────────────────────
    iteration = 0
    consecutive_failures = 0
    _key_format_logged = []  # sentinel: log oc key format exactly once

    while True:
        now = ist_now()

        if not args.ignore_market_hours and is_after_close(now):
            log.info('Market closed (15:30) — exiting')
            break

        if os.path.exists(stop_trigger_path()):
            os.remove(stop_trigger_path())
            log.info('Stop trigger detected — exiting')
            break

        ts = now.strftime('%Y-%m-%d %H:%M:%S')

        try:
            # Refresh spot each iteration (but keep ATM locked)
            live_spot = helper.get_ltp(underlying, exchange='IDX_I', instrument='INDEX') or spot
            chain_data = helper.get_option_chain(underlying, expiry, exchange_segment='IDX_I')
            oc = chain_data.get('oc', {}) if chain_data else {}

            if not oc:
                consecutive_failures += 1
                log.warning('[%s] Empty option chain response — skipping (failure #%d)',
                            ts, consecutive_failures)
            else:
                consecutive_failures = 0
                rows = build_rows(ts, live_spot, expiry, strikes, oc,
                                  _logged_keys=_key_format_logged)
                if args.dry_run:
                    for row in rows:
                        print(row)
                else:
                    write_rows(out_path, rows, write_header=(need_header and iteration == 0))
                    need_header = False
                log.info('[%s] Wrote %d rows (spot=%.2f)', ts, len(rows), live_spot)

        except Exception as exc:
            consecutive_failures += 1
            log.error('[%s] Error: %s', ts, exc)

        iteration += 1

        # Exponential backoff on consecutive failures: 30s → 60s → 120s → 300s (cap)
        if consecutive_failures > 0:
            backoff = min(30 * (2 ** (consecutive_failures - 1)), 300)
            if consecutive_failures == 1 or consecutive_failures % 5 == 0:
                log.info('Backing off %ds after %d consecutive failures', backoff, consecutive_failures)
            time.sleep(backoff)
        else:
            time.sleep(POLL_SEC)
        time.sleep(POLL_SEC)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        log.info('Interrupted — exiting')
