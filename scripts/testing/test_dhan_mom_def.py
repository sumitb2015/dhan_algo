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

# Strength Trend: 100 * (EMA_14 / EMA_125)
strength_trend = 100.0 * (ema_14 / ema_125)

# Strength Momentum: 100 * (RS_raw / EMA_14)
strength_mom = 100.0 * (rs_raw / ema_14)

print("Dhan RRG exact definitions on last 5 days:")
df_res = pd.DataFrame({
    'date': merged['date'],
    'close_bank': merged['Close_bank'],
    'close_bench': merged['Close_bench'],
    'strength_trend': strength_trend,
    'strength_mom': strength_mom
})

print(df_res.tail(5))
