import yfinance as yf
import pandas as pd
import numpy as np
import pandas_ta as ta

def calculate_supertrend(df, period=10, multiplier=2):
    # Using pandas_ta for quick calculation on yfinance data
    st = df.ta.supertrend(length=period, multiplier=multiplier)
    return st

def main():
    ticker = "^NSEI"
    print(f"Downloading {ticker} data from yfinance (5d, 5m)...")
    
    # Download 5 days of 5-minute data
    df = yf.download(ticker, period="5d", interval="5m", progress=False)
    
    if df.empty:
        print("No data downloaded.")
        return

    # YFinance MultiIndex columns fix
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    
    # Calculate Supertrend
    st = calculate_supertrend(df)
    df = df.join(st)
    
    # Rename for clarity
    # pandas_ta columns: SUPERT_10_2.0, SUPERTd_10_2.0, SUPERTl_10_2.0, SUPERTs_10_2.0
    st_col = f"SUPERT_{10}_{2.0}"
    dir_col = f"SUPERTd_{10}_{2.0}"
    
    print("\n--- YFinance Data (Last 20 rows) ---")
    print(df[['Close', st_col, dir_col]].tail(20))
    
    # Specific check for 2026-01-23 if available (likely not if '5d' is relative to today 2026-01-27)
    # 5d from 27th Jan might include 23rd Jan (Friday).
    
    target_date = "2026-01-23"
    print(f"\n--- Data for {target_date} ---")
    try:
        day_df = df[target_date]
        if not day_df.empty:
             print(day_df[['Close', st_col, dir_col]].head(10))
             print("...")
             print(day_df[['Close', st_col, dir_col]].tail(10))
        else:
            print(f"No data found for {target_date} in last 5 days.")
    except Exception as e:
        print(f"Error slicing date: {e}")

if __name__ == "__main__":
    main()
