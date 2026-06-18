import pandas as pd
import numpy as np
import os
import sys

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pandas_ta as ta

def calculate_indicators(df):
    length = 10
    multiplier = 2
    
    high, low, close = df['High'], df['Low'], df['Close']
    
    # Calculate ATR using Wilder's (RMA) logic
    price_diffs = [high - low, 
                   (high - close.shift()).abs(), 
                   (low - close.shift()).abs()]
    tr = pd.concat(price_diffs, axis=1).max(axis=1)
    # Using alpha=1/length to match RMA
    atr = tr.ewm(alpha=1/length, min_periods=length, adjust=True).mean()

    hl2 = (high + low) / 2
    final_ub = (hl2 + (multiplier * atr)).copy()
    final_lb = (hl2 - (multiplier * atr)).copy()

    direction = np.ones(len(df)) # 1 for Bullish, -1 for Bearish
    
    for i in range(1, len(df)):
        curr, prev = i, i - 1
        
        # 1. Update Direction
        if close.iloc[curr] > final_ub.iloc[prev]:
            direction[i] = 1
        elif close.iloc[curr] < final_lb.iloc[prev]:
            direction[i] = -1
        else:
            direction[i] = direction[prev]
            
            # 2. Ratchet logic: Bands can only move in favor of trend
            if direction[i] == 1 and final_lb.iloc[curr] < final_lb.iloc[prev]:
                final_lb.iat[curr] = final_lb.iat[prev]
            if direction[i] == -1 and final_ub.iloc[curr] > final_ub.iloc[prev]:
                final_ub.iat[curr] = final_ub.iat[prev]
                
    df['SUPERTREND_DIR_CALC'] = direction
    df['SUPERTREND_VAL_CALC'] = np.where(direction == 1, final_lb, final_ub)
    df['ATR'] = atr
    
    return df

def main():
    parquet_path = os.path.join("Historical Data Parquet", "NIFTY_50_1Min_5Y.parquet")
    if not os.path.exists(parquet_path):
        print("Parquet file not found.")
        return

    df = pd.read_parquet(parquet_path)
    df['Datetime'] = pd.to_datetime(df['Datetime'])
    df.sort_values('Datetime', inplace=True)
    df.set_index('Datetime', inplace=True)
    
    # Resample to 5-min
    df_5m = df.resample('5min').agg({
        'Open': 'first',
        'High': 'max',
        'Low': 'min',
        'Close': 'last',
        'Volume': 'sum'
    }).dropna().reset_index()

    df_5m = calculate_indicators(df_5m)
    
    # Filter for 2026-01-23 (Jan 23)
    target_date = "2026-01-23"
    day_df = df_5m[df_5m['Datetime'].dt.date == pd.to_datetime(target_date).date()].copy()
    
    print(f"--- Data and Calculation for {target_date} ---")
    cols = ['Datetime', 'Open', 'High', 'Low', 'Close', 'ATR', 'SUPERTREND_VAL_CALC', 'SUPERTREND_DIR_CALC']
    # Filter for morning hours
    morning_df = day_df[(day_df['Datetime'].dt.time >= pd.Timestamp("09:15:00").time()) & 
                        (day_df['Datetime'].dt.time <= pd.Timestamp("11:30:00").time())]
    
    pd.set_option('display.max_rows', None)
    pd.set_option('display.float_format', '{:.2f}'.format)
    print(morning_df[cols].to_string(index=False))

if __name__ == "__main__":
    main()
