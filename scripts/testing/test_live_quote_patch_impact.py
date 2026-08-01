import pandas as pd
import numpy as np

bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

merged = pd.merge(bank, nifty500, on='date', suffixes=('_bank', '_bench'))
rs_raw = (merged['Close_bank'] / merged['Close_bench']) * 100.0

ema_fast = rs_raw.ewm(span=14, adjust=False).mean()
ema_slow = rs_raw.ewm(span=125, adjust=False).mean()
rs_ratio = 100.0 * (ema_fast / ema_slow)
ema_mom = rs_ratio.ewm(span=14, adjust=False).mean()
rs_mom = 100.0 * (rs_ratio / ema_mom)

print(f"Unpatched Jul 31: RS-Ratio = {rs_ratio.iloc[-1]:.2f}, RS-Mom = {rs_mom.iloc[-1]:.2f}")

# What if Bank Nifty intraday high / close is higher by 0.5% - 1.5%?
for bump in [0.2, 0.5, 0.8, 1.0, 1.2, 1.5, 2.0]:
    b_bank = merged['Close_bank'].copy()
    b_bank.iloc[-1] = b_bank.iloc[-1] * (1.0 + bump / 100.0)
    rs_raw_b = (b_bank / merged['Close_bench']) * 100.0
    
    fast_b = rs_raw_b.ewm(span=14, adjust=False).mean()
    slow_b = rs_raw_b.ewm(span=125, adjust=False).mean()
    ratio_b = 100.0 * (fast_b / slow_b)
    mom_b = 100.0 * (ratio_b / ratio_b.ewm(span=14, adjust=False).mean())
    
    print(f"Bump +{bump}%: RS-Ratio = {ratio_b.iloc[-1]:.2f}, RS-Mom = {mom_b.iloc[-1]:.2f}")
