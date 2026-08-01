import pandas as pd
import numpy as np

bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

merged = pd.merge(bank, nifty500, on='date', suffixes=('_bank', '_bench'))
rs_raw = (merged['Close_bank'] / merged['Close_bench']) * 100.0

# RS-Ratio in Ratio method
ema_14 = rs_raw.ewm(span=14, adjust=False).mean()
ema_125 = rs_raw.ewm(span=125, adjust=False).mean()
rs_ratio = 100.0 * (ema_14 / ema_125)

# Standard JdK RS-Momentum: 100 + (RS_Ratio - SMA(RS_Ratio, 14)) / StDev(RS_Ratio, 14)
mean_ratio = rs_ratio.rolling(14).mean()
std_ratio = rs_ratio.rolling(14).std(ddof=1)
rs_mom_jdk = 100.0 + (rs_ratio - mean_ratio) / std_ratio

# ROC version: 100 + (ROC(RS_Ratio, 1) - mean) / std
roc = (rs_ratio - rs_ratio.shift(1))
mean_roc = roc.rolling(14).mean()
std_roc = roc.rolling(14).std(ddof=1)
rs_mom_roc = 100.0 + (roc - mean_roc) / std_roc

i = merged.index[merged['date'] == '2026-07-31'][0]

print(f"Jul 31 RS-Ratio: {rs_ratio.iloc[i]:.2f}")
print(f"Jul 31 JdK Standard Momentum: {rs_mom_jdk.iloc[i]:.2f}")
print(f"Jul 31 JdK ROC Momentum: {rs_mom_roc.iloc[i]:.2f}")

print("\nLast 5 days JdK ROC Momentum:")
for idx in range(i-4, i+1):
    print(f"  {merged['date'].iloc[idx]}: Trend = {rs_ratio.iloc[idx]:.2f}, Mom_ROC = {rs_mom_roc.iloc[idx]:.2f}, Mom_Std = {rs_mom_jdk.iloc[idx]:.2f}")
