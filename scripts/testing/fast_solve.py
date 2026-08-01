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

# All 5 Dhan Ground-Truth Screenshot Targets:
# Nifty 50:
#   2026-07-30: (100.41, 101.15)
#   2026-07-31: (100.77, 101.47)
# Bank Nifty:
#   2026-07-28: (99.33, 100.67)
#   2026-07-30: (99.60, 100.80)
#   2026-07-31: (99.73, 100.74)

targets_n50 = {'2026-07-30': (100.41, 101.15), '2026-07-31': (100.77, 101.47)}
targets_bank = {'2026-07-28': (99.33, 100.67), '2026-07-30': (99.60, 100.80), '2026-07-31': (99.73, 100.74)}

idx_n50 = {d: df_n50.index[df_n50['date'] == d][0] for d in targets_n50}
idx_bank = {d: df_bank.index[df_bank['date'] == d][0] for d in targets_bank}

results = []

# Method A: Standard ratio with Base-Normalization
# RS_norm(t) = 100 * (Stock(t) / Stock(base)) / (Bench(t) / Bench(base))
for base_offset in [10, 14, 20, 30, 50, 100, 125, 252]:
    s_n50 = df_n50['Close_stock'].values
    b_n50 = df_n50['Close_bench'].values
    s_bank = df_bank['Close_stock'].values
    b_bank = df_bank['Close_bench'].values

    # Base offset RS
    rs_n50 = (s_n50 / np.roll(s_n50, base_offset)) / (b_n50 / np.roll(b_n50, base_offset)) * 100.0
    rs_bank = (s_bank / np.roll(s_bank, base_offset)) / (b_bank / np.roll(b_bank, base_offset)) * 100.0

    for fast_p in [5, 10, 12, 14, 15, 20]:
        for slow_p in [30, 50, 75, 100, 125]:
            # EMA
            f_a = 2.0 / (fast_p + 1.0)
            s_a = 2.0 / (slow_p + 1.0)

            # N50
            ema_f_n50 = pd.Series(rs_n50).ewm(alpha=f_a, adjust=False).mean().values
            ema_s_n50 = pd.Series(rs_n50).ewm(alpha=s_a, adjust=False).mean().values
            t_n50 = 100.0 * (ema_f_n50 / ema_s_n50)

            # Bank
            ema_f_bank = pd.Series(rs_bank).ewm(alpha=f_a, adjust=False).mean().values
            ema_s_bank = pd.Series(rs_bank).ewm(alpha=s_a, adjust=False).mean().values
            t_bank = 100.0 * (ema_f_bank / ema_s_bank)

            for mom_p in [3, 5, 10, 14]:
                m_a = 2.0 / (mom_p + 1.0)
                mom_n50 = 100.0 * (t_n50 / pd.Series(t_n50).ewm(alpha=m_a, adjust=False).mean().values)
                mom_bank = 100.0 * (t_bank / pd.Series(t_bank).ewm(alpha=m_a, adjust=False).mean().values)

                total_err = 0.0
                n50_res = []
                bank_res = []

                for d, target in targets_n50.items():
                    i = idx_n50[d]
                    tv, mv = t_n50[i], mom_n50[i]
                    total_err += abs(tv - target[0]) + abs(mv - target[1])
                    n50_res.append((d, tv, mv, target[0], target[1]))

                for d, target in targets_bank.items():
                    i = idx_bank[d]
                    tv, mv = t_bank[i], mom_bank[i]
                    total_err += abs(tv - target[0]) + abs(mv - target[1])
                    bank_res.append((d, tv, mv, target[0], target[1]))

                desc = f"base_offset={base_offset} fast={fast_p} slow={slow_p} mom={mom_p}"
                results.append((total_err, desc, n50_res, bank_res))

results.sort(key=lambda x: x[0])

print("TOP 5 MATCHES ACROSS ALL 5 DHAN SCREENSHOT POINTS:")
for err, desc, n50_res, bank_res in results[:5]:
    print(f"\nTotal Err: {err:.4f} | {desc}")
    print("   Nifty 50:")
    for d, tv, mv, tt, tm in n50_res:
        print(f"      {d}: Calc (Trend={tv:.2f}, Mom={mv:.2f}) vs Dhan (Trend={tt:.2f}, Mom={tm:.2f})")
    print("   Bank Nifty:")
    for d, tv, mv, tt, tm in bank_res:
        print(f"      {d}: Calc (Trend={tv:.2f}, Mom={mv:.2f}) vs Dhan (Trend={tt:.2f}, Mom={tm:.2f})")
