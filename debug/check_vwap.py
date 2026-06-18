import pandas as pd
import os

def check_reliance_vwap():
    file_path = "Stocks Historical Data Parquet/RELIANCE_1Min_5Y.parquet"
    df = pd.read_parquet(file_path)
    df['Datetime'] = pd.to_datetime(df['Datetime'])
    df.set_index('Datetime', inplace=True)
    
    friday = df[df.index >= '2026-01-23 09:15:00']
    
    total_val = (friday['Close'] * friday['Volume']).sum()
    total_vol = friday['Volume'].sum()
    vwap = total_val / total_vol if total_vol > 0 else 0
    
    print(f"Reliance Friday VWAP: {vwap:.2f}")
    
    # Check if (Close - VWAP) / VWAP is -1.17%
    close = friday['Close'].iloc[-1]
    pct = ((close - vwap) / vwap) * 100
    print(f"Change vs VWAP: {pct:.2f}%")

if __name__ == "__main__":
    check_reliance_vwap()
