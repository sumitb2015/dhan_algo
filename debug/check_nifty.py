import pandas as pd
import glob
import os

def check_nifty():
    f = "Historical Data Parquet/NIFTY_50_Daily_5Y.parquet"
    if not os.path.exists(f):
        print(f"File {f} not found.")
        return
    
    df = pd.read_parquet(f)
    print(f"NIFTY 50 Daily 5Y:\n{df.tail()}")
    
    # Calculate some returns
    latest = df['Close'].iloc[-1]
    prev_day = df['Close'].iloc[-2]
    prev_5 = df['Close'].iloc[-6]
    prev_21 = df['Close'].iloc[-22]
    prev_252 = df['Close'].iloc[-253]
    
    print(f"\nPrice: {latest}")
    print(f"Daily:   {((latest/prev_day)-1)*100:.2f}%")
    print(f"Weekly:  {((latest/prev_5)-1)*100:.2f}%")
    print(f"Monthly: {((latest/prev_21)-1)*100:.2f}%")
    print(f"Yearly:  {((latest/prev_252)-1)*100:.2f}%")

check_nifty()
