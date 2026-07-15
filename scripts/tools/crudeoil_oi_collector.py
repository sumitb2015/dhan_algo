"""
Crude Oil Options OI Snapshot Collector — runs during MCX market hours (09:00 to 23:30 IST),
polling the CRUDEOIL option chain every 30 seconds and writing a snapshot of ATM±10 strikes to a daily CSV file.

ATM is locked at startup based on the active near-month Futures contract price.

Usage:
    python scripts/tools/crudeoil_oi_collector.py
    python scripts/tools/crudeoil_oi_collector.py --expiry 2026-07-16
    python scripts/tools/crudeoil_oi_collector.py --dry-run
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
from scripts.tools.premarket_data import _find_nearest_future

_LOG_FILE = os.path.join(ROOT, 'debug', 'crudeoil_oi_collector.log')
os.makedirs(os.path.join(ROOT, 'debug'), exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)s  %(message)s',
    datefmt='%H:%M:%S',
    filename=_LOG_FILE,
    filemode='a',
)
log = logging.getLogger(__name__)

# Standard stdout logger as well so CLI users can see progress
stdout_handler = logging.StreamHandler(sys.stdout)
stdout_handler.setFormatter(logging.Formatter('%(asctime)s  %(levelname)s  %(message)s', '%H:%M:%S'))
log.addHandler(stdout_handler)

STRIKE_STEP = 100
ATM_RANGE   = 10          # ATM ± 10 strikes = 21 total
POLL_SEC    = 30
MARKET_OPEN = (9, 0)      # MCX opens at 09:00
MARKET_CLOSE = (23, 30)   # MCX closes at 23:30 (standard)

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
    return os.path.join(debug_dir, f'crudeoil_oi_snapshots_{today.isoformat()}.csv')


def stop_trigger_path() -> str:
    return os.path.join(ROOT, 'debug', 'crudeoil_oi_stop.trigger')


def extract_side(side: dict) -> dict:
    """Extract all useful fields from a CE or PE option side dict."""
    greeks = side.get('greeks', {}) or {}
    return {
        'LTP':       side.get('last_price', ''),
        'IV':        side.get('implied_volatility') or greeks.get('iv', ''),
        'OI':        side.get('oi', ''),
        'change_OI': side.get('change_in_open_interest') or side.get('oi_change') or (float(side.get('oi', 0) or 0) - float(side.get('previous_oi', 0) or 0)),
        'volume':    side.get('volume', ''),
        'bid':       side.get('top_bid_price') or side.get('bid_price', ''),
        'ask':       side.get('top_ask_price') or side.get('ask_price', ''),
        'delta':     greeks.get('delta', ''),
        'gamma':     greeks.get('gamma', ''),
        'theta':     greeks.get('theta', ''),
        'vega':      greeks.get('vega', ''),
    }


def build_oc_lookup(oc: dict) -> dict:
    """Convert the raw oc dict to a float-keyed lookup."""
    lookup = {}
    for k, v in oc.items():
        try:
            lookup[float(k)] = v
        except (ValueError, TypeError):
            pass
    return lookup


def build_rows(ts: str, spot: float, expiry: str, strikes: list, oc: dict) -> list:
    """Build one CSV row per strike from the raw `oc` dict."""
    oc_lookup = build_oc_lookup(oc)
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
    parser = argparse.ArgumentParser(description='Crude Oil Options OI Snapshot Collector')
    parser.add_argument('--expiry',     default='', help='Expiry date YYYY-MM-DD; auto-selects nearest if omitted')
    parser.add_argument('--dry-run',    action='store_true', help='Print rows to stdout, do not write CSV')
    parser.add_argument('--ignore-market-hours', action='store_true', help='Ignore market open/close times')
    args = parser.parse_args()

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

    # ── Find active Crude Oil futures contract ─────────────────────────
    fut = _find_nearest_future(helper, "CRUDEOIL", exchange="MCX", instrument="FUTCOM")
    if not fut:
        log.error('Could not find active CRUDEOIL future contract')
        sys.exit(1)
    
    futures_sid = int(fut["SECURITY_ID"])
    log.info('Active Crude Oil Future Security ID: %d (%s)', futures_sid, fut.get('tradingSymbol'))

    # ── Resolve expiry ────────────────────────────────────────────────
    expiry = args.expiry
    if not expiry:
        expiries = helper.get_expiry_list(under_security_id=futures_sid, under_exchange_segment='MCX_COMM')
        if not expiries:
            log.error('Could not fetch Crude Oil expiry list')
            sys.exit(1)
        expiry = expiries[0]
        log.info('Auto-selected options expiry: %s', expiry)

    # ── Lock ATM from futures price ───────────────────────────────────
    spot = 0.0
    ohlc_raw = helper.get_ohlc_data({"MCX_COMM": [futures_sid]})
    spot = ohlc_raw.get("MCX_COMM", {}).get(str(futures_sid), {}).get("last_price") or 0.0
    if not spot:
        spot = helper.get_ltp(futures_sid, exchange="MCX", instrument="FUTCOM") or 0.0
    
    if spot <= 0:
        log.error('Could not fetch futures price for Crude Oil spot reference')
        sys.exit(1)

    atm     = round(spot / STRIKE_STEP) * STRIKE_STEP
    strikes = [atm + i * STRIKE_STEP for i in range(-ATM_RANGE, ATM_RANGE + 1)]
    log.info('Futures Spot=%.2f  ATM=%d  strikes=%d–%d  expiry=%s',
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

    while True:
        now = ist_now()

        if not args.ignore_market_hours and is_after_close(now):
            log.info('Market closed (23:30) — exiting')
            break

        if os.path.exists(stop_trigger_path()):
            os.remove(stop_trigger_path())
            log.info('Stop trigger detected — exiting')
            break

        ts = now.strftime('%Y-%m-%d %H:%M:%S')

        try:
            # Refresh futures spot each iteration
            live_spot = helper.get_ltp(futures_sid, exchange="MCX", instrument="FUTCOM") or spot
            chain_data = helper.get_option_chain("CRUDEOIL", expiry, exchange_segment='MCX_COMM')
            oc = chain_data.get('oc', {}) if chain_data else {}

            if not oc:
                consecutive_failures += 1
                log.warning('[%s] Empty option chain response — skipping (failure #%d)',
                            ts, consecutive_failures)
            else:
                consecutive_failures = 0
                rows = build_rows(ts, live_spot, expiry, strikes, oc)
                if args.dry_run:
                    for row in rows[:5]:
                        log.info('SAMPLE ROW: %s', row)
                else:
                    write_rows(out_path, rows, write_header=(need_header and iteration == 0))
                    need_header = False
                log.info('[%s] Wrote %d rows (spot=%.2f)', ts, len(rows), live_spot)

        except Exception as exc:
            consecutive_failures += 1
            log.error('[%s] Error: %s', ts, exc)

        iteration += 1

        if args.dry_run:
            log.info('Dry run completed successfully')
            break

        # Exponential backoff on consecutive failures
        if consecutive_failures > 0:
            backoff = min(POLL_SEC * (2 ** (consecutive_failures - 1)), 300)
            log.info('Backing off %ds after %d consecutive failures', backoff, consecutive_failures)
            time.sleep(backoff)
        else:
            time.sleep(POLL_SEC)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        log.info('Interrupted — exiting')
