import pandas as pd
import numpy as np
import pandas_ta as ta
import os

def calculate_exact_tv_supertrend(df, period=10, multiplier=2):
    high = df['High'].values
    low = df['Low'].values
    close = df['Close'].values
    
    # 1. TR Calculation
    # TR = max(high-low, abs(high-prev_close), abs(low-prev_close))
    tr = np.zeros(len(df))
    # First TR is simply high-low
    tr[0] = high[0] - low[0]
    
    for i in range(1, len(df)):
        tr[i] = max(high[i] - low[i], 
                    abs(high[i] - close[i-1]), 
                    abs(low[i] - close[i-1]))
                    
    # 2. ATR (RMA) Calculation
    # TradingView rma(src, length) =>
    #   alpha = 1/length
    #   sum = 0.0
    #   sum := alpha * src + (1 - alpha) * nz(sum[1])
    # INITIALIZATION: usually SMA of first 'length' bars or just accumulation?
    # TV docs say: "RMA is Moving Average used in RSI. It is the exponentially weighted moving average with alpha = 1 / length."
    # Standard Pine Script initialization for RMA/EMA depends on the function.
    # Often it starts with SMA(tr, length) as the first value at index 'length-1'.
    
    alpha = 1.0 / period
    atr = np.zeros(len(df))
    atr[:] = np.nan
    
    # Calculate initial SMA for the first valid RMA value
    # Sum first 'period' TRs
    initial_sum = np.sum(tr[0:period])
    atr[period-1] = initial_sum / period
    
    # Calculate rest
    for i in range(period, len(df)):
        atr[i] = alpha * tr[i] + (1 - alpha) * atr[i-1]
        
    # 3. Supertrend Bands
    hl2 = (high + low) / 2
    final_ub = np.zeros(len(df))
    final_lb = np.zeros(len(df))
    trend = np.zeros(len(df), dtype=int) # 1: Bullish, -1: Bearish
    
    # Initialize logic
    # We need to handle the pre-ATR period (0 to period-1) where ATR is NaN
    # Let's fill with NaNs
    final_ub[:] = np.nan
    final_lb[:] = np.nan
    
    # First valid index is 'period-1' (0-based)
    # We can start calculating bands from 'period-1'
    idx = period - 1
    
    # Initialize bands at first valid ATR
    curr_atr = atr[idx]
    basic_ub = hl2[idx] + (multiplier * curr_atr)
    basic_lb = hl2[idx] - (multiplier * curr_atr)
    final_ub[idx] = basic_ub
    final_lb[idx] = basic_lb
    trend[idx] = 1 # Arbitrary start, or check close vs bands?
    
    for i in range(period, len(df)):
        prev = i-1
        curr_atr = atr[i]
        
        # Calculate Basic Bands
        basic_ub = hl2[i] + (multiplier * curr_atr)
        basic_lb = hl2[i] - (multiplier * curr_atr)
        
        # Calculate Final Upper Band
        # If (Basic UB < Prev Final UB) OR (Prev Close > Prev Final UB) -> Basic UB
        # Else -> Prev Final UB
        if (basic_ub < final_ub[prev]) or (close[prev] > final_ub[prev]):
            final_ub[i] = basic_ub
        else:
            final_ub[i] = final_ub[prev]
            
        # Calculate Final Lower Band
        # If (Basic LB > Prev Final LB) OR (Prev Close < Prev Final LB) -> Basic LB
        # Else -> Prev Final LB
        if (basic_lb > final_lb[prev]) or (close[prev] < final_lb[prev]):
            final_lb[i] = basic_lb
        else:
            final_lb[i] = final_lb[prev]
            
        # Determine Trend
        # If Prev Trend was Bullish (1):
        #   If Close < Final LB -> Bearish (-1)
        #   Else -> Bullish (1)
        # If Prev Trend was Bearish (-1):
        #   If Close > Final UB -> Bullish (1)
        #   Else -> Bearish (-1)
        
        # Wait, the logic is usually:
        # trend := true
        # trend := close > final_ub[1] ? true : close < final_lb[1] ? false : trend[1]
        
        if trend[prev] == 1:
            if close[i] < final_lb[prev]: # Crossed below
                trend[i] = -1
            else:
                trend[i] = 1
        elif trend[prev] == -1:
            if close[i] > final_ub[prev]: # Crossed above
                trend[i] = 1
            else:
                trend[i] = -1
        else:
            # Should not happen if initialized
            trend[i] = 1
            
    # Compile results
    st_val = np.zeros(len(df))
    for i in range(len(df)):
        if trend[i] == 1:
            st_val[i] = final_lb[i]
        else:
            st_val[i] = final_ub[i]
            
    return pd.DataFrame({
        'TR': tr,
        'ATR': atr,
        'Final_UB': final_ub,
        'Final_LB': final_lb,
        'Trend': trend,
        'ST_Val': st_val
    }, index=df.index)

def main():
    parquet_path = os.path.join("Historical Data Parquet", "NIFTY_50_1Min_5Y.parquet")
    print(f"Loading data from {parquet_path}...")
    df_raw = pd.read_parquet(parquet_path)
    df_raw['Datetime'] = pd.to_datetime(df_raw['Datetime'])
    df_raw.set_index('Datetime', inplace=True)
    
    # Resample to 5min
    df = df_raw.resample('5min').agg({
        'Open': 'first',
        'High': 'max',
        'Low': 'min',
        'Close': 'last'
    }).dropna()
    
    # Focus on a specific recent day for comparison
    target_date = "2026-01-23" # User's sample day
    start_dt = pd.to_datetime(f"{target_date} 09:00:00")
    end_dt = pd.to_datetime(f"{target_date} 15:30:00")
    
    # Need enough lookback for ATR to stabilize if we want exact match? 
    # Or just check if the logic holds for the day window?
    # RMA has infinite memory, so we should calculate on full history or a large chunk before.
    # Let's use the full df for calculation, then slice.
    
    print("Calculating Exact TV Supertrend on full data...")
    res = calculate_exact_tv_supertrend(df, period=10, multiplier=2)
    
    # Add Price for context
    res['Close'] = df['Close']
    
    # Slice
    mask = (res.index >= start_dt) & (res.index <= end_dt)
    view = res.loc[mask]
    
    print("\n--- Detailed Calculation for 2026-01-23 ---")
    print(view[['Close', 'TR', 'ATR', 'Final_UB', 'Final_LB', 'Trend', 'ST_Val']].head(20))
    print("...")
    print(view[['Close', 'TR', 'ATR', 'Final_UB', 'Final_LB', 'Trend', 'ST_Val']].tail(10))
    
    # Print a specific candle for "Spot Check" by user
    check_time = pd.to_datetime("2026-01-23 09:15:00")
    if check_time in view.index:
        r = view.loc[check_time]
        print(f"\nSPOT CHECK at {check_time}:")
        print(f"Close: {r['Close']:.2f}")
        print(f"TR: {r['TR']:.2f}")
        print(f"ATR (10): {r['ATR']:.4f}")
        print(f"Supertrend (10,2): {r['ST_Val']:.4f}")
        print(f"Trend: {'BULL' if r['Trend']==1 else 'BEAR'}")

if __name__ == "__main__":
    main()
