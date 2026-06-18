
import pandas as pd
import glob
import os

files = glob.glob(os.path.join("Stocks Historical Data Parquet", "*.parquet"))
if files:
    f = files[0]
    print(f"Reading {f}...")
    df = pd.read_parquet(f)
    print(df.head())
    print(df.info())
else:
    print("No parquet files found.")
