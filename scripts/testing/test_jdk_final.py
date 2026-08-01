import pandas as pd
import numpy as np

nifty50 = pd.read_csv('Historical Data/NIFTY_50_Daily_5Y.csv')
bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

nifty50['date'] = nifty50['Datetime'].str.slice(0, 10)
bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

m_n50 = pd.merge(nifty50[['date', 'Close']], nifty500[['date', 'Close']], on='date', suffixes=('_stock', '_bench'))
m_bank = pd.merge(bank[['date', 'Close']], nifty500[['date', 'Close']], on='date', suffixes=('_stock', '_bench'))

def jdk_rrg(df, window=14, period=14):
    rs = (df['Close_stock'] / df['Close_bench']) * 100.0
    mean_rs = rs.rolling(window).mean()
    std_rs = rs.rolling(window).std(ddof=1)
    rs_ratio = 100.0 + (rs - mean_rs) / std_rs
    
    roc = 100.0 * ((rs_ratio / rs_ratio.shift(period)) - 1.0)
    mean_roc = roc.rolling(window).mean()
    std_roc = roc.rolling(window).std(ddof=1)
    rs_mom = 100.0 + (roc - mean_roc) / std_roc
    
    res = pd.DataFrame({
        'date': df['date'],
        'rsRatio': rs_ratio,
        'rsMomentum': rs_mom
    })
    return res

res_n50 = jdk_rrg(m_n50)
res_bank = jdk_rrg(m_bank)

print("=== JdK Standard Formula Output (Window=14, Period=14) ===")
print("\nNifty 50:")
print(res_n50[res_n50['date'].isin(['2026-07-30', '2026-07-31'])])

print("\nBank Nifty:")
print(res_bank[res_bank['date'].isin(['2026-07-28', '2026-07-30', '2026-07-31'])])
