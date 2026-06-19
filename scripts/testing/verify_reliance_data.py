"""
Script to verify data discrepancies between 1-minute aggregated data and official daily data for Reliance.
"""
import pandas as pd
import os
import glob
from datetime import datetime, timedelta

def verify_reliance():
    # 1. Define Paths
    # Resolve relative to the project root folder
    script_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    daily_file = os.path.join(script_dir, "Daily_Historical_Data_Fresh", "RELIANCE_Daily_2Y.csv")
    min_file = os.path.join(script_dir, "Stocks Historical Data", "RELIANCE_1Min_5Y.csv")
    
    print(f"Checking files...")
    if not os.path.exists(daily_file):
        print(f"ERROR: Daily file not found at {daily_file}")
        return
    if not os.path.exists(min_file):
        print(f"ERROR: 1-Min file not found at {min_file}")
        return
        
    print(f"Loading 1-min data from {min_file}...")
    # 2. Load and Aggregate 1-Min Data
    df_min = pd.read_csv(min_file)
    df_min['Datetime'] = pd.to_datetime(df_min['Datetime'])
    df_min['Date'] = df_min['Datetime'].dt.date
    
    # Calculate VWAP inputs if Volume exists
    has_volume = 'Volume' in df_min.columns
    
    # Aggregate
    agg_rules = {
        'Close': 'last',
        'High': 'max',
        'Low': 'min',
        'Open': 'first'
    }
    if has_volume:
        agg_rules['Volume'] = 'sum'
        
    print("Aggregating 1-min data to Daily...")
    daily_agg = df_min.groupby('Date').agg(agg_rules).reset_index()
    daily_agg.rename(columns={
        'Close': 'Agg_Close',
        'High': 'Agg_High',
        'Low': 'Agg_Low',
        'Open': 'Agg_Open',
        'Volume': 'Agg_Volume'
    }, inplace=True)
    
    
    # 3. Load Official Daily Data
    print(f"Loading Daily data from {daily_file}...")
    df_daily = pd.read_csv(daily_file)
    if df_daily.index.name == 'Datetime':
        df_daily = df_daily.reset_index()
    df_daily['Datetime'] = pd.to_datetime(df_daily['Datetime'])
    df_daily['Date'] = df_daily['Datetime'].dt.date
    
    # Rename for merge
    df_daily = df_daily[['Date', 'Close']]
    df_daily.rename(columns={'Close': 'Official_Close'}, inplace=True)
    
    # 4. Merge
    print("Merging datasets...")
    merged = pd.merge(daily_agg, df_daily, on='Date', how='inner')
    
    # 5. Calculate Differences
    merged['Diff_Close'] = merged['Official_Close'] - merged['Agg_Close']
    merged['Pct_Diff_Close'] = (merged['Diff_Close'] / merged['Official_Close']) * 100
    
    # 6. Output Analysis
    print("\n" + "="*50)
    print("COMPARISON RESULTS (RELIANCE)")
    print("="*50)
    print(f"Total Overlapping Days: {len(merged)}")
    
    mean_diff = merged['Diff_Close'].abs().mean()
    max_diff = merged['Diff_Close'].abs().max()
    
    # 7. VWAP Verification (The Fix)
    print("\nVerifying VWAP Fix (Last 30 Mins Method)...")
    if has_volume:
        results = []
        # Check last 5 days
        last_dates = sorted(merged['Date'].unique())[-5:]
        
        for d in last_dates:
            day_data = df_min[df_min['Date'] == d]
            
            # Filter 15:00 - 15:30
            mask_30m = (day_data['Datetime'].dt.time >= pd.Timestamp("15:00:00").time()) & \
                       (day_data['Datetime'].dt.time <= pd.Timestamp("15:30:00").time())
            last_30m = day_data[mask_30m]
            
            official = merged[merged['Date'] == d]['Official_Close'].iloc[0]
            ltp_close = merged[merged['Date'] == d]['Agg_Close'].iloc[0] # This is LTP from agg
            
            if not last_30m.empty:
                vwap = (last_30m['Close'] * last_30m['Volume']).sum() / last_30m['Volume'].sum()
                results.append({
                    'Date': d,
                    'Official': official,
                    'LTP_Close': ltp_close,
                    'VWAP_Close': round(vwap, 2),
                    'LTP_Diff': round(official - ltp_close, 2),
                    'VWAP_Diff': round(official - vwap, 2)
                })
        
        print(f"{'Date':<12} {'Official':<10} {'LTP':<10} {'VWAP':<10} {'LTP Diff':<10} {'VWAP Diff':<10}")
        print("-" * 65)
        for r in results:
            print(f"{str(r['Date']):<12} {r['Official']:<10} {r['LTP_Close']:<10} {r['VWAP_Close']:<10} {r['LTP_Diff']:<10} {r['VWAP_Diff']:<10}")

    # Save detailed CSV
    output_file = "Reliance_Comparison_VWAP.csv"
    pd.DataFrame(results).to_csv(output_file, index=False)
    print(f"\nDetailed VWAP report saved to: {output_file}")

if __name__ == "__main__":
    verify_reliance()
