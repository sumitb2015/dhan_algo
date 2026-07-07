"""
Rank ATM+/-10 options strikes for NIFTY/BANKNIFTY/FINNIFTY based on:
Price Change, OI Change, RSI, Supertrend, VWAP, EMA 20, EMA 50

Usage:
    python options_analyzer.py --underlying NIFTY --expiry 2026-07-14 --interval 15
"""
import sys
import os
import json
import argparse
import time
import random
import pandas as pd
import threading
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper


class RateLimiter:
    """Thread-safe rate limiter to space out API requests."""
    def __init__(self, max_per_second):
        self.interval = 1.0 / max_per_second
        self.next_time = time.time()
        self.lock = threading.Lock()
        
    def acquire(self):
        with self.lock:
            now = time.time()
            if now < self.next_time:
                sleep_time = self.next_time - now
                time.sleep(sleep_time)
                self.next_time += self.interval
            else:
                self.next_time = now + self.interval


# Create a global rate limiter to limit requests to exactly 4 requests per second
# Dhan FNO historical/minute API limits to 5 requests per second
api_rate_limiter = RateLimiter(max_per_second=4.0)


def fetch_candles_for_sec(helper, sec, interval, days):
    if not sec:
        return pd.DataFrame()
    
    security_id = int(sec['SECURITY_ID'])
    exch_id = sec.get('EXCH_ID', 'NSE')
    instr = sec.get('INSTRUMENT', 'EQUITY')
    
    exchange_segment = "NSE_EQ"
    if exch_id == "NSE":
        if instr == "INDEX": exchange_segment = "IDX_I"
        elif instr == "EQUITY": exchange_segment = "NSE_EQ"
        else: exchange_segment = "NSE_FNO"
    elif exch_id == "BSE":
        if instr == "INDEX": exchange_segment = "BSE_IDX" 
        elif instr == "EQUITY": exchange_segment = "BSE_EQ"
        else: exchange_segment = "BSE_FNO"
    elif exch_id == "MCX":
        exchange_segment = "MCX_COMM"
        
    instrument_type = sec['INSTRUMENT']
    
    to_date_obj = datetime.now()
    effective_days = max(days, 5)
    from_date_obj = to_date_obj - timedelta(days=effective_days)
    
    to_date = to_date_obj.strftime("%Y-%m-%d")
    from_date = from_date_obj.strftime("%Y-%m-%d")
    
    api_interval = interval
    if interval == "30":
        api_interval = "15"
    
    df = pd.DataFrame()
    max_retries = 5
    for attempt in range(max_retries):
        try:
            # Wait for rate limiter slot to ensure we stay under Dhan limits
            api_rate_limiter.acquire()
            
            res = helper.dhan.intraday_minute_data(
                security_id=str(security_id),
                exchange_segment=exchange_segment,
                instrument_type=instrument_type,
                interval=api_interval,
                from_date=from_date,
                to_date=to_date,
                oi=True
            )
            
            if isinstance(res, dict):
                remarks = res.get('remarks', {})
                remarks_str = str(remarks)
                
                # Check for rate limiting
                if 'DH-904' in remarks_str or 'Rate_Limit' in remarks_str or 'Too many requests' in remarks_str:
                    # Additional backing off on explicit rate limit responses
                    wait_time = 1.0 * (2 ** attempt) + random.uniform(0.1, 0.5)
                    sys.stderr.write(f"Rate limited on {security_id}. Retrying in {wait_time:.2f}s... (Attempt {attempt+1}/{max_retries})\n")
                    time.sleep(wait_time)
                    continue
                    
                if res.get('status') == 'success':
                    data = res.get('data', [])
                    df = pd.DataFrame(data)
                    break
                else:
                    # Non-rate-limit error (e.g. genuinely no volume/candles for deep OTM/ITM options)
                    break
            else:
                break
        except Exception as e:
            sys.stderr.write(f"Exception in fetching candles for {security_id}: {e}\n")
            time.sleep(0.5)
            
    if df.empty:
        return df
    
    # Normalize Data
    rename_map = {
        "start_time": "Datetime", "start_Time": "Datetime", "kline_time": "Datetime",
        "timestamp": "Datetime",
        "open": "Open", "high": "High", "low": "Low", "close": "Close", "volume": "Volume"
    }
    cols = df.columns
    new_map = {}
    for c in cols:
        low_c = c.lower()
        if low_c in rename_map:
            new_map[c] = rename_map[low_c]
    
    df = df.rename(columns=new_map)
    desired_cols = ["Datetime", "Open", "High", "Low", "Close", "Volume"]
    available_cols = [c for c in desired_cols if c in df.columns]
    df = df[available_cols]
    
    if "Datetime" in df.columns:
        first_val = df["Datetime"].iloc[0]
        if isinstance(first_val, (int, float)):
            df["Datetime"] = pd.to_datetime(df["Datetime"], unit='s').dt.tz_localize('UTC').dt.tz_convert('Asia/Kolkata').dt.tz_localize(None)
        else:
            df["Datetime"] = pd.to_datetime(df["Datetime"])
        df = df.set_index("Datetime").sort_index()
        
    return df


def analyze_single_contract(helper, sec, contract_info, option_type, strike, interval):
    try:
        if not sec:
            return {
                'symbol': 'Unknown',
                'display_name': 'Unknown',
                'security_id': int(contract_info.get('security_id', 0)),
                'ltp': float(contract_info.get('last_price', 0)),
                'prev_close': float(contract_info.get('previous_close_price', 0)),
                'oi': int(contract_info.get('oi', 0)),
                'prev_oi': int(contract_info.get('previous_oi', 0)),
                'rsi': None,
                'vwap': None,
                'ema20': None,
                'ema50': None,
                'supertrend_dir': None
            }
            
        symbol = sec.get('SYMBOL_NAME', '')
        security_id = int(sec.get('SECURITY_ID', 0))
        display_name = sec.get('DISPLAY_NAME', '')
        
        # Request last 10 days of candles
        df = fetch_candles_for_sec(helper, sec, interval, days=10)
        
        if df.empty or len(df) < 5:
            return {
                'symbol': symbol,
                'display_name': display_name,
                'security_id': security_id,
                'ltp': float(contract_info.get('last_price', 0)),
                'prev_close': float(contract_info.get('previous_close_price', 0)),
                'oi': int(contract_info.get('oi', 0)),
                'prev_oi': int(contract_info.get('previous_oi', 0)),
                'rsi': None,
                'vwap': None,
                'ema20': None,
                'ema50': None,
                'supertrend_dir': None
            }
            
        df_ta = helper.calculate_ta_indicators(df, ['EMA20', 'EMA50', 'RSI14', 'VWAP', 'SUPERTREND'])
        
        last_row = df_ta.iloc[-1]
        
        rsi = float(last_row.get('RSI_14')) if not pd.isna(last_row.get('RSI_14')) else None
        vwap = float(last_row.get('VWAP_D')) if not pd.isna(last_row.get('VWAP_D')) else None
        ema20 = float(last_row.get('EMA_20')) if not pd.isna(last_row.get('EMA_20')) else None
        ema50 = float(last_row.get('EMA_50')) if not pd.isna(last_row.get('EMA_50')) else None
        supertrend_dir = int(last_row.get('SUPERTd_7_3.0')) if not pd.isna(last_row.get('SUPERTd_7_3.0')) else None
        
        ltp = float(last_row.get('Close', contract_info.get('last_price', 0)))
        prev_close = float(contract_info.get('previous_close_price', 0))
        
        return {
            'symbol': symbol,
            'display_name': display_name,
            'security_id': security_id,
            'ltp': ltp,
            'prev_close': prev_close,
            'oi': int(contract_info.get('oi', 0)),
            'prev_oi': int(contract_info.get('previous_oi', 0)),
            'rsi': rsi,
            'vwap': vwap,
            'ema20': ema20,
            'ema50': ema50,
            'supertrend_dir': supertrend_dir
        }
    except Exception as e:
        sys.stderr.write(f"Error analyzing contract: {e}\n")
        return {
            'symbol': sec.get('SYMBOL_NAME', 'Unknown') if sec else 'Unknown',
            'display_name': sec.get('DISPLAY_NAME', 'Unknown') if sec else 'Unknown',
            'security_id': int(sec.get('SECURITY_ID', 0)) if sec else int(contract_info.get('security_id', 0)),
            'ltp': float(contract_info.get('last_price', 0)),
            'prev_close': float(contract_info.get('previous_close_price', 0)),
            'oi': int(contract_info.get('oi', 0)),
            'prev_oi': int(contract_info.get('previous_oi', 0)),
            'rsi': None,
            'vwap': None,
            'ema20': None,
            'ema50': None,
            'supertrend_dir': None,
            'error': str(e)
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--underlying', default='NIFTY')
    parser.add_argument('--expiry', required=True)
    parser.add_argument('--interval', default='15')
    args = parser.parse_args()
    
    dhan = get_dhan_client()
    if not dhan:
        print(json.dumps({'error': 'auth_failed — run login.py to refresh the access token'}))
        return
        
    helper = DhanHelper(dhan)
    
    # Auto-refresh master list if older than 24 hours
    csv_path = helper._master_list_path
    if os.path.exists(csv_path):
        mtime = os.path.getmtime(csv_path)
        age_hours = (time.time() - mtime) / 3600.0
        if age_hours > 24:
            sys.stderr.write(f"Master list is {age_hours:.1f} hours old. Refreshing from Dhan API...\n")
            helper.fetch_security_list()
    else:
        sys.stderr.write("Master list does not exist. Downloading from Dhan API...\n")
        helper.fetch_security_list()
        
    # Fetch Option Chain
    chain = helper.get_option_chain(
        symbol=args.underlying.upper(),
        expiry=args.expiry,
        exchange_segment='IDX_I'
    )
    
    if not chain:
        print(json.dumps({'error': f'Failed to retrieve option chain for {args.underlying} on {args.expiry}'}))
        return
        
    spot = chain.get('last_price', 0.0)
    if not spot:
        spot = helper.get_ltp(args.underlying.upper(), exchange='IDX_I', instrument='INDEX') or 0.0
        
    oc = chain.get('oc', {})
    if not oc:
        print(json.dumps({'error': 'No option contracts found'}))
        return
        
    # Get all strikes
    strikes = sorted([float(k) for k in oc.keys()])
    if not strikes:
        print(json.dumps({'error': 'No strikes found in option chain'}))
        return
        
    # Find ATM strike
    atm_strike = min(strikes, key=lambda x: abs(x - spot))
    atm_idx = strikes.index(atm_strike)
    
    # Get ATM +/- 10 strikes
    start_idx = max(0, atm_idx - 10)
    end_idx = min(len(strikes), atm_idx + 11)
    selected_strikes = strikes[start_idx:end_idx]
    
    # Resolve all security IDs in main thread (thread-safety)
    resolved_info = {}
    for strike in selected_strikes:
        strike_str = f"{strike:.6f}"
        strike_data = oc.get(strike_str)
        if not strike_data:
            continue
        for opt_type in ('ce', 'pe'):
            info = strike_data.get(opt_type)
            if info and info.get('security_id'):
                sid = str(info['security_id'])
                sec_rec = helper._resolve_symbol(sid)
                if sec_rec:
                    resolved_info[sid] = sec_rec
                    
    # Fetch and compute in parallel (using 4 workers managed by rate limiter)
    results_map = {}
    
    def process_contract(sid, contract_info, opt_type, strike_price):
        sec_rec = resolved_info.get(str(sid))
        res = analyze_single_contract(
            helper, sec_rec, contract_info, opt_type, strike_price, args.interval
        )
        results_map[f"{strike_price}_{opt_type}"] = res

    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = []
        for strike in selected_strikes:
            strike_str = f"{strike:.6f}"
            strike_data = oc.get(strike_str)
            if not strike_data:
                continue
            
            ce_info = strike_data.get('ce')
            if ce_info and ce_info.get('security_id'):
                futures.append(executor.submit(
                    process_contract, ce_info['security_id'], ce_info, 'CE', strike
                ))
                
            pe_info = strike_data.get('pe')
            if pe_info and pe_info.get('security_id'):
                futures.append(executor.submit(
                    process_contract, pe_info['security_id'], pe_info, 'PE', strike
                ))
                
        # Wait for all to complete
        for f in futures:
            try:
                f.result()
            except Exception as e:
                sys.stderr.write(f"Future error: {e}\n")

    # Combine results
    strikes_output = []
    for strike in selected_strikes:
        ce_res = results_map.get(f"{strike}_CE")
        pe_res = results_map.get(f"{strike}_PE")
        strikes_output.append({
            'strike': strike,
            'ce': ce_res,
            'pe': pe_res
        })
        
    output = {
        'spot': spot,
        'atm': atm_strike,
        'expiry': args.expiry,
        'strikes': strikes_output
    }
    
    print(json.dumps(output))


if __name__ == '__main__':
    main()
