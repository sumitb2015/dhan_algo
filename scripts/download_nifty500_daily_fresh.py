import sys
import os
import pandas as pd
import time
from datetime import datetime, timedelta
import warnings
import glob

# Suppress warnings
warnings.filterwarnings("ignore")

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def is_file_up_to_date(csv_file, today_str):
    if not os.path.exists(csv_file):
        return False
    try:
        df_temp = pd.read_csv(csv_file)
        if df_temp.empty or 'Datetime' not in df_temp.columns:
            return False
        latest_date = pd.to_datetime(df_temp['Datetime'].iloc[-1]).strftime("%Y-%m-%d")
        return latest_date >= today_str
    except Exception:
        return False

def fetch_bulk_quotes(helper, segment, ids):
    quotes = {}
    chunk_size = 100
    for i in range(0, len(ids), chunk_size):
        chunk = ids[i:i+chunk_size]
        retries = 3
        success = False
        while retries > 0 and not success:
            try:
                res = helper.get_quote_data(securities={segment: chunk})
                if isinstance(res, dict) and segment in res and res[segment]:
                    quotes.update(res[segment])
                    success = True
                else:
                    retries -= 1
                    if retries > 0:
                        print(f"\nQuote fetch failed/empty for chunk {i//chunk_size + 1}. Retrying in 2 seconds... ({retries} retries left)")
                        time.sleep(2.0)
            except Exception as e:
                retries -= 1
                if retries > 0:
                    print(f"\nError in quote fetch for chunk {i//chunk_size + 1}: {e}. Retrying in 2 seconds... ({retries} retries left)")
                    time.sleep(2.0)
        time.sleep(1.0)
    return quotes

def main():
    csv_path = "MW-NIFTY-500-25-Jan-2026.csv"
    output_dir = "Daily_Historical_Data_Fresh"
    os.makedirs(output_dir, exist_ok=True)
    
    print(f"\n" + "="*60)
    print("NIFTY 500 DAILY DATA FRESH DOWNLOADER (2 YEARS)")
    print("="*60)
    
    # 1. Parse CSV and extract symbols
    if not os.path.exists(csv_path):
        print(f"[FAIL] CSV file not found: {csv_path}")
        return
        
    try:
        # Auto-detect format: if it contains metadata, first column has non-symbol headers or it has metadata rows
        df_temp = pd.read_csv(csv_path)
        first_col_name = str(df_temp.columns[0]).upper().strip()
        
        # If the first column header contains SYMBOL, it is the clean format
        if "SYMBOL" in first_col_name:
            df_list = df_temp
        else:
            # Re-read skipping the 16 metadata rows
            df_list = pd.read_csv(csv_path, skiprows=16)
            
        # First column is SYMBOL
        symbols = df_list.iloc[:, 0].astype(str).str.strip().tolist()
        
        # Filter unwanted symbols
        symbols = [s for s in symbols if s and s != "NIFTY 500" and not s.startswith("Note") and len(s) > 0 and s != 'nan']
        
    except Exception as e:
        print(f"[FAIL] Could not parse CSV symbols: {e}")
        return

    print(f">>> Found {len(symbols)} symbols.")
    
    # 2. Setup Dhan Client
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)
    
    # 3. Define Date Range (Last 2 Years)
    to_date = datetime.now().strftime("%Y-%m-%d")
    from_date = (datetime.now() - timedelta(days=2*365)).strftime("%Y-%m-%d")
    today_str = to_date

    # 4. Resolve symbols to security details and fetch bulk quotes
    print("\nResolving symbols and fetching bulk quotes to prevent rate limits...")
    security_map = {}
    nse_ids = []
    bse_ids = []
    
    for symbol in symbols:
        sec = helper.get_security_id(symbol=symbol, instrument="EQUITY")
        if sec:
            security_id = int(sec['SECURITY_ID'])
            exch_id = sec.get('EXCH_ID', 'NSE')
            instrument = sec.get('INSTRUMENT', 'EQUITY')
            
            segment = "NSE_EQ"
            if exch_id == "NSE":
                if instrument == "INDEX": segment = "IDX_I"
                elif instrument == "EQUITY": segment = "NSE_EQ"
                else: segment = "NSE_FNO"
            elif exch_id == "BSE":
                if instrument == "INDEX": segment = "BSE_IDX" 
                elif instrument == "EQUITY": segment = "BSE_EQ"
                else: segment = "BSE_FNO"
                
            security_map[symbol] = {
                'security_id': security_id,
                'segment': segment,
                'exch_id': exch_id,
                'instrument': instrument
            }
            if segment == "NSE_EQ":
                nse_ids.append(security_id)
            elif segment == "BSE_EQ":
                bse_ids.append(security_id)
                
    print(f"Fetching quotes in bulk for {len(nse_ids)} NSE and {len(bse_ids)} BSE stocks...")
    all_quotes = {}
    if nse_ids:
        all_quotes.update(fetch_bulk_quotes(helper, "NSE_EQ", nse_ids))
    if bse_ids:
        all_quotes.update(fetch_bulk_quotes(helper, "BSE_EQ", bse_ids))
    print(f"Fetched quotes for {len(all_quotes)} securities.")
    
    # 5. Processing Loop
    success_count = 0
    fail_count = 0
    
    for i, symbol in enumerate(symbols):
        csv_file = os.path.join(output_dir, f"{symbol}_Daily_2Y.csv")
        parquet_file = os.path.join(output_dir, f"{symbol}_Daily_2Y.parquet")
        
        # Resume capability - skip only if CSV exists and is up to date (has today's data)
        if is_file_up_to_date(csv_file, today_str) or os.path.exists(parquet_file):
            print(f"[{i+1}/{len(symbols)}] Skipping {symbol} - Already exists and is up to date.")
            success_count += 1
            continue
            
        print(f"[{i+1}/{len(symbols)}] Fetching: {symbol}...", end="", flush=True)
        
        if symbol not in security_map:
            print(" Symbol Not Found in Master List")
            fail_count += 1
            continue
            
        sec_info = security_map[symbol]
        security_id = sec_info['security_id']
        segment = sec_info['segment']
        instrument = sec_info['instrument']
        
        try:
            # Fetch Daily Data
            df = helper.get_historical_daily_data(
                security_id=security_id,
                exchange_segment=segment,
                instrument_type=instrument,
                from_date=from_date,
                to_date=to_date
            )
            
            if not df.empty:
                # Convert UTC timestamp to IST/Kolkata timezone
                if 'timestamp' in df.columns:
                    df['Datetime'] = pd.to_datetime(df['timestamp'], unit='s').dt.tz_localize('UTC').dt.tz_convert('Asia/Kolkata').dt.tz_localize(None)
                    df.set_index('Datetime', inplace=True)
                    df.sort_index(inplace=True)
                
                # Fetch today's real-time quote to append today's candle (if EOD historical API doesn't have it yet)
                try:
                    quote_data = all_quotes.get(str(security_id), {})
                    if quote_data:
                        ohlc = quote_data.get('ohlc', {})
                        last_trade_time_str = quote_data.get('last_trade_time', '')
                        if last_trade_time_str:
                            trade_dt = datetime.strptime(last_trade_time_str, "%d/%m/%Y %H:%M:%S")
                            trade_date_str = trade_dt.strftime("%Y-%m-%d")
                            if trade_date_str == today_str and trade_date_str not in df.index.strftime("%Y-%m-%d"):
                                new_row = pd.DataFrame({
                                    'open': [ohlc.get('open')],
                                    'high': [ohlc.get('high')],
                                    'low': [ohlc.get('low')],
                                    'close': [ohlc.get('close')],
                                    'volume': [quote_data.get('volume')],
                                    'timestamp': [trade_dt.timestamp()]
                                }, index=pd.to_datetime([trade_date_str]))
                                new_row.index.name = 'Datetime'
                                df = pd.concat([df, new_row])
                                print(" (Appended today's quote)", end="")
                except Exception as ex:
                    print(f" (Quote error: {ex})", end="")
                
                # Save as parquet (retaining original index name and lowercase columns)
                df.to_parquet(parquet_file)
                print(f" Success ({len(df)} days)")
                success_count += 1
            else:
                print(" No Data")
                fail_count += 1
                
        except Exception as e:
            print(f" Error: {e}")
            fail_count += 1
            
        # Rate limit safety for historical candles endpoint
        time.sleep(0.5)

    print(f"\n" + "="*60)
    print(f"DOWNLOAD COMPLETE!")
    print(f"Success: {success_count} | Failed: {fail_count}")
    print(f"Folder: {output_dir}")
    print("="*60)
    
    # 6. Convert downloaded parquet files to CSV
    print("\nConverting Parquet files to CSV...")
    parquet_files = glob.glob(os.path.join(output_dir, "*.parquet"))
    if parquet_files:
        converted_count = 0
        for f in parquet_files:
            try:
                df = pd.read_parquet(f)
                if df.index.name is None:
                    df.index.name = 'Datetime'
                else:
                    df.index.name = df.index.name.capitalize()
                    
                df_save = df.reset_index()
                df_save.columns = [str(c).capitalize() for c in df_save.columns]
                
                csv_path_file = f.replace(".parquet", ".csv")
                df_save.to_csv(csv_path_file, index=False)
                os.remove(f)
                converted_count += 1
            except Exception as e:
                print(f"Error converting {f}: {e}")
        print(f"Converted {converted_count} parquet files to CSV successfully.")
    else:
        print("No new parquet files to convert.")

if __name__ == "__main__":
    main()
