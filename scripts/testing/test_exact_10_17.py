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

# Parameters: fast=10, slow=17
f_a = 2.0 / (10.0 + 1.0)
s_a = 2.0 / (17.0 + 1.0)

rs_n50 = (m_n50['Close_stock'].values / m_n50['Close_bench'].values) * 100.0
rs_bank = (m_bank['Close_stock'].values / m_bank['Close_bench'].values) * 100.0

trend_n50 = 100.0 * (pd.Series(rs_n50).ewm(alpha=f_a, adjust=False).mean().values / pd.Series(rs_n50).ewm(alpha=s_a, adjust=False).mean().values)
trend_bank = 100.0 * (pd.Series(rs_bank).ewm(alpha=f_a, adjust=False).mean().values / pd.Series(rs_bank).ewm(alpha=s_a, adjust=False).mean().values)

# Test Momentum = 100 * (RS / EMA(RS, 10)) or 100 + ROC(trend, P)
for p in [1, 2, 3, 5, 10, 14]:
    # ROC momentum: 100 + (trend(t) - trend(t-p))
    mom_n50_roc = 100.0 + 10.0 * (trend_n50 - np.roll(trend_n50, p))
    mom_bank_roc = 100.0 + 10.0 * (trend_bank - np.roll(trend_bank, p))

    # RS momentum: 100 * (rs / EMA(rs, p))
    m_a = 2.0 / (p + 1.0)
    mom_n50_rs = 100.0 * (rs_n50 / pd.Series(rs_n50).ewm(alpha=m_a, adjust=False).mean().values)
    mom_bank_rs = 100.0 * (rs_bank / pd.Series(rs_bank).ewm(alpha=m_a, adjust=False).mean().values)

    i_n50 = m_n50.index[m_n50['date'] == '2026-07-31'][0]
    i_bank = m_bank.index[m_bank['date'] == '2026-07-31'][0]

    print(f"P={p}:")
    print(f"   Nifty 50  : Trend={trend_n50[i_n50]:.2f} (Target 99.99), Mom_ROC={mom_n50_roc[i_n50]:.2f}, Mom_RS={mom_n50_rs[i_n50]:.2f} (Target 100.32)")
    print(f"   Bank Nifty: Trend={trend_bank[i_bank]:.2f} (Target 99.73), Mom_ROC={mom_bank_roc[i_bank]:.2f}, Mom_RS={mom_bank_rs[i_bank]:.2f} (Target 100.74)")
