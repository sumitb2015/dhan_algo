import pandas as pd
import numpy as np

nifty50 = pd.read_csv('Historical Data/NIFTY_50_Daily_5Y.csv')
bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

nifty50['date'] = nifty50['Datetime'].str.slice(0, 10)
bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

m_n50 = pd.merge(nifty50[['date', 'Close']], nifty500[['date', 'Close']], on='date', suffixes=('_stock', '_bench'))

# We want Fri, Jul 31, 2026 to yield:
#   Strength Trend = 99.99
#   Strength Momentum = 100.32

# Test 1: Rolling Mean / Normalization methods on RS = (Close_stock / Close_bench)
rs_raw = (m_n50['Close_stock'] / m_n50['Close_bench']) * 100.0

i_31 = m_n50.index[m_n50['date'] == '2026-07-31'][0]

print("Raw RS on Jul 31:", rs_raw.iloc[i_31])

# Check what window makes EMA(RS, fast) / EMA(RS, slow) * 100 or SMA(RS, fast) / SMA(RS, slow) * 100 equal 99.99
results = []
for fast_p in range(1, 100):
    for slow_p in range(fast_p + 1, 300):
        # EMA ratio
        e_f = rs_raw.ewm(span=fast_p, adjust=False).mean()
        e_s = rs_raw.ewm(span=slow_p, adjust=False).mean()
        t_ema = 100.0 * (e_f / e_s)
        
        # SMA ratio
        s_f = rs_raw.rolling(fast_p).mean()
        s_s = rs_raw.rolling(slow_p).mean()
        t_sma = 100.0 * (s_f / s_s)

        tv_ema = t_ema.iloc[i_31]
        tv_sma = t_sma.iloc[i_31]

        if abs(tv_ema - 99.99) < 0.05:
            results.append(('EMA', fast_p, slow_p, tv_ema))
        if abs(tv_sma - 99.99) < 0.05:
            results.append(('SMA', fast_p, slow_p, tv_sma))

print("\nFormulas yielding Trend ~ 99.99 on Jul 31, 2026:")
for r in results[:15]:
    print(r)
