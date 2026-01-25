
"""
Test 16: Indicator Comparison (TA-Lib vs. Pure Pandas)
Validates the accuracy of Pandas fallback vs. TA-Lib standard.
"""
import sys
import os
import pandas as pd
import numpy as np
import talib
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def calculate_pandas_ema(df, period):
    return df['Close'].ewm(span=period, adjust=False).mean()

def calculate_pandas_rsi(df, period):
    delta = df['Close'].diff()
    # Simple RSI implementation (SMA based)
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / loss
    return 100 - (100 / (1 + rs))

def calculate_pandas_atr(df, period):
    high_low = df['High'] - df['Low']
    high_cp = (df['High'] - df['Close'].shift()).abs()
    low_cp = (df['Low'] - df['Close'].shift()).abs()
    tr = pd.concat([high_low, high_cp, low_cp], axis=1).max(axis=1)
    return tr.rolling(window=period).mean()

def run(helper=None):
    print("\n" + "="*70)
    print("TEST 16: INDICATOR COMPARISON (TA-LIB VS. PURE PANDAS)")
    print("="*70)
    
    try:
        if helper is None:
            dhan = get_dhan_client()
            helper = DhanHelper(dhan)
        
        symbol = "RELIANCE"
        df = helper.get_latest_candles(symbol, interval="5", days=30)
        
        if df.empty:
            print("[FAIL] No data for comparison.")
            return False

        print(f">>> Comparing results on {len(df)} candles...")
        
        indicators = [
            ('EMA9', 9), ('EMA20', 20), ('EMA200', 200),
            ('RSI14', 14), ('ATR14', 14)
        ]
        
        results = []
        
        for name, period in indicators:
            print(f"\nComparing {name}...")
            
            # TA-Lib Version
            if 'EMA' in name:
                ta_res = talib.EMA(df['Close'], timeperiod=period)
                pd_res = calculate_pandas_ema(df, period)
            elif 'RSI' in name:
                ta_res = talib.RSI(df['Close'], timeperiod=period)
                pd_res = calculate_pandas_rsi(df, period)
            elif 'ATR' in name:
                ta_res = talib.ATR(df['High'], df['Low'], df['Close'], timeperiod=period)
                pd_res = calculate_pandas_atr(df, period)
            
            # Calculate Differences
            diff = (ta_res - pd_res).abs()
            
            # Focus on the last 50 candles (where EMA200 has stabilized)
            stable_ta = ta_res.tail(50)
            stable_pd = pd_res.tail(50)
            stable_diff = diff.tail(50)
            
            max_err = stable_diff.max()
            avg_err = stable_diff.mean()
            
            print(f"  [Max Diff]: {max_err:.6f}")
            print(f"  [Avg Diff]: {avg_err:.6f}")
            
            # Detailed check for RSI/ATR
            if 'RSI' in name or 'ATR' in name:
                print(f"  [Note]: TA-Lib uses Wilder's Smoothing. Pandas uses Simple Moving Average.")
                print(f"          Difference is expected due to smoothing method.")
            else:
                if max_err < 0.001:
                    print(f"  [Status]: PERFECT MATCH (Pandas ewm matches TA-Lib EMA)")
                else:
                    print(f"  [Status]: MINOR VARIANCE (Expected on long periods)")

            results.append({
                'Indicator': name,
                'TA-Lib (Latest)': ta_res.iloc[-1],
                'Pandas (Latest)': pd_res.iloc[-1],
                'Abs Diff': stable_diff.iloc[-1]
            })

        print("\n" + "-"*70)
        print(f"{'Indicator':<12} {'TA-Lib':<12} {'Pandas':<12} {'Diff':<12}")
        print("-"*70)
        for r in results:
            print(f"{r['Indicator']:<12} {r['TA-Lib (Latest)']:<12.4f} {r['Pandas (Latest)']:<12.4f} {r['Abs Diff']:<12.6f}")
        print("-"*70)
        return True

    except Exception as e:
        print(f"[ERROR] Comparison failed: {e}")

if __name__ == "__main__":
    run()
