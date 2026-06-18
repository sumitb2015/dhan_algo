import pandas as pd
import numpy as np
import os
import pandas_ta as ta

def calculate_st_manual(df, length, multiplier, mode='rma', source='hl2'):
    if source == 'hl2':
        src = (df['High'] + df['Low']) / 2
    elif source == 'close':
        src = df['Close']
    elif source == 'hlc3':
        src = (df['High'] + df['Low'] + df['Close']) / 3
    else:
        src = (df['Open'] + df['High'] + df['Low'] + df['Close']) / 4
        
    atr = ta.atr(df['High'], df['Low'], df['Close'], length=length, mamode=mode)
    
    basic_ub = src + (multiplier * atr)
    basic_lb = src - (multiplier * atr)

    final_ub = basic_ub.copy()
    final_lb = basic_lb.copy()
    direction = np.zeros(len(df))
    
    # Initialize first valid index
    first_valid = atr.first_valid_index()
    if first_valid is None: return np.full(len(df), np.nan)
    start_idx = df.index.get_loc(first_valid)

    for i in range(start_idx + 1, len(df)):
        curr, prev = i, i - 1
        
        # Upper band ratchet
        if basic_ub.iloc[curr] < final_ub.iloc[prev] or df['Close'].iloc[prev] > final_ub.iloc[prev]:
            final_ub.iat[curr] = basic_ub.iloc[curr]
        else:
            final_ub.iat[curr] = final_ub.iloc[prev]
            
        # Lower band ratchet
        if basic_lb.iloc[curr] > final_lb.iloc[prev] or df['Close'].iloc[prev] < final_lb.iloc[prev]:
            final_lb.iat[curr] = basic_lb.iloc[curr]
        else:
            final_lb.iat[curr] = final_lb.iloc[prev]
            
        # Direction
        if df['Close'].iloc[curr] > final_ub.iloc[prev]:
            direction[i] = 1
        elif df['Close'].iloc[curr] < final_lb.iloc[prev]:
            direction[i] = -1
        else:
            direction[i] = direction[prev]
            if direction[i] == 0: direction[i] = 1 # Default to bullish if unknown
                
    st_val = np.where(direction == 1, final_lb, final_ub)
    return st_val

def main():
    parquet_path = "Historical Data Parquet/NIFTY_50_1Min_5Y.parquet"
    if not os.path.exists(parquet_path):
        print("Parquet not found")
        return
        
    df_raw = pd.read_parquet(parquet_path)
    df_raw['Datetime'] = pd.to_datetime(df_raw['Datetime'])
    df_raw.set_index('Datetime', inplace=True)
    df = df_raw.resample('5min').agg({'Open': 'first', 'High': 'max', 'Low': 'min', 'Close': 'last'}).dropna()

    target_val = 25258.75
    target_start = "2026-01-23 09:15:00"
    target_end = "2026-01-23 11:25:00"

    # Optimization: Slice data to only what is needed for stabilization + target range
    # 500 bars of 5-min data is about 4 days. Let's take 1000 bars.
    target_idx = df.index.get_loc(pd.to_datetime(target_start))
    start_slice = max(0, target_idx - 1000)
    df = df.iloc[start_slice : target_idx + 100] # Include some bars after target too

    print(f"Scanning for ST value {target_val} (Slice size: {len(df)} bars)...")

    # Wider search
    lengths = [7, 10, 11, 12, 14, 20]
    multipliers = [1.0, 1.5, 2.0, 2.5, 2.618, 3.0, 3.5, 4.0]
    modes = ['rma', 'ema', 'sma']
    sources = ['hl2', 'close', 'hlc3', 'ohlc4']

    results = []

    for l in lengths:
        for m in multipliers:
            for mode in modes:
                for src in sources:
                    st_series = calculate_st_manual(df, l, m, mode, src)
                    df_res = pd.DataFrame({'ST': st_series}, index=df.index)
                    
                    if pd.to_datetime(target_start) not in df_res.index: continue
                    subset = df_res.loc[target_start:target_end]
                    
                    val = subset['ST'].iloc[0]
                    if abs(val - target_val) < 0.2:
                        is_flat = subset['ST'].nunique() == 1
                        results.append({'l': l, 'm': m, 'mode': mode, 'src': src, 'val': val})
                        print(f"MATCH! Params(L={l}, M={m}, Mode={mode}, Src={src}): Value={val:.2f}, Flat={is_flat}")

    if not results:
        print("No exact matches. Trying precise multipliers for common periods...")
        for l in [7, 10, 14]:
            for mode in ['rma']:
                for m in np.arange(1.5, 3.5, 0.01):
                    st_series = calculate_st_manual(df, l, m, mode, 'hl2')
                    val = pd.Series(st_series, index=df.index).loc[target_start]
                    if abs(val - target_val) < 0.05:
                        print(f"PRECISE MATCH! Params(L={l}, M={m:.2f}, Mode={mode}): Value={val:.2f}")

if __name__ == "__main__":
    main()
