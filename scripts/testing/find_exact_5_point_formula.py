import pandas as pd
import numpy as np

nifty50 = pd.read_csv('Historical Data/NIFTY_50_Daily_5Y.csv')
bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

nifty50['date'] = nifty50['Datetime'].str.slice(0, 10)
bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

df_n50 = pd.merge(nifty50[['date', 'Close']], nifty500[['date', 'Close']], on='date', suffixes=('_stock', '_bench'))
df_bank = pd.merge(bank[['date', 'Close']], nifty500[['date', 'Close']], on='date', suffixes=('_stock', '_bench'))

targets_n50 = {'2026-07-30': (100.41, 101.15), '2026-07-31': (100.77, 101.47)}
targets_bank = {'2026-07-28': (99.33, 100.67), '2026-07-30': (99.60, 100.80), '2026-07-31': (99.73, 100.74)}

print("Searching for exact 5-point formula match...")

results = []

for base_L in [0, 5, 10, 14, 20, 50, 100, 125, 252]:
    if base_L == 0:
        rs_n50 = (df_n50['Close_stock'] / df_n50['Close_bench']) * 100.0
        rs_bank = (df_bank['Close_stock'] / df_bank['Close_bench']) * 100.0
    else:
        rs_n50 = ((df_n50['Close_stock'] / df_n50['Close_stock'].shift(base_L)) / (df_n50['Close_bench'] / df_n50['Close_bench'].shift(base_L))) * 100.0
        rs_bank = ((df_bank['Close_stock'] / df_bank['Close_stock'].shift(base_L)) / (df_bank['Close_bench'] / df_bank['Close_bench'].shift(base_L))) * 100.0

    for fast_p in range(3, 30):
        for slow_p in range(15, 150, 5):
            t_n50_ema = 100.0 * (rs_n50.ewm(span=fast_p, adjust=False).mean() / rs_n50.ewm(span=slow_p, adjust=False).mean())
            t_bank_ema = 100.0 * (rs_bank.ewm(span=fast_p, adjust=False).mean() / rs_bank.ewm(span=slow_p, adjust=False).mean())

            t_n50_sma = 100.0 * (rs_n50.rolling(fast_p).mean() / rs_n50.rolling(slow_p).mean())
            t_bank_sma = 100.0 * (rs_bank.rolling(fast_p).mean() / rs_bank.rolling(slow_p).mean())

            for t_name, t_n50, t_bank in [('EMA_ratio', t_n50_ema, t_bank_ema), ('SMA_ratio', t_n50_sma, t_bank_sma)]:
                for mom_p in range(2, 25):
                    m_n50_a = 100.0 * (t_n50 / t_n50.ewm(span=mom_p, adjust=False).mean())
                    m_bank_a = 100.0 * (t_bank / t_bank.ewm(span=mom_p, adjust=False).mean())

                    m_n50_b = 100.0 * (t_n50 / t_n50.rolling(mom_p).mean())
                    m_bank_b = 100.0 * (t_bank / t_bank.rolling(mom_p).mean())

                    for m_name, mom_n50, mom_bank in [('t/EMA(t)', m_n50_a, m_bank_a), ('t/SMA(t)', m_n50_b, m_bank_b)]:
                        valid = True
                        total_err = 0.0
                        n50_res = []
                        bank_res = []

                        for d, target in targets_n50.items():
                            match_idx = df_n50.index[df_n50['date'] == d]
                            if len(match_idx) == 0: valid = False; break
                            i = match_idx[0]
                            tv, mv = t_n50.iloc[i], mom_n50.iloc[i]
                            if np.isnan(tv) or np.isnan(mv): valid = False; break
                            total_err += abs(tv - target[0]) + abs(mv - target[1])
                            n50_res.append((d, tv, mv, target[0], target[1]))

                        for d, target in targets_bank.items():
                            match_idx = df_bank.index[df_bank['date'] == d]
                            if len(match_idx) == 0: valid = False; break
                            i = match_idx[0]
                            tv, mv = t_bank.iloc[i], mom_bank.iloc[i]
                            if np.isnan(tv) or np.isnan(mv): valid = False; break
                            total_err += abs(tv - target[0]) + abs(mv - target[1])
                            bank_res.append((d, tv, mv, target[0], target[1]))

                        if valid:
                            desc = f"base_L={base_L} | {t_name} fast={fast_p} slow={slow_p} | {m_name} mom={mom_p}"
                            results.append((total_err, desc, n50_res, bank_res))

results.sort(key=lambda x: x[0])

print("\nTOP 15 JOINT MATCHES ACROSS ALL 5 DHAN SCREENSHOT POINTS:")
for err, desc, n50_res, bank_res in results[:15]:
    print(f"\nTotal Err: {err:.4f} | {desc}")
    print("   Nifty 50:")
    for d, tv, mv, tt, tm in n50_res:
        print(f"      {d}: Calc (Trend={tv:.2f}, Mom={mv:.2f}) vs Dhan (Trend={tt:.2f}, Mom={tm:.2f})")
    print("   Bank Nifty:")
    for d, tv, mv, tt, tm in bank_res:
        print(f"      {d}: Calc (Trend={tv:.2f}, Mom={mv:.2f}) vs Dhan (Trend={tt:.2f}, Mom={tm:.2f})")
