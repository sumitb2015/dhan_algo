import pandas as pd
import os
import sys
import pandas_ta as ta
import numpy as np

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from lib.dhan_helper import DhanHelper
from login import get_dhan_client

def main():
    parquet_path = os.path.join("Historical Data Parquet", "NIFTY_50_1Min_5Y.parquet")
    
    if not os.path.exists(parquet_path):
        print(f"Error: {parquet_path} not found.")
        return

    print(f"Loading {parquet_path}...")
    df = pd.read_parquet(parquet_path)
    
    # Check if indicators already exist
    existing_cols = df.columns.tolist()
    target_cols = ['EMA9', 'EMA20', 'SUPERTREND_10_2']
    
    # We might want to overwrite or only add missing ones. 
    # Let's overwrite to ensure they are calculated with the latest logic.
    print(f"Calculating indicators: {target_cols}...")
    
    # EMA 9
    df['EMA9'] = df.ta.ema(length=9)
    
    # EMA 20
    df['EMA20'] = df.ta.ema(length=20)
    
    # Supertrend(10, 2)
    period = 10
    multiplier = 2
    
    # Manual Calculation to match TradingView logic (RMA ATR)
    high, low, close = df['High'], df['Low'], df['Close']
    price_diffs = [high - low, 
                   (high - close.shift()).abs(), 
                   (low - close.shift()).abs()]
    tr = pd.concat(price_diffs, axis=1).max(axis=1)
    atr = tr.ewm(alpha=1/period, min_periods=period).mean()

    hl2 = (high + low) / 2
    upperband = hl2 + (multiplier * atr)
    lowerband = hl2 - (multiplier * atr)
    
    supertrend = np.zeros(len(df))
    direction = np.ones(len(df))
    
    # Start loop from first valid ATR
    for i in range(1, len(df)):
        curr, prev = i, i - 1
        if close.iloc[curr] > upperband.iloc[prev]:
            direction[i] = 1
        elif close.iloc[curr] < lowerband.iloc[prev]:
            direction[i] = -1
        else:
            direction[i] = direction[prev]
            if direction[i] == 1 and lowerband.iloc[i] < lowerband.iloc[prev]:
                lowerband.iat[i] = lowerband.iat[prev]
            if direction[i] == -1 and upperband.iloc[i] > upperband.iloc[prev]:
                upperband.iat[i] = upperband.iat[prev]
        
        supertrend[i] = lowerband.iloc[i] if direction[i] == 1 else upperband.iloc[i]
            
    df['SUPERTREND_10_2'] = supertrend
    df['SUPERTREND_10_2_DIR'] = direction
    
    print("Indicators calculated.")
    print(df.tail(10))
    
    # Save back to parquet
    print(f"Saving updated data to {parquet_path}...")
    df.to_parquet(parquet_path, index=False)
    print("Done.")

if __name__ == "__main__":
    main()
