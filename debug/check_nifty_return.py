import pandas as pd
import os

def check_nifty_return():
    file_path = "Historical Data Parquet/NIFTY_50_Daily_5Y.parquet"
    if not os.path.exists(file_path):
        return

    df = pd.read_parquet(file_path)
    df['Datetime'] = pd.to_datetime(df['Datetime'])
    df.set_index('Datetime', inplace=True)
    
    print("\n--- NIFTY 50 Recent Data ---")
    print(df.tail(6))
    
    current_close = df['Close'].iloc[-1]
    
    # Check 1-Week Change
    # Option A: Current Close vs Monday Open
    monday_open = df['Open'].iloc[-5]
    monday_date = df.index[-5]
    pct_a = ((current_close - monday_open) / monday_open) * 100
    
    # Option B: Current Close vs Previous Friday Close
    friday_close = df['Close'].iloc[-6]
    friday_date = df.index[-6]
    pct_b = ((current_close - friday_close) / friday_close) * 100
    
    print(f"\nCurrent Close ({df.index[-1].date()}): {current_close}")
    print(f"Option A (vs {monday_date.date()} Open {monday_open}): {pct_a:.2f}%")
    print(f"Option B (vs {friday_date.date()} Close {friday_close}): {pct_b:.2f}%")

if __name__ == "__main__":
    check_nifty_return()
