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

i_n50_31 = m_n50.index[m_n50['date'] == '2026-07-31'][0]
i_bank_31 = m_bank.index[m_bank['date'] == '2026-07-31'][0]

print("Searching for exact 2-decimal place matching parameters...\n")

matches = []

# Sweep weighting schemes: EMA vs SMA vs Wilders vs WMA
# Sweep fast_p (1..30), slow_p (2..100), mom_p (1..30)
# Sweep RS definition: (Stock/Bench) vs (Stock/Bench) shifted/normalized

s_n50, b_n50 = m_n50['Close_stock'].values, m_n50['Close_bench'].values
s_bank, b_bank = m_bank['Close_stock'].values, m_bank['Close_bench'].values

rs_n50_raw = (s_n50 / b_n50) * 100.0
rs_bank_raw = (s_bank / b_bank) * 100.0

for norm_type in ['raw', 'base100_start', 'base100_50', 'base100_252']:
    if norm_type == 'raw':
        rs1, rs2 = rs_n50_raw, rs_bank_raw
    elif norm_type == 'base100_start':
        rs1 = (s_n50 / s_n50[0]) / (b_n50 / b_n50[0]) * 100.0
        rs2 = (s_bank / s_bank[0]) / (b_bank / b_bank[0]) * 100.0
    elif norm_type == 'base100_50':
        rs1 = (s_n50 / np.roll(s_n50, 50)) / (b_n50 / np.roll(b_n50, 50)) * 100.0
        rs2 = (s_bank / np.roll(s_bank, 50)) / (b_bank / np.roll(b_bank, 50)) * 100.0
    elif norm_type == 'base100_252':
        rs1 = (s_n50 / np.roll(s_n50, 252)) / (b_n50 / np.roll(b_n50, 252)) * 100.0
        rs2 = (s_bank / np.roll(s_bank, 252)) / (b_bank / np.roll(b_bank, 252)) * 100.0

    s_rs1, s_rs2 = pd.Series(rs1), pd.Series(rs2)

    for fast_p in range(1, 40):
        for slow_p in range(fast_p + 1, 150):
            # EMA ratio
            f_a = 2.0 / (fast_p + 1.0)
            s_a = 2.0 / (slow_p + 1.0)

            t1_ema = 100.0 * (s_rs1.ewm(alpha=f_a, adjust=False).mean().values / s_rs1.ewm(alpha=s_a, adjust=False).mean().values)
            t2_ema = 100.0 * (s_rs2.ewm(alpha=f_a, adjust=False).mean().values / s_rs2.ewm(alpha=s_a, adjust=False).mean().values)

            # SMA ratio
            t1_sma = 100.0 * (s_rs1.rolling(fast_p).mean().values / s_rs1.rolling(slow_p).mean().values)
            t2_sma = 100.0 * (s_rs2.rolling(fast_p).mean().values / s_rs2.rolling(slow_p).mean().values)

            for t_type, t1, t2 in [('EMA', t1_ema, t2_ema), ('SMA', t1_sma, t2_sma)]:
                s_t1, s_t2 = pd.Series(t1), pd.Series(t2)

                for mom_p in range(1, 40):
                    m_a = 2.0 / (mom_p + 1.0)
                    
                    # Mom A: 100 * (t / EMA(t, mom_p))
                    m1_a = 100.0 * (t1 / s_t1.ewm(alpha=m_a, adjust=False).mean().values)
                    m2_a = 100.0 * (t2 / s_t2.ewm(alpha=m_a, adjust=False).mean().values)

                    # Mom B: 100 * (t / SMA(t, mom_p))
                    m1_b = 100.0 * (t1 / s_t1.rolling(mom_p).mean().values)
                    m2_b = 100.0 * (t2 / s_t2.rolling(mom_p).mean().values)

                    # Mom C: 100 + ROC(t, mom_p)
                    m1_c = 100.0 + (t1 - np.roll(t1, mom_p))
                    m2_c = 100.0 + (t2 - np.roll(t2, mom_p))

                    for m_type, m1, m2 in [('t/EMA(t)', m1_a, m2_a), ('t/SMA(t)', m1_b, m2_b), ('100+ROC', m1_c, m2_c)]:
                        v_n50_t, v_n50_m = t1[i_n50_31], m1[i_n50_31]
                        v_bank_t, v_bank_m = t2[i_bank_31], m2[i_bank_31]

                        if np.isnan(v_n50_t) or np.isnan(v_n50_m) or np.isnan(v_bank_t) or np.isnan(v_bank_m):
                            continue

                        err_n50 = abs(v_n50_t - 99.99) + abs(v_n50_m - 100.32)
                        err_bank = abs(v_bank_t - 99.73) + abs(v_bank_m - 100.74)
                        total_err = err_n50 + err_bank

                        if total_err < 0.2:
                            desc = f"{norm_type} | {t_type} fast={fast_p} slow={slow_p} | {m_type} mom={mom_p}"
                            matches.append((total_err, desc, v_n50_t, v_n50_m, v_bank_t, v_bank_m))

matches.sort(key=lambda x: x[0])

print("TOP 10 EXACT 2-DECIMAL MATCHES:")
for err, desc, n50_t, n50_m, bank_t, bank_m in matches[:10]:
    print(f"\nTotal Err: {err:.4f} | {desc}")
    print(f"   Nifty 50 Jul 31: Trend = {n50_t:.2f} (Target 99.99), Mom = {n50_m:.2f} (Target 100.32)")
    print(f"   Bank Nifty Jul 31: Trend = {bank_t:.2f} (Target 99.73), Mom = {bank_m:.2f} (Target 100.74)")
