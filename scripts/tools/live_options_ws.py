"""
Live options WebSocket bridge for the RS dashboard options page.

Subscribes to NSE FNO option contracts via Dhan WebSocket and writes
debug/live_options_quotes.json + debug/live_options_history.json every 2 seconds
for the Next.js dashboard to poll.

Usage:
    venv\\Scripts\\python.exe scripts/tools/live_options_ws.py --underlying NIFTY --expiry 2026-06-27

Stop gracefully by writing debug/live_options_stop.trigger (done automatically
by the dashboard's /api/options/live POST {action:"stop"} endpoint).
"""
import sys
import os
import json
import time
import argparse
from datetime import datetime, date

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from dhanhq.marketfeed import MarketFeed

DEBUG_DIR    = os.path.join(ROOT, 'debug')
QUOTES_FILE  = os.path.join(DEBUG_DIR, 'live_options_quotes.json')
HISTORY_FILE = os.path.join(DEBUG_DIR, 'live_options_history.json')
STATUS_FILE  = os.path.join(DEBUG_DIR, 'live_options_status.json')
STOP_TRIGGER = os.path.join(DEBUG_DIR, 'live_options_stop.trigger')

MAX_HISTORY  = 300   # ~10 min at 2s ticks

# MarketFeed constants
NSE_FNO     = 2   # NSE F&O segment
IDX         = 0   # Index segment
FULL        = 21  # Full packet — includes OI
FEED_QUOTE  = 17  # Quote packet — LTP + OHLC + volume (includes prev_close)

# Security IDs
NIFTY_IDX_SID = '13'   # NIFTY 50 index (spot canary)
VIX_SID       = '21'   # India VIX index

# Strike step per underlying
STRIKE_STEP = {'NIFTY': 50, 'BANKNIFTY': 100, 'FINNIFTY': 50}


def _f(val, default: float = 0.0) -> float:
    if val is None:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def atomic_write(path: str, data: dict):
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w') as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except PermissionError:
        # File is locked by Next.js reader, skip this cycle
        pass
    except Exception as e:
        print(f"[live_options_ws] Warning: failed to write {path} ({e})", flush=True)


def write_status(status: str, underlying: str = '', expiry: str = '',
                 subscribed: int = 0, started_at: str = ''):
    try:
        atomic_write(STATUS_FILE, {
            'status': status,
            'pid': os.getpid(),
            'underlying': underlying,
            'expiry': expiry,
            'subscribed': subscribed,
            'started_at': started_at or datetime.now().isoformat(),
            'last_update': datetime.now().isoformat(),
        })
    except Exception as e:
        print(f"[live_options_ws] Warning: failed to write status ({e})", flush=True)


def main():
    parser = argparse.ArgumentParser(description='Live options WebSocket bridge')
    parser.add_argument('--underlying', default='NIFTY',
                        choices=['NIFTY', 'BANKNIFTY', 'FINNIFTY'])
    parser.add_argument('--expiry', required=True,
                        help='Expiry date YYYY-MM-DD')
    parser.add_argument('--num-strikes', type=int, default=10,
                        help='Number of strikes each side of ATM (default 10)')
    args = parser.parse_args()

    os.makedirs(DEBUG_DIR, exist_ok=True)
    started_at = datetime.now().isoformat()
    write_status('STARTING', underlying=args.underlying, expiry=args.expiry,
                 started_at=started_at)

    print(f'[live_options_ws] Starting — underlying={args.underlying} expiry={args.expiry}',
          flush=True)

    dhan = get_dhan_client()
    if not dhan:
        print('[live_options_ws] ERROR: authentication failed', flush=True)
        write_status('ERROR', underlying=args.underlying, expiry=args.expiry,
                     started_at=started_at)
        sys.exit(1)

    helper = DhanHelper(dhan)
    step = STRIKE_STEP.get(args.underlying, 50)

    # Get spot to determine ATM
    print('[live_options_ws] Fetching spot price…', flush=True)
    spot = helper.get_ltp(args.underlying, exchange='IDX_I', instrument='INDEX') or 0.0
    atm  = round(spot / step) * step if spot > 0 else 0
    print(f'[live_options_ws] Spot={spot:.2f} ATM={atm} step={step}', flush=True)

    num = args.num_strikes
    strikes = [atm + i * step for i in range(-num, num + 1)] if atm > 0 else []

    # Resolve security IDs from master list
    instruments = []
    sid_map: dict[str, dict] = {}  # sid -> {strike, type}

    print(f'[live_options_ws] Resolving {len(strikes) * 2} option contracts…', flush=True)
    for strike in strikes:
        for opt_type in ('CE', 'PE'):
            opt = helper.find_option(args.underlying, args.expiry, float(strike), opt_type)
            if opt is None:
                continue
            sid = str(int(opt['SECURITY_ID']))
            sid_map[sid] = {'strike': int(strike), 'type': opt_type}
            instruments.append((NSE_FNO, sid, FULL))

    # Subscribe to NIFTY index (spot canary) and India VIX
    instruments.append((IDX, NIFTY_IDX_SID, FEED_QUOTE))
    instruments.append((IDX, VIX_SID, FEED_QUOTE))

    n = len(instruments) - 1  # exclude index canary
    print(f'[live_options_ws] Subscribing to {n} option contracts + index canary…', flush=True)

    if n == 0:
        print('[live_options_ws] ERROR: no contracts resolved — aborting', flush=True)
        write_status('ERROR', underlying=args.underlying, expiry=args.expiry,
                     started_at=started_at)
        sys.exit(1)

    helper.start_websocket(instruments)
    time.sleep(3)  # wait for connection + first tick batch

    # Diagnostic: check if index canary received a tick
    idx_initial = helper.live_data.get(NIFTY_IDX_SID)
    if idx_initial:
        initial_ltp = _f(idx_initial.get('LTP') or idx_initial.get('last_price'))
        print(f'[live_options_ws] Index tick received — LTP={initial_ltp:.2f}', flush=True)
    else:
        print('[live_options_ws] WARNING: No index tick received after 3s; will use REST spot as fallback', flush=True)

    write_status('RUNNING', underlying=args.underlying, expiry=args.expiry,
                 subscribed=n, started_at=started_at)
    print('[live_options_ws] WebSocket connected. Writing quotes every 2s…', flush=True)

    last_print = 0.0
    last_quotes = None

    try:
        while True:
            if os.path.exists(STOP_TRIGGER):
                try:
                    os.remove(STOP_TRIGGER)
                except OSError:
                    pass
                print('[live_options_ws] Stop trigger detected — exiting.', flush=True)
                break

            # Update spot from index canary
            idx_tick = helper.live_data.get(NIFTY_IDX_SID)
            if idx_tick:
                live_spot = _f(idx_tick.get('LTP') or idx_tick.get('last_price'))
                if live_spot > 0:
                    spot = live_spot
                    atm  = round(spot / step) * step

            # Read India VIX from WebSocket
            vix_data: dict | None = None
            vix_tick = helper.live_data.get(VIX_SID)
            if vix_tick:
                vix_ltp        = _f(vix_tick.get('LTP') or vix_tick.get('last_price'))
                vix_prev_close = _f(vix_tick.get('prev_close') or vix_tick.get('close'))
                if vix_ltp > 0:
                    vix_chg     = round(vix_ltp - vix_prev_close, 2) if vix_prev_close else 0.0
                    vix_chg_pct = round(vix_chg / vix_prev_close * 100, 4) if vix_prev_close else 0.0
                    vix_data = {
                        'ltp':        round(vix_ltp, 2),
                        'prev_close': round(vix_prev_close, 2),
                        'change':     vix_chg,
                        'change_pct': vix_chg_pct,
                    }

            # Build per-strike quotes
            strikes_data: dict[str, dict] = {}
            for sid, meta in sid_map.items():
                sk_key = str(meta['strike'])
                if sk_key not in strikes_data:
                    strikes_data[sk_key] = {
                        'strike': meta['strike'],
                        'ce': {'ltp': 0, 'oi': 0, 'volume': 0},
                        'pe': {'ltp': 0, 'oi': 0, 'volume': 0},
                    }

                tick = helper.live_data.get(sid)
                if tick:
                    ltp = _f(tick.get('LTP') or tick.get('last_price'))
                    oi  = int(tick.get('OI', 0) or tick.get('oi', 0) or 0)
                    vol = int(tick.get('volume', 0) or 0)
                    strikes_data[sk_key][meta['type'].lower()] = {
                        'ltp':    round(ltp, 2),
                        'oi':     oi,
                        'volume': vol,
                        'open':   round(_f(tick.get('open')), 2),
                        'high':   round(_f(tick.get('high')), 2),
                        'low':    round(_f(tick.get('low')), 2),
                    }

            # ATM straddle premium
            atm_key = str(atm)
            straddle = 0.0
            if atm_key in strikes_data:
                ce_ltp = strikes_data[atm_key].get('ce', {}).get('ltp', 0)
                pe_ltp = strikes_data[atm_key].get('pe', {}).get('ltp', 0)
                straddle = round(ce_ltp + pe_ltp, 2)

            now_iso = datetime.now().isoformat()

            current_quotes = {
                'underlying':        args.underlying,
                'expiry':            args.expiry,
                'spot':              round(spot, 2),
                'atm':               atm,
                'straddle_premium':  straddle,
                'strikes':           strikes_data,
                'vix':               vix_data,
            }

            if current_quotes != last_quotes:
                current_quotes['updated_at'] = now_iso
                atomic_write(QUOTES_FILE, current_quotes)
                last_quotes = current_quotes

            # Print status update to terminal every 10 seconds
            now_ts = time.time()
            if now_ts - last_print > 10:
                print(f'[live_options_ws] Spot={spot:.2f} | ATM={atm} | Straddle={straddle:.2f} | Subscribed={n}', flush=True)
                last_print = now_ts

            time.sleep(0.1)

    except KeyboardInterrupt:
        print('[live_options_ws] KeyboardInterrupt — shutting down.', flush=True)
    finally:
        write_status('STOPPED', underlying=args.underlying, expiry=args.expiry,
                     subscribed=0, started_at=started_at)
        print('[live_options_ws] Stopped.', flush=True)


if __name__ == '__main__':
    main()
