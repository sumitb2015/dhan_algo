import pandas as pd

bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty50 = pd.read_csv('Historical Data/NIFTY_50_Daily_5Y.csv')

bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty50['date'] = nifty50['Datetime'].str.slice(0, 10)

merged = pd.merge(bank, nifty50, on='date', suffixes=('_bank', '_n50'))
merged['rs_n50'] = (merged['Close_bank'] / merged['Close_n50']) * 100.0

print("Bank Nifty vs Nifty 50 Daily Data (Jul 24 - Jul 31):")
print(merged[['date', 'Close_bank', 'Close_n50', 'rs_n50']].tail(8))
