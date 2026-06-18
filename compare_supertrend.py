import pandas as pd
import numpy as np
import pandas_ta as ta
import os

def UserSupertrend(df, atr_period, multiplier):
    """
    User's provided Supertrend indicator.
    """
    high = df['High']
    low = df['Low']
    close = df['Close']

    # Calculate ATR using ewm like original code
    price_diffs = [high - low, 
                   high - close.shift(), 
                   close.shift() - low]
    true_range = pd.concat(price_diffs, axis=1)
    true_range = true_range.abs().max(axis=1)
    atr = true_range.ewm(alpha=1/atr_period, min_periods=atr_period).mean()

    hl2 = (high + low) / 2
    final_upperband = hl2 + (multiplier * atr)
    final_lowerband = hl2 - (multiplier * atr)

    # Initialize supertrend array with boolean values
    supertrend = [True] * len(df)

    # Copy series to avoid modifying originals if needed, 
    # but user's code modifies final_upperband and final_lowerband directly.
    final_upperband = final_upperband.copy()
    final_lowerband = final_lowerband.copy()

    for i in range(1, len(df.index)):
        curr, prev = i, i - 1

        if close.iloc[curr] > final_upperband.iloc[prev]:
            supertrend[curr] = True
        elif close.iloc[curr] < final_lowerband.iloc[prev]:
            supertrend[curr] = False
        else:
            supertrend[curr] = supertrend[prev]

            if supertrend[curr] == True and final_lowerband.iloc[curr] < final_lowerband.iloc[prev]:
                final_lowerband.iat[curr] = final_lowerband.iat[prev]
            if supertrend[curr] == False and final_upperband.iloc[curr] > final_upperband.iloc[prev]:
                final_upperband.iat[curr] = final_upperband.iat[prev]

        if supertrend[curr] == True:
            final_upperband.iat[curr] = np.nan
        else:
            final_lowerband.iat[curr] = np.nan

    return pd.DataFrame({
        'Supertrend': supertrend,
        'Final_Lowerband': final_lowerband,
        'Final_Upperband': final_upperband
    }, index=df.index)

def ExistingSupertrend(df, period, multiplier):
    """
    Logic from backtest_supertrend_flip.py
    """
    hl2 = (df['High'] + df['Low']) / 2
    atr = df.ta.atr(length=period)
    
    basic_ub = hl2 + (multiplier * atr)
    basic_lb = hl2 - (multiplier * atr)
    
    final_ub = basic_ub.copy()
    final_lb = basic_lb.copy()
    direction = np.zeros(len(df))
    supertrend_val = np.zeros(len(df))
    
    start_idx = period + 1
    
    for i in range(start_idx, len(df)):
        if basic_ub[i] < final_ub[i-1] or df['Close'].iloc[i-1] > final_ub[i-1]:
            final_ub[i] = basic_ub[i]
        else:
            final_ub[i] = final_ub[i-1]
            
        if basic_lb[i] > final_lb[i-1] or df['Close'].iloc[i-1] < final_lb[i-1]:
            final_lb[i] = basic_lb[i]
        else:
            final_lb[i] = final_lb[i-1]
            
        if df['Close'].iloc[i] > final_ub[i-1]:
            direction[i] = 1
        elif df['Close'].iloc[i] < final_lb[i-1]:
            direction[i] = -1
        else:
            direction[i] = direction[i-1]
            if direction[i] == 0: direction[i] = 1
            
        supertrend_val[i] = final_lb[i] if direction[i] == 1 else final_ub[i]
        
    return pd.DataFrame({
        'Supertrend_Val': supertrend_val,
        'Direction': direction
    }, index=df.index)

def main():
    parquet_path = os.path.join("Historical Data Parquet", "NIFTY_50_1Min_5Y.parquet")
    df_all = pd.read_parquet(parquet_path)
    
    # Take a chunk of data for testing (e.g., last 500 rows)
    df = df_all.tail(500).copy().reset_index(drop=True)
    
    period = 10
    multiplier = 2
    
    res_user = UserSupertrend(df, period, multiplier)
    res_existing = ExistingSupertrend(df, period, multiplier)
    
    comparison = pd.DataFrame({
        'Close': df['Close'],
        'User_ST': res_user['Supertrend'],
        'User_Val': np.where(res_user['Supertrend'], res_user['Final_Lowerband'], res_user['Final_Upperband']),
        'Exist_Dir': res_existing['Direction'],
        'Exist_Val': res_existing['Supertrend_Val']
    })
    
    # Check for mismatches
    comparison['Val_Diff'] = comparison['User_Val'] - comparison['Exist_Val']
    comparison['Dir_Match'] = ((comparison['User_ST'] & (comparison['Exist_Dir'] == 1)) | 
                                (~comparison['User_ST'] & (comparison['Exist_Dir'] == -1)))
    
    print("--- Comparison Results (Last 20 rows) ---")
    print(comparison.tail(20))
    
    mismatches = comparison[comparison['Dir_Match'] == False]
    print(f"\nTotal Direction Mismatches: {len(mismatches)}")
    if not mismatches.empty:
        print("First 5 mismatches:")
        print(mismatches.head(5))

    val_mismatches = comparison[abs(comparison['Val_Diff']) > 0.01]
    print(f"Total Value Mismatches (>0.01): {len(val_mismatches)}")

if __name__ == "__main__":
    main()
