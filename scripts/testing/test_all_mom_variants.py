import pandas as pd
import numpy as np

bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

merged = pd.merge(bank, nifty500, on='date', suffixes=('_bank', '_bench'))
rs_raw = (merged['Close_bank'] / merged['Close_bench']) * 100.0

ema_14 = rs_raw.ewm(span=14, adjust=False).mean()
ema_125 = rs_raw.ewm(span=125, adjust=False).mean()
rs_ratio = 100.0 * (ema_14 / ema_125)

i = merged.index[merged['date'] == '2026-07-31'][0]

print("RS-Ratio on 2026-07-31:", rs_ratio.iloc[i])

# Test 1: RS / SMA(RS, 14)
m1 = 100.0 * (rs_raw / rs_raw.rolling(14).mean())

# Test 2: RS_Ratio / SMA(RS_Ratio, 14)
m2 = 100.0 * (rs_ratio / rs_ratio.rolling(14).mean())

# Test 3: RS_Ratio / RS_Ratio.shift(1)
m3 = 100.0 * (rs_ratio / rs_ratio.shift(1))

# Test 4: RS_Ratio / RS_Ratio.shift(5)
m4 = 100.0 * (rs_ratio / rs_ratio.shift(5))

# Test 5: RS / RS.shift(14)
m5 = 100.0 * (rs_raw / rs_raw.shift(14))

# Test 6: RS / RS.shift(5)
m6 = 100.0 * (rs_raw / rs_raw.shift(5))

# Test 7: (EMA_fast / RS_raw)
m7 = 100.0 * (ema_14 / rs_raw)

# Test 8: 100 + (RS_ratio - EMA(RS_ratio, 14)) * 10
m8 = 100.0 + (rs_ratio - rs_ratio.ewm(span=14, adjust=False).mean()) * 10.0

# Test 9: 100 + (RS_ratio - RS_ratio.shift(5)) * 2
m9 = 100.0 + (rs_ratio - rs_ratio.shift(5)) * 2.0

for name, series in [('RS/SMA14', m1), ('Ratio/SMARatio14', m2), ('Ratio/Shift1', m3), ('Ratio/Shift5', m4), ('RS/Shift14', m5), ('RS/Shift5', m6), ('EMA14/RS', m7), ('ScaledDiff EMA', m8), ('ScaledDiff Shift5', m9)]:
    val = series.iloc[i]
    val_prev = series.iloc[i-1]
    print(f"{name}: Jul 31 = {val:.2f}, Jul 30 = {val_prev:.2f}")
