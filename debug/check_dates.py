import pandas as pd
import os

def check_dates():
    rel_path = "Stocks Historical Data Parquet/RELIANCE_1Min_5Y.parquet"
    df = pd.read_parquet(rel_path)
    df['Datetime'] = pd.to_datetime(df['Datetime'])
    df.set_index('Datetime', inplace=True)
    day = df.resample('D').agg({'Open': 'first', 'Close': 'last'}).dropna()

    for date in ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']:
        if date in day.index:
            print(f"{date}: Open {day.loc[date, 'Open']}, Close {day.loc[date, 'Close']}")

check_dates()
