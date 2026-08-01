import pandas as pd
import numpy as np

bank = pd.read_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty50 = pd.read_csv('Historical Data/NIFTY_50_Daily_5Y.csv')
nifty500 = pd.read_csv('Historical Data/NIFTY_500_Daily.csv')

bank['date'] = bank['Datetime'].str.slice(0, 10)
nifty50['date'] = nifty50['Datetime'].str.slice(0, 10)
nifty500['date'] = nifty500['Datetime'].str.slice(0, 10)

def test_formula(stock_df, bench_df, name):
    merged = pd.merge(stock_df, bench_df, on='date', suffixes=('_stock', '_bench'))
    
    # Standard Ratio: Stock / Benchmark
    rs_std = (merged['Close_stock'] / merged['Close_bench']) * 100.0
    
    # Standard Dhan/Optuma RRG Formula:
    # RS_Ratio = 100 * (EMA(RS, 14) / EMA(RS, 125))
    # RS_Mom = 100 * (EMA(RS, 14) / EMA(RS, 5)) -- or 100 * (RS_Ratio / EMA(RS_Ratio, 14))
    
    ema_5 = rs_std.ewm(span=5, adjust=False).mean()
    ema_14 = rs_std.ewm(span=14, adjust=False).mean()
    ema_125 = rs_std.ewm(span=125, adjust=False).mean()
    
    # Optuma Trend & Momentum
    trend = 100.0 * (ema_14 / ema_125)
    
    # Test different momentum definitions
    mom1 = 100.0 * (rs_std / ema_14)
    mom2 = 100.0 * (trend / trend.ewm(span=14, adjust=False).mean())
    mom3 = 100.0 * (ema_5 / ema_14)
    
    df_res = pd.DataFrame({
        'date': merged['date'],
        'trend': trend,
        'mom_rs_over_ema14': mom1,
        'mom_trend_over_ema': mom2,
        'mom_ema5_over_ema14': mom3
    })
    return df_res

print("=== NIFTY 50 ===")
df_n50 = test_formula(nifty50, nifty500, "Nifty 50")
print(df_n50.tail(5))

print("\n=== BANK NIFTY ===")
print(test_formula(bank, nifty500, "Bank Nifty").tail(5))
