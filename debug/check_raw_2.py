import pandas as pd
import os

def check_raw():
    rel_path = "Stocks Historical Data Parquet/RELIANCE_1Min_5Y.parquet"
    df_rel = pd.read_parquet(rel_path)
    df_rel['Datetime'] = pd.to_datetime(df_rel['Datetime'])
    df_rel.set_index('Datetime', inplace=True)
    day_rel = df_rel.resample('D').agg({'Open': 'first', 'High': 'max', 'Low': 'min', 'Close': 'last'}).dropna()
    day_rel = day_rel[day_rel.index.dayofweek < 5]

    nif_path = "Historical Data Parquet/NIFTY_50_Daily_5Y.parquet"
    day_nif = pd.read_parquet(nif_path)
    day_nif['Datetime'] = pd.to_datetime(day_nif['Datetime'])
    day_nif.set_index('Datetime', inplace=True)

    print("\n--- Reliance Search ---")
    latest_rel = 1386.50 # Based on parquet
    for d in day_rel.tail(40).index:
        v_close = day_rel.loc[d, 'Close']
        v_open = day_rel.loc[d, 'Open']
        pct_c = ((latest_rel / v_close) - 1) * 100
        pct_o = ((latest_rel / v_open) - 1) * 100
        if abs(pct_c + 4.86) < 0.1 or abs(pct_o + 4.86) < 0.1:
            print(f"1W Match Potential at {d.date()}: Close {v_close} ({pct_c:.2f}%), Open {v_open} ({pct_o:.2f}%)")
        if abs(pct_c + 11.70) < 0.1 or abs(pct_o + 11.70) < 0.1:
            print(f"1M Match Potential at {d.date()}: Close {v_close} ({pct_c:.2f}%), Open {v_open} ({pct_o:.2f}%)")
        if abs(pct_c + 11.97) < 0.1 or abs(pct_o + 11.97) < 0.1:
            print(f"YTD Match Potential at {d.date()}: Close {v_close} ({pct_c:.2f}%), Open {v_open} ({pct_o:.2f}%)")

    print("\n--- Nifty Search ---")
    latest_nif = 25048.65
    for d in day_nif.tail(40).index:
        v_close = day_nif.loc[d, 'Close']
        v_open = day_nif.loc[d, 'Open']
        pct_c = ((latest_nif / v_close) - 1) * 100
        pct_o = ((latest_nif / v_open) - 1) * 100
        if abs(pct_c + 2.51) < 0.02 or abs(pct_o + 2.51) < 0.02:
            print(f"1W Match Potential at {d.date()}: Close {v_close} ({pct_c:.2f}%), Open {v_open} ({pct_o:.2f}%)")
        if abs(pct_c + 4.31) < 0.02 or abs(pct_o + 4.31) < 0.02:
            print(f"1M Match Potential at {d.date()}: Close {v_close} ({pct_c:.2f}%), Open {v_open} ({pct_o:.2f}%)")
        if abs(pct_c + 4.20) < 0.02 or abs(pct_o + 4.20) < 0.02:
            print(f"YTD Match Potential at {d.date()}: Close {v_close} ({pct_c:.2f}%), Open {v_open} ({pct_o:.2f}%)")

check_raw()
