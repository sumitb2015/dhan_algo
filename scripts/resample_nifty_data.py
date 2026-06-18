import pandas as pd
import os

def resample_nifty_data():
    file_path = r'c:\dhan_algo\Historical Data\NIFTY_50_1Min_5Y.csv'
    output_path = r'c:\dhan_algo\Historical Data\NIFTY_50_5Min.csv'

    print(f"Reading data from {file_path}...")
    try:
        df = pd.read_csv(file_path)
    except FileNotFoundError:
        print(f"Error: File not found at {file_path}")
        return

    # Convert Datetime column to datetime objects
    print("Parsing datetime...")
    df['Datetime'] = pd.to_datetime(df['Datetime'])
    
    # Set Datetime as index
    df.set_index('Datetime', inplace=True)

    # Define resampling logic
    ohlcv_dict = {
        'Open': 'first',
        'High': 'max',
        'Low': 'min',
        'Close': 'last',
        'Volume': 'sum'
    }

    print("Resampling to 5 minutes...")
    # Resample to 5 minutes
    # label='left', closed='left' keeps the start time of the bin (standard for trading data)
    df_resampled = df.resample('5min', label='left', closed='left').agg(ohlcv_dict)

    # Drop any rows with NaN values (which might occur if there are gaps in trading days)
    # However, for market hours gaps, we might want to keep them or drop them. 
    # Usually, we drop rows that have no data at all.
    df_resampled.dropna(inplace=True)

    print(f"Saving resampled data to {output_path}...")
    df_resampled.to_csv(output_path)
    print("Done!")

if __name__ == "__main__":
    resample_nifty_data()
