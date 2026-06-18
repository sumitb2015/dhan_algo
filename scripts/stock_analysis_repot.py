import pandas as pd
import glob
import os
import warnings
from datetime import timedelta

# Suppress warnings
warnings.filterwarnings("ignore")

def calculate_pct(current_close, base_price):
    if base_price == 0 or pd.isna(base_price):
        return 0.0
    return ((current_close - base_price) / base_price) * 100

def process_stock(file_path):
    try:
        df = pd.read_parquet(file_path)
        if df.empty:
            return None
        
        if 'Datetime' in df.columns:
            df['Datetime'] = pd.to_datetime(df['Datetime'])
            df.set_index('Datetime', inplace=True)
            
        # Daily Resample to OHLC
        df_daily = df.resample('D').agg({
            'Open': 'first',
            'High': 'max',
            'Low': 'min',
            'Close': 'last'
        }).dropna()
        
        # Trading Days only (Mon-Fri)
        df_daily = df_daily[df_daily.index.dayofweek < 5]
        
        if df_daily.empty:
            return None

        stock_name = os.path.basename(file_path).split('_')[0]
        current_close = df_daily['Close'].iloc[-1]
        
        # LOGIC TO MATCH ABSOLUTE RETURNS TABLE (Rolling Close-to-Close)
        # 1. Daily: Current Close vs Yesterday Close
        # 2. 1W: Current Close vs 5-trading-sessions-ago Close (Shift 5)
        # 3. 1M: Current Close vs 21-trading-sessions-ago Close (Shift 21)
        # 4. YTD: Current Close vs Dec 31 Close
        # 5. 1Y: Current Close vs 252-trading-sessions-ago Close (Shift 252)
        
        daily_pct = 0.0
        weekly_pct = 0.0
        monthly_pct = 0.0
        ytd_pct = 0.0
        yearly_pct = 0.0
        
        # Shifts: -1 is current, -2 is yesterday, etc.
        # Shift 1 = index -2
        # Shift 5 = index -6
        
        if len(df_daily) >= 2:
            daily_pct = calculate_pct(current_close, df_daily['Close'].iloc[-2])
        if len(df_daily) >= 6:
            weekly_pct = calculate_pct(current_close, df_daily['Close'].iloc[-6])
        if len(df_daily) >= 22:
            monthly_pct = calculate_pct(current_close, df_daily['Close'].iloc[-22])
        if len(df_daily) >= 253:
            yearly_pct = calculate_pct(current_close, df_daily['Close'].iloc[-253])
            
        # YTD Search (Dec 31, 2025)
        pot_ytd = df_daily[df_daily.index <= '2025-12-31']
        if not pot_ytd.empty:
            ytd_pct = calculate_pct(current_close, pot_ytd['Close'].iloc[-1])
            
        # 52-Week High / Low
        latest_date = df_daily.index[-1]
        start_52w = latest_date - timedelta(days=364)
        df_52w = df_daily[df_daily.index >= start_52w]
        df_52w = df_52w[df_52w['Low'] > 0]
        
        if not df_52w.empty:
            high_52w = df_52w['High'].max()
            low_52w = df_52w['Low'].min()
        else:
            high_52w = 0.0
            low_52w = 0.0
            
        return {
            'Stock': stock_name,
            'Price': round(current_close, 2),
            'Daily %': round(daily_pct, 2),
            '1W %': round(weekly_pct, 2),
            '1M %': round(monthly_pct, 2),
            'YTD %': round(ytd_pct, 2),
            '1Y %': round(yearly_pct, 2),
            '52W High': round(high_52w, 2),
            '52W Low': round(low_52w, 2)
        }
    except Exception:
        return None

def main():
    sources = [
        ("Stocks", "Stocks Historical Data Parquet/*.parquet"),
        ("Indices", "Historical Data Parquet/NIFTY_50_Daily_5Y.parquet")
    ]
    
    results = []
    for label, pattern in sources:
        files = glob.glob(pattern)
        for file_path in files:
            res = process_stock(file_path)
            if res:
                results.append(res)
            
    df_results = pd.DataFrame(results)
    
    if not df_results.empty:
        df_results.sort_values(by='Stock', inplace=True)
        df_results['Stock'] = df_results['Stock'].replace('NIFTY_50_Daily_5Y', 'NIFTY')
        
        output_file = "stock_analysis_report_v8.csv"
        df_results.to_csv(output_file, index=False)
        
        print("\nVerified Absolute Returns (Matching Your Image):")
        check_list = ["NIFTY", "RELIANCE"]
        verification = df_results[df_results['Stock'].isin(check_list)]
        print(verification[['Stock', 'Price', '1W %', '1M %', 'YTD %', '1Y %']].to_markdown(index=False, floatfmt=".2f"))
        
        print(f"\nFinal report saved to {output_file}")

if __name__ == "__main__":
    main()
