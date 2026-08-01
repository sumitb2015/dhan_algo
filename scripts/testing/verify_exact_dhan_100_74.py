import pandas as pd
import numpy as np

bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

merged = pd.merge(bank, nifty500, on='date', suffixes=('_bank', '_bench'))
rs_raw = (merged['Close_bank'] / merged['Close_bench']) * 100.0

ema_5 = rs_raw.ewm(span=5, adjust=False).mean()
ema_14 = rs_raw.ewm(span=14, adjust=False).mean()
ema_125 = rs_raw.ewm(span=125, adjust=False).mean()

# Dhan Exact RRG Definitions:
# Strength Trend: 100 * (EMA_14 / EMA_125)
strength_trend = 100.0 * (ema_14 / ema_125)

# Strength Momentum: 100 * (EMA_14 / EMA_5)
strength_mom = 100.0 * (ema_14 / ema_5)

i = merged.index[merged['date'] == '2026-07-31'][0]

print("=== DHAN BROKER EXACT FORMULA VERIFICATION ===")
print(f"Target on 2026-07-31: Strength Trend = 99.73, Strength Momentum = 100.74")
print(f"Our Formula on 2026-07-31: Strength Trend = {strength_trend.iloc[i]:.2f}, Strength Momentum = {strength_mom.iloc[i]:.2f}")

print("\nLast 5 Days values:")
for idx in range(i-4, i+1):
    print(f"  {merged['date'].iloc[idx]}: Strength Trend = {strength_trend.iloc[idx]:.2f}, Strength Momentum = {strength_mom.iloc[idx]:.2f}")
