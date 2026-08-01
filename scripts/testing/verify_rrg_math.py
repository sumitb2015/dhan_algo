import pandas as pd
import numpy as np

def compute_rrg_sma(aligned_df, window=14, period=1):
    """
    Standard SMA JdK RRG calculation.
    """
    rs_raw = (aligned_df['stockClose'] / aligned_df['indexClose']) * 100.0
    
    # 1. RS-Ratio
    mean_rs = rs_raw.rolling(window).mean()
    std_rs = rs_raw.rolling(window).std(ddof=1)
    rs_ratio = 100.0 + np.where(std_rs == 0, 0, (rs_raw - mean_rs) / std_rs)
    
    # 2. RS-ROC (1-period or period-period ROC of RS-Ratio)
    rs_ratio_s = pd.Series(rs_ratio)
    rs_roc = (rs_ratio_s / rs_ratio_s.shift(period) - 1.0) * 100.0
    
    # 3. RS-Momentum (normalized RS-ROC over window)
    mean_roc = rs_roc.rolling(window).mean()
    std_roc = rs_roc.rolling(window).std(ddof=1)
    rs_momentum = 100.0 + np.where(std_roc == 0, 0, (rs_roc - mean_roc) / std_roc)
    
    df_out = pd.DataFrame({
        'date': aligned_df['date'],
        'rsRatio': rs_ratio,
        'rsMomentum': rs_momentum
    })
    return df_out.dropna()

def compute_rrg_ema_correct(aligned_df, window=14, period=1):
    """
    Corrected Welford/Finch EMA JdK RRG calculation.
    """
    n = len(aligned_df)
    stock = aligned_df['stockClose'].values
    index = aligned_df['indexClose'].values
    rs_raw = (stock / index) * 100.0
    
    alpha = 2.0 / (window + 1.0)
    
    rs_ratio = np.full(n, np.nan)
    mean = rs_raw[0]
    variance = 0.0
    
    for i in range(n):
        val = rs_raw[i]
        delta = val - mean
        mean += alpha * delta
        # Exponential moving variance formula:
        variance = (1.0 - alpha) * (variance + alpha * (delta ** 2))
        std = np.sqrt(max(0.0, variance))
        rs_ratio[i] = 100.0 if std < 1e-8 else 100.0 + delta / std
        
    rs_roc = np.full(n, np.nan)
    for i in range(period, n):
        base = rs_ratio[i - period]
        if not np.isnan(base) and base != 0:
            rs_roc[i] = ((rs_ratio[i] / base) - 1.0) * 100.0
            
    rs_momentum = np.full(n, np.nan)
    valid_idx = period
    mean_roc = rs_roc[valid_idx]
    var_roc = 0.0
    
    for i in range(valid_idx, n):
        val = rs_roc[i]
        delta = val - mean_roc
        mean_roc += alpha * delta
        var_roc = (1.0 - alpha) * (var_roc + alpha * (delta ** 2))
        std = np.sqrt(max(0.0, var_roc))
        rs_momentum[i] = 100.0 if std < 1e-8 else 100.0 + delta / std
        
    df_out = pd.DataFrame({
        'date': aligned_df['date'],
        'rsRatio': rs_ratio,
        'rsMomentum': rs_momentum
    })
    return df_out.iloc[period + 10:].reset_index(drop=True)

if __name__ == '__main__':
    np.random.seed(42)
    dates = pd.date_range('2025-01-01', periods=200).strftime('%Y-%m-%d')
    idx_close = 24000 + np.cumsum(np.random.normal(5, 50, 200))
    stk_close = 1500 + np.cumsum(np.random.normal(1, 10, 200))
    
    df = pd.DataFrame({'date': dates, 'stockClose': stk_close, 'indexClose': idx_close})
    
    sma_res = compute_rrg_sma(df, window=14, period=1)
    ema_res = compute_rrg_ema_correct(df, window=14, period=1)
    
    print("SMA RRG Sample (last 5):")
    print(sma_res.tail())
    print("\nEMA RRG Sample (last 5):")
    print(ema_res.tail())
    
    print(f"\nSMA RS-Ratio mean: {sma_res['rsRatio'].mean():.2f}, std: {sma_res['rsRatio'].std():.2f}")
    print(f"EMA RS-Ratio mean: {ema_res['rsRatio'].mean():.2f}, std: {ema_res['rsRatio'].std():.2f}")
    print(f"SMA RS-Momentum mean: {sma_res['rsMomentum'].mean():.2f}, std: {sma_res['rsMomentum'].std():.2f}")
    print(f"EMA RS-Momentum mean: {ema_res['rsMomentum'].mean():.2f}, std: {ema_res['rsMomentum'].std():.2f}")
