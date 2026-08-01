import pandas as pd
import numpy as np

bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

merged = pd.merge(bank, nifty500, on='date', suffixes=('_bank', '_bench'))
# Inverted RS: 100 * (Close_bench / Close_bank)
rs_inv = (merged['Close_bench'] / merged['Close_bank']) * 100.0

print("Inverted RS (Nifty 500 / Bank Nifty):")
print(merged[['date', 'Close_bank', 'Close_bench']].assign(rs_inv=rs_inv).tail(6))

ema_14 = rs_inv.ewm(span=14, adjust=False).mean()
ema_125 = rs_inv.ewm(span=125, adjust=False).mean()

# Inverted Strength Trend: 100 * (EMA_14 / EMA_125)
trend_inv = 100.0 * (ema_14 / ema_125)

# Momentum: 100 * (EMA_14 / EMA_5)
ema_5 = rs_inv.ewm(span=5, adjust=False).mean()
mom_inv = 100.0 * (ema_14 / ema_5)

i_28 = merged.index[merged['date'] == '2026-07-28'][0]
i_30 = merged.index[merged['date'] == '2026-07-30'][0]
i_31 = merged.index[merged['date'] == '2026-07-31'][0]

print("\nInverted Formula Values:")
print(f"Jul 28: Trend = {trend_inv.iloc[i_28]:.2f}, Mom = {mom_inv.iloc[i_28]:.2f} (Dhan: Trend = 99.33, Mom = 100.67)")
print(f"Jul 30: Trend = {trend_inv.iloc[i_30]:.2f}, Mom = {mom_inv.iloc[i_30]:.2f} (Dhan: Trend = 99.60, Mom = 100.80)")
print(f"Jul 31: Trend = {trend_inv.iloc[i_31]:.2f}, Mom = {mom_inv.iloc[i_31]:.2f} (Dhan: Trend = 99.73, Mom = 100.74)")
