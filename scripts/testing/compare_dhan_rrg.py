import pandas as pd
import numpy as np

def load_csv(path):
    df = pd.read_csv(path)
    # Normalize date column
    date_col = [c for c in df.columns if c.lower() in ['date', 'datetime']][0]
    close_col = [c for c in df.columns if c.lower() == 'close'][0]
    df['date'] = df[date_col].str.slice(0, 10)
    df['close'] = df[close_col].astype(float)
    return df[['date', 'close']].sort_values('date').reset_index(drop=True)

bank = load_csv('Historical Data/Indices/BANKNIFTY.csv')
nifty50 = load_csv('Historical Data/NIFTY_50_Daily_5Y.csv')
nifty500 = load_csv('Historical Data/NIFTY_500_Daily.csv')

# Merge on date
df_n50 = pd.merge(bank, nifty50, on='date', suffixes=('_bank', '_n50'))
df_n500 = pd.merge(bank, nifty500, on='date', suffixes=('_bank', '_n500'))

print(f"Bank vs Nifty50 dates: {len(df_n50)}, Bank vs Nifty500 dates: {len(df_n500)}")

# ── Formula 1: Z-score RRG (Current Implementation) ──────────────────────
def calc_zscore_rrg(df, stock_col, bench_col, window=14, period=1):
    rs_raw = (df[stock_col] / df[bench_col]) * 100.0
    mean_rs = rs_raw.rolling(window).mean()
    std_rs = rs_raw.rolling(window).std(ddof=1)
    rs_ratio = 100.0 + (rs_raw - mean_rs) / std_rs
    
    rs_roc = (rs_ratio / rs_ratio.shift(period) - 1.0) * 100.0
    mean_roc = rs_roc.rolling(window).mean()
    std_roc = rs_roc.rolling(window).std(ddof=1)
    rs_mom = 100.0 + (rs_roc - mean_roc) / std_roc
    
    res = pd.DataFrame({'date': df['date'], 'rsRatio': rs_ratio, 'rsMomentum': rs_mom})
    return res.dropna()

# ── Formula 2: Optuma / TradingView Ratio RRG ─────────────────────────────
def calc_optuma_ratio_rrg(df, stock_col, bench_col, fast=14, slow=125):
    rs_raw = (df[stock_col] / df[bench_col]) * 100.0
    ema_fast = rs_raw.ewm(span=fast, adjust=False).mean()
    ema_slow = rs_raw.ewm(span=slow, adjust=False).mean()
    
    # RS-Ratio in Optuma / RRG: 100 * (EMA_fast / EMA_slow)
    rs_ratio = 100.0 * (ema_fast / ema_slow)
    
    # RS-Momentum: 100 * (RS_Ratio / EMA(RS_Ratio, fast))
    ema_ratio = rs_ratio.ewm(span=fast, adjust=False).mean()
    rs_mom = 100.0 * (rs_ratio / ema_ratio)
    
    res = pd.DataFrame({'date': df['date'], 'rsRatio': rs_ratio, 'rsMomentum': rs_mom})
    return res.iloc[slow:].reset_index(drop=True)

# ── Formula 3: Simplified Percentage Deviation RRG ────────────────────────
def calc_pct_dev_rrg(df, stock_col, bench_col, window=14):
    rs_raw = (df[stock_col] / df[bench_col]) * 100.0
    ema_rs = rs_raw.ewm(span=window, adjust=False).mean()
    
    # RS-Ratio: 100 * (RS_raw / EMA_rs)
    rs_ratio = 100.0 * (rs_raw / ema_rs)
    
    # RS-Momentum: 100 * (rs_ratio / EMA(rs_ratio, window))
    ema_ratio = rs_ratio.ewm(span=window, adjust=False).mean()
    rs_mom = 100.0 * (rs_ratio / ema_ratio)
    
    res = pd.DataFrame({'date': df['date'], 'rsRatio': rs_ratio, 'rsMomentum': rs_mom})
    return res.iloc[window:].reset_index(drop=True)

print("\n--- 1. Current Z-Score RRG (Benchmark: Nifty 50) ---")
z_n50 = calc_zscore_rrg(df_n50, 'close_bank', 'close_n50')
print(z_n50.tail(5))

print("\n--- 2. Current Z-Score RRG (Benchmark: Nifty 500) ---")
z_n500 = calc_zscore_rrg(df_n500, 'close_bank', 'close_n500')
print(z_n500.tail(5))

print("\n--- 3. Optuma / TradingView Ratio RRG (Benchmark: Nifty 500) ---")
op_n500 = calc_optuma_ratio_rrg(df_n500, 'close_bank', 'close_n500')
print(op_n500.tail(5))

print("\n--- 4. Optuma / TradingView Ratio RRG (Benchmark: Nifty 50) ---")
op_n50 = calc_optuma_ratio_rrg(df_n50, 'close_bank', 'close_n50')
print(op_n50.tail(5))
