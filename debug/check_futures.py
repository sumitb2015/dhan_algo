import pandas as pd
import os

def check_futures():
    file_path = "Historical Data Parquet/NIFTY_Futures_1min_1Year_Continuous.parquet"
    if not os.path.exists(file_path):
        return

    df = pd.read_parquet(file_path)
    df['Datetime'] = pd.to_datetime(df['Datetime'])
    df.set_index('Datetime', inplace=True)
    
    friday = df[df.index >= '2026-01-23 09:15:00']
    if friday.empty:
        return
        
    f_open = friday['Open'].iloc[0]
    f_close = friday['Close'].iloc[-1]
    
    print(f"Nifty Futures Friday Open: {f_open}")
    print(f"Nifty Futures Friday Close: {f_close}")
    print(f"Futures Change: {((f_close-f_open)/f_open)*100:.2f}%")

if __name__ == "__main__":
    check_futures()
