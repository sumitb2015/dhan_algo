import pandas as pd
import glob
import os
from datetime import datetime, timedelta

def compare_methods(stock_symbol_part):
    files = glob.glob(os.path.join("Stocks Historical Data Parquet", f"*{stock_symbol_part}*.parquet"))
    if not files:
        return

    df = pd.read_parquet(files[0])
    df['Datetime'] = pd.to_datetime(df['Datetime'])
    df.set_index('Datetime', inplace=True)
    
    # Create Daily OHLC
    df_daily = df.resample('D').agg({
        'Open': 'first',
        'High': 'max',
        'Low': 'min',
        'Close': 'last',
        'Volume': 'sum'
    }).dropna()
    
    latest_close = df_daily['Close'].iloc[-1]
    latest_date = df_daily.index[-1]
    
    print(f"\n--- {stock_symbol_part} Analysis ({latest_date.date()}, Price: {latest_close}) ---")
    
    # Method 1: Rolling (Shifts)
    # Using approx trading days: W=5, M=21, Y=252
    def get_pct(series, shift):
        if len(series) > shift:
            prev = series.iloc[-(shift+1)]
            return ((series.iloc[-1] - prev) / prev) * 100
        return 0.0

    print("Rolling (Trading Day Shifts):")
    print(f" Daily:   {get_pct(df_daily['Close'], 1):.2f}% (vs prev day)")
    print(f" Weekly:  {get_pct(df_daily['Close'], 5):.2f}% (vs 5 days ago)")
    print(f" Monthly: {get_pct(df_daily['Close'], 21):.2f}% (vs 21 days ago)")
    print(f" Yearly:  {get_pct(df_daily['Close'], 252):.2f}% (vs 252 days ago)")

    # Method 2: Calendar Based
    # Weekly = since start of current week (or prev Fri)
    # Monthly = since start of current month (or prev month-end)
    # Yearly = since start of current year (or prev year-end)
    
    # Previous Year End
    prev_year_end = latest_date - pd.offsets.YearEnd(1)
    # Previous Month End
    prev_month_end = latest_date - pd.offsets.MonthEnd(1)
    # Previous Friday (roughly)
    prev_friday = latest_date - pd.offsets.Week(weekday=4) if latest_date.weekday() != 4 else latest_date - pd.offsets.Week(1)

    def get_val_at(series, target_date):
        # Find the value on or before target_date
        potential = series[series.index <= target_date]
        if not potential.empty:
            return potential.iloc[-1]
        return series.iloc[0]

    val_prev_year = get_val_at(df_daily['Close'], prev_year_end)
    val_prev_month = get_val_at(df_daily['Close'], prev_month_end)
    val_prev_friday = get_val_at(df_daily['Close'], prev_friday)

    print("\nCalendar Based:")
    print(f" Daily:   {get_pct(df_daily['Close'], 1):.2f}%")
    print(f" Weekly (vs {prev_friday.date()}):  {((latest_close - val_prev_friday) / val_prev_friday)*100:.2f}%")
    print(f" Monthly (vs {prev_month_end.date()}): {((latest_close - val_prev_month) / val_prev_month)*100:.2f}%")
    print(f" Yearly (vs {prev_year_end.date()}):  {((latest_close - val_prev_year) / val_prev_year)*100:.2f}%")

    # 52 Week Logic
    # 52 weeks = 364 days
    start_52w = latest_date - timedelta(days=364)
    df_52w = df_daily[df_daily.index >= start_52w]
    
    # Check for outliers in Low
    low_52w = df_52w['Low'].min()
    high_52w = df_52w['High'].max()
    print(f"\n52W High: {high_52w}")
    print(f"52W Low (Daily Lows): {low_52w}")
    
    # Check if any Intraday Low is lower
    df_52w_intra = df[df.index >= start_52w]
    low_intra = df_52w_intra['Low'].min()
    if low_intra < low_52w:
        print(f"52W Low (Intraday): {low_intra} (Found in 1-min data)")
    
    # Look for unusually low values
    low_median = df_52w['Low'].median()
    df_very_low = df_52w_intra[df_52w_intra['Low'] < low_median * 0.5]
    if not df_very_low.empty:
        print(f"WARNING: Found {len(df_very_low)} rows with Low < 50% of median!")
        print(df_very_low[['Low', 'Close']].head())

if __name__ == "__main__":
    stocks = ["YESBANK", "ZEEL", "AXISBANK"]
    for s in stocks:
        compare_methods(s)
