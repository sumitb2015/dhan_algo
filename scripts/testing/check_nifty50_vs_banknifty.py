import pandas as pd
import numpy as np

# Load Bank Nifty, Nifty 50 & Nifty 500
bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty50 = pd.read_csv('Historical Data/NIFTY_50_Daily_5Y.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty50['date'] = nifty50['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

def calc_rrg(stock_df, bench_df):
    merged = pd.merge(stock_df, bench_df, on='date', suffixes=('_stock', '_bench'))
    rs_inv = (merged['Close_bench'] / merged['Close_stock']) * 100.0
    
    fastWindow = 14
    slowWindow = 50
    momAlpha = 2 / (14 + 1)
    
    n = len(merged)
    rsRatioArr = np.full(n, 100.0)
    
    for i in range(slowWindow - 1, n):
        meanFast = rs_inv.iloc[i - fastWindow + 1 : i + 1].mean()
        meanSlow = rs_inv.iloc[i - slowWindow + 1 : i + 1].mean()
        rsRatioArr[i] = 100.0 * (meanFast / meanSlow) if meanSlow != 0 else 100.0
        
    emaTrend = rsRatioArr[slowWindow - 1]
    res = []
    for i in range(slowWindow - 1, n):
        trend = rsRatioArr[i]
        emaTrend = momAlpha * trend + (1.0 - momAlpha) * emaTrend
        momentum = 100.0 * (trend / emaTrend) if emaTrend != 0 else 100.0
        res.append((merged['date'].iloc[i], trend, momentum))
    return pd.DataFrame(res, columns=['date', 'rsRatio', 'rsMomentum'])

df_bank = calc_rrg(bank, nifty500)
df_n50 = calc_rrg(nifty50, nifty500)

print("=== NIFTY BANK (Bank Nifty) ===")
print(df_bank.tail(5))

print("\n=== NIFTY 50 (Index) ===")
print(df_n50.tail(5))
