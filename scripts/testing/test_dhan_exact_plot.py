import pandas as pd
import numpy as np
import glob
import os

def load_csv(path):
    df = pd.read_csv(path)
    date_col = [c for c in df.columns if c.lower() in ['date', 'datetime']][0]
    close_col = [c for c in df.columns if c.lower() == 'close'][0]
    df['date'] = df[date_col].str.slice(0, 10)
    df['close'] = df[close_col].astype(float)
    return df[['date', 'close']].sort_values('date').reset_index(drop=True)

# Load benchmark: Nifty 500
nifty500 = load_csv('Historical Data/NIFTY_500_Daily.csv')

# Load all sector indices
indices_files = glob.glob('Historical Data/Indices/*.csv')
index_data = {}

for f in indices_files:
    name = os.path.basename(f).replace('.csv', '')
    if name in ['INDIA_VIX']: continue
    index_data[name] = load_csv(f)

# Also load Nifty 50
nifty50 = load_csv('Historical Data/NIFTY_50_Daily_5Y.csv')
index_data['NIFTY50'] = nifty50

def calc_dhan_rrg(stock_df, bench_df, fast=14, slow=125):
    merged = pd.merge(stock_df, bench_df, on='date', suffixes=('_stk', '_bench'))
    rs_raw = (merged['close_stk'] / merged['close_bench']) * 100.0
    
    ema_fast = rs_raw.ewm(span=fast, adjust=False).mean()
    ema_slow = rs_raw.ewm(span=slow, adjust=False).mean()
    
    rs_ratio = 100.0 * (ema_fast / ema_slow)
    ema_ratio = rs_ratio.ewm(span=fast, adjust=False).mean()
    rs_mom = 100.0 * (rs_ratio / ema_ratio)
    
    res = pd.DataFrame({
        'date': merged['date'],
        'rsRatio': rs_ratio,
        'rsMomentum': rs_mom
    })
    return res

print("=== DHAN / OPTUMA RRG VALUES ON LATEST DATE (2026-07-31) ===")
for name in ['BANKNIFTY', 'NIFTY50', 'NIFTYIT', 'NIFTY_AUTO', 'NIFTY_PHARMA', 'NIFTY_REALTY']:
    if name in index_data:
        rrg = calc_dhan_rrg(index_data[name], nifty500)
        tail = rrg.tail(5)
        latest = tail.iloc[-1]
        print(f"\n--- {name} (Latest: {latest['date']}) ---")
        print(f"RS-Ratio (Strength Trend): {latest['rsRatio']:.2f}")
        print(f"RS-Momentum (Strength Momentum): {latest['rsMomentum']:.2f}")
        print("Last 5 tail points:")
        for idx, row in tail.iterrows():
            print(f"  {row['date']}: Ratio={row['rsRatio']:.2f}, Mom={row['rsMomentum']:.2f}")
