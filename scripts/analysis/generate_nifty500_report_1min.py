"""
Script to generate a comprehensive analysis report for NIFTY 500 stocks using 1-Minute Historical Data.
Aggregates 1-min data to Daily Close and applies specific lookback rules.
"""
import pandas as pd
import glob
import os
import warnings
import logging
import pandas_ta as ta
import numpy as np
import math
from datetime import datetime, timedelta

# Suppress warnings
warnings.filterwarnings("ignore")

# Global Cache for Nifty Index
nifty_df = None

def load_nifty_index():
    global nifty_df
    try:
        # Prioritize 5Y daily data (Parquet)
        nifty_path = os.path.join("Historical Data Parquet", "NIFTY_50_Daily_5Y.parquet")
        if not os.path.exists(nifty_path):
             nifty_path = os.path.join("..", "Historical Data Parquet", "NIFTY_50_Daily_5Y.parquet")
             
        if os.path.exists(nifty_path):
            print(f"Loading Benchmark: {nifty_path}")
            df = pd.read_parquet(nifty_path)
            # Parquet preserves types, but ensure Datetime is datetime if not index
            if 'Datetime' in df.columns:
                df['Datetime'] = pd.to_datetime(df['Datetime'])
                df['Date'] = df['Datetime'].dt.normalize()
                df.set_index('Date', inplace=True)
            elif 'Date' in df.columns:
                 df['Date'] = pd.to_datetime(df['Date']).dt.normalize()
                 df.set_index('Date', inplace=True)
                 
            df.sort_index(inplace=True)
            # print(f"Benchmark Loaded. Rows: {len(df)}")
            nifty_df = df
        else:
            print(f"WARNING: Benchmark not found at {nifty_path}")
            nifty_df = pd.DataFrame()
            
    except Exception as e:
        print(f"Error loading benchmark: {e}")
        nifty_df = pd.DataFrame()

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

def calculate_rs_metrics(stock_df):
    """
    Calculates Mansfield Relative Strength and Period Returns.
    
    Args:
        stock_df: Daily aggregated DataFrame with 'Date' and 'Close'
        
    Returns:
        dict: {
            'Mansfield_RS': float,
            'Ret_3M': float,
            'Ret_6M': float,
            'Ret_9M': float, 
            'Ret_12M': float
        }
    """
    metrics = {
        'Mansfield_RS': None,
        'Ret_3M': None,
        'Ret_6M': None,
        'Ret_9M': None,
        'Ret_12M': None
    }
    
    if nifty_df is None or nifty_df.empty:
        # print("DEBUG: nifty_df is None or empty")
        return metrics
    
    if stock_df.empty:
        return metrics
        
    try:
        # Align Data
        # Ensure stock_df has Date index for easier calc
        df = stock_df.copy()
        
        index_col = None
        if 'Date' in df.columns:
            index_col = 'Date'
        elif 'Datetime' in df.columns:
             index_col = 'Datetime'
             
        if index_col:
            df.set_index(index_col, inplace=True)
            
        common_dates = df.index.intersection(nifty_df.index)
        
        if len(common_dates) < 260: # Need ~1 year for proper RS
             pass # Still calculate what we can
             
        # Filter both to common dates
             # print(f"DEBUG: Not enough common dates: {len(common_dates)}")
             pass # Still calculate what we can
             
        # Filter both to common dates
        stock_series = df.loc[common_dates]['Close']
        nifty_series = nifty_df.loc[common_dates]['Close']
        
        # 1. Mansfield RS (Weekly)
        # Resample to weekly (Friday)
        stock_weekly = stock_series.resample('W-FRI').last()
        nifty_weekly = nifty_series.resample('W-FRI').last()
        
        # Re-align weekly
        common_weeks = stock_weekly.index.intersection(nifty_weekly.index)
        stock_weekly = stock_weekly.loc[common_weeks]
        nifty_weekly = nifty_weekly.loc[common_weeks]
        
        if len(stock_weekly) > 52:
            rs_ratio = stock_weekly / nifty_weekly
            sma_52 = rs_ratio.rolling(window=52).mean()
            mansfield = ((rs_ratio / sma_52) - 1) * 10
            metrics['Mansfield_RS'] = round(mansfield.iloc[-1], 2)
            
        # 2. Period Returns (Daily) for RS Rating
        # 3M = 63 days, 6M = 126, 9M = 189, 12M = 252
        if len(stock_series) > 252:
            current = stock_series.iloc[-1]
            try:
                metrics['Ret_3M'] = (current / stock_series.iloc[-63] - 1) * 100
                metrics['Ret_6M'] = (current / stock_series.iloc[-126] - 1) * 100
                metrics['Ret_9M'] = (current / stock_series.iloc[-189] - 1) * 100
                metrics['Ret_12M'] = (current / stock_series.iloc[-252] - 1) * 100
            except:
                pass
                
    except Exception as e:
        # print(f"RS Calc Error: {e}")
        pass
        
    return metrics

def process_stock_1min(file_path):
    try:
        # Read 1-min data (Parquet)
        df = pd.read_parquet(file_path)
        
        if df.empty:
            return None
            
        # Ensure Datetime is a column
        if df.index.name == 'Datetime':
            df = df.reset_index()
        elif 'Datetime' not in df.columns:
            # Check for case variations
            cols_map = {c.lower(): c for c in df.columns}
            if 'datetime' in cols_map:
                df = df.rename(columns={cols_map['datetime']: 'Datetime'})
            else:
                # If still not found, check if index is the datetime
                if pd.api.types.is_datetime64_any_dtype(df.index):
                    df.index.name = 'Datetime'
                    df = df.reset_index()
                else:
                    print(f"      [ERROR] No Datetime found in {file_path}. Columns: {df.columns.tolist()}")
                    return None

        # Ensure datetime type
        if not pd.api.types.is_datetime64_any_dtype(df['Datetime']):
            df['Datetime'] = pd.to_datetime(df['Datetime'])
        
        df = df.sort_values('Datetime')
        
        # Aggregate to Daily
        df['Date'] = df['Datetime'].dt.normalize()
        
        # 1. Standard Aggregation (LTP for Close)
        daily_agg = df.groupby('Date').agg({
            'Close': 'last',
            'High': 'max',
            'Low': 'min',
            'Volume': 'sum'
        }).reset_index()
        
        # 2. VWAP Calculation (Official Close approximation)
        # Filter for last 30 mins: 15:00:00 <= Time <= 15:30:00
        mask_30m = (df['Datetime'].dt.time >= pd.Timestamp("15:00:00").time()) & \
                   (df['Datetime'].dt.time <= pd.Timestamp("15:30:00").time())
        
        df_30m = df[mask_30m].copy()
        
        # Calculate VWAP per day: Sum(Price * Volume) / Sum(Volume)
        if not df_30m.empty:
            df_30m['TPV'] = df_30m['Close'] * df_30m['Volume'] # Typical Price Volume
            
            vwap_agg = df_30m.groupby('Date').agg({
                'TPV': 'sum',
                'Volume': 'sum'
            }).reset_index()
            
            vwap_agg['VWAP_Close'] = vwap_agg['TPV'] / vwap_agg['Volume']
            
            # Merge VWAP into daily_agg
            daily_agg = pd.merge(daily_agg, vwap_agg[['Date', 'VWAP_Close']], on='Date', how='left')
            
            # Use VWAP Close where available, else fallback to 'last' Close
            daily_agg['Close'] = daily_agg['VWAP_Close'].combine_first(daily_agg['Close'])
        
        # --- NEW ANALYSES: VCP, TREND, BREADTH ---
        
        # A. TREND INTENSITY (ADX, EMAs)
        # Need at least 200 days for SMA 200
        if len(daily_agg) > 20: 
            daily_agg['EMA20'] = daily_agg.ta.ema(length=20)
            daily_agg['SMA50'] = daily_agg.ta.sma(length=50)
            daily_agg['SMA200'] = daily_agg.ta.sma(length=200)
            
            # ADX Calculation
            try:
                adx_res = daily_agg.ta.adx(length=14)
                if adx_res is not None:
                    # pandas_ta.adx returns a DataFrame with ADX_14, DMP_14, DMN_14
                    daily_agg['ADX'] = adx_res['ADX_14']
                else:
                    daily_agg['ADX'] = 0
                    
                daily_agg['RSI'] = daily_agg.ta.rsi(length=14)
            except Exception as e:
                # print(f"Indicator Error for stock: {e}")
                daily_agg['ADX'] = 0
                daily_agg['RSI'] = 0
            
            # Perfect Order: EMA20 > SMA50 > SMA200
            last_idx = daily_agg.index[-1]
            prev_idx = daily_agg.index[-2] if len(daily_agg) > 1 else last_idx
            
            c = daily_agg.loc[last_idx, 'Close']
            e20 = daily_agg.loc[last_idx, 'EMA20']
            s50 = daily_agg.loc[last_idx, 'SMA50']
            s200 = daily_agg.loc[last_idx, 'SMA200']
            adx = daily_agg.loc[last_idx, 'ADX']
            rsi = daily_agg.loc[last_idx, 'RSI']
            
            # ADX Rising: Current ADX > Previous ADX
            adx_prev = daily_agg.loc[prev_idx, 'ADX'] if not pd.isna(daily_agg.loc[prev_idx, 'ADX']) else adx
            adx_rising = adx > adx_prev
            
            # User Criteria: Price > EMA20 > SMA50 > SMA200
            perfect_order = (c > e20 > s50 > s200) if not pd.isna(s200) else False
            
            above_20 = c > e20 if not pd.isna(e20) else False
            above_50 = c > s50 if not pd.isna(s50) else False
            above_200 = c > s200 if not pd.isna(s200) else False
            
            trend_intensity = "Strong Up" if (perfect_order and adx > 25) else ("Up" if perfect_order else "Sideways/Down")
            
            # Final "Strong Trend" Flag
            is_strong_trend = (perfect_order and rsi > 50 and adx > 20 and adx_rising)
        else:
            trend_intensity = "N/A"
            adx = 0
            rsi = 0
            above_20 = above_50 = above_200 = False
            s200 = 0
            is_strong_trend = False

        # B. VCP (Volatility Contraction Pattern)
        # Daily Range % = (High - Low) / Close * 100
        daily_agg['RangePct'] = (daily_agg['High'] - daily_agg['Low']) / daily_agg['Close'] * 100
        
        if len(daily_agg) >= 60:
            vol_10 = daily_agg['RangePct'].rolling(10).mean().iloc[-1]
            vol_20 = daily_agg['RangePct'].rolling(20).mean().iloc[-1]
            vol_60 = daily_agg['RangePct'].rolling(60).mean().iloc[-1]
            
            # Is contracting if 10D vol < 20D vol < 60D vol
            is_contracting = (vol_10 < vol_20 < vol_60)
            vcp_score = f"{round(vol_10,1)}% < {round(vol_60,1)}%" if is_contracting else "No"
        else:
            vcp_score = "N/A"
            is_contracting = False
            vol_10 = 0
            
            # Drop temporary columns
            daily_agg.drop(columns=['VWAP_Close'], inplace=True)

        daily_agg.rename(columns={'Date': 'Datetime'}, inplace=True)
        daily_agg = daily_agg.sort_values('Datetime')
        
        stock_name = os.path.basename(file_path).split('_')[0]
        
        # Latest Data
        latest_row = daily_agg.iloc[-1]
        current_close = latest_row['Close']
        latest_date = latest_row['Datetime']
        
        # 1. Daily (Previous Session - 1 Day)
        daily_pct = 0.0
        if len(daily_agg) > 1:
            prev_close = daily_agg.iloc[-2]['Close']
            if prev_close != 0:
                daily_pct = ((current_close - prev_close) / prev_close) * 100
                
        # 2. Weekly (4 Days - User Rule from Daily Script)
        # Note: Daily script had 4 days hardcoded by user edit
        weekly_pct = get_change_pct(daily_agg, latest_row, days_offset=4)
        
        # 3. Monthly (Start of Current Month - User Rule)
        # User updated requirement: "last date below the offset of 30 days"
        monthly_pct = get_change_pct(daily_agg, latest_row, days_offset=30, strict_within_offset=True)
        
        # 4. Yearly (361 Days - User Rule from Daily Script)
        yearly_pct = get_change_pct(daily_agg, latest_row, days_offset=361)
        
        # 5. YTD (Dec 31 of Previous Year - User Rule)
        current_year = latest_date.year
        last_year_end = datetime(current_year - 1, 12, 31)
        ytd_pct = get_change_pct(daily_agg, latest_row, fixed_date=last_year_end)
        
        # 52-Week High/Low (Last 365 Days)
        start_52w = latest_date - timedelta(days=365)
        df_52w = daily_agg[daily_agg['Datetime'] >= start_52w]
        
        if not df_52w.empty:
            high_52w = df_52w['High'].max()
            low_52w = df_52w['Low'].min()
        else:
            high_52w = 0.0
            low_52w = 0.0

        # --- Advanced Metrics ---
        
        # 1. Volatility: NR7
        # Check if today's range is the smallest in the last 7 sessions
        is_nr7 = False
        daily_range = latest_row['High'] - latest_row['Low']
        if len(daily_agg) >= 7:
            last_7 = daily_agg.iloc[-7:].copy()
            last_7['Range'] = last_7['High'] - last_7['Low']
            min_range_7 = last_7['Range'].min()
            # Allow small float diff
            if abs(daily_range - min_range_7) < 0.01:
                is_nr7 = True
                
        # 2. Volume: RVOL (20-day average)
        rvol = 0.0
        avg_vol_20 = 0
        if len(daily_agg) >= 21:
            # Exclude today for average? Usually includes previous days
            # Let's take last 20 days EXCLUDING today for cleaner comparison
            avg_vol_20 = daily_agg.iloc[-21:-1]['Volume'].mean()
            if avg_vol_20 > 0:
                rvol = latest_row['Volume'] / avg_vol_20
                
        # 3. Risk: Drawdown from 52W High
        drawdown_pct = 0.0
        if high_52w > 0:
            drawdown_pct = ((current_close - high_52w) / high_52w) * 100
            
        # 4. Fresh 52W High/Low Flags
        # Check if today's High >= 52W High (calculated generally including today)
        # Note: df_52w includes today. If today is the max, it's a fresh high.
        is_52w_high = (latest_row['High'] >= high_52w)
        is_52w_low = (latest_row['Low'] <= low_52w)

        # Calculate RS Metrics
        rs_data = calculate_rs_metrics(daily_agg)

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
            '52W Low': round(low_52w, 2),
            # Advanced Metrics
            'NR7': is_nr7,
            'RVOL': round(rvol, 2),
            'Drawdown %': round(drawdown_pct, 2),
            'Is_52W_High': is_52w_high,
            'Is_52W_Low': is_52w_low,
            # RS Metrics
            'Mansfield RS': rs_data['Mansfield_RS'],
            'Ret_3M': rs_data['Ret_3M'],
            'Ret_6M': rs_data['Ret_6M'],
            'Ret_9M': rs_data['Ret_9M'],
            'Ret_12M': rs_data['Ret_12M'],
            # Advanced Metrics
            'ADX': round(adx, 2) if not pd.isna(adx) else 0,
            'RSI': round(rsi, 2) if not pd.isna(rsi) else 0,
            'Trend': trend_intensity,
            'VCP': vcp_score,
            'Above 200 EMA': "YES" if above_200 else "no",
            'is_above_20': above_20,
            'is_above_50': above_50,
            'is_above_200': above_200,
            'is_vcp': is_contracting,
            'is_strong_trend': is_strong_trend
        }
        
    except Exception as e:
        print(f"Error processing {file_path}: {e}")
        import traceback
        traceback.print_exc()
        return None

def main():
    # Load Benchmark First
    load_nifty_index()
    
    # Primary directory for 1-min data (Parquet)
    data_dir = "Stocks Historical Data Parquet"
    search_pattern = os.path.join(data_dir, "*_1Min_*.parquet")
    
    # Adjust for running from root or scripts dir
    if not os.path.exists(data_dir):
        # try one up
        data_dir = os.path.join("..", "Stocks Historical Data Parquet")
        search_pattern = os.path.join(data_dir, "*_1Min_*.parquet")
        
    files = glob.glob(search_pattern)
    print(f"Found {len(files)} files in {data_dir}. Processing...")
    
    results = []
    
    for i, f in enumerate(files):
        res = process_stock_1min(f)
        if res:
            results.append(res)
        
        if i % 10 == 0: # Print more frequently as 1-min processing is slower
            print(f"Processed {i}/{len(files)}...")
            
    df_results = pd.DataFrame(results)
    
    if not df_results.empty:
        # Calculate RS Rating (1-99)
        # Weightage: 3M (40%), 6M (20%), 9M (20%), 12M (20%)
        # Note: 9M is ~189 days, 12M is ~252 days
        
        # Ensure columns are numeric
        rs_cols = ['Ret_3M', 'Ret_6M', 'Ret_9M', 'Ret_12M']
        for c in rs_cols:
            df_results[c] = pd.to_numeric(df_results[c], errors='coerce').fillna(-999) # Fill NaNs with low val
            
        df_results['Raw_RS_Score'] = (
            (df_results['Ret_3M'] * 0.4) +
            (df_results['Ret_6M'] * 0.2) +
            (df_results['Ret_9M'] * 0.2) +
            (df_results['Ret_12M'] * 0.2)
        )
        
        # Percentile Rank (0 to 1) -> scaled to 1-99
        df_results['RS Rating'] = df_results['Raw_RS_Score'].rank(pct=True) * 99
        df_results['RS Rating'] = df_results['RS Rating'].round(0).astype('Int64')
        
        # Reorder columns
        cols = [
            'Stock', 'Analysis Date', 'Close', 
            'RS Rating', 'Trend', 'ADX', 'RSI', 'VCP',
            'Above 200 EMA', 'Daily %', '1W %', '1M %', 
            '52W High', '52W Low', 'Drawdown %', 'NR7', 'RVOL',
            'Mansfield RS', '1Y %', 'Is_52W_High'
        ]
        
        # Market Breadth Calculations
        total = len(df_results)
        above_20 = df_results['is_above_20'].sum() if 'is_above_20' in df_results.columns else 0
        above_50 = df_results['is_above_50'].sum() if 'is_above_50' in df_results.columns else 0
        above_200 = df_results['is_above_200'].sum() if 'is_above_200' in df_results.columns else 0
        vcp_count = df_results['is_vcp'].sum() if 'is_vcp' in df_results.columns else 0
        
        breadth_pulse = {
            'Metric': ['Stocks Above 20 DMA', 'Stocks Above 50 DMA', 'Stocks Above 200 DMA', 'VCP Setups'],
            'Count': [above_20, above_50, above_200, vcp_count],
            'Percentage': [f"{round(above_20/total*100, 1)}%" if total > 0 else "0%", 
                           f"{round(above_50/total*100, 1)}%" if total > 0 else "0%", 
                           f"{round(above_200/total*100, 1)}%" if total > 0 else "0%", 
                           f"{round(vcp_count/total*100, 1)}%" if total > 0 else "0%"]
        }
        df_breadth = pd.DataFrame(breadth_pulse)

        # Ensure all columns exist
        for col in cols:
            if col not in df_results.columns:
                df_results[col] = None

        # Create Subsets for Excel Sheets (Do this BEFORE reordering/dropping columns)
        df_highs = df_results[df_results['Is_52W_High'] == True]
        df_lows = df_results[df_results['Is_52W_Low'] == True]
        df_swing = df_results[df_results['NR7'] == True]
        df_vcp = df_results[df_results['is_vcp'] == True]
        df_strong_trends = df_results[df_results['is_strong_trend'] == True]

        # Reorder/Clean All Stocks Sheet
        df_results = df_results[cols]
        
        # Sort by RS Rating Descending (Strongest First)
        df_results.sort_values('RS Rating', ascending=False, inplace=True)
        
        output_file = "Nifty500_Analysis.xlsx"
        try:
            with pd.ExcelWriter(output_file, engine='openpyxl') as writer:
                df_results.to_excel(writer, sheet_name='All Stocks', index=False)
                df_strong_trends[cols].to_excel(writer, sheet_name='Strong Trends', index=False)
                df_highs[cols].to_excel(writer, sheet_name='Fresh 52W Highs', index=False)
                df_lows[cols].to_excel(writer, sheet_name='Fresh 52W Lows', index=False)
                df_swing[cols].to_excel(writer, sheet_name='NR7 & Swing', index=False)
                df_vcp[cols].to_excel(writer, sheet_name='VCP Setups', index=False)
                df_breadth.to_excel(writer, sheet_name='Market Breadth Pulse', index=False)
            print(f"REPORT GENERATED: {output_file}")
            
        except PermissionError:
            output_file = "Nifty500_Analysis_v2.xlsx"
            try:
                with pd.ExcelWriter(output_file, engine='openpyxl') as writer:
                    df_results.to_excel(writer, sheet_name='All Stocks', index=False)
                    df_strong_trends[cols].to_excel(writer, sheet_name='Strong Trends', index=False)
                    df_highs[cols].to_excel(writer, sheet_name='Fresh 52W Highs', index=False)
                    df_lows[cols].to_excel(writer, sheet_name='Fresh 52W Lows', index=False)
                    df_swing[cols].to_excel(writer, sheet_name='NR7 & Swing', index=False)
                    df_vcp[cols].to_excel(writer, sheet_name='VCP Setups', index=False)
                    df_breadth.to_excel(writer, sheet_name='Market Breadth Pulse', index=False)
                print(f"REPORT GENERATED: {output_file} (Original was locked)")
            except Exception as e:
                print(f"Critical Error saving Excel: {e}")
            
        print("\n" + "="*60)
        print(f"Total Stocks: {len(df_results)}")
        print(f"Market Breadth (>200 DMA): {round(above_200/total*100, 1)}%")
        print(f"Strong Trend Stocks: {len(df_strong_trends)}")
        print(f"VCP Contractions Found: {vcp_count}")
        print(f"Fresh 52W Highs: {len(df_highs)}")
        print(f"NR7 Setups: {len(df_swing)}")
        print("="*60)
        
        # Verify Top RS Stocks
        print("\nTop 5 RS Stocks:")
        print(df_results[['Stock', 'Close', 'RS Rating', 'Mansfield RS', 'RVOL']].head(5).to_string(index=False))

        # Verify Reliance
        reliance = df_results[df_results['Stock'] == 'RELIANCE']
        if not reliance.empty:
            print("\nVerification (Reliance):")
            print(reliance[['Stock', 'Close', 'RS Rating', 'Mansfield RS', 'NR7', 'RVOL']].to_string(index=False))
    else:
        print("No results generated.")

if __name__ == "__main__":
    main()
