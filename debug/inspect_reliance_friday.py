import pandas as pd
import os

def inspect_reliance_friday():
    file_path = "Stocks Historical Data Parquet/RELIANCE_1Min_5Y.parquet"
    if not os.path.exists(file_path):
        return

    df = pd.read_parquet(file_path)
    df['Datetime'] = pd.to_datetime(df['Datetime'])
    df.set_index('Datetime', inplace=True)
    
    friday_data = df[df.index >= '2026-01-23 09:15:00']
    print("\n--- RELIANCE Friday (Jan 23) First 10 Minutes ---")
    print(friday_data.head(10))
    
    first_open = friday_data['Open'].iloc[0]
    last_close = friday_data['Close'].iloc[-1]
    
    print(f"\nFirst Open at 09:15: {first_open}")
    print(f"Final Close: {last_close}")
    print(f"Daily Change (Close-Open)/Open: {((last_close-first_open)/first_open)*100:.4f}%")

if __name__ == "__main__":
    inspect_reliance_friday()
