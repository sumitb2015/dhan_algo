import pandas as pd
import glob
import os
import sys
import warnings
from datetime import datetime, timedelta

# Suppress warnings
warnings.filterwarnings("ignore")

# Add project root to path so we can import login and lib.dhan_helper
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

try:
    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper
except ImportError:
    get_dhan_client = None
    DhanHelper = None

# NIFTY 50 List of Stocks (as specified by user)
NIFTY50_SYMBOLS = [
    "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK", 
    "BAJAJ-AUTO", "BAJFINANCE", "BAJAJFINSV", "BEL", "BHARTIARTL", 
    "CIPLA", "COALINDIA", "DRREDDY", "EICHERMOT", "ETERNAL", 
    "GRASIM", "HCLTECH", "HDFCBANK", "HDFCLIFE", "HEROMOTOCO", 
    "HINDALCO", "HINDUNILVR", "ICICIBANK", "ITC", "INDUSINDBK", 
    "INFY", "JIOFIN", "KOTAKBANK", "LT", "M&M", 
    "MARUTI", "NESTLEIND", "NTPC", "ONGC", "POWERGRID", 
    "RELIANCE", "SHRIRAMFIN", "SBILIFE", "SBIN", "SUNPHARMA", 
    "TCS", "TATACONSUM", "TMPV", "TMCV", "TATASTEEL", 
    "TECHM", "TITAN", "TRENT", "ULTRACEMCO", "WIPRO"
]

def calculate_pct(current_close, base_price):
    if base_price == 0 or pd.isna(base_price):
        return 0.0
    return ((current_close - base_price) / base_price) * 100

def calculate_rsi(series, period=14):
    if len(series) <= period:
        return None
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    
    avg_gain = gain.ewm(com=period - 1, adjust=False).mean()
    avg_loss = loss.ewm(com=period - 1, adjust=False).mean()
    
    rs = avg_gain / avg_loss.replace(0, 1e-10)
    rsi = 100 - (100 / (1 + rs))
    return rsi.iloc[-1]

def process_stock(file_path):
    try:
        df = pd.read_csv(file_path)
        if df.empty:
            return None
        
        # Rename date columns to standard 'Datetime' safely
        found_col = None
        date_cols = ['date', 'datetime', 'unnamed: 0']
        for col in df.columns:
            if col.strip().lower() in date_cols:
                found_col = col
                break
        if found_col is None:
            for col in df.columns:
                if col.strip().lower() == 'timestamp':
                    found_col = col
                    break
        if found_col and found_col != 'Datetime':
            df.rename(columns={found_col: 'Datetime'}, inplace=True)
            
        if 'Datetime' in df.columns:
            df['Datetime'] = pd.to_datetime(df['Datetime'])
            df.set_index('Datetime', inplace=True)
            
        # Daily Resample to OHLCV
        df_daily = df.resample('D').agg({
            'Open': 'first',
            'High': 'max',
            'Low': 'min',
            'Close': 'last',
            'Volume': 'sum'
        }).dropna()
        
        # Trading Days only (Mon-Fri)
        df_daily = df_daily[df_daily.index.dayofweek < 5]
        
        if df_daily.empty:
            return None

        stock_name = os.path.basename(file_path).split('_')[0]
        current_close = df_daily['Close'].iloc[-1]
        
        # Absolute returns (Rolling Close-to-Close)
        daily_pct = 0.0
        weekly_pct = 0.0
        monthly_pct = 0.0
        ytd_pct = 0.0
        yearly_pct = 0.0
        
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
            
        pct_from_52w_high = ((current_close - high_52w) / high_52w * 100) if high_52w > 0 else 0.0
        pct_from_52w_low = ((current_close - low_52w) / low_52w * 100) if low_52w > 0 else 0.0
        
        # Simple Moving Averages (50 DMA and 200 DMA)
        dma_50 = df_daily['Close'].rolling(window=50).mean().iloc[-1] if len(df_daily) >= 50 else None
        pct_from_50_dma = ((current_close - dma_50) / dma_50 * 100) if dma_50 and dma_50 > 0 else None
        
        dma_200 = df_daily['Close'].rolling(window=200).mean().iloc[-1] if len(df_daily) >= 200 else None
        pct_from_200_dma = ((current_close - dma_200) / dma_200 * 100) if dma_200 and dma_200 > 0 else None
        
        # RSI (14)
        rsi_14 = calculate_rsi(df_daily['Close'], period=14)
        
        # Volume calculations (Current Volume and 20-Day Average Volume)
        curr_vol = df_daily['Volume'].iloc[-1]
        curr_vol_m = curr_vol / 1_000_000
        
        avg_vol_20d = df_daily['Volume'].rolling(window=20).mean().iloc[-1] if len(df_daily) >= 20 else None
        avg_vol_20d_m = (avg_vol_20d / 1_000_000) if avg_vol_20d is not None else None
            
        return {
            'Stock': stock_name,
            'Price': round(current_close, 2),
            'Daily %': round(daily_pct, 2),
            '1W %': round(weekly_pct, 2),
            '1M %': round(monthly_pct, 2),
            'YTD %': round(ytd_pct, 2),
            '1Y %': round(yearly_pct, 2),
            '52W High': round(high_52w, 2),
            '52W Low': round(low_52w, 2),
            '% from 52W High': round(pct_from_52w_high, 2) if pct_from_52w_high is not None else None,
            '% from 52W Low': round(pct_from_52w_low, 2) if pct_from_52w_low is not None else None,
            '50 DMA': round(dma_50, 2) if dma_50 is not None else None,
            '% from 50 DMA': round(pct_from_50_dma, 2) if pct_from_50_dma is not None else None,
            '200 DMA': round(dma_200, 2) if dma_200 is not None else None,
            '% from 200 DMA': round(pct_from_200_dma, 2) if pct_from_200_dma is not None else None,
            'RSI (14)': round(rsi_14, 2) if rsi_14 is not None else None,
            'Curr Vol (M)': round(curr_vol_m, 2) if curr_vol_m is not None else None,
            '20D Avg Vol (M)': round(avg_vol_20d_m, 2) if avg_vol_20d_m is not None else None
        }
    except Exception as e:
        # print(f"Error processing {file_path}: {e}")
        return None

def save_report_to_excel(df_results, output_file_xlsx):
    writer = pd.ExcelWriter(output_file_xlsx, engine='xlsxwriter')
    df_results.to_excel(writer, sheet_name='Stock Analysis', index=False)
    
    workbook  = writer.book
    worksheet = writer.sheets['Stock Analysis']
    
    # Formats
    green_format = workbook.add_format({'bg_color': '#C6EFCE', 'font_color': '#006100'})
    red_format = workbook.add_format({'bg_color': '#FFC7CE', 'font_color': '#9C0006'})
    light_blue_format = workbook.add_format({'bg_color': '#DDEBF7', 'font_color': '#1F497D'})
    
    # Enable autofit column widths
    for i, col in enumerate(df_results.columns):
        val_lens = [len(str(v)) for v in df_results[col].dropna().tolist()]
        max_len = max(max(val_lens) if val_lens else 0, len(col)) + 2
        worksheet.set_column(i, i, max_len)
        
    # Column mapping
    col_indices = {col: df_results.columns.get_loc(col) for col in df_results.columns}
    
    # Apply conditional formatting for return columns: positive is green, negative is red
    pct_cols = ['Daily %', '1W %', '1M %', 'YTD %', '1Y %', '% from 50 DMA', '% from 200 DMA']
    for col in pct_cols:
        if col in col_indices:
            col_idx = col_indices[col]
            worksheet.conditional_format(1, col_idx, len(df_results), col_idx, {
                'type': 'cell',
                'criteria': '>',
                'value': 0,
                'format': green_format
            })
            worksheet.conditional_format(1, col_idx, len(df_results), col_idx, {
                'type': 'cell',
                'criteria': '<',
                'value': 0,
                'format': red_format
            })
            
    # % from 52W High (always <= 0. Color near 0 (e.g. >= -3%) green as potential breakouts)
    if '% from 52W High' in col_indices:
        col_idx = col_indices['% from 52W High']
        worksheet.conditional_format(1, col_idx, len(df_results), col_idx, {
            'type': 'cell',
            'criteria': '>=',
            'value': -3.0,
            'format': green_format
        })
        worksheet.conditional_format(1, col_idx, len(df_results), col_idx, {
            'type': 'cell',
            'criteria': '<=',
            'value': -20.0,
            'format': red_format
        })
        
    # % from 52W Low (always >= 0. Highlight low values close to bottom <= 5% as blue)
    if '% from 52W Low' in col_indices:
        col_idx = col_indices['% from 52W Low']
        worksheet.conditional_format(1, col_idx, len(df_results), col_idx, {
            'type': 'cell',
            'criteria': '<=',
            'value': 5.0,
            'format': light_blue_format
        })
        
    # RSI (14) - RSI < 30 is oversold (Green/Buy), RSI > 70 is overbought (Red/Sell)
    if 'RSI (14)' in col_indices:
        col_idx = col_indices['RSI (14)']
        worksheet.conditional_format(1, col_idx, len(df_results), col_idx, {
            'type': 'cell',
            'criteria': '<=',
            'value': 30.0,
            'format': green_format
        })
        worksheet.conditional_format(1, col_idx, len(df_results), col_idx, {
            'type': 'cell',
            'criteria': '>=',
            'value': 70.0,
            'format': red_format
        })
        
    # Highlight current volume cells in green if volume exceeds 20-day average volume
    if 'Curr Vol (M)' in col_indices and '20D Avg Vol (M)' in col_indices:
        vol_idx = col_indices['Curr Vol (M)']
        avg_vol_idx = col_indices['20D Avg Vol (M)']
        from xlsxwriter.utility import xl_col_to_name
        vol_col_letter = xl_col_to_name(vol_idx)
        avg_vol_col_letter = xl_col_to_name(avg_vol_idx)
        worksheet.conditional_format(1, vol_idx, len(df_results), vol_idx, {
            'type': 'formula',
            'criteria': f'={vol_col_letter}2>{avg_vol_col_letter}2',
            'format': green_format
        })
        
    writer.close()

def ensure_stock_data(symbol, helper=None):
    os.makedirs("Daily_Historical_Data_Fresh", exist_ok=True)
    file_path = os.path.join("Daily_Historical_Data_Fresh", f"{symbol}_Daily_2Y.csv")
    if os.path.exists(file_path):
        return file_path
    
    if helper is None:
        print(f"Warning: Local file not found for {symbol} and Dhan API is not available.")
        return None
        
    print(f"Downloading data for missing stock {symbol} from Dhan API...")
    try:
        sec = helper.get_security_id(symbol=symbol, instrument="EQUITY")
        if not sec:
            print(f"Warning: Symbol {symbol} not found in Dhan Master List")
            return None
            
        security_id = int(sec['SECURITY_ID'])
        to_date = datetime.now().strftime("%Y-%m-%d")
        from_date = (datetime.now() - timedelta(days=int(2 * 365))).strftime("%Y-%m-%d")
        
        df = helper.get_historical_daily_data(
            security_id=security_id,
            exchange_segment="NSE_EQ",
            instrument_type="EQUITY",
            from_date=from_date,
            to_date=to_date
        )
        if df.empty:
            print(f"Warning: No historical data returned for {symbol}")
            return None
            
        # Format the df
        if 'timestamp' in df.columns:
            df['Datetime'] = pd.to_datetime(df['timestamp'], unit='s').dt.tz_localize('UTC').dt.tz_convert('Asia/Kolkata').dt.tz_localize(None)
            df['Datetime'] = df['Datetime'].dt.strftime("%Y-%m-%d")
            
        df.columns = [str(c).capitalize() for c in df.columns]
        cols = ['Datetime', 'Open', 'High', 'Low', 'Close', 'Volume', 'Timestamp']
        df = df[[c for c in cols if c in df.columns]]
        
        df.to_csv(file_path, index=False)
        print(f"Saved {symbol} historical data to {file_path}")
        return file_path
    except Exception as e:
        print(f"Error downloading/saving data for {symbol}: {e}")
        return None

def ensure_index_data(symbol="NIFTY", helper=None):
    os.makedirs("Historical Data", exist_ok=True)
    file_path = os.path.join("Historical Data", "NIFTY_50_Daily_5Y.csv")
    if os.path.exists(file_path):
        return file_path
        
    if helper is None:
        print(f"Warning: Local index file not found and Dhan API is not available.")
        return None
        
    print(f"Downloading index data for {symbol} from Dhan API...")
    try:
        sec = helper.get_security_id(symbol=symbol, instrument="INDEX", exchange="NSE")
        if not sec:
            security_id = 13
            segment = "IDX_I"
            instrument = "INDEX"
        else:
            security_id = int(sec['SECURITY_ID'])
            segment = sec.get('SEGMENT', 'IDX_I')
            instrument = sec.get('INSTRUMENT', 'INDEX')
            
        to_date = datetime.now().strftime("%Y-%m-%d")
        from_date = (datetime.now() - timedelta(days=int(5 * 365))).strftime("%Y-%m-%d")
        
        df = helper.get_historical_daily_data(
            security_id=security_id,
            exchange_segment=segment,
            instrument_type=instrument,
            from_date=from_date,
            to_date=to_date
        )
        if df.empty:
            print(f"Warning: No historical index data returned for {symbol}")
            return None
            
        if 'timestamp' in df.columns:
            df['Datetime'] = pd.to_datetime(df['timestamp'], unit='s').dt.tz_localize('UTC').dt.tz_convert('Asia/Kolkata').dt.tz_localize(None)
            df['Datetime'] = df['Datetime'].dt.strftime("%Y-%m-%d")
            
        df.columns = [str(c).capitalize() for c in df.columns]
        cols = ['Datetime', 'Open', 'High', 'Low', 'Close', 'Volume', 'Timestamp']
        df = df[[c for c in cols if c in df.columns]]
        df.to_csv(file_path, index=False)
        print(f"Saved {symbol} index historical data to {file_path}")
        return file_path
    except Exception as e:
        print(f"Error downloading/saving index data: {e}")
        return None

def main():
    helper = None
    if get_dhan_client is not None and DhanHelper is not None:
        try:
            dhan = get_dhan_client()
            if dhan:
                helper = DhanHelper(dhan)
                print("Dhan Client authenticated successfully.")
        except Exception as e:
            print(f"Could not connect to Dhan client: {e}. Running in offline/local-only mode.")
            
    # Ensure Index data is present
    nifty_path = ensure_index_data("NIFTY", helper)
    
    # Resolve and ensure stock files
    sources = []
    if nifty_path:
        sources.append(nifty_path)
        
    for symbol in NIFTY50_SYMBOLS:
        path = ensure_stock_data(symbol, helper)
        if path:
            sources.append(path)
            
    print(f"\nProcessing {len(sources)} data files...")
    results = []
    for file_path in sources:
        res = process_stock(file_path)
        if res:
            results.append(res)
            
    df_results = pd.DataFrame(results)
    
    if not df_results.empty:
        # Reorder Stock to have NIFTY first, then alphabetized stocks
        df_results['Stock'] = df_results['Stock'].replace('NIFTY_50_Daily_5Y', 'NIFTY')
        
        # Split NIFTY from stocks
        df_nifty = df_results[df_results['Stock'] == 'NIFTY']
        df_stocks = df_results[df_results['Stock'] != 'NIFTY'].sort_values(by='Stock')
        
        # Concatenate back
        df_final = pd.concat([df_nifty, df_stocks])
        
        print("\nVerified Technical and Investment Indicators (NIFTY & RELIANCE):")
        check_list = ["NIFTY", "RELIANCE"]
        verification = df_final[df_final['Stock'].isin(check_list)]
        cols_to_print = [
            'Stock', 'Price', '1W %', 'YTD %', 
            '% from 52W High', '% from 52W Low', 
            '% from 200 DMA', 'RSI (14)', 'Curr Vol (M)', '20D Avg Vol (M)'
        ]
        print(verification[cols_to_print].to_markdown(index=False, floatfmt=".2f"))

        os.makedirs("reports", exist_ok=True)
        output_file_csv = os.path.join("reports", "nifty50_stock_analysis_report_v8.csv")
        try:
            df_final.to_csv(output_file_csv, index=False)
            print(f"\nFinal report saved to {output_file_csv}")
        except PermissionError:
            output_file_csv = os.path.join("reports", "nifty50_stock_analysis_report_v8_backup.csv")
            df_final.to_csv(output_file_csv, index=False)
            print(f"\nWarning: nifty50_stock_analysis_report_v8.csv was locked. Final CSV saved to backup: {output_file_csv}")

        output_file_xlsx = os.path.join("reports", "nifty50_stock_analysis_report_v8.xlsx")
        try:
            save_report_to_excel(df_final, output_file_xlsx)
            print(f"Excel report with conditional formatting saved to {output_file_xlsx}")
        except PermissionError:
            output_file_xlsx = os.path.join("reports", "nifty50_stock_analysis_report_v8_backup.xlsx")
            save_report_to_excel(df_final, output_file_xlsx)
            print(f"Warning: nifty50_stock_analysis_report_v8.xlsx was locked. Excel saved to backup: {output_file_xlsx}")
    else:
        print("No results generated.")

if __name__ == "__main__":
    main()
