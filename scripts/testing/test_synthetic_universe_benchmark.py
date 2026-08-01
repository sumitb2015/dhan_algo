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

# Also load Nifty 50
nifty50 = load_csv('Historical Data/NIFTY_50_Daily_5Y.csv')
all_indices['NIFTY50'] = nifty50

# Build Equal-Weighted Index of all sector indices
# Normalize each index to 100 on common start date
all_dates = set.intersection(*[set(df['date']) for df in all_indices.values()])
all_dates = sorted(list(all_dates))

df_dates = pd.DataFrame({'date': all_dates})
norm_series = []

for name, df in all_indices.items():
    merged = pd.merge(df_dates, df, on='date')
    # Normalize by base price
    base = merged['close'].iloc[0]
    merged[name] = (merged['close'] / base) * 100.0
    norm_series.append(merged[['date', name]])

bench_df = norm_series[0]
for s in norm_series[1:]:
    bench_df = pd.merge(bench_df, s, on='date')

index_cols = [c for c in bench_df.columns if c != 'date']
bench_df['eq_bench'] = bench_df[index_cols].mean(axis=1)

print(f"Equal-Weighted Universe Benchmark constructed over {len(index_cols)} indices, {len(bench_df)} dates.")

# Test Bank Nifty against Equal-Weighted Benchmark
bank_df = all_indices['BANKNIFTY']
merged_bank = pd.merge(bank_df, bench_df[['date', 'eq_bench']], on='date')

rs_raw = (merged_bank['close'] / merged_bank['eq_bench']) * 100.0

target_date = '2026-07-31'
target_trend = 99.73
target_mom = 100.74

print(f"\nTesting against Equal-Weighted Universe Benchmark for {target_date}:")

results = []
for fast in [10, 12, 14, 20]:
    for slow in [50, 100, 125, 150]:
        ema_fast = rs_raw.ewm(span=fast, adjust=False).mean()
        ema_slow = rs_raw.ewm(span=slow, adjust=False).mean()
        rs_ratio = 100.0 * (ema_fast / ema_slow)
        
        for mom_span in [10, 12, 14, 20]:
            ema_mom = rs_ratio.ewm(span=mom_span, adjust=False).mean()
            mom = 100.0 * (rs_ratio / ema_mom)
            
            idx = merged_bank.index[merged_bank['date'] == target_date]
            if len(idx) > 0:
                i = idx[0]
                t_val = rs_ratio.iloc[i]
                m_val = mom.iloc[i]
                err = abs(t_val - target_trend) + abs(m_val - target_mom)
                results.append((err, f"EqualWeighted fast={fast} slow={slow} mom={mom_span}", t_val, m_val))

# Also test standard Z-score on Equal-Weighted Benchmark
for w in [10, 12, 14, 20]:
    mean_rs = rs_raw.rolling(w).mean()
    std_rs = rs_raw.rolling(w).std(ddof=1)
    rs_ratio = 100.0 + (rs_raw - mean_rs) / std_rs
    
    rs_roc = (rs_ratio / rs_ratio.shift(1) - 1.0) * 100.0
    mean_roc = rs_roc.rolling(w).mean()
    std_roc = rs_roc.rolling(w).std(ddof=1)
    mom = 100.0 + (rs_roc - mean_roc) / std_roc
    
    idx = merged_bank.index[merged_bank['date'] == target_date]
    if len(idx) > 0:
        i = idx[0]
        t_val = rs_ratio.iloc[i]
        m_val = mom.iloc[i]
        err = abs(t_val - target_trend) + abs(m_val - target_mom)
        results.append((err, f"ZScore EqualWeighted w={w}", t_val, m_val))

results.sort(key=lambda x: x[0])
print("\nTOP 10 CLOSEST MATCHES:")
for err, desc, t_val, m_val in results[:10]:
    print(f"Err: {err:.4f} | {desc} => Trend: {t_val:.2f}, Mom: {m_val:.2f}")
