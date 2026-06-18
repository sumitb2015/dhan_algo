import yfinance as yf
import pandas as pd
import os
import requests
from datetime import datetime, timedelta

# Create a session with a User-Agent header
session = requests.Session()
session.headers.update({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
})

def compare_data():
    parquet_path = r'c:\dhan_algo\Historical Data Parquet\NIFTY_50_1Min_5Y.parquet'
    
    if not os.path.exists(parquet_path):
        print(f"Parquet file not found at {parquet_path}")
        return

    print(f"Loading local parquet data from {parquet_path}...")
    df_parquet = pd.read_parquet(parquet_path)
    
    # Ensure Datetime is datetime objects
    df_parquet['Datetime'] = pd.to_datetime(df_parquet['Datetime'])
    
    # Filter for Jan 22 onwards
    start_date_str = "2026-01-22"
    df_local = df_parquet[df_parquet['Datetime'] >= start_date_str].copy()
    
    if df_local.empty:
        print(f"No data found in parquet for {start_date_str} onwards.")
        # We can still download yfinance data to show what's there
    else:
        print(f"Found {len(df_local)} rows in parquet since {start_date_str}")
        print(f"Parquet data date range: {df_local['Datetime'].min()} to {df_local['Datetime'].max()}")

    # Download yfinance data
    # Ticker for NIFTY 50 is ^NSEI
    # Interval 1m
    print("\nDownloading last 3 days of data from yfinance (^NSEI)...")
    ticker = "^NSEI"
    
    try:
        # Use period="3d" for last 3 days
        df_yf = yf.download(ticker, period="3d", interval="1m", session=session)
        
        if df_yf.empty:
            print("No data returned from yfinance. It might be due to rate limiting or market being closed.")
            return

        # Flatten multi-index if present
        if isinstance(df_yf.columns, pd.MultiIndex):
            df_yf.columns = df_yf.columns.get_level_values(0)

        # Reset index to get Datetime as a column
        df_yf = df_yf.reset_index()
        
        # yfinance index name is 'Datetime' usually
        if 'Datetime' not in df_yf.columns and 'Date' in df_yf.columns:
            df_yf.rename(columns={'Date': 'Datetime'}, inplace=True)
            
        # Ensure 'Datetime' is the column name we use
        df_yf['Datetime'] = pd.to_datetime(df_yf['Datetime'])
        
        # Convert yf datetime to match parquet (naive IST)
        if df_yf['Datetime'].dt.tz is not None:
            df_yf['Datetime'] = df_yf['Datetime'].dt.tz_convert('Asia/Kolkata').dt.tz_localize(None)

        print(f"Found {len(df_yf)} rows in yfinance data.")
        print(f"yfinance data date range: {df_yf['Datetime'].min()} to {df_yf['Datetime'].max()}")

        # Update local filter to match yf range
        start_date_yf = df_yf['Datetime'].min()
        df_local = df_parquet[df_parquet['Datetime'] >= start_date_yf].copy()
        
        if df_local.empty:
            print("\nParquet data is empty for this range. yfinance data sample:")
            print(df_yf.head())
            return

        # Merge for comparison
        # We compare Open, High, Low, Close
        comparison = pd.merge(df_local[['Datetime', 'Open', 'High', 'Low', 'Close']], 
                              df_yf[['Datetime', 'Open', 'High', 'Low', 'Close']], 
                              on='Datetime', suffixes=('_parquet', '_yf'))

        print(f"\nComparing {len(comparison)} overlapping rows...")
        
        if len(comparison) == 0:
            print("No overlapping timestamps found between Parquet and yfinance.")
            return

        # Calculate differences
        comparison['Open_diff'] = comparison['Open_parquet'] - comparison['Open_yf']
        comparison['High_diff'] = comparison['High_parquet'] - comparison['High_yf']
        comparison['Low_diff'] = comparison['Low_parquet'] - comparison['Low_yf']
        comparison['Close_diff'] = comparison['Close_parquet'] - comparison['Close_yf']

        # Check for perfect matches
        exact_matches = (comparison['Open_diff'].abs() < 0.01) & \
                        (comparison['High_diff'].abs() < 0.01) & \
                        (comparison['Low_diff'].abs() < 0.01) & \
                        (comparison['Close_diff'].abs() < 0.01)
        
        match_count = exact_matches.sum()
        print(f"Perfect matches: {match_count} / {len(comparison)} ({match_count/len(comparison)*100:.2f}%)")

        if match_count < len(comparison):
            print("\nSample of rows with differences:")
            print(comparison[~exact_matches].head(10))
            
            # Print max differences
            print("\nMax absolute differences:")
            print(comparison[['Open_diff', 'High_diff', 'Low_diff', 'Close_diff']].abs().max())
        else:
            print("\nAll overlapping data points match perfectly!")

    except Exception as e:
        print(f"Error during comparison: {e}")

if __name__ == "__main__":
    compare_data()
