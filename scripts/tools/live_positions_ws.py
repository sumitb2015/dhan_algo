"""
Live positions WebSocket bridge for the RS dashboard options page.

Subscribes to all active F&O options positions via Dhan WebSocket and writes
debug/live_positions_data.json + debug/live_positions_history.json every 1-2 seconds
for the Next.js dashboard to poll.
"""
import sys
import os
import json
import time
import re
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from dhanhq.marketfeed import MarketFeed

DEBUG_DIR    = os.path.join(ROOT, 'debug')
DATA_FILE    = os.path.join(DEBUG_DIR, 'live_positions_data.json')
HISTORY_FILE = os.path.join(DEBUG_DIR, 'live_positions_history.json')
STATUS_FILE  = os.path.join(DEBUG_DIR, 'live_positions_status.json')
STOP_TRIGGER = os.path.join(DEBUG_DIR, 'live_positions_stop.trigger')

MAX_HISTORY  = 300   # ~10 min at 2s ticks

NSE_FNO     = 2   # NSE F&O segment
IDX         = 0   # Index segment
FULL        = 21  # Full packet (includes OI)
FEED_QUOTE  = 17  # Quote packet
VIX_SID     = '21'

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
        pass
    except Exception as e:
        print(f"[live_positions_ws] Warning: failed to write {path} ({e})", flush=True)

def write_status(status: str, started_at: str = '', subscribed: int = 0):
    try:
        atomic_write(STATUS_FILE, {
            'status': status,
            'pid': os.getpid(),
            'subscribed': subscribed,
            'started_at': started_at or datetime.now().isoformat(),
            'last_update': datetime.now().isoformat(),
        })
    except Exception as e:
        print(f"[live_positions_ws] Warning: failed to write status ({e})", flush=True)

def get_options_positions(helper: DhanHelper) -> list:
    """Fetch current options positions from Dhan."""
    df = helper.get_positions()
    options = []
    if not df.empty:
        for _, row in df.iterrows():
            qty = int(row.get('netQty', 0) or 0)
            if qty == 0:
                continue
            segment = str(row.get('exchangeSegment', ''))
            if segment != 'NSE_FNO':
                continue
            
            sym = str(row.get('tradingSymbol', ''))
            # Filter options (must have CE or PE in symbol)
            if not ('-CE' in sym or '-PE' in sym or 'CE' in sym or 'PE' in sym):
                continue
                
            sec_id = str(row.get('securityId', ''))
            if not sec_id:
                continue

            options.append({
                'symbol': sym,
                'securityId': sec_id,
                'netQty': qty,
                'lastPrice': float(row.get('lastPrice', 0) or 0),
                'drvOptionType': str(row.get('drvOptionType', '')),
                'drvStrikePrice': float(row.get('drvStrikePrice', 0) or 0)
            })
    return options

def main():
    os.makedirs(DEBUG_DIR, exist_ok=True)
    started_at = datetime.now().isoformat()
    write_status('STARTING', started_at=started_at)

    print('[live_positions_ws] Starting WebSocket bridge for open positions...', flush=True)

    dhan = get_dhan_client()
    if not dhan:
        print('[live_positions_ws] ERROR: authentication failed', flush=True)
        write_status('ERROR', started_at=started_at)
        sys.exit(1)

    helper = DhanHelper(dhan)

    # 1. Fetch initial positions and subscribe
    print('[live_positions_ws] Fetching current positions...', flush=True)
    positions = get_options_positions(helper)
    
    subscribed_sids = set()
    instruments = []
    
    # Map to help reconstruct details
    pos_map = {}
    for p in positions:
        sid = p['securityId']
        subscribed_sids.add(sid)
        pos_map[sid] = p
        instruments.append((NSE_FNO, sid, FULL))
        
    # Subscribe to India VIX
    instruments.append((IDX, VIX_SID, FEED_QUOTE))
    
    print(f'[live_positions_ws] Subscribing to {len(subscribed_sids)} options positions + India VIX...', flush=True)
    helper.start_websocket(instruments)
    time.sleep(2) # wait for connection

    write_status('RUNNING', started_at=started_at, subscribed=len(subscribed_sids))

    last_history_write = 0.0
    last_positions_poll = time.time()
    history_ticks = []
    
    # Load existing history if fresh start within same hour
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE, 'r') as f:
                hist_data = json.load(f)
                history_ticks = hist_data.get('history', [])
        except:
            pass

    try:
        while True:
            # Check stop trigger
            if os.path.exists(STOP_TRIGGER):
                try:
                    os.remove(STOP_TRIGGER)
                except OSError:
                    pass
                print('[live_positions_ws] Stop trigger detected — exiting.', flush=True)
                break

            now_ts = time.time()

            # Dynamic subscription updates: poll positions every 15s
            if now_ts - last_positions_poll >= 15.0:
                last_positions_poll = now_ts
                try:
                    current_positions = get_options_positions(helper)
                    current_sids = {p['securityId'] for p in current_positions}
                    
                    # Update maps
                    new_pos_map = {p['securityId']: p for p in current_positions}
                    
                    to_sub = current_sids - subscribed_sids
                    to_unsub = subscribed_sids - current_sids
                    
                    if to_sub or to_unsub:
                        print(f'[live_positions_ws] Positions changed. Subscribing: {list(to_sub)}, Unsubscribing: {list(to_unsub)}', flush=True)
                        if to_unsub:
                            helper.unsubscribe_instruments([(NSE_FNO, sid, FULL) for sid in to_unsub])
                        if to_sub:
                            helper.subscribe_instruments([(NSE_FNO, sid, FULL) for sid in to_sub])
                            
                        subscribed_sids = current_sids
                        pos_map = new_pos_map
                        write_status('RUNNING', started_at=started_at, subscribed=len(subscribed_sids))
                    else:
                        # Update quantities and details even if SIDs didn't change
                        pos_map = new_pos_map
                except Exception as e:
                    print(f"[live_positions_ws] Error polling positions: {e}", flush=True)

            # Build response
            vix = 0.0
            vix_tick = helper.live_data.get(VIX_SID)
            if vix_tick:
                vix = _f(vix_tick.get('LTP') or vix_tick.get('last_price'))

            legs = []
            net_premium = 0.0
            
            for sid, p in pos_map.items():
                tick = helper.live_data.get(sid)
                ltp = _f(tick.get('LTP') or tick.get('last_price')) if tick else p['lastPrice']
                
                qty = p['netQty']
                side = 'SELL' if qty < 0 else 'BUY'
                
                # Strike and type
                sym = p['symbol']
                cepe = 'CE'
                if p['drvOptionType'] == 'CALL':
                    cepe = 'CE'
                elif p['drvOptionType'] == 'PUT':
                    cepe = 'PE'
                else:
                    cepe = 'CE' if '-CE' in sym else 'PE'
                    
                strike = p['drvStrikePrice']
                if strike == 0:
                    match1 = re.search(r'-(CE|PE)-(\d+)', sym)
                    match2 = re.search(r'(\d+)-(CE|PE)', sym)
                    if match1:
                        strike = float(match1.group(2))
                    elif match2:
                        strike = float(match2.group(1))

                abs_qty = abs(qty)
                if side == 'SELL':
                    net_premium += ltp * abs_qty
                else:
                    net_premium -= ltp * abs_qty
                
                legs.append({
                    'symbol': sym,
                    'strike': strike,
                    'type': cepe,
                    'side': side,
                    'ltp': round(ltp, 2),
                    'netQty': qty
                })

            now_iso = datetime.now().isoformat()
            payload = {
                'has_positions': len(legs) > 0,
                'net_premium': round(net_premium, 2),
                'vix': round(vix, 2),
                'legs': legs,
                'timestamp': now_iso
            }

            # Write latest data snapshot
            atomic_write(DATA_FILE, payload)

            # Write history every 2 seconds
            if now_ts - last_history_write >= 2.0:
                last_history_write = now_ts
                if len(legs) > 0:
                    history_ticks.append({
                        'timestamp': now_iso,
                        'net_premium': round(net_premium, 2),
                        'vix': round(vix, 2)
                    })
                    if len(history_ticks) > MAX_HISTORY:
                        history_ticks = history_ticks[-MAX_HISTORY:]
                    atomic_write(HISTORY_FILE, {'history': history_ticks})

            time.sleep(0.5)

    except KeyboardInterrupt:
        print('[live_positions_ws] KeyboardInterrupt — shutting down.', flush=True)
    finally:
        write_status('STOPPED', started_at=started_at, subscribed=0)
        print('[live_positions_ws] Stopped.', flush=True)

if __name__ == '__main__':
    main()
