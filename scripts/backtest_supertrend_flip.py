import pandas as pd
import os
import sys
import pandas_ta as ta
import numpy as np
from datetime import datetime

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper
except ImportError:
    print("Warning: Could not import Dhan client/helper. Make sure you are in the project root.")

def calculate_indicators(df):
    """
    Calculate EMA200 and Supertrend(10, 2) manually using RMA-smoothed ATR 
    to exactly match TradingView's implementation.
    """
    print(f"Calculating Indicators on DF with shape: {df.shape}")
    
    # Ensure float types
    cols_to_float = ['Open', 'High', 'Low', 'Close']
    for c in cols_to_float:
        if c in df.columns:
            df[c] = df[c].astype(float)

    # 1. EMA 200
    # Use functional API to ensure we get a Series from the Close column
    ema_200 = ta.ema(df['Close'], length=200)
    df['EMA200_CALC'] = ema_200
    
    # 2. Supertrend Calculation using pandas_ta
    # This appends columns like SUPERT_10_2.0, SUPERTd_10_2.0, SUPERTl_10_2.0, SUPERTs_10_2.0
    df.ta.supertrend(length=10, multiplier=2, append=True)
    
    # Map pandas_ta columns to the names expected by the rest of the script
    # SUPERT_10_2.0 is the Supertrend Line (Value)
    # SUPERTd_10_2.0 is the Direction (1 for Bullish, -1 for Bearish)
    if 'SUPERT_10_2.0' in df.columns:
        df['SUPERTREND_VAL_CALC'] = df['SUPERT_10_2.0']
        df['SUPERTREND_DIR_CALC'] = df['SUPERTd_10_2.0']
    else:
        # Fallback in case column names are different (e.g. integer vs float suffix)
        # Some versions might produce SUPERT_10_2
        cols = [c for c in df.columns if c.startswith('SUPERT_')]
        dir_cols = [c for c in df.columns if c.startswith('SUPERTd_')]
        if cols and dir_cols:
             df['SUPERTREND_VAL_CALC'] = df[cols[0]]
             df['SUPERTREND_DIR_CALC'] = df[dir_cols[0]]
    
    return df

def fetch_fresh_data():
    print("Initializing Dhan Client...")
    try:
        dhan_client = get_dhan_client()
        if not dhan_client:
            print("Failed to initialize client.")
            return None
    except Exception as e:
        print(f"Error initializing client: {e}")
        return None

    helper = DhanHelper(dhan_client)
    
    # Nifty 50 Index: Security ID 13, Segment IDX_I
    security_id = "13"
    exchange_segment = "IDX_I"
    instrument_type = "INDEX"
    
    # Specific dates as requested (extended for EMA 200 warmup)
    # Need at least 200 candles before the target date. 
    # 5 min candles -> 75 candles per day (approx? No 375). 
    # One day is 375 candles. So 2 days is enough. 
    # fetching from Jan 19 to be safe.
    from_date = "2026-01-19"
    to_date = "2026-01-23"

    print(f"Fetching 5-minute candles for Nifty 50 from {from_date} to {to_date}...")
    
    try:
        df = helper.get_historical_data(
            security_id=security_id,
            exchange_segment=exchange_segment,
            instrument_type=instrument_type,
            from_date=from_date,
            to_date=to_date,
            interval="5" # 5-minute interval
        )
    except Exception as e:
        print(f"Error fetching data: {e}")
        return None

    if df.empty:
        print("No data returned from API.")
        return None
        
    print("Success! Data fetched.")
    
    # Standardize column names and types
    # Dhan API usually returns 'start_Time' as epoch seconds
    if 'start_Time' in df.columns:
        # Check if helper has the method, otherwise use pandas directly
        if hasattr(helper, 'epoch_to_datetime'):
             df['Datetime'] = df['start_Time'].apply(helper.epoch_to_datetime)
        else:
             # Assume epoch seconds
             # Adjust for IST if needed (assuming UTC source)
             # Usually standard epoch is UTC. to_datetime gives UTC or naive.
             # We can add +5:30 because Dhan candles are in IST but generic epoch conversion gives UTC
             df['Datetime'] = df['Datetime'] + pd.Timedelta(hours=5, minutes=30)

    elif 'timestamp' in df.columns: # fallback
         # Assuming timestamp is also epoch seconds if it's Int64/Float
         # Smart check: if > 1e11 likely ms, else s
         sample = df['timestamp'].iloc[0] if not df['timestamp'].empty else 0
         unit = 'ms' if sample > 1e11 else 's'
         df['Datetime'] = pd.to_datetime(df['timestamp'], unit=unit)
         # Adjust for IST if needed (assuming UTC source)
         df['Datetime'] = df['Datetime'] + pd.Timedelta(hours=5, minutes=30)
         
    # Rename lowercase columns to Capitalized
    rename_map = {
        'open': 'Open',
        'high': 'High',
        'low': 'Low',
        'close': 'Close',
        'volume': 'Volume'
    }
    df.rename(columns=rename_map, inplace=True)
    
    # Ensure required columns exist
    required = ['Datetime', 'Open', 'High', 'Low', 'Close', 'Volume']
    if not all(col in df.columns for col in required):
        print(f"Missing columns. Available: {df.columns}")
        return None
        
    return df[required]

def run_backtest():
    # Attempt to fetch fresh data first
    df = fetch_fresh_data()
    
    if df is None:
        print("Failed to fetch fresh data. Exiting.")
        return

    print("Using fetched data.")
    # Ensure Datetime is index or column as needed. 
    # fetch_fresh_data returns a DF with Datetime column.
    # The rest of the script expects Datetime column.
    df.sort_values('Datetime', inplace=True)
    df.reset_index(drop=True, inplace=True)

    print("Calculating indicators (EMA20 + Supertrend 10,2) on 5-minute data...")
    df = calculate_indicators(df)
    
    # Get the last trading day's date
    last_date = df['Datetime'].dt.date.max()
    print(f"Last trading day: {last_date}")
    
    # Filter for the last day
    day_df = df[df['Datetime'].dt.date == last_date].copy()
    
    if day_df.empty:
        print("No data found for the last trading day.")
        return

    print(f"Backtesting Strategy (Supertrend + EMA200) for {last_date}")
    print(f"Total candles: {len(day_df)}")
    
    print("\n--- Day Dataframe (OHLC + Indicators) ---")
    # Show all columns including Supertrend and Direction
    pd.set_option('display.max_rows', None)
    print(day_df[['Datetime', 'Open', 'High', 'Low', 'Close', 'EMA200_CALC', 'SUPERTREND_VAL_CALC', 'SUPERTREND_DIR_CALC']].to_string(index=False))
    print("-" * 40 + "\n")
    
    trades = []
    current_position = None # 'LONG', 'SHORT', or None
    entry_price = 0
    entry_time = None
    
    for i in range(len(day_df)):
        row = day_df.iloc[i]
        st_dir = row['SUPERTREND_DIR_CALC']
        price = row['Close']
        time = row['Datetime']
        
        # Track trend flips and trades taken within a trend
        if 'last_st_dir' not in locals():
            last_st_dir = st_dir
            trend_trade_taken = False
        
        # If Supertrend flips, force exit any open position and reset trade tracking
        if st_dir != last_st_dir:
            if current_position is not None:
                pnl = price - entry_price if current_position == 'LONG' else entry_price - price
                trades.append({
                    'Type': current_position,
                    'Entry Time': entry_time,
                    'Exit Time': time,
                    'PnL': round(pnl, 2)
                })
                current_position = None
            
            last_st_dir = st_dir
            trend_trade_taken = False

        # Check for 3:15 PM Hard Exit
        if time.time() >= pd.Timestamp("15:15:00").time():
            if current_position is not None:
                pnl = price - entry_price if current_position == 'LONG' else entry_price - price
                trades.append({
                    'Type': current_position,
                    'Entry Time': entry_time,
                    'Exit Time': time,
                    'PnL': round(pnl, 2)
                })
                current_position = None
            # Do not process entries after 15:15
            continue

        # Entry logic: Only if no trade taken in current trend direction
        # Skip if EMA is not calculated yet (NaN/None)
        if pd.isna(row['EMA200_CALC']):
            continue

        if current_position is None and not trend_trade_taken:
            target_pos = None
            if st_dir == 1 and price > row['EMA200_CALC']:
                target_pos = 'LONG'
            elif st_dir == -1 and price < row['EMA200_CALC']:
                target_pos = 'SHORT'
            
            if target_pos is not None:
                current_position = target_pos
                entry_price = price
                entry_time = time
                trend_trade_taken = True
            
    # Auto-close at EOD
    if current_position is not None:
        last_row = day_df.iloc[-1]
        pnl = last_row['Close'] - entry_price if current_position == 'LONG' else entry_price - last_row['Close']
        trades.append({
            'Type': current_position,
            'Entry Time': entry_time,
            'Exit Time': last_row['Datetime'],
            'PnL': round(pnl, 2)
        })

    if not trades:
        print("No trades executed.")
        return

    res_df = pd.DataFrame(trades)
    print("\n" + "="*80)
    print(f"BACKTEST RESULTS - {last_date}")
    print("="*80)
    print(f"Total Trades:    {len(res_df)}")
    print(f"Total PnL (Pts): {res_df['PnL'].sum():.2f}")
    print(f"Win Rate:        {(res_df['PnL'] > 0).mean()*100:.1f}%")
    print("-" * 80)
    print(res_df.to_string(index=False))
    print("="*80)

if __name__ == "__main__":
    run_backtest()
