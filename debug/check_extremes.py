import pandas as pd
import os

def check_extremes():
    file_path = "Stocks Historical Data Parquet/RELIANCE_1Min_5Y.parquet"
    df = pd.read_parquet(file_path)
    df['Datetime'] = pd.to_datetime(df['Datetime'])
    df.set_index('Datetime', inplace=True)
    
    friday = df[df.index >= '2026-01-23 09:15:00']
    
    o = friday['Open'].iloc[0]
    h = friday['High'].max()
    l = friday['Low'].min()
    c = friday['Close'].iloc[-1]
    
    print(f"Reliance Friday OHLC: {o}, {h}, {l}, {c}")
    print(f"Close vs Open: {((c-o)/o)*100:.2f}%")
    print(f"Close vs High: {((c-h)/h)*100:.2f}%")
    print(f"Close vs Low: {((c-l)/l)*100:.2f}%")
    
    # Target search -1.17%
    target = o * (1 - 0.0117)
    print(f"Price for -1.17% vs Open: {target:.2f}")

if __name__ == "__main__":
    check_extremes()
