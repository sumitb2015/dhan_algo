import pandas as pd

bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

merged = pd.merge(bank, nifty500, on='date', suffixes=('_bank', '_bench'))
merged['rs_raw'] = (merged['Close_bank'] / merged['Close_bench']) * 100.0

print("Bank Nifty vs Nifty 500 Daily Data (Jul 24 - Jul 31):")
print(merged[['date', 'Close_bank', 'Close_bench', 'rs_raw']].tail(8))
