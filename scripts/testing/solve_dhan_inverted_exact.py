import pandas as pd
import numpy as np

bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

merged = pd.merge(bank, nifty500, on='date', suffixes=('_bank', '_bench'))

# Inverted RS: 100 * (Close_bench / Close_bank)
rs_inv = (merged['Close_bench'] / merged['Close_bank']) * 100.0

targets = {
    '2026-07-28': (99.33, 100.67),
    '2026-07-30': (99.60, 100.80),
    '2026-07-31': (99.73, 100.74)
}

dates = list(targets.keys())
indices = [merged.index[merged['date'] == d][0] for d in dates]

results = []

for fast_p in range(5, 40):
    for slow_p in range(40, 200, 5):
        ema_fast = rs_inv.ewm(span=fast_p, adjust=False).mean()
        ema_slow = rs_inv.ewm(span=slow_p, adjust=False).mean()
        sma_fast = rs_inv.rolling(fast_p).mean()
        sma_slow = rs_inv.rolling(slow_p).mean()
        
        t1 = 100.0 * (ema_fast / ema_slow)
        t2 = 100.0 * (sma_fast / sma_slow)
        t3 = 100.0 * (ema_slow / ema_fast)
        t4 = 100.0 * (sma_slow / sma_fast)
        
        for t_name, t_series in [('EMA_ratio', t1), ('SMA_ratio', t2), ('EMA_inv', t3), ('SMA_inv', t4)]:
            for mom_p in range(2, 25):
                m1 = 100.0 * (t_series / t_series.ewm(span=mom_p, adjust=False).mean())
                m2 = 100.0 * (t_series.ewm(span=mom_p, adjust=False).mean() / t_series)
                m3 = 100.0 * (rs_inv.ewm(span=mom_p, adjust=False).mean() / ema_fast)
                m4 = 100.0 * (ema_fast / rs_inv.ewm(span=mom_p, adjust=False).mean())
                
                for m_name, m_series in [('t/EMA(t)', m1), ('EMA(t)/t', m2), ('mom/fast', m3), ('fast/mom', m4)]:
                    valid = True
                    total_err = 0.0
                    t_vals = []
                    m_vals = []
                    
                    for idx, d in zip(indices, dates):
                        tv = t_series.iloc[idx]
                        mv = m_series.iloc[idx]
                        if np.isnan(tv) or np.isnan(mv):
                            valid = False; break
                        target_t, target_m = targets[d]
                        total_err += abs(tv - target_t) + abs(mv - target_m)
                        t_vals.append(tv)
                        m_vals.append(mv)
                    
                    if valid:
                        results.append((total_err, f"{t_name} fast={fast_p} slow={slow_p} | {m_name} mom={mom_p}", t_vals, m_vals))

results.sort(key=lambda x: x[0])

print("\nTOP 15 CLOSEST MATCHES WITH INVERTED RS:")
for err, desc, t_vals, m_vals in results[:15]:
    print(f"\nErr: {err:.4f} | {desc}")
    for d, tv, mv in zip(dates, t_vals, m_vals):
        target_t, target_m = targets[d]
        print(f"   {d}: Calc (Trend={tv:.2f}, Mom={mv:.2f}) vs Dhan (Trend={target_t:.2f}, Mom={target_m:.2f})")
