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
merged = pd.merge(bank, nifty500, on='date', suffixes=('_bank', '_bench'))

target_date = '2026-07-31'
target_trend = 99.73
target_mom = 100.74

print(f"Target on {target_date}: Strength Trend = {target_trend}, Strength Momentum = {target_mom}\n")

rs_raw = (merged['close_bank'] / merged['close_bench']) * 100.0
i_target = merged.index[merged['date'] == target_date][0]

results = []

# Test 1: RS-Ratio = 100 * (EMA(RS, 14) / EMA(RS, 125))
# Test different Strength Momentum definitions
for fast in [10, 12, 14, 20]:
    for slow in [50, 100, 125, 150]:
        ema_fast = rs_raw.ewm(span=fast, adjust=False).mean()
        ema_slow = rs_raw.ewm(span=slow, adjust=False).mean()
        rs_ratio = 100.0 * (ema_fast / ema_slow)
        
        # Mom Def 1: 100 * (RS_raw / EMA(RS_raw, fast))
        mom1 = 100.0 * (rs_raw / ema_fast)
        
        # Mom Def 2: 100 * (RS_ratio / EMA(RS_ratio, mom_span))
        for m_span in [3, 5, 8, 10, 14, 20]:
            ema_mom = rs_ratio.ewm(span=m_span, adjust=False).mean()
            mom2 = 100.0 * (rs_ratio / ema_mom)
            
            # Mom Def 3: 100 + ROC(RS_ratio, m_span)
            mom3 = 100.0 + ((rs_ratio / rs_ratio.shift(m_span)) - 1.0) * 100.0
            
            # Mom Def 4: 100 * (RS_ratio / RS_ratio.shift(m_span))
            mom4 = 100.0 * (rs_ratio / rs_ratio.shift(m_span))
            
            # Mom Def 5: 100 + (RS_ratio - RS_ratio.shift(m_span))
            mom5 = 100.0 + (rs_ratio - rs_ratio.shift(m_span))

            t_val = rs_ratio.iloc[i_target]
            m1_val = mom1.iloc[i_target]
            m2_val = mom2.iloc[i_target]
            m3_val = mom3.iloc[i_target]
            m4_val = mom4.iloc[i_target]
            m5_val = mom5.iloc[i_target]

            results.append((abs(t_val - target_trend) + abs(m1_val - target_mom), f"Fast={fast} Slow={slow} MomDef1 (RS/EMA_fast)", t_val, m1_val))
            results.append((abs(t_val - target_trend) + abs(m2_val - target_mom), f"Fast={fast} Slow={slow} MomDef2 m_span={m_span} (Ratio/EMA_mom)", t_val, m2_val))
            results.append((abs(t_val - target_trend) + abs(m3_val - target_mom), f"Fast={fast} Slow={slow} MomDef3 m_span={m_span} (100+ROC)", t_val, m3_val))
            results.append((abs(t_val - target_trend) + abs(m4_val - target_mom), f"Fast={fast} Slow={slow} MomDef4 m_span={m_span} (100*Ratio/Shift)", t_val, m4_val))
            results.append((abs(t_val - target_trend) + abs(m5_val - target_mom), f"Fast={fast} Slow={slow} MomDef5 m_span={m_span} (100+Diff)", t_val, m5_val))

results.sort(key=lambda x: x[0])

print("TOP 15 CLOSEST FORMULA MATCHES:")
for err, desc, t_val, m_val in results[:15]:
    print(f"Err: {err:.4f} | {desc} => Trend: {t_val:.2f}, Mom: {m_val:.2f}")
