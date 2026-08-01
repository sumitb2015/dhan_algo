import pandas as pd
import numpy as np

bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty50 = pd.read_csv('Historical Data/NIFTY_50_Daily_5Y.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty50['date'] = nifty50['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

def compute_dhan_rrg(stock_df, bench_df):
    merged = pd.merge(stock_df, bench_df, on='date', suffixes=('_stock', '_bench'))
    rs_raw = (merged['Close_stock'] / merged['Close_bench']) * 100.0
    
    fast_alpha = 2 / (14 + 1)
    slow_alpha = 2 / (125 + 1)
    
    n = len(merged)
    ema_fast = rs_raw.iloc[0]
    ema_slow = rs_raw.iloc[0]
    
    ratio_arr = np.full(n, 100.0)
    for i in range(n):
        ema_fast = fast_alpha * rs_raw.iloc[i] + (1 - fast_alpha) * ema_fast
        ema_slow = slow_alpha * rs_raw.iloc[i] + (1 - slow_alpha) * ema_slow
        ratio_arr[i] = 100.0 * (ema_fast / ema_slow) if ema_slow != 0 else 100.0
        
    ema_trend = ratio_arr[0]
    mom_arr = np.full(n, 100.0)
    for i in range(n):
        ema_trend = fast_alpha * ratio_arr[i] + (1 - fast_alpha) * ema_trend
        mom_arr[i] = 100.0 * (ratio_arr[i] / ema_trend) if ema_trend != 0 else 100.0
        
    df_res = pd.DataFrame({
        'date': merged['date'],
        'rsRatio': ratio_arr,
        'rsMomentum': mom_arr
    })
    return df_res

print("=== CORRECT NIFTY 50 ===")
print(compute_dhan_rrg(nifty50, nifty500).tail(5))

print("\n=== CORRECT BANK NIFTY ===")
print(compute_dhan_rrg(bank, nifty500).tail(5))
