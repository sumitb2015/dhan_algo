import pandas as pd
import os

def check_fut_1w():
    file_path = "Historical Data Parquet/NIFTY_Futures_1min_1Year_Continuous.parquet"
    df = pd.read_parquet(file_path)
    df['Datetime'] = pd.to_datetime(df['Datetime'])
    df.set_index('Datetime', inplace=True)
    day = df.resample('D').agg({'Close': 'last'}).dropna()
    day = day[day.index.dayofweek < 5]
    
    latest = day['Close'].iloc[-1]
    prev_5 = day['Close'].iloc[-6]
    pct = (latest/prev_5 - 1) * 100
    print(f"Nifty Futures 1W: {pct:.2f}% (Close {latest} vs {day.index[-6].date()} Close {prev_5})")

check_fut_1w()
