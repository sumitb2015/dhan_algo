import pandas as pd
import numpy as np

bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

merged = pd.merge(bank, nifty500, on='date', suffixes=('_bank', '_bench'))
rs_raw = (merged['Close_bank'] / merged['Close_bench']) * 100.0

i = merged.index[merged['date'] == '2026-07-31'][0]

target_trend = 99.73
target_mom = 100.74

# Test Formula:
# Strength Trend = 100 * (EMA(RS, fast) / EMA(RS, slow))
# Strength Momentum = 100 * (EMA(RS, 5) / EMA(RS, fast))
for fast in [10, 14, 20]:
    for slow in [50, 100, 125]:
        ema_fast = rs_raw.ewm(span=fast, adjust=False).mean()
        ema_slow = rs_raw.ewm(span=slow, adjust=False).mean()
        trend = 100.0 * (ema_fast / ema_slow)
        
        for m_fast in [3, 5, 7]:
            ema_mfast = rs_raw.ewm(span=m_fast, adjust=False).mean()
            mom = 100.0 * (ema_mfast / ema_fast)
            
            t_val = trend.iloc[i]
            m_val = mom.iloc[i]
            err = abs(t_val - target_trend) + abs(m_val - target_mom)
            print(f"fast={fast} slow={slow} m_fast={m_fast} => Trend: {t_val:.2f}, Mom: {m_val:.2f} (Err: {err:.2f})")
