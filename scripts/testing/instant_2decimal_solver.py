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

# Targets for 2026-07-31:
# Nifty 50: Trend = 99.99, Mom = 100.32
# Bank Nifty: Trend = 99.73, Mom = 100.74

i_n50 = m_n50.index[m_n50['date'] == '2026-07-31'][0]
i_bank = m_bank.index[m_bank['date'] == '2026-07-31'][0]

rs_n50 = (m_n50['Close_stock'].values / m_n50['Close_bench'].values) * 100.0
rs_bank = (m_bank['Close_stock'].values / m_bank['Close_bench'].values) * 100.0

results = []

# Test fast spans [10..30], slow spans [20..100], mom spans [3..20]
for fast_p in [10, 12, 14, 15, 16, 20]:
    for slow_p in range(fast_p + 1, 90):
        # EMA ratio
        f_a = 2.0 / (fast_p + 1.0)
        s_a = 2.0 / (slow_p + 1.0)

        t_n50 = 100.0 * (pd.Series(rs_n50).ewm(alpha=f_a, adjust=False).mean().values / pd.Series(rs_n50).ewm(alpha=s_a, adjust=False).mean().values)
        t_bank = 100.0 * (pd.Series(rs_bank).ewm(alpha=f_a, adjust=False).mean().values / pd.Series(rs_bank).ewm(alpha=s_a, adjust=False).mean().values)

        for mom_p in [3, 5, 7, 10, 14]:
            m_a = 2.0 / (mom_p + 1.0)
            m_n50 = 100.0 * (t_n50 / pd.Series(t_n50).ewm(alpha=m_a, adjust=False).mean().values)
            m_bank = 100.0 * (t_bank / pd.Series(t_bank).ewm(alpha=m_a, adjust=False).mean().values)

            tv_n50, mv_n50 = t_n50[i_n50], m_n50[i_n50]
            tv_bank, mv_bank = t_bank[i_bank], m_bank[i_bank]

            err = abs(tv_n50 - 99.99) + abs(mv_n50 - 100.32) + abs(tv_bank - 99.73) + abs(mv_bank - 100.74)
            desc = f"fast={fast_p} slow={slow_p} mom={mom_p}"
            results.append((err, desc, tv_n50, mv_n50, tv_bank, mv_bank))

results.sort(key=lambda x: x[0])

print("=== TOP 5 CLOSEST MATCHES FOR 2-DECIMAL ACCURACY (JUL 31, 2026) ===")
for err, desc, tv_n50, mv_n50, tv_bank, mv_bank in results[:5]:
    print(f"\nTotal Err: {err:.4f} | {desc}")
    print(f"   Nifty 50: Trend = {tv_n50:.2f} (Target: 99.99), Mom = {mv_n50:.2f} (Target: 100.32)")
    print(f"   Bank Nifty: Trend = {tv_bank:.2f} (Target: 99.73), Mom = {mv_bank:.2f} (Target: 100.74)")
