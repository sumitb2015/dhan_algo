import pandas as pd
import numpy as np

def load_csv(path):
    df = pd.read_csv(path)
    date_col = [c for c in df.columns if c.lower() in ['date', 'datetime']][0]
    close_col = [c for c in df.columns if c.lower() == 'close'][0]
    df['date'] = df[date_col].str.slice(0, 10)
    df['close'] = df[close_col].astype(float)
    return df[['date', 'close']].sort_values('date').reset_index(drop=True)

bank = load_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty500 = load_csv('Historical Data/NIFTY_500_Daily.csv')
nifty50 = load_csv('Historical Data/NIFTY_50_Daily_5Y.csv')

df_500 = pd.merge(bank, nifty500, on='date', suffixes=('_bank', '_bench'))
df_50 = pd.merge(bank, nifty50, on='date', suffixes=('_bank', '_bench'))

target_date = '2026-07-31'
target_trend = 99.73
target_mom = 100.74

print(f"Target for {target_date}: Strength Trend = {target_trend}, Strength Momentum = {target_mom}")

# Search across different parameters and formula variants
results = []

# Variant 1: EMA ratio: RS = 100 * (bank / bench)
# RS_Ratio = 100 * (EMA(RS, fast) / EMA(RS, slow))
# RS_Mom = 100 * (RS_Ratio / EMA(RS_Ratio, mom_fast)) or 100 + (RS_Ratio - EMA) or ROC
for name, df_data in [('Nifty500', df_500), ('Nifty50', df_50)]:
    rs_raw = (df_data['close_bank'] / df_data['close_bench']) * 100.0
    
    for fast in [10, 12, 14, 20, 26]:
        for slow in [50, 100, 125, 150, 200]:
            ema_fast = rs_raw.ewm(span=fast, adjust=False).mean()
            ema_slow = rs_raw.ewm(span=slow, adjust=False).mean()
            
            rs_ratio = 100.0 * (ema_fast / ema_slow)
            
            for mom_span in [10, 12, 14, 20]:
                ema_mom = rs_ratio.ewm(span=mom_span, adjust=False).mean()
                
                # Form A: 100 * (rs_ratio / ema_mom)
                mom_a = 100.0 * (rs_ratio / ema_mom)
                
                # Form B: 100 + (rs_ratio - ema_mom)
                mom_b = 100.0 + (rs_ratio - ema_mom)
                
                # Form C: 100 + (rs_ratio - SMA(rs_ratio, mom_span))
                sma_mom = rs_ratio.rolling(mom_span).mean()
                mom_c = 100.0 + (rs_ratio - sma_mom)
                
                # Check for target date
                idx_arr = df_data.index[df_data['date'] == target_date]
                if len(idx_arr) > 0:
                    i = idx_arr[0]
                    t_val = rs_ratio.iloc[i]
                    ma_val = mom_a.iloc[i]
                    mb_val = mom_b.iloc[i]
                    mc_val = mom_c.iloc[i]
                    
                    err_a = abs(t_val - target_trend) + abs(ma_val - target_mom)
                    err_b = abs(t_val - target_trend) + abs(mb_val - target_mom)
                    err_c = abs(t_val - target_trend) + abs(mc_val - target_mom)
                    
                    results.append((err_a, f"{name} FormA fast={fast} slow={slow} mom={mom_span}", t_val, ma_val))
                    results.append((err_b, f"{name} FormB fast={fast} slow={slow} mom={mom_span}", t_val, mb_val))
                    results.append((err_c, f"{name} FormC fast={fast} slow={slow} mom={mom_span}", t_val, mc_val))

# Variant 2: TradingView RRG formula / Normalized Difference
for name, df_data in [('Nifty500', df_500), ('Nifty50', df_50)]:
    rs_raw = (df_data['close_bank'] / df_data['close_bench']) * 100.0
    for w in [10, 12, 14, 20]:
        # RS_Ratio = 100 + (RS - SMA(14)) / SMA(14) * 100 or similar
        mean_rs = rs_raw.rolling(w).mean()
        ema_rs = rs_raw.ewm(span=w, adjust=False).mean()
        
        ratio1 = 100.0 + (rs_raw - mean_rs)
        ratio2 = 100.0 * (rs_raw / mean_rs)
        ratio3 = 100.0 + (rs_raw - ema_rs) / ema_rs * 100.0
        
        for m_w in [10, 12, 14, 20]:
            mom1 = 100.0 + (ratio1 - ratio1.rolling(m_w).mean())
            mom2 = 100.0 * (ratio2 / ratio2.rolling(m_w).mean())
            mom3 = 100.0 + (ratio3 - ratio3.ewm(span=m_w, adjust=False).mean())
            
            idx_arr = df_data.index[df_data['date'] == target_date]
            if len(idx_arr) > 0:
                i = idx_arr[0]
                results.append((abs(ratio1.iloc[i]-target_trend)+abs(mom1.iloc[i]-target_mom), f"{name} TV1 w={w} mw={m_w}", ratio1.iloc[i], mom1.iloc[i]))
                results.append((abs(ratio2.iloc[i]-target_trend)+abs(mom2.iloc[i]-target_mom), f"{name} TV2 w={w} mw={m_w}", ratio2.iloc[i], mom2.iloc[i]))
                results.append((abs(ratio3.iloc[i]-target_trend)+abs(mom3.iloc[i]-target_mom), f"{name} TV3 w={w} mw={m_w}", ratio3.iloc[i], mom3.iloc[i]))

results.sort(key=lambda x: x[0])
print("\nTOP 10 CLOSEST FORMULA MATCHES FOR 2026-07-31:")
for err, desc, t_val, m_val in results[:10]:
    print(f"Err: {err:.4f} | {desc} => Trend: {t_val:.2f}, Mom: {m_val:.2f}")
