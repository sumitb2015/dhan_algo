"""
NIFTY Time-Based Analysis Collector — polls spot/futures/option-chain data on a
fixed interval throughout the trading session and appends one row per poll to a
daily JSON file, so the dashboard can render a time-based comparison table
(Nifty Spot/Fut, PCR, Max Pain, ATM, VIX, Futures OI change, highest CE/PE OI
strikes, ATM straddle delta, and a heuristic bias classification).

Dhan's option-chain API only returns the CURRENT snapshot — there is no way to
ask it for "the chain at 11:30 AM" after the fact — so this collector exists to
build that history forward from whenever it is started; it cannot backfill
earlier rows on a given day.

Usage:
    python scripts/tools/nifty_time_analysis_collector.py --interval-min 15
    python scripts/tools/nifty_time_analysis_collector.py --interval-min 5 --dry-run
"""
import sys
import os
import json
import time
import math
import argparse
import logging
from datetime import datetime, date

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

_LOG_FILE = os.path.join(ROOT, 'debug', 'nifty_time_analysis_collector.log')
os.makedirs(os.path.join(ROOT, 'debug'), exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)s  %(message)s',
    datefmt='%H:%M:%S',
    filename=_LOG_FILE,
    filemode='a',
)
log = logging.getLogger(__name__)
stdout_handler = logging.StreamHandler(sys.stdout)
stdout_handler.setFormatter(logging.Formatter('%(asctime)s  %(levelname)s  %(message)s', '%H:%M:%S'))
log.addHandler(stdout_handler)

ALLOWED_INTERVALS = (1, 3, 5, 15, 30)
MARKET_OPEN  = (9, 0)
MARKET_CLOSE = (15, 30)
VIX_SECURITY_ID = 21   # India VIX, NSE_IDX segment (see docs/API_GOTCHAS.md / india_vix_candles.py)

# Vol. Bias / Bias thresholds — heuristic, tune here rather than scattering
# magic numbers through the classifier functions.
VOL_BIAS_FLAT_POINTS = 3.0     # |spot change| below this reads as "Follow OI bias"
WEAK_BEARISH_POINTS  = 8.0     # Long Unwinding below this magnitude is tagged "(Weak Bearish)"


def clean_val(v, default=0.0):
    try:
        val = float(v)
        if math.isnan(val) or math.isinf(val):
            return default
        return val
    except Exception:
        return default


def ist_now() -> datetime:
    return datetime.now()


def minutes_since_midnight(dt: datetime) -> int:
    return dt.hour * 60 + dt.minute


def is_before_open(dt: datetime) -> bool:
    return minutes_since_midnight(dt) < MARKET_OPEN[0] * 60 + MARKET_OPEN[1]


def is_after_close(dt: datetime) -> bool:
    return minutes_since_midnight(dt) >= MARKET_CLOSE[0] * 60 + MARKET_CLOSE[1]


def data_path(today: date, interval_min: int) -> str:
    debug_dir = os.path.join(ROOT, 'debug')
    os.makedirs(debug_dir, exist_ok=True)
    return os.path.join(debug_dir, f'nifty_time_analysis_{today.isoformat()}_{interval_min}m.json')


def stop_trigger_path() -> str:
    return os.path.join(ROOT, 'debug', 'nifty_time_analysis_stop.trigger')


def status_file_path() -> str:
    return os.path.join(ROOT, 'debug', 'nifty_time_analysis_status.json')


def write_status(**fields) -> None:
    payload = {'pid': os.getpid(), 'updated_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
    payload.update(fields)
    try:
        tmp = status_file_path() + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(payload, f)
        os.replace(tmp, status_file_path())
    except OSError as exc:
        log.warning('Could not write status file: %s', exc)


def write_rows_atomic(path: str, payload: dict) -> None:
    """Read-modify-write is single-writer here (one collector process), but the
    dashboard API reads this file concurrently — write to a temp file and
    rename so a reader never observes a half-written JSON body."""
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(payload, f)
    os.replace(tmp, path)


def fetch_vix(dhan) -> float:
    """Direct OHLC REST call for India VIX (security id 21, NSE_IDX) — mirrors
    india_vix_candles.py; DhanHelper has no dedicated VIX lookup."""
    import urllib.request
    try:
        token = dhan.dhan_http.access_token
        client_id = dhan.dhan_http.client_id
        body = json.dumps({"NSE_IDX": [VIX_SECURITY_ID]}).encode()
        req = urllib.request.Request(
            "https://api.dhan.co/v2/marketfeed/ohlc", data=body, method="POST",
            headers={
                "access-token": token,
                "client-id": client_id,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            res = json.loads(resp.read())
        if res.get("status") == "success":
            entry = (res.get("data", {}) or {}).get("NSE_IDX", {}).get(str(VIX_SECURITY_ID), {}) or {}
            val = float((entry.get("ohlc") or {}).get("close") or entry.get("last_price") or 0)
            return round(val, 2) if val > 0 else 0.0
    except Exception as exc:
        log.warning('VIX fetch failed: %s', exc)
    return 0.0


def compute_max_pain(chain_df) -> float:
    """Brute-force max pain over the strikes actually present in the fetched
    chain (payout = sum ce_oi*max(0,K-s) + pe_oi*max(0,s-K), minimized over K)."""
    if chain_df is None or chain_df.empty:
        return 0.0
    strikes = chain_df.index.tolist()
    best_strike, best_payout = 0.0, None
    for k in strikes:
        payout = 0.0
        for s in strikes:
            ce_oi = clean_val(chain_df.loc[s].get('ce_oi'))
            pe_oi = clean_val(chain_df.loc[s].get('pe_oi'))
            payout += ce_oi * max(0.0, k - s) + pe_oi * max(0.0, s - k)
        if best_payout is None or payout < best_payout:
            best_payout, best_strike = payout, k
    return best_strike


def highest_oi_strike(chain_df, side: str):
    """side: 'ce' or 'pe'. Seeded at -1 with a strict > so an all-zero chain
    reports no signal instead of nominating the lowest strike (see
    dhan-oi-analytics skill)."""
    col = f'{side}_oi'
    best_strike, best_oi = 0.0, -1.0
    for s, row in chain_df.iterrows():
        oi = clean_val(row.get(col))
        if oi > 0 and oi > best_oi:
            best_oi, best_strike = oi, s
    return best_strike, (best_oi if best_oi > 0 else 0.0)


def classify_vol_bias(spot_diff, has_prev: bool) -> str:
    if not has_prev:
        return '#N/A'
    if spot_diff > VOL_BIAS_FLAT_POINTS:
        return 'Bullish'
    if spot_diff < -VOL_BIAS_FLAT_POINTS:
        return 'Bearish'
    return 'Follow OI bias'


def classify_bias(spot_diff, fut_oi_chg_pct, has_prev: bool) -> str:
    """Standard OI-buildup quadrant (see components/OptionsBuildupTab.tsx /
    dhan-oi-analytics skill), applied to futures OI-change% vs spot price
    change rather than a single option side.

    `fut_oi_chg_pct=None` means "no OI baseline / fetch failed this poll" and
    must NOT be treated as "zero change" — that would report a confident
    Neutral/quadrant label from data that was never actually read (the exact
    NaN-baseline-masking bug the dhan-oi-analytics skill's own guard exists
    to prevent)."""
    if not has_prev or fut_oi_chg_pct is None:
        return '#N/A'
    if fut_oi_chg_pct > 0 and spot_diff >= 0:
        return 'Long Build-up'
    if fut_oi_chg_pct > 0 and spot_diff < 0:
        return 'Short Build-up'
    if fut_oi_chg_pct < 0 and spot_diff >= 0:
        return 'Short Covering'
    if fut_oi_chg_pct < 0 and spot_diff < 0:
        return 'Long Unwinding (Weak Bearish)' if abs(spot_diff) < WEAK_BEARISH_POINTS else 'Long Unwinding'
    return 'Neutral'


def main():
    parser = argparse.ArgumentParser(description='NIFTY Time-Based Analysis Collector')
    parser.add_argument('--interval-min', type=int, default=15, choices=ALLOWED_INTERVALS)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--ignore-market-hours', action='store_true')
    args = parser.parse_args()

    dhan = get_dhan_client()
    if not dhan:
        log.error('Auth failed — run login.py to refresh the access token')
        sys.exit(1)
    helper = DhanHelper(dhan)

    if not args.ignore_market_hours:
        while is_before_open(ist_now()):
            now = ist_now()
            wait_mins = (MARKET_OPEN[0] * 60 + MARKET_OPEN[1]) - minutes_since_midnight(now)
            log.info('Market not open yet — sleeping %d min', wait_mins)
            time.sleep(min(wait_mins * 60, 60))

    today = date.today()
    out_path = data_path(today, args.interval_min)

    rows = []
    if os.path.exists(out_path):
        try:
            with open(out_path, 'r', encoding='utf-8') as f:
                existing = json.load(f)
            rows = existing.get('rows', [])
            log.info('Resuming existing file with %d rows', len(rows))
        except Exception:
            rows = []

    write_status(status='RUNNING', interval_min=args.interval_min, date=today.isoformat(), rows=len(rows))

    poll_sec = args.interval_min * 60
    consecutive_failures = 0

    while True:
        now = ist_now()

        if not args.ignore_market_hours and is_after_close(now):
            log.info('Market closed (15:30) — exiting')
            write_status(status='STOPPED', interval_min=args.interval_min, date=today.isoformat(),
                         rows=len(rows), reason='market_closed')
            break

        if os.path.exists(stop_trigger_path()):
            os.remove(stop_trigger_path())
            log.info('Stop trigger detected — exiting')
            write_status(status='STOPPED', interval_min=args.interval_min, date=today.isoformat(),
                         rows=len(rows), reason='stop_trigger')
            break

        ts = now.strftime('%H:%M')

        try:
            spot = helper.get_ltp('NIFTY', exchange='NSE', instrument='INDEX') or 0.0

            fut_rec = helper.find_future('NIFTY', exchange='NSE', instrument='FUTIDX')
            fut_price, fut_oi, fut_oi_ok = 0.0, 0.0, False
            if fut_rec:
                fut_sid = int(fut_rec['SECURITY_ID'])
                fut_price = helper.get_ltp(fut_sid, exchange='NSE', instrument='FUTIDX') or 0.0
                # get_ohlc_data only returns last_price/ohlc — no `oi` field
                # (lib/dhan_helper.py:3222-3226). OI lives on the quote endpoint.
                quote_raw = helper.get_quote_data({'NSE_FNO': [fut_sid]})
                fut_entry = (quote_raw or {}).get('NSE_FNO', {}).get(str(fut_sid), {}) or {}
                if 'oi' in fut_entry:
                    fut_oi = clean_val(fut_entry.get('oi'))
                    fut_oi_ok = True

            nearest_expiry = helper.get_nearest_expiry('NIFTY')
            chain_df = helper.get_option_chain_df('NIFTY', nearest_expiry) if nearest_expiry else None

            if chain_df is None or chain_df.empty or spot <= 0:
                consecutive_failures += 1
                log.warning('[%s] Empty chain/spot — skipping (failure #%d)', ts, consecutive_failures)
            else:
                consecutive_failures = 0

                atm = helper.get_atm_strike(chain_df, underlying_ltp=spot)
                total_ce_oi = clean_val(chain_df['ce_oi'].sum()) if 'ce_oi' in chain_df else 0.0
                total_pe_oi = clean_val(chain_df['pe_oi'].sum()) if 'pe_oi' in chain_df else 0.0
                pcr = round(total_pe_oi / total_ce_oi, 3) if total_ce_oi > 0 else 0.0

                max_pain = compute_max_pain(chain_df)
                put_strike, put_oi = highest_oi_strike(chain_df, 'pe')
                call_strike, call_oi = highest_oi_strike(chain_df, 'ce')

                atm_row = chain_df.loc[atm] if atm in chain_df.index else {}
                straddle_premium = clean_val(atm_row.get('ce_last_price')) + clean_val(atm_row.get('pe_last_price')) if len(atm_row) else 0.0

                vix = fetch_vix(dhan)

                prev = rows[-1] if rows else None
                has_prev = prev is not None
                prev_spot = prev['spot'] if has_prev else None
                spot_diff = (spot - prev_spot) if has_prev else 0.0
                prev_fut_oi = prev.get('_fut_oi_raw') if has_prev else None
                prev_fut_oi_ok = bool(prev.get('_fut_oi_ok')) if has_prev else False
                # None (not 0.0) when either poll's OI read failed/was unavailable —
                # a missing baseline must never masquerade as "zero change" (see
                # classify_bias docstring / dhan-oi-analytics skill).
                if has_prev and prev_fut_oi_ok and fut_oi_ok and prev_fut_oi:
                    fut_oi_chg_pct = round(((fut_oi - prev_fut_oi) / prev_fut_oi) * 100, 2)
                else:
                    fut_oi_chg_pct = None
                straddle_delta = round(straddle_premium - prev['_straddle_raw'], 2) if (has_prev and '_straddle_raw' in prev) else None

                avg_price = round((sum(r['spot'] for r in rows) + spot) / (len(rows) + 1), 2)

                def dir_of(cur, prevv):
                    if prevv is None:
                        return 0
                    return 1 if cur > prevv else (-1 if cur < prevv else 0)

                row = {
                    'time': ts,
                    'spot': round(spot, 2),
                    'spot_dir': dir_of(spot, prev_spot),
                    'fut': round(fut_price, 2),
                    'fut_dir': dir_of(fut_price, prev['fut'] if has_prev else None),
                    'fut_spot_diff': round(fut_price - spot, 2),
                    'fut_spot_diff_dir': dir_of(fut_price - spot, (prev['fut'] - prev['spot']) if has_prev else None),
                    'avg_price': avg_price,
                    'avg_price_dir': dir_of(avg_price, prev['avg_price'] if has_prev else None),
                    'max_pain': max_pain,
                    'max_pain_dir': dir_of(max_pain, prev['max_pain'] if has_prev else None),
                    'pcr': pcr,
                    'atm': atm,
                    'atm_dir': dir_of(atm, prev['atm'] if has_prev else None),
                    'vix': vix,
                    'vix_dir': dir_of(vix, prev['vix'] if has_prev else None),
                    'fut_oi_chg_pct': fut_oi_chg_pct,
                    'highest_put_oi_strike': put_strike,
                    'highest_put_oi_lakhs': round(put_oi / 100000, 1),
                    'highest_call_oi_strike': call_strike,
                    'highest_call_oi_lakhs': round(call_oi / 100000, 1),
                    'straddle_delta': straddle_delta,
                    'vol_bias': classify_vol_bias(spot_diff, has_prev),
                    'bias': classify_bias(spot_diff, fut_oi_chg_pct, has_prev),
                    # underscore-prefixed: internal carry-forward values for next
                    # row's delta math, not rendered by the dashboard.
                    '_fut_oi_raw': fut_oi,
                    '_fut_oi_ok': fut_oi_ok,
                    '_straddle_raw': straddle_premium,
                }

                if args.dry_run:
                    log.info('SAMPLE ROW: %s', row)
                else:
                    rows.append(row)
                    write_rows_atomic(out_path, {
                        'date': today.isoformat(),
                        'interval_min': args.interval_min,
                        'nearest_expiry': nearest_expiry,
                        'rows': rows,
                    })
                log.info('[%s] spot=%.2f fut=%.2f atm=%s pcr=%.3f maxpain=%s vix=%.2f',
                         ts, spot, fut_price, atm, pcr, max_pain, vix)
                write_status(status='RUNNING', interval_min=args.interval_min, date=today.isoformat(),
                             rows=len(rows), last_update=ts)

        except Exception as exc:
            consecutive_failures += 1
            log.error('[%s] Error: %s', ts, exc)
            write_status(status='RUNNING', interval_min=args.interval_min, date=today.isoformat(),
                         rows=len(rows), last_update=ts, error=str(exc), consecutive_failures=consecutive_failures)

        if args.dry_run:
            log.info('Dry run completed successfully')
            write_status(status='STOPPED', interval_min=args.interval_min, date=today.isoformat(),
                         rows=len(rows), reason='dry_run')
            break

        if consecutive_failures > 0:
            backoff = min(poll_sec * (2 ** (consecutive_failures - 1)), 300)
            log.info('Backing off %ds after %d consecutive failures', backoff, consecutive_failures)
            time.sleep(backoff)
        else:
            time.sleep(poll_sec)


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
