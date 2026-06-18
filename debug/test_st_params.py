import pandas as pd
import numpy as np
import os
import sys
import pandas_ta as ta

def calculate_st_manual(df, length, multiplier, mamode='rma'):
    high, low, close = df['High'], df['Low'], df['Close']
    
    if mamode == 'rma':
        # RMA is recursive alpha=1/length
        atr = ta.atr(high, low, close, length=length, mamode='rma')
    elif mamode == 'sma':
        atr = ta.atr(high, low, close, length=length, mamode='sma')
    else:
        atr = ta.atr(high, low, close, length=length, mamode='ema')

    hl2 = (high + low) / 2
    basic_ub = hl2 + (multiplier * atr)
    basic_lb = hl2 - (multiplier * atr)

    first_valid_idx = atr.first_valid_index()
    if first_valid_idx is None:
        return np.full(len(df), np.nan), np.zeros(len(df)), atr

    # Get integer location of the first valid index
    start_idx = df.index.get_loc(first_valid_idx)
    
    final_ub = basic_ub.copy()
    final_lb = basic_lb.copy()
    direction = np.ones(len(df))
    
    # Initialize direction based on close vs bands at start_idx could be arbitrary, 
    # but usually we just start loop. 
    # Ideally, we start loop from start_idx + 1
    
    for i in range(start_idx + 1, len(df)):
        curr, prev = i, i - 1
        
        # Upper band
        if basic_ub.iloc[curr] < final_ub.iloc[prev] or close.iloc[prev] > final_ub.iloc[prev]:
            final_ub.iat[curr] = basic_ub.iloc[curr]
        else:
            final_ub.iat[curr] = final_ub.iloc[prev]
            
        # Lower band
        if basic_lb.iloc[curr] > final_lb.iloc[prev] or close.iloc[prev] < final_lb.iloc[prev]:
            final_lb.iat[curr] = basic_lb.iloc[curr]
        else:
            final_lb.iat[curr] = final_lb.iloc[prev]
            
        # Direction
        # If previous direction was 1 (Bullish), check if Close < Lower Band
        # If previous direction was -1 (Bearish), check if Close > Upper Band
        # But we calculate explicitly based on crossover
        
        if close.iloc[curr] > final_ub.iloc[prev]:
            direction[i] = 1
        elif close.iloc[curr] < final_lb.iloc[prev]:
            direction[i] = -1
        else:
            direction[i] = direction[prev]
            if direction[i] == 0: direction[i] = 1 # Default to bullish if undefined
                
    st_val = np.where(direction == 1, final_lb, final_ub)
    return st_val, direction, atr

def main():
    parquet_path = os.path.join("Historical Data Parquet", "NIFTY_50_1Min_5Y.parquet")
    df_raw = pd.read_parquet(parquet_path)
    df_raw['Datetime'] = pd.to_datetime(df_raw['Datetime'])
    df_raw.set_index('Datetime', inplace=True)
    
    df = df_raw.resample('5min').agg({
        'Open': 'first',
        'High': 'max',
        'Low': 'min',
        'Close': 'last'
    }).dropna()

    combinations = [
        (10, 2, 'rma'),
        (10, 3, 'rma'),
        (10, 2, 'sma'),
        (10, 3, 'sma'),
        (7, 3, 'rma'),
        (14, 2, 'rma')
    ]

    target_time = pd.to_datetime("2026-01-23 09:15:00")
    
    print(f"Checking data at {target_time}:")
    row = df.loc[target_time]
    print(f"Close: {row['Close']}, HL2: {(row['High']+row['Low'])/2}")

    for length, mult, mode in combinations:
        val, dir, atr_series = calculate_st_manual(df, length, mult, mode)
        df_target = pd.DataFrame({'Val': val}, index=df.index)
        st_at_time = df_target.loc[target_time, 'Val']
        atr_at_time = atr_series.loc[target_time]
        dir_at_time = dir[df.index.get_loc(target_time)]
        print(f"Params({length}, {mult}, {mode}): Value={st_at_time:.2f}, ATR={atr_at_time:.2f}, Dir={dir_at_time}")

if __name__ == "__main__":
    main()
