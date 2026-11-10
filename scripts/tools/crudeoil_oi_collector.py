"""
Crude Oil Options OI Snapshot Collector — runs during MCX market hours (09:00 IST to the evening close: 23:30
while the US is on daylight saving, 23:55 otherwise), polling the CRUDEOIL or CRUDEOILM option chain every 30 seconds
and writing a snapshot of ATM±10 strikes to a daily CSV file.

ATM is locked at startup based on the active near-month Futures contract price.

Each underlying has its own files, so both can run at once:
    CRUDEOIL : debug/crudeoil_oi_snapshots_<date>.csv,  crudeoil_oi_collector_status.json,  crudeoil_oi_stop.trigger
    CRUDEOILM: debug/crudeoilm_oi_snapshots_<date>.csv, crudeoilm_oi_collector_status.json, crudeoilm_oi_stop.trigger
OI and volume are in LOTS (Dhan reports MCX quantities in lots).

Usage:
    python scripts/tools/crudeoil_oi_collector.py
    python scripts/tools/crudeoil_oi_collector.py --underlying CRUDEOILM
    python scripts/tools/crudeoil_oi_collector.py --expiry 2026-07-16
    python scripts/tools/crudeoil_oi_collector.py --dry-run
"""
import sys
import os
import csv
import json
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
UNDERLYINGS = ('CRUDEOIL', 'CRUDEOILM')
UNDERLYING = 'CRUDEOIL'   # set from --underlying in main()


def _nth_sunday(year: int, month: int, n: int) -> date:
    first = date(year, month, 1)
    return date(year, month, 1 + (6 - first.weekday()) % 7 + (n - 1) * 7)


_HOLIDAYS_FILE = os.path.join(ROOT, 'rs_dashboard', 'lib', 'mcxHolidays.json')


def _mcx_holidays() -> dict:
    """The dashboard's MCX holiday list (closed / evening_only / morning_only), so the collector and the trading gate
    (rs_dashboard/lib/mcxSession.ts) agree. Missing/unreadable file: weekdays-only, like mcxSession for an unknown year."""
    try:
        with open(_HOLIDAYS_FILE, encoding='utf-8') as f:
            data = json.load(f)
        return {k: set(data.get(k, [])) for k in ('closed', 'evening_only', 'morning_only')}
    except (OSError, ValueError):
        return {'closed': set(), 'evening_only': set(), 'morning_only': set()}


def market_session(d: date):
    """(open, close) as (h, m) tuples for this IST date, or None when MCX is shut. Same rules as lib/mcxSession.ts:
    weekends and holidays closed; evening-only days open at 17:00; morning-only days close at 17:00; the evening close
    is 23:30 while the US is on DST (2nd Sunday of March to 1st Sunday of November), else 23:55."""
    if d.weekday() >= 5:
        return None
    hol = _mcx_holidays()
    iso = d.isoformat()
    if iso in hol['closed']:
        return None
    summer = _nth_sunday(d.year, 3, 2) < d <= _nth_sunday(d.year, 11, 1)
    open_ = (17, 0) if iso in hol['evening_only'] else MARKET_OPEN
    close = (17, 0) if iso in hol['morning_only'] else ((23, 30) if summer else (23, 55))
    return open_, close


def market_close(d: date) -> tuple:
    sess = market_session(d)
    return sess[1] if sess else MARKET_OPEN

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
    sess = market_session(dt.date())
    open_ = sess[0] if sess else MARKET_OPEN
    return minutes_since_midnight(dt) < open_[0] * 60 + open_[1]


def is_after_close(dt: datetime) -> bool:
    close = market_close(dt.date())
    close_mins = close[0] * 60 + close[1]
    return minutes_since_midnight(dt) >= close_mins


def csv_path(today: date) -> str:
    debug_dir = os.path.join(ROOT, 'debug')
    os.makedirs(debug_dir, exist_ok=True)
    return os.path.join(debug_dir, f'{UNDERLYING.lower()}_oi_snapshots_{today.isoformat()}.csv')


def stop_trigger_path() -> str:
    return os.path.join(ROOT, 'debug', f'{UNDERLYING.lower()}_oi_stop.trigger')


def status_file_path() -> str:
    return os.path.join(ROOT, 'debug', f'{UNDERLYING.lower()}_oi_collector_status.json')


def write_status(**fields) -> None:
    """Write a status JSON the dashboard route reads to detect running/crashed state.

    Mirrors the live-bridge pattern: always carries pid + status so the API can
    cross-check the PID and flag a crashed collector.
    """
    payload = {'pid': os.getpid(), 'updated_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
    payload.update(fields)
    try:
        with open(status_file_path(), 'w', encoding='utf-8') as f:
            json.dump(payload, f)
    except OSError as exc:
        log.warning('Could not write status file: %s', exc)


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
    parser.add_argument('--underlying', default='CRUDEOIL', choices=UNDERLYINGS, help='CRUDEOIL (default) or CRUDEOILM')
    parser.add_argument('--expiry',     default='', help='Expiry date YYYY-MM-DD; auto-selects nearest if omitted')
    parser.add_argument('--dry-run',    action='store_true', help='Print rows to stdout, do not write CSV')
    parser.add_argument('--ignore-market-hours', action='store_true', help='Ignore market open/close times')
    args = parser.parse_args()
    global UNDERLYING
    UNDERLYING = args.underlying

    dhan = get_dhan_client()
    if not dhan:
        log.error('Auth failed — run login.py to refresh the access token')
        sys.exit(1)

    helper = DhanHelper(dhan)

    # ── Wait for market open ──────────────────────────────────────────
    if not args.ignore_market_hours:
        if market_session(ist_now().date()) is None:
            log.info('MCX is closed today — exiting')
            write_status(status='STOPPED', underlying=UNDERLYING, reason='mcx_closed_today')
            return
        if is_after_close(ist_now()):
            log.info('MCX has closed for the day — exiting')
            write_status(status='STOPPED', underlying=UNDERLYING, reason='market_closed')
            return
        # Say so at once: without a status the dashboard would show "stopped" and allow a second Start.
        while is_before_open(ist_now()):
            write_status(status='WAITING', underlying=UNDERLYING, reason='waiting_for_open')
            if os.path.exists(stop_trigger_path()):
                os.remove(stop_trigger_path())
                log.info('Stop trigger detected while waiting for the open — exiting')
                write_status(status='STOPPED', underlying=UNDERLYING, reason='stop_trigger')
                return
            time.sleep(15)

    # ── Find active Crude Oil futures contract ─────────────────────────
    fut = _find_nearest_future(helper, UNDERLYING, exchange="MCX", instrument="FUTCOM")
    if not fut:
        log.error('Could not find active %s future contract', UNDERLYING)
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

    write_status(status='RUNNING', underlying=UNDERLYING, expiry=expiry, atm=atm, rows=0, last_update=None)

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
            log.info('Market closed (%02d:%02d) — exiting', *market_close(now.date()))
            write_status(status='STOPPED', expiry=expiry, atm=atm, reason='market_closed')
            break

        if os.path.exists(stop_trigger_path()):
            os.remove(stop_trigger_path())
            log.info('Stop trigger detected — exiting')
            write_status(status='STOPPED', expiry=expiry, atm=atm, reason='stop_trigger')
            break

        ts = now.strftime('%Y-%m-%d %H:%M:%S')

        try:
            # Refresh futures spot each iteration
            live_spot = helper.get_ltp(futures_sid, exchange="MCX", instrument="FUTCOM") or spot
            chain_data = helper.get_option_chain(UNDERLYING, expiry, exchange_segment='MCX_COMM')
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
                write_status(status='RUNNING', expiry=expiry, atm=atm,
                             rows=len(rows), last_update=ts, spot=round(live_spot, 2))

        except Exception as exc:
            consecutive_failures += 1
            log.error('[%s] Error: %s', ts, exc)
            write_status(status='RUNNING', expiry=expiry, atm=atm,
                         last_update=ts, error=str(exc), consecutive_failures=consecutive_failures)

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
        write_status(status='STOPPED', reason='interrupted')
    except Exception as exc:
        log.error('Fatal error — exiting: %s', exc)
        write_status(status='STOPPED', reason='error', error=str(exc))
        raise
