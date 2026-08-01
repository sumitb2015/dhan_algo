import pandas as pd
import numpy as np

# Load Bank Nifty & Nifty 500
bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

merged = pd.merge(bank, nifty500, on='date', suffixes=('_bank', '_bench'))

# Targets from Dhan Broker Screenshots:
# 2026-07-28: Trend = 99.33, Mom = 100.67
# 2026-07-30: Trend = 99.60, Mom = 100.80
# 2026-07-31: Trend = 99.73, Mom = 100.74

targets = {
    '2026-07-28': (99.33, 100.67),
    '2026-07-30': (99.60, 100.80),
    '2026-07-31': (99.73, 100.74)
}

print("Searching for exact formula across all 3 target dates...")

# Let's test various raw RS definitions:
# RS_raw = 100 * (Close_bank / Close_bench)
rs_raw = (merged['Close_bank'] / merged['Close_bench']) * 100.0

# Also test Normalized RS (base = 100 on start date or 100 * ratio)
# Test different EMA / SMA combinations for Trend & Momentum

results = []

dates = list(targets.keys())
indices = [merged.index[merged['date'] == d][0] for d in dates]

# Parameter sweep for EMA/SMA spans
for fast_p in range(5, 30):
    for slow_p in range(30, 200, 5):
        # EMA fast & slow
        ema_fast = rs_raw.ewm(span=fast_p, adjust=False).mean()
        ema_slow = rs_raw.ewm(span=slow_p, adjust=False).mean()
        
        # SMA fast & slow
        sma_fast = rs_raw.rolling(fast_p).mean()
        sma_slow = rs_raw.rolling(slow_p).mean()
        
        # Trend option 1: 100 * (ema_fast / ema_slow)
        t1 = 100.0 * (ema_fast / ema_slow)
        # Trend option 2: 100 * (sma_fast / sma_slow)
        t2 = 100.0 * (sma_fast / sma_slow)
        # Trend option 3: 100 + (rs_raw - ema_slow) / ema_slow * 100
        t3 = 100.0 * (rs_raw / ema_slow)
        
        for t_name, t_series in [('EMA_ratio', t1), ('SMA_ratio', t2), ('Raw_to_Slow', t3)]:
            
            # Momentum options:
            for mom_p in range(2, 30):
                # Mom 1: 100 * (t_series / EMA(t_series, mom_p))
                m1 = 100.0 * (t_series / t_series.ewm(span=mom_p, adjust=False).mean())
                # Mom 2: 100 * (t_series / SMA(t_series, mom_p))
                m2 = 100.0 * (t_series / t_series.rolling(mom_p).mean())
                # Mom 3: 100 * (EMA(rs_raw, mom_p) / ema_fast)
                m3 = 100.0 * (rs_raw.ewm(span=mom_p, adjust=False).mean() / ema_fast)
                # Mom 4: 100 * (ema_fast / rs_raw.ewm(span=mom_p, adjust=False).mean())
                m4 = 100.0 * (ema_fast / rs_raw.ewm(span=mom_p, adjust=False).mean())
                # Mom 5: 100 + (t_series - t_series.shift(mom_p))
                m5 = 100.0 + (t_series - t_series.shift(mom_p))
                # Mom 6: 100 * (t_series / t_series.shift(mom_p))
                m6 = 100.0 * (t_series / t_series.shift(mom_p))
                
                for m_name, m_series in [
                    ('t/EMA(t)', m1), ('t/SMA(t)', m2), ('EMA(mom)/fast', m3),
                    ('fast/EMA(mom)', m4), ('100+Shift', m5), ('100*Shift', m6)
                ]:
                    total_err = 0.0
                    valid = True
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

print(f"\nTOP 15 CLOSEST MATCHES ACROSS ALL 3 DATES (Jul 28, Jul 30, Jul 31):")
for err, desc, t_vals, m_vals in results[:15]:
    print(f"\nErr: {err:.4f} | {desc}")
    for d, tv, mv in zip(dates, t_vals, m_vals):
        target_t, target_m = targets[d]
        print(f"   {d}: Calc (Trend={tv:.2f}, Mom={mv:.2f}) vs Dhan (Trend={target_t:.2f}, Mom={target_m:.2f})")
