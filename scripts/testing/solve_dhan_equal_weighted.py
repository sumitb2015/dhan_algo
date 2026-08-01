import pandas as pd
import numpy as np
import glob
import os

def load_csv(path):
    df = pd.read_csv(path)
    date_col = [c for c in df.columns if c.lower() in ['date', 'datetime']][0]
    close_col = [c for c in df.columns if c.lower() == 'close'][0]
    df['date'] = df[date_col].str.slice(0, 10)
    df['close'] = df[close_col].astype(float)
    return df[['date', 'close']].sort_values('date').reset_index(drop=True)

# Load all sector indices
indices_files = glob.glob('Historical Data/Indices/*.csv')
all_indices = {}

for f in indices_files:
    name = os.path.basename(f).replace('.csv', '')
    if name in ['INDIA_VIX']: continue
    all_indices[name] = load_csv(f)

all_indices['NIFTY50'] = load_csv('Historical Data/NIFTY_50_Daily_5Y.csv')

# Build Equal-Weighted Index
all_dates = set.intersection(*[set(df['date']) for df in all_indices.values()])
all_dates = sorted(list(all_dates))

df_dates = pd.DataFrame({'date': all_dates})
norm_series = []

for name, df in all_indices.items():
    merged = pd.merge(df_dates, df, on='date')
    base = merged['close'].iloc[0]
    merged[name] = (merged['close'] / base) * 100.0
    norm_series.append(merged[['date', name]])

bench_df = norm_series[0]
for s in norm_series[1:]:
    bench_df = pd.merge(bench_df, s, on='date')

index_cols = [c for c in bench_df.columns if c != 'date']
bench_df['eq_bench'] = bench_df[index_cols].mean(axis=1)

bank_df = all_indices['BANKNIFTY']
merged_bank = pd.merge(bank_df, bench_df[['date', 'eq_bench']], on='date')

rs_raw = (merged_bank['close'] / merged_bank['eq_bench']) * 100.0

targets = {
    '2026-07-28': (99.33, 100.67),
    '2026-07-30': (99.60, 100.80),
    '2026-07-31': (99.73, 100.74)
}

dates = list(targets.keys())
indices = [merged_bank.index[merged_bank['date'] == d][0] for d in dates]

results = []

for fast_p in range(5, 30):
    for slow_p in range(30, 200, 5):
        ema_fast = rs_raw.ewm(span=fast_p, adjust=False).mean()
        ema_slow = rs_raw.ewm(span=slow_p, adjust=False).mean()
        sma_fast = rs_raw.rolling(fast_p).mean()
        sma_slow = rs_raw.rolling(slow_p).mean()
        
        t1 = 100.0 * (ema_fast / ema_slow)
        t2 = 100.0 * (sma_fast / sma_slow)
        
        for t_name, t_series in [('EMA_ratio', t1), ('SMA_ratio', t2)]:
            for mom_p in range(2, 20):
                m1 = 100.0 * (t_series / t_series.ewm(span=mom_p, adjust=False).mean())
                m2 = 100.0 * (rs_raw.ewm(span=mom_p, adjust=False).mean() / ema_fast)
                m3 = 100.0 * (ema_fast / rs_raw.ewm(span=mom_p, adjust=False).mean())
                
                for m_name, m_series in [('t/EMA(t)', m1), ('EMA(mom)/fast', m2), ('fast/EMA(mom)', m3)]:
                    total_err = 0.0
                    t_vals = []
                    m_vals = []
                    valid = True
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

print(f"\nTOP 15 CLOSEST MATCHES WITH EQUAL-WEIGHTED BENCHMARK:")
for err, desc, t_vals, m_vals in results[:15]:
    print(f"\nErr: {err:.4f} | {desc}")
    for d, tv, mv in zip(dates, t_vals, m_vals):
        target_t, target_m = targets[d]
        print(f"   {d}: Calc (Trend={tv:.2f}, Mom={mv:.2f}) vs Dhan (Trend={target_t:.2f}, Mom={target_m:.2f})")
