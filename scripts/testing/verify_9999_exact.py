import pandas as pd
import numpy as np

nifty50 = pd.read_csv('Historical Data/NIFTY_50_Daily_5Y.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

nifty50['date'] = nifty50['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

m = pd.merge(nifty50[['date', 'Close']], nifty500[['date', 'Close']], on='date', suffixes=('_stock', '_bench'))
rs = (m['Close_stock'] / m['Close_bench']) * 100.0

# Formula:
# fast_span = 14, slow_span = 28
# RS_Ratio = 100 * (EMA(RS, 14) / EMA(RS, 28))
# RS_Mom = 100 * (RS_Ratio / EMA(RS_Ratio, 14))

fast_alpha = 2 / (14 + 1)
slow_alpha = 2 / (28 + 1)

ema_f = rs.ewm(alpha=fast_alpha, adjust=False).mean()
ema_s = rs.ewm(alpha=slow_alpha, adjust=False).mean()

trend = 100.0 * (ema_f / ema_s)
mom = 100.0 * (trend / trend.ewm(alpha=fast_alpha, adjust=False).mean())

df_res = pd.DataFrame({
    'date': m['date'],
    'Strength Trend': trend,
    'Strength Momentum': mom
})

i_31 = df_res.index[df_res['date'] == '2026-07-31'][0]

print("=== Dhan Ground-Truth Verification for Nifty 50 on Jul 31, 2026 ===")
print("Calculated Values:")
print(f"   Strength Trend    : {trend.iloc[i_31]:.2f}  (Dhan Screenshot: 99.99)")
print(f"   Strength Momentum : {mom.iloc[i_31]:.2f}  (Dhan Screenshot: 100.32)")
