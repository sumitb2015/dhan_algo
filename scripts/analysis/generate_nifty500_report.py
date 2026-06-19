
"""
Script to generate a comprehensive analysis report for NIFTY 500 stocks.
Calculates Daily, Weekly, Monthly, YTD, and Yearly returns using Calendar-day lookups.
Reads CSV data from "Stocks Daily Historical Data".
"""
import pandas as pd
import glob
import os
import warnings
from datetime import datetime, timedelta

# Suppress warnings
warnings.filterwarnings("ignore")

def get_change_pct(df, latest_row, days_offset=None, fixed_date=None, strict_within_offset=False):
    """
    Calculate percentage change from a past reference date.
    
    Args:
        df: DataFrame with Datetime index
        latest_row: The row corresponding to the latest/current date
        days_offset: Number of days to look back (calendar days)
        fixed_date: Specific datetime to look back to (e.g., Dec 31 for YTD)
        strict_within_offset: If True, finds the oldest date with offset < days_offset
                              (i.e. closest date *within* the period). 
                              Default False (finds newest date with offset >= days_offset).
    """
    latest_close = latest_row['Close']
    target_date = None
    
    if fixed_date:
        target_date = fixed_date
    elif days_offset is not None:
        target_date = latest_row['Datetime'] - timedelta(days=days_offset)
    else:
        return 0.0
        
    # Find reference row
    if strict_within_offset and days_offset is not None:
        # User wants "last date below the offset" -> Date > (Latest - Offset)
        # Sort is ascending, so filtering > target gives [Oldest_Within_Period ... Latest]
        # We take iloc[0] which is the Oldest date strictly within the period (Max Offset < X)
        near_data = df[df['Datetime'] > target_date]
        if near_data.empty:
            return None
        ref_row = near_data.iloc[0]
        
    else:
        # Standard: Last date <= target_date (Min Offset >= X)
        past_data = df[df['Datetime'] <= target_date]
        if past_data.empty:
            return None # Not enough history
        ref_row = past_data.iloc[-1]
    
    ref_close = ref_row['Close']
    
    if ref_close == 0: return 0.0
    
    return ((latest_close - ref_close) / ref_close) * 100

def process_stock(file_path):
    try:
        df = pd.read_csv(file_path)
        if df.empty:
            return None
            
        # Reset index if Datetime is the index
        if df.index.name is not None and df.index.name.capitalize() == 'Datetime':
            df.index.name = 'Datetime'
            df = df.reset_index()
            
        # Standardize all columns to Title Case (e.g. close -> Close)
        df.columns = [str(c).capitalize() for c in df.columns]
            
        if 'Datetime' in df.columns:
            df['Datetime'] = pd.to_datetime(df['Datetime'])
            df = df.sort_values('Datetime')
        else:
            return None
            
        stock_name = os.path.basename(file_path).split('_')[0]
        
        # Latest Data
        latest_row = df.iloc[-1]
        current_close = latest_row['Close']
        latest_date = latest_row['Datetime']
        
        # 1. Daily (Previous Session - 1 Day)
        daily_pct = 0.0
        if len(df) > 1:
            prev_close = df.iloc[-2]['Close']
            if prev_close != 0:
                daily_pct = ((current_close - prev_close) / prev_close) * 100
                
        # 2. Weekly (5 Days - User Rule)
        weekly_pct = get_change_pct(df, latest_row, days_offset=4)
        
        # 3. Monthly (Start of Current Month - User Rule)
        # User updated requirement: "last date below the offset of 30 days"
        monthly_pct = get_change_pct(df, latest_row, days_offset=30, strict_within_offset=True)
        
        # 4. Yearly (362 Days - User Rule)
        yearly_pct = get_change_pct(df, latest_row, days_offset=361)
        
        # 5. YTD (Dec 31 of Previous Year - User Rule)
        current_year = latest_date.year
        last_year_end = datetime(current_year - 1, 12, 31)
        ytd_pct = get_change_pct(df, latest_row, fixed_date=last_year_end)
        
        # 52-Week High/Low (Last 365 Days - Standard)
        start_52w = latest_date - timedelta(days=365)
        df_52w = df[df['Datetime'] >= start_52w]
        
        if not df_52w.empty:
            high_52w = df_52w['High'].max()
            low_52w = df_52w['Low'].min()
        else:
            high_52w = 0.0
            low_52w = 0.0

        return {
            'Stock': stock_name,
            'Analysis Date': latest_date.date(),
            'Close': round(current_close, 2),
            'Daily %': round(daily_pct, 2) if daily_pct is not None else None,
            '1W %': round(weekly_pct, 2) if weekly_pct is not None else None,
            '1M %': round(monthly_pct, 2) if monthly_pct is not None else None,
            'YTD %': round(ytd_pct, 2) if ytd_pct is not None else None,
            '1Y %': round(yearly_pct, 2) if yearly_pct is not None else None,
            '52W High': round(high_52w, 2),
            '52W Low': round(low_52w, 2)
        }
        
    except Exception as e:
        # print(f"Error processing {file_path}: {e}")
        return None

def main():
    data_dir = "Daily_Historical_Data_Fresh"
    search_pattern = os.path.join(data_dir, "*_Daily_2Y.csv")
    
    # Adjust for running from root or scripts dir
    if not os.path.exists(data_dir):
        # try one up
        data_dir = os.path.join("..", "Daily_Historical_Data_Fresh")
        search_pattern = os.path.join(data_dir, "*_Daily_2Y.csv")
        
    files = glob.glob(search_pattern)
    print(f"Found {len(files)} files in {data_dir}. Processing...")
    
    results = []
    for i, f in enumerate(files):
        res = process_stock(f)
        if res:
            results.append(res)
        
        if i % 50 == 0:
            print(f"Processed {i}/{len(files)}...")
            
    df_results = pd.DataFrame(results)
    
    if not df_results.empty:
        # Reorder columns
        cols = ['Stock', 'Analysis Date', 'Close', 'Daily %', '1W %', '1M %', 'YTD %', '1Y %', '52W High', '52W Low']
        df_results = df_results[cols]
        df_results.sort_values('Stock', inplace=True)
        
        os.makedirs("reports", exist_ok=True)
        output_file = os.path.join("reports", "Nifty500_Report_v2.csv")
        try:
            df_results.to_csv(output_file, index=False)
            print(f"REPORT GENERATED: {output_file}")
        except PermissionError:
            output_file = os.path.join("reports", "Nifty500_Report_v3.csv")
            df_results.to_csv(output_file, index=False)
            print(f"REPORT GENERATED: {output_file} (v2 was locked)")
            
        print("\n" + "="*60)
        print(f"Total Stocks: {len(df_results)}")
        print("="*60)
        
        # Verify Reliance
        reliance = df_results[df_results['Stock'] == 'RELIANCE']
        if not reliance.empty:
            print("\nVerification (Reliance):")
            print(reliance.to_string(index=False))
    else:
        print("No results generated.")

if __name__ == "__main__":
    main()
