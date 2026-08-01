import pandas as pd
import numpy as np

bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

merged = pd.merge(bank, nifty500, on='date', suffixes=('_bank', '_bench'))
rs_raw = (merged['Close_bank'] / merged['Close_bench']) * 100.0

dates = ['2026-07-28', '2026-07-30', '2026-07-31']
dhan_targets = {
    '2026-07-28': (99.33, 100.67),
    '2026-07-30': (99.60, 100.80),
    '2026-07-31': (99.73, 100.74)
}

print("Testing formulas where Strength Trend increases from Jul 28 to Jul 31:\n")

# Test 1: Ratio using shorter fast span (e.g. 5 vs 50 or 7 vs 50)
for fast_p in [3, 5, 7, 10, 14]:
    for slow_p in [30, 50, 75, 100, 125]:
        ema_fast = rs_raw.ewm(span=fast_p, adjust=False).mean()
        ema_slow = rs_raw.ewm(span=slow_p, adjust=False).mean()
        trend = 100.0 * (ema_fast / ema_slow)
        
        # Test Momentum = 100 * (rs_raw / ema_fast) or 100 * (ema_fast / ema_slow_mom)
        mom = 100.0 * (rs_raw / ema_fast)
        
        # Check trend direction: is trend(Jul28) < trend(Jul30) < trend(Jul31)?
        idx_28 = merged.index[merged['date'] == '2026-07-28'][0]
        idx_30 = merged.index[merged['date'] == '2026-07-30'][0]
        idx_31 = merged.index[merged['date'] == '2026-07-31'][0]
        
        t28, m28 = trend.iloc[idx_28], mom.iloc[idx_28]
        t30, m30 = trend.iloc[idx_30], mom.iloc[idx_30]
        t31, m31 = trend.iloc[idx_31], mom.iloc[idx_31]
        
        if t28 < t30 and t30 < t31:
            err = abs(t28 - 99.33) + abs(m28 - 100.67) + abs(t30 - 99.60) + abs(m30 - 100.80) + abs(t31 - 99.73) + abs(m31 - 100.74)
            print(f"INCREASING MATCH fast={fast_p} slow={slow_p}:")
            print(f"   Jul 28: Trend={t28:.2f}, Mom={m28:.2f}")
            print(f"   Jul 30: Trend={t30:.2f}, Mom={m30:.2f}")
            print(f"   Jul 31: Trend={t31:.2f}, Mom={m31:.2f} (Err={err:.2f})")
