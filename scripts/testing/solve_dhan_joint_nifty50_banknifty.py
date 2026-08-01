import pandas as pd
import numpy as np

bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty50 = pd.read_csv('Historical Data/NIFTY_50_Daily_5Y.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty50['date'] = nifty50['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

merged_n50 = pd.merge(nifty50, nifty500, on='date', suffixes=('_n50', '_n500'))
merged_bank = pd.merge(bank, nifty500, on='date', suffixes=('_bank', '_n500'))

# Targets from Dhan Broker Screenshots:
# Nifty 50:
#   2026-07-30: (100.41, 101.15)
#   2026-07-31: (100.77, 101.47)
# Bank Nifty:
#   2026-07-28: (99.33, 100.67)
#   2026-07-30: (99.60, 100.80)
#   2026-07-31: (99.73, 100.74)

targets_n50 = {
    '2026-07-30': (100.41, 101.15),
    '2026-07-31': (100.77, 101.47)
}

targets_bank = {
    '2026-07-28': (99.33, 100.67),
    '2026-07-30': (99.60, 100.80),
    '2026-07-31': (99.73, 100.74)
}

print("Searching for joint formula for Nifty 50 & Bank Nifty across all 5 target points...\n")

results = []

# Sweep EMA/SMA parameters, scaling methods, and lookbacks
for fast_p in range(5, 30):
    for slow_p in range(20, 150, 5):
        # 1. Standard RS: Stock / Benchmark
        rs_n50_std = (merged_n50['Close_n50'] / merged_n50['Close_n500']) * 100.0
        rs_bank_std = (merged_bank['Close_bank'] / merged_bank['Close_n500']) * 100.0
        
        # 2. Inverted RS: Benchmark / Stock
        rs_n50_inv = (merged_n50['Close_n500'] / merged_n50['Close_n50']) * 100.0
        rs_bank_inv = (merged_bank['Close_n500'] / merged_bank['Close_bank']) * 100.0

        for rs_type, rs_n50, rs_bank in [('Standard (Stock/Bench)', rs_n50_std, rs_bank_std), ('Inverted (Bench/Stock)', rs_n50_inv, rs_bank_inv)]:
            
            # EMA trend
            ema_fast_n50 = rs_n50.ewm(span=fast_p, adjust=False).mean()
            ema_slow_n50 = rs_n50.ewm(span=slow_p, adjust=False).mean()
            trend_n50_ema = 100.0 * (ema_fast_n50 / ema_slow_n50)
            
            ema_fast_bank = rs_bank.ewm(span=fast_p, adjust=False).mean()
            ema_slow_bank = rs_bank.ewm(span=slow_p, adjust=False).mean()
            trend_bank_ema = 100.0 * (ema_fast_bank / ema_slow_bank)

            # SMA trend
            sma_fast_n50 = rs_n50.rolling(fast_p).mean()
            sma_slow_n50 = rs_n50.rolling(slow_p).mean()
            trend_n50_sma = 100.0 * (sma_fast_n50 / sma_slow_n50)
            
            sma_fast_bank = rs_bank.rolling(fast_p).mean()
            sma_slow_bank = rs_bank.rolling(slow_p).mean()
            trend_bank_sma = 100.0 * (sma_fast_bank / sma_slow_bank)

            for t_type, t_n50, t_bank in [('EMA_ratio', trend_n50_ema, trend_bank_ema), ('SMA_ratio', trend_n50_sma, trend_bank_sma)]:
                
                for mom_p in range(2, 30):
                    # Mom A: 100 * (t_series / EMA(t_series, mom_p))
                    m_n50_a = 100.0 * (t_n50 / t_n50.ewm(span=mom_p, adjust=False).mean())
                    m_bank_a = 100.0 * (t_bank / t_bank.ewm(span=mom_p, adjust=False).mean())
                    
                    # Mom B: 100 * (EMA(rs, mom_p) / ema_fast)
                    m_n50_b = 100.0 * (rs_n50.ewm(span=mom_p, adjust=False).mean() / ema_fast_n50)
                    m_bank_b = 100.0 * (rs_bank.ewm(span=mom_p, adjust=False).mean() / ema_fast_bank)
                    
                    # Mom C: 100 * (ema_fast / EMA(rs, mom_p))
                    m_n50_c = 100.0 * (ema_fast_n50 / rs_n50.ewm(span=mom_p, adjust=False).mean())
                    m_bank_c = 100.0 * (ema_fast_bank / rs_bank.ewm(span=mom_p, adjust=False).mean())

                    # Mom D: 100 + ROC(t_series, mom_p)
                    m_n50_d = 100.0 + (t_n50 - t_n50.shift(mom_p))
                    m_bank_d = 100.0 + (t_bank - t_bank.shift(mom_p))

                    for m_type, m_n50, m_bank in [
                        ('t/EMA(t)', m_n50_a, m_bank_a),
                        ('EMA(mom)/fast', m_n50_b, m_bank_b),
                        ('fast/EMA(mom)', m_n50_c, m_bank_c),
                        ('100+Shift', m_n50_d, m_bank_d)
                    ]:
                        total_err = 0.0
                        valid = True
                        
                        # Evaluate Nifty 50
                        n50_res = []
                        for d, target in targets_n50.items():
                            idx = merged_n50.index[merged_n50['date'] == d]
                            if len(idx) == 0: valid = False; break
                            i = idx[0]
                            tv, mv = t_n50.iloc[i], m_n50.iloc[i]
                            if np.isnan(tv) or np.isnan(mv): valid = False; break
                            total_err += abs(tv - target[0]) + abs(mv - target[1])
                            n50_res.append((d, tv, mv, target[0], target[1]))

                        # Evaluate Bank Nifty
                        bank_res = []
                        for d, target in targets_bank.items():
                            idx = merged_bank.index[merged_bank['date'] == d]
                            if len(idx) == 0: valid = False; break
                            i = idx[0]
                            tv, mv = t_bank.iloc[i], m_bank.iloc[i]
                            if np.isnan(tv) or np.isnan(mv): valid = False; break
                            total_err += abs(tv - target[0]) + abs(mv - target[1])
                            bank_res.append((d, tv, mv, target[0], target[1]))

                        if valid:
                            desc = f"{rs_type} | {t_type} fast={fast_p} slow={slow_p} | {m_type} mom={mom_p}"
                            results.append((total_err, desc, n50_res, bank_res))

results.sort(key=lambda x: x[0])

print("TOP 10 CLOSEST JOINT FORMULA MATCHES ACROSS NIFTY 50 AND BANK NIFTY:")
for err, desc, n50_res, bank_res in results[:10]:
    print(f"\nTotal Err: {err:.4f} | {desc}")
    print("   Nifty 50:")
    for d, tv, mv, tt, tm in n50_res:
        print(f"      {d}: Calc (Trend={tv:.2f}, Mom={mv:.2f}) vs Dhan (Trend={tt:.2f}, Mom={tm:.2f})")
    print("   Bank Nifty:")
    for d, tv, mv, tt, tm in bank_res:
        print(f"      {d}: Calc (Trend={tv:.2f}, Mom={mv:.2f}) vs Dhan (Trend={tt:.2f}, Mom={tm:.2f})")
