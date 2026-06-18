import pandas as pd
import os
from datetime import datetime, timedelta

def main():
    file_path = "menv/../Stocks Daily Historical Data/RELIANCE_Daily_2Y.csv"
    # Adjust path if running from root
    if not os.path.exists(file_path):
        file_path = "Stocks Daily Historical Data/RELIANCE_Daily_2Y.csv"
        
    print(f"Loading data from: {file_path}")
    
    try:
        df = pd.read_csv(file_path)
        df['Datetime'] = pd.to_datetime(df['Datetime'])
        df = df.sort_values('Datetime')
        
        if df.empty:
            print("Error: DataFrame is empty")
            return

        # Latest Data Point
        latest_row = df.iloc[-1]
        latest_date = latest_row['Datetime']
        latest_close = latest_row['Close']
        
        print("\n" + "="*50)
        print(f"ANALYSIS DATE: {latest_date.date()}")
        print(f"LATEST CLOSE : {latest_close}")
        print("="*50)
        
        # Helper to find close price N days ago (calendar days)
        def get_change(label, days_offset):
            target_date = latest_date - timedelta(days=days_offset)
            
            # Find nearest date <= target_date
            # We look for the index where date is closest
            past_data = df[df['Datetime'] <= target_date]
            
            if past_data.empty:
                print(f"{label:10} | {days_offset:3} days ago | No data found before {target_date.date()}")
                return
                
            ref_row = past_data.iloc[-1]
            ref_date = ref_row['Datetime']
            ref_close = ref_row['Close']
            
            # Calculate Change
            change = latest_close - ref_close
            pct_change = (change / ref_close) * 100
            
            print(f"{label:10} | {days_offset:3}d ago | Ref Date: {ref_date.date()} | Ref Close: {ref_close:>8.2f} | Change: {pct_change:>6.2f}%")

        # 1. Daily (Last trading session)
        # For daily, we just take the previous row, not calendar day
        if len(df) > 1:
            prev_row = df.iloc[-2]
            prev_date = prev_row['Datetime']
            prev_close = prev_row['Close']
            change = latest_close - prev_close
            pct_change = (change / prev_close) * 100
            print(f"{'Daily':10} | Prev Sess.| Ref Date: {prev_date.date()} | Ref Close: {prev_close:>8.2f} | Change: {pct_change:>6.2f}%")
        else:
            print("Not enough data for Daily change")

        # 2. Weekly (7 days / 1 week)
        get_change("Weekly", 7)
        
        # 3. Monthly (30 days)
        get_change("Monthly", 30)
        
        # 4. Yearly (365 days)
        get_change("Yearly", 365)
        
        # 5. YTD (Year To Date)
        # Use last trading day of previous year
        current_year = latest_date.year
        last_year_end = datetime(current_year - 1, 12, 31)
        
        ytd_data = df[df['Datetime'] <= last_year_end]
        if not ytd_data.empty:
            ytd_row = ytd_data.iloc[-1]
            ytd_ref_date = ytd_row['Datetime']
            ytd_ref_close = ytd_row['Close']
            
            ytd_change = latest_close - ytd_ref_close
            ytd_pct = (ytd_change / ytd_ref_close) * 100
            print(f"{'YTD':10} | Since Jan 1| Ref Date: {ytd_ref_date.date()} | Ref Close: {ytd_ref_close:>8.2f} | Change: {ytd_pct:>6.2f}%")
        else:
             print("Not enough data for YTD (Previous year end not found)")

        print("-" * 50)
        print("Note: Weekly/Monthly/Yearly lookups find the nearest trading day <= N days ago.")

    except Exception as e:
        print(f"Error calculating stats: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()
