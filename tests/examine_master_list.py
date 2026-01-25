import pandas as pd

# Read the master list
df = pd.read_csv('master_list.csv')

print("Total records:", len(df))
print("\nColumns:", df.columns.tolist())

print("\n" + "="*80)
print("INSTRUMENT Types:")
print("="*80)
print(df['INSTRUMENT'].value_counts())

print("\n" + "="*80)
print("Sample EQUITY records:")
print("="*80)
equity = df[df['INSTRUMENT'] == 'EQUITY'][['SECURITY_ID', 'SYMBOL_NAME', 'EXCH_ID', 'SEGMENT', 'SERIES']].head(5)
print(equity)

print("\n" + "="*80)
print("Sample INDEX records:")
print("="*80)
index = df[df['INSTRUMENT'] == 'INDEX'][['SECURITY_ID', 'SYMBOL_NAME', 'UNDERLYING_SYMBOL', 'EXCH_ID']].head(5)
print(index)

print("\n" + "="*80)
print("Sample OPTIDX records (Options on Index):")
print("="*80)
optidx = df[df['INSTRUMENT'] == 'OPTIDX'][['SECURITY_ID', 'SYMBOL_NAME', 'UNDERLYING_SYMBOL', 'STRIKE_PRICE', 'OPTION_TYPE', 'SM_EXPIRY_DATE']].head(5)
print(optidx)

print("\n" + "="*80)
print("Sample FUTIDX records (Futures on Index):")
print("="*80)
futidx = df[df['INSTRUMENT'] == 'FUTIDX'][['SECURITY_ID', 'SYMBOL_NAME', 'UNDERLYING_SYMBOL', 'SM_EXPIRY_DATE']].head(5)
print(futidx)
