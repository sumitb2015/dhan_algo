import pandas as pd
import os

def find_logic():
    # Load Reliance and Nifty Daily
    rel_path = "Stocks Historical Data Parquet/RELIANCE_1Min_5Y.parquet"
    nif_path = "Historical Data Parquet/NIFTY_50_Daily_5Y.parquet"
    
    # Reliance Daily from Minute Data
    df_rel_min = pd.read_parquet(rel_path)
    df_rel_min['Datetime'] = pd.to_datetime(df_rel_min['Datetime'])
    df_rel_min.set_index('Datetime', inplace=True)
    df_rel = df_rel_min.resample('D').agg({'Close': 'last'}).dropna()
    df_rel = df_rel[df_rel.index.dayofweek < 5]
    
    # Nifty Daily
    df_nif = pd.read_parquet(nif_path)
    df_nif['Datetime'] = pd.to_datetime(df_nif['Datetime'])
    df_nif.set_index('Datetime', inplace=True)
    
    def check_period(name, df, target, label):
        latest = df['Close'].iloc[-1]
        print(f"\n--- {label} {name} Check (Target: {target}%) ---")
        for i in range(1, min(300, len(df))):
            prev = df['Close'].iloc[-(i+1)]
            pct = ((latest - prev) / prev) * 100
            if abs(pct - target) < 0.05:
                print(f"Match found at shift {i} ({df.index[-(i+1)].date()}): {pct:.2f}%")

    # Image Values
    # 1W: Nifty -2.51, Reliance -4.86
    check_period("1W", df_nif, -2.51, "Nifty")
    check_period("1W", df_rel, -4.86, "Reliance")
    
    # 1M: Nifty -4.31, Reliance -11.70
    check_period("1M", df_nif, -4.31, "Nifty")
    check_period("1M", df_rel, -11.70, "Reliance")
    
    # YTD: Nifty -4.20, Reliance -11.97
    # Dec 31, 2025
    def check_date(df, target_date, target_pct, label):
        latest = df['Close'].iloc[-1]
        if target_date in df.index:
            v = df.loc[target_date, 'Close']
            pct = ((latest - v) / v) * 100
            print(f"{label} vs {target_date.date()}: {pct:.2f}% (Target: {target_pct})")
        else:
            # Nearest before
            pot = df[df.index <= target_date]
            if not pot.empty:
                v = pot['Close'].iloc[-1]
                pct = ((latest - v) / v) * 100
                print(f"{label} vs {pot.index[-1].date()}: {pct:.2f}% (Target: {target_pct})")

    check_date(df_nif, '2025-12-31', -4.20, "Nifty YTD")
    check_date(df_rel, '2025-12-31', -11.97, "Reliance YTD")

if __name__ == "__main__":
    find_logic()
