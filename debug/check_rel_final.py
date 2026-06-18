import pandas as pd
import os

def check_rel_final():
    rel_path = "Stocks Historical Data Parquet/RELIANCE_1Min_5Y.parquet"
    df_rel = pd.read_parquet(rel_path)
    df_rel['Datetime'] = pd.to_datetime(df_rel['Datetime'])
    df_rel.set_index('Datetime', inplace=True)
    day_rel = df_rel.resample('D').agg({'Open': 'first', 'Close': 'last'}).dropna()
    day_rel = day_rel[day_rel.index.dayofweek < 5]

    latest = 1386.50
    print(f"Latest: {latest}")

    # 1Y Check
    for i in range(240, 260):
        prev = day_rel['Close'].iloc[-(i+1)]
        d = day_rel.index[-(i+1)]
        pct = (latest/prev - 1) * 100
        if abs(pct - 9.76) < 0.2:
             print(f"Match 1Y at shift {i} ({d.date()}): {pct:.2f}% (Price {prev})")

    # 1W Check
    for i in range(1, 10):
        prev_c = day_rel['Close'].iloc[-(i+1)]
        prev_o = day_rel['Open'].iloc[-(i+1)]
        pct_c = (latest/prev_c - 1) * 100
        pct_o = (latest/prev_o - 1) * 100
        print(f"Shift {i} ({day_rel.index[-(i+1)].date()}): Close-to-Close {pct_c:.2f}%, Open-to-Close {pct_o:.2f}%")

check_rel_final()
