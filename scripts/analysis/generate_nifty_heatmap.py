import pandas as pd
import glob
import os
import sys
import time
import warnings
from datetime import datetime, timedelta
import xlsxwriter

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

# NIFTY 50 List of Stocks (standardized)
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

def ensure_stock_data(symbol, helper=None, target_latest_date=None):
    os.makedirs("Daily_Historical_Data_Fresh", exist_ok=True)
    file_path = os.path.join("Daily_Historical_Data_Fresh", f"{symbol}_Daily_2Y.csv")
    
    is_fresh = False
    if os.path.exists(file_path):
        if target_latest_date is None:
            is_fresh = True
        else:
            # Check last date in CSV quickly
            last_date = None
            try:
                with open(file_path, 'rb') as f:
                    f.seek(0, 2)
                    size = f.tell()
                    f.seek(max(0, size - 200), 0)
                    lines = f.readlines()
                    if len(lines) >= 2:
                        for line in reversed(lines):
                            line_str = line.decode('utf-8').strip()
                            if line_str:
                                date_str = line_str.split(',')[0]
                                last_date = datetime.strptime(date_str, "%Y-%m-%d").date()
                                break
            except Exception:
                pass
            
            if last_date and last_date >= target_latest_date:
                is_fresh = True
                
    if is_fresh or (os.path.exists(file_path) and helper is None):
        return file_path
        
    action_str = "Updating stale" if os.path.exists(file_path) else "Downloading missing"
    print(f"{action_str} data for {symbol} from Dhan API...")
    try:
        sec = helper.get_security_id(symbol=symbol, instrument="EQUITY")
        if not sec:
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
            if os.path.exists(file_path):
                return file_path
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
        time.sleep(0.15) # friendly sleep to avoid rate limits
        return file_path
    except Exception as e:
        print(f"Error downloading/saving data for {symbol}: {e}")
        if os.path.exists(file_path):
            return file_path
        return None

def ensure_index_data(symbol="NIFTY", helper=None):
    os.makedirs("Historical Data", exist_ok=True)
    file_path = os.path.join("Historical Data", "NIFTY_50_Daily_5Y.csv")
    if os.path.exists(file_path):
        return file_path
        
    if helper is None:
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

def process_daily_returns(file_path, start_date):
    """
    Reads a stock daily CSV file, calculates daily return, and filters for dates >= start_date.
    Returns a pandas Series with Date index and Return values as fractions.
    """
    try:
        df = pd.read_csv(file_path)
        if df.empty:
            return None
            
        # Standardize date column
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
            df['Datetime'] = pd.to_datetime(df['Datetime']).dt.normalize()
            df = df.sort_values('Datetime')
            df = df.drop_duplicates(subset=['Datetime'], keep='last')
        else:
            return None
            
        # Standardize Open/High/Low/Close columns to standard casing
        df.columns = [str(c).capitalize() for c in df.columns]
        
        if 'Close' not in df.columns:
            return None
            
        # Calculate daily percentage returns as fractions
        df['Return'] = df['Close'].pct_change()
        
        # Replace inf with nan
        df['Return'] = df['Return'].replace([float('inf'), float('-inf')], None)
        
        # Set datetime index to filter
        df.set_index('Datetime', inplace=True)
        
        # Filter for the last 1 year window
        df_filtered = df[df.index >= start_date]
        
        if df_filtered.empty:
            return None
            
        # Return Series with string representation of Date index
        series = df_filtered['Return']
        series.index = series.index.strftime('%Y-%m-%d')
        return series
        
    except Exception as e:
        # print(f"Error processing {file_path}: {e}")
        return None

def write_heatmap_sheet(writer, sheet_name, df_final, title):
    workbook = writer.book
    df_final.to_excel(writer, sheet_name=sheet_name, startrow=4, index=False)
    
    worksheet = writer.sheets[sheet_name]
    
    # 1. Title Block Formatting
    title_format = workbook.add_format({
        'bold': True,
        'size': 16,
        'font_color': '#1F4E79',
        'font_name': 'Segoe UI'
    })
    subtitle_format = workbook.add_format({
        'italic': True,
        'size': 10,
        'font_color': '#595959',
        'font_name': 'Segoe UI'
    })
    
    worksheet.write('A2', title, title_format)
    worksheet.write('A3', f"Generated on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | Data Source: Dhan Daily Historical Data (Past 1 Year)", subtitle_format)
    
    # 2. Table Headers Formatting
    header_format = workbook.add_format({
        'bold': True,
        'bg_color': '#1F4E79',
        'font_color': '#FFFFFF',
        'align': 'center',
        'valign': 'vcenter',
        'border': 1,
        'font_name': 'Segoe UI',
        'size': 10
    })
    
    # Stock symbol column header format (left aligned)
    stock_header_format = workbook.add_format({
        'bold': True,
        'bg_color': '#1F4E79',
        'font_color': '#FFFFFF',
        'align': 'left',
        'valign': 'vcenter',
        'border': 1,
        'font_name': 'Segoe UI',
        'size': 10
    })
    
    # Apply header format
    for col_idx, col_name in enumerate(df_final.columns):
        fmt = stock_header_format if col_idx == 0 else header_format
        worksheet.write(4, col_idx, col_name, fmt)
        
    # 3. Freeze Panes: freeze rows 1-5 (index 5) and column A (index 1)
    worksheet.freeze_panes(5, 1)
    
    # 4. Formats for Data Cells
    stock_name_format = workbook.add_format({
        'bold': True,
        'font_name': 'Segoe UI',
        'size': 10,
        'border': 1,
        'bg_color': '#F2F4F4'
    })
    
    # Custom format for percent returns: +0.00%;-0.00%;0.00%
    pct_format = workbook.add_format({
        'num_format': '+0.00%;-0.00%;0.00%',
        'font_name': 'Segoe UI',
        'size': 9,
        'border': 1,
        'align': 'right'
    })
    
    # Format NIFTY row specially to make it stand out
    nifty_stock_format = workbook.add_format({
        'bold': True,
        'font_name': 'Segoe UI',
        'size': 10,
        'border': 1,
        'bg_color': '#DDEBF7' # Soft blue
    })
    nifty_pct_format = workbook.add_format({
        'bold': True,
        'num_format': '+0.00%;-0.00%;0.00%',
        'font_name': 'Segoe UI',
        'size': 9,
        'border': 1,
        'align': 'right',
        'bg_color': '#DDEBF7'
    })
    
    # Apply format to A column (Stock name) and re-format data cells
    num_rows = len(df_final)
    num_cols = len(df_final.columns)
    
    for r_idx in range(num_rows):
        is_nifty = (df_final.iloc[r_idx, 0] == 'NIFTY')
        row_excel_idx = 5 + r_idx  # Data starts at row 6 (index 5)
        
        # Stock symbol column
        symbol_fmt = nifty_stock_format if is_nifty else stock_name_format
        worksheet.write(row_excel_idx, 0, df_final.iloc[r_idx, 0], symbol_fmt)
        
        # Returns columns
        for c_idx in range(1, num_cols):
            val = df_final.iloc[r_idx, c_idx]
            cell_fmt = nifty_pct_format if is_nifty else pct_format
            if pd.isna(val):
                worksheet.write_string(row_excel_idx, c_idx, 'N/A', cell_fmt)
            else:
                worksheet.write_number(row_excel_idx, c_idx, float(val), cell_fmt)
                
    # 5. Column Widths
    worksheet.set_column(0, 0, 15)  # Stock column
    worksheet.set_column(1, num_cols - 1, 11)  # Date columns
    
    # Set row heights
    worksheet.set_row(4, 25)  # Header row height
    for r_idx in range(num_rows):
        worksheet.set_row(5 + r_idx, 18)  # Data row height
        
    # 6. 3-Color Scale Conditional Formatting (applied row-by-row)
    # Soft Red, White, Soft Green
    # We apply this to the data cells (columns 1 to num_cols-1) for each row
    for r_idx in range(num_rows):
        row_excel_idx = 5 + r_idx
        start_cell = xlsxwriter.utility.xl_rowcol_to_cell(row_excel_idx, 1)
        end_cell = xlsxwriter.utility.xl_rowcol_to_cell(row_excel_idx, num_cols - 1)
        
        worksheet.conditional_format(f"{start_cell}:{end_cell}", {
            'type': '3_color_scale',
            'min_value': -0.03, # -3%
            'min_type': 'num',
            'min_color': '#F5B7B1', # Soft red
            'mid_value': 0.0,
            'mid_type': 'num',
            'mid_color': '#FFFFFF', # White
            'max_value': 0.03, # +3%
            'max_type': 'num',
            'max_color': '#A9DFBF'  # Soft green
        })

def calculate_relative_strength_and_beta(df_returns, canonical_dates):
    """
    Calculates Beta, Correlation, Outperformance Days %, Avg Excess Return, Volatility, 
    and 1-Year Cumulative/Excess returns for each stock.
    """
    nifty_row = df_returns[df_returns['Stock'] == 'NIFTY']
    if nifty_row.empty:
        return pd.DataFrame()
        
    nifty_series = pd.to_numeric(nifty_row.iloc[0][canonical_dates], errors='coerce').fillna(0.0)
    nifty_var = nifty_series.var()
    n_cum_ret = (1 + nifty_series).prod() - 1
    
    # Predefined Nifty 50 Sector Mapping
    SECTOR_MAP = {
        "HDFCBANK": "Financial Services", "ICICIBANK": "Financial Services", "AXISBANK": "Financial Services", 
        "SBIN": "Financial Services", "KOTAKBANK": "Financial Services", "INDUSINDBK": "Financial Services", 
        "BAJFINANCE": "Financial Services", "BAJAJFINSV": "Financial Services", "JIOFIN": "Financial Services", 
        "SHRIRAMFIN": "Financial Services", "HDFCLIFE": "Financial Services", "SBILIFE": "Financial Services",
        "TCS": "IT", "INFY": "IT", "HCLTECH": "IT", "TECHM": "IT", "WIPRO": "IT",
        "RELIANCE": "Oil, Gas & Energy", "ONGC": "Oil, Gas & Energy", "COALINDIA": "Oil, Gas & Energy", 
        "NTPC": "Oil, Gas & Energy", "POWERGRID": "Oil, Gas & Energy",
        "M&M": "Automobile", "MARUTI": "Automobile", "BAJAJ-AUTO": "Automobile", 
        "EICHERMOT": "Automobile", "HEROMOTOCO": "Automobile", "TMPV": "Automobile", "TMCV": "Automobile",
        "ITC": "FMCG", "HINDUNILVR": "FMCG", "NESTLEIND": "FMCG", "TATACONSUM": "FMCG",
        "TATASTEEL": "Metals & Mining", "HINDALCO": "Metals & Mining",
        "SUNPHARMA": "Pharma & Healthcare", "CIPLA": "Pharma & Healthcare", 
        "DRREDDY": "Pharma & Healthcare", "APOLLOHOSP": "Pharma & Healthcare",
        "LT": "Infrastructure", "ADANIPORTS": "Infrastructure",
        "ADANIENT": "Diversified",
        "ASIANPAINT": "Consumer Discretionary", "TITAN": "Consumer Discretionary", "TRENT": "Consumer Discretionary", 
        "ULTRACEMCO": "Cement", "GRASIM": "Cement", "BEL": "Capital Goods"
    }
    
    records = []
    stocks_df = df_returns[df_returns['Stock'] != 'NIFTY']
    
    for _, row in stocks_df.iterrows():
        symbol = row['Stock']
        stock_series = pd.to_numeric(row[canonical_dates], errors='coerce').fillna(0.0)
        
        # Cumulative Return
        cum_ret = (1 + stock_series).prod() - 1
        
        # Beta
        cov = stock_series.cov(nifty_series)
        beta = cov / nifty_var if nifty_var > 0 else 1.0
        
        # Correlation
        corr = stock_series.corr(nifty_series)
        if pd.isna(corr):
            corr = 0.0
            
        # Outperformance Days %
        outperform_pct = (stock_series > nifty_series).mean()
        
        # Avg Daily Excess Return
        avg_excess_ret = (stock_series - nifty_series).mean()
        
        # Volatility
        vol = stock_series.std()
        
        # Sector Mapping
        sector = SECTOR_MAP.get(symbol, 'Other')
        
        records.append({
            'Stock': symbol,
            'Sector': sector,
            'Beta': beta,
            'Correlation': corr,
            'Outperformance Days %': outperform_pct,
            'Avg Daily Excess Return': avg_excess_ret,
            'Daily Volatility': vol,
            '1-Year Cumulative Return': cum_ret,
            'Excess Return vs Nifty': cum_ret - n_cum_ret
        })
        
    df_metrics = pd.DataFrame(records)
    if not df_metrics.empty:
        df_metrics = df_metrics.sort_values(by='1-Year Cumulative Return', ascending=False)
        
    return df_metrics

def write_relative_strength_sheet(writer, sheet_name, df_n50_metrics, df_n500_metrics, title):
    workbook = writer.book
    
    # Create the sheet
    worksheet = workbook.add_worksheet(sheet_name)
    writer.sheets[sheet_name] = worksheet
    
    # 1. Title Block Formatting
    title_format = workbook.add_format({
        'bold': True,
        'size': 16,
        'font_color': '#1F4E79',
        'font_name': 'Segoe UI'
    })
    subtitle_format = workbook.add_format({
        'italic': True,
        'size': 10,
        'font_color': '#595959',
        'font_name': 'Segoe UI'
    })
    
    worksheet.write('A2', title, title_format)
    worksheet.write('A3', f"Generated on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | Data Source: Nifty 50 & 500 Daily Stock Returns (Past 1 Year)", subtitle_format)
    
    # 2. Section Headers for Nifty 50 and Nifty 500
    section_format = workbook.add_format({
        'bold': True,
        'size': 12,
        'font_color': '#1F4E79',
        'bg_color': '#DDEBF7',
        'font_name': 'Segoe UI',
        'border': 1
    })
    
    worksheet.merge_range('A5:I5', "NIFTY 50 STOCKS - STRENGTH & BETA RANKING", section_format)
    worksheet.merge_range('K5:S5', "NIFTY 500 STOCKS - STRENGTH & BETA RANKING (TOP PERFORMERS)", section_format)
    
    # 3. Table Headers formatting
    header_format = workbook.add_format({
        'bold': True,
        'bg_color': '#1F4E79',
        'font_color': '#FFFFFF',
        'align': 'center',
        'valign': 'vcenter',
        'border': 1,
        'font_name': 'Segoe UI',
        'size': 9
    })
    
    stock_header_format = workbook.add_format({
        'bold': True,
        'bg_color': '#1F4E79',
        'font_color': '#FFFFFF',
        'align': 'left',
        'valign': 'vcenter',
        'border': 1,
        'font_name': 'Segoe UI',
        'size': 9
    })
    
    # Write Nifty 50 headers
    for col_idx, col_name in enumerate(df_n50_metrics.columns):
        fmt = stock_header_format if col_idx in [0, 1] else header_format
        worksheet.write(5, col_idx, col_name, fmt)
        
    # Write Nifty 500 headers
    for col_idx, col_name in enumerate(df_n500_metrics.columns):
        fmt = stock_header_format if col_idx in [0, 1] else header_format
        worksheet.write(5, 10 + col_idx, col_name, fmt)
        
    # Freeze Panes
    worksheet.freeze_panes(6, 0)
    
    # Data formats
    stock_name_format = workbook.add_format({
        'bold': True,
        'font_name': 'Segoe UI',
        'size': 9,
        'border': 1,
        'bg_color': '#F2F4F4'
    })
    
    text_format = workbook.add_format({
        'font_name': 'Segoe UI',
        'size': 9,
        'border': 1,
        'align': 'left'
    })
    
    num_fmt_2dec = workbook.add_format({
        'num_format': '0.00',
        'font_name': 'Segoe UI',
        'size': 9,
        'border': 1,
        'align': 'right'
    })
    
    num_fmt_pct = workbook.add_format({
        'num_format': '0.0%',
        'font_name': 'Segoe UI',
        'size': 9,
        'border': 1,
        'align': 'right'
    })
    
    num_fmt_pct_signed = workbook.add_format({
        'num_format': '+0.0%;-0.0%;0.0%',
        'font_name': 'Segoe UI',
        'size': 9,
        'border': 1,
        'align': 'right'
    })
    
    # Helper to write table
    def write_table_data(df, start_col):
        for r_idx, row in df.iterrows():
            row_excel_idx = 6 + r_idx
            
            # Stock Symbol
            worksheet.write(row_excel_idx, start_col, row['Stock'], stock_name_format)
            # Sector
            worksheet.write(row_excel_idx, start_col + 1, row['Sector'], text_format)
            # Beta
            worksheet.write(row_excel_idx, start_col + 2, float(row['Beta']), num_fmt_2dec)
            # Correlation
            worksheet.write(row_excel_idx, start_col + 3, float(row['Correlation']), num_fmt_2dec)
            # Outperformance Days %
            worksheet.write(row_excel_idx, start_col + 4, float(row['Outperformance Days %']), num_fmt_pct)
            # Avg Daily Excess
            worksheet.write(row_excel_idx, start_col + 5, float(row['Avg Daily Excess Return']), num_fmt_pct_signed)
            # Volatility
            worksheet.write(row_excel_idx, start_col + 6, float(row['Daily Volatility']), num_fmt_pct)
            # 1-Year Cumulative Return
            worksheet.write(row_excel_idx, start_col + 7, float(row['1-Year Cumulative Return']), num_fmt_pct_signed)
            # Excess Return vs Nifty
            worksheet.write(row_excel_idx, start_col + 8, float(row['Excess Return vs Nifty']), num_fmt_pct_signed)
            
    # Write Nifty 50 data
    df_n50_sorted = df_n50_metrics.reset_index(drop=True)
    write_table_data(df_n50_sorted, 0)
    
    # Write Nifty 500 data
    df_n500_sorted = df_n500_metrics.reset_index(drop=True)
    write_table_data(df_n500_sorted, 10)
    
    # 4. Set Column Widths
    worksheet.set_column(0, 0, 12)  # Symbol
    worksheet.set_column(1, 1, 16)  # Sector
    worksheet.set_column(2, 3, 10)  # Beta, Corr
    worksheet.set_column(4, 4, 15)  # Outperf %
    worksheet.set_column(5, 5, 16)  # Avg Daily Excess
    worksheet.set_column(6, 6, 12)  # Vol
    worksheet.set_column(7, 7, 16)  # 1Y Cum
    worksheet.set_column(8, 8, 16)  # Excess vs Nifty
    
    worksheet.set_column(9, 9, 3)    # Gap column
    
    worksheet.set_column(10, 10, 12)  # Symbol
    worksheet.set_column(11, 11, 16)  # Sector
    worksheet.set_column(12, 13, 10)  # Beta, Corr
    worksheet.set_column(14, 14, 15)  # Outperf %
    worksheet.set_column(15, 15, 16)  # Avg Daily Excess
    worksheet.set_column(16, 16, 12)  # Vol
    worksheet.set_column(17, 17, 16)  # 1Y Cum
    worksheet.set_column(18, 18, 16)  # Excess vs Nifty
    
    # Set Row Heights
    worksheet.set_row(4, 20)  # Section header row
    worksheet.set_row(5, 25)  # Table header row
    for r in range(max(len(df_n50_sorted), len(df_n500_sorted))):
        worksheet.set_row(6 + r, 16)
        
    # 5. Conditional Formatting
    def apply_color_scales(start_row, num_rows, col_offset):
        if num_rows == 0:
            return
            
        cum_col_idx = col_offset + 7
        exc_col_idx = col_offset + 8
        beta_col_idx = col_offset + 2
        
        cum_start = xlsxwriter.utility.xl_rowcol_to_cell(start_row, cum_col_idx)
        cum_end = xlsxwriter.utility.xl_rowcol_to_cell(start_row + num_rows - 1, cum_col_idx)
        
        exc_start = xlsxwriter.utility.xl_rowcol_to_cell(start_row, exc_col_idx)
        exc_end = xlsxwriter.utility.xl_rowcol_to_cell(start_row + num_rows - 1, exc_col_idx)
        
        beta_start = xlsxwriter.utility.xl_rowcol_to_cell(start_row, beta_col_idx)
        beta_end = xlsxwriter.utility.xl_rowcol_to_cell(start_row + num_rows - 1, beta_col_idx)
        
        worksheet.conditional_format(f"{cum_start}:{cum_end}", {
            'type': '3_color_scale',
            'min_value': -0.30,
            'min_type': 'num',
            'min_color': '#F5B7B1',
            'mid_value': 0.0,
            'mid_type': 'num',
            'mid_color': '#FFFFFF',
            'max_value': 0.30,
            'max_type': 'num',
            'max_color': '#A9DFBF'
        })
        
        worksheet.conditional_format(f"{exc_start}:{exc_end}", {
            'type': '3_color_scale',
            'min_value': -0.30,
            'min_type': 'num',
            'min_color': '#F5B7B1',
            'mid_value': 0.0,
            'mid_type': 'num',
            'mid_color': '#FFFFFF',
            'max_value': 0.30,
            'max_type': 'num',
            'max_color': '#A9DFBF'
        })
        
        worksheet.conditional_format(f"{beta_start}:{beta_end}", {
            'type': '3_color_scale',
            'min_value': 0.5,
            'min_type': 'num',
            'min_color': '#DDEBF7',
            'mid_value': 1.0,
            'mid_type': 'num',
            'mid_color': '#FFFFFF',
            'max_value': 1.5,
            'max_type': 'num',
            'max_color': '#FADBD8'
        })
        
    apply_color_scales(6, len(df_n50_sorted), 0)
    apply_color_scales(6, len(df_n500_sorted), 10)

def write_help_sheet(writer, sheet_name="Help"):
    workbook = writer.book
    worksheet = workbook.add_worksheet(sheet_name)
    writer.sheets[sheet_name] = worksheet
    
    # Enable grid lines visible
    worksheet.hide_gridlines(2) # 2 means show visible grid lines
    
    # Formats
    title_format = workbook.add_format({
        'bold': True,
        'size': 16,
        'font_color': '#1F4E79',
        'font_name': 'Segoe UI'
    })
    
    subtitle_format = workbook.add_format({
        'italic': True,
        'size': 10,
        'font_color': '#595959',
        'font_name': 'Segoe UI'
    })
    
    header_format = workbook.add_format({
        'bold': True,
        'bg_color': '#1F4E79',
        'font_color': '#FFFFFF',
        'align': 'left',
        'valign': 'vcenter',
        'border': 1,
        'font_name': 'Segoe UI',
        'size': 10
    })
    
    metric_format = workbook.add_format({
        'bold': True,
        'font_name': 'Segoe UI',
        'size': 9,
        'border': 1,
        'bg_color': '#F2F4F4',
        'valign': 'top',
        'text_wrap': True
    })
    
    text_format = workbook.add_format({
        'font_name': 'Segoe UI',
        'size': 9,
        'border': 1,
        'align': 'left',
        'valign': 'top',
        'text_wrap': True
    })
    
    # Write Title block
    worksheet.write('A2', "METRIC GLOSSARY & REPORT DOCUMENTATION", title_format)
    worksheet.write('A3', "This sheet provides definitions, formulas, and interpretations of the metrics computed in the report.", subtitle_format)
    
    # Write Headers
    headers = ["Metric Name", "Formula / Calculation", "Description", "Typical Range & Interpretation"]
    for col_idx, h in enumerate(headers):
        worksheet.write(5, col_idx, h, header_format)
        
    # Data rows
    help_data = [
        (
            "1-Year Cumulative Return",
            "Product of (1 + R_daily) - 1",
            "The total compounded growth of the stock over the past 1 year.",
            "Indicates absolute long-term performance. E.g., +25% means a ₹100 investment grew to ₹125."
        ),
        (
            "Beta (vs. Nifty)",
            "Cov(R_stock, R_Nifty) / Var(R_Nifty)",
            "Measures the sensitivity/volatility of the stock's returns relative to the Nifty 50 index.",
            "Beta > 1.0: Aggressive (more volatile than market).\nBeta = 1.0: Matches market moves.\nBeta < 1.0: Defensive (less volatile)."
        ),
        (
            "Correlation (vs. Nifty)",
            "Pearson Correlation Coefficient (r)",
            "Measures the strength and direction of the linear relationship between stock and Nifty daily returns.",
            "Range: -1.0 to +1.0.\n+1.0: Moves in lockstep with Nifty.\n0.0: Independent movement.\n-1.0: Moves in exact opposite direction."
        ),
        (
            "Outperformance Days %",
            "Count(R_stock > R_Nifty) / Total Days",
            "The percentage of trading days where the stock's daily return was greater than Nifty's return.",
            "Range: 0% to 100%.\n> 50% indicates that the stock consistently beat the benchmark on a day-to-day basis."
        ),
        (
            "Avg Daily Excess Return",
            "Mean(R_stock - R_Nifty)",
            "The average daily return differential between the stock and Nifty 50.",
            "Positive values indicate daily alpha generation bias. A higher positive number means stronger daily outperformance."
        ),
        (
            "Daily Volatility",
            "Standard Deviation of Daily Returns",
            "Measures the daily dispersion/variance of returns from their average.",
            "Represents stock risk. Higher percentage indicates larger daily price swings and potential options pricing inflation."
        ),
        (
            "Excess Return vs Nifty",
            "Stock 1-Year Cumulative Return - Nifty 1-Year Cumulative Return",
            "The net outperformance of the stock over the benchmark index over the 1-year period.",
            "Positive value: Outperformed Nifty (Alpha).\nNegative value: Underperformed Nifty (Beta-drag)."
        ),
        (
            "Sector Mapping",
            "Predefined lookup mapping table",
            "Maps stock symbols to their respective industry classifications (e.g., Financial Services, IT, FMCG, Metals, Automobile).",
            "Used to aggregate stock returns into sector indices to identify Sector Rotation (capital flowing from one sector to another)."
        )
    ]
    
    # Write Table Data
    for r_idx, row in enumerate(help_data):
        row_excel_idx = 6 + r_idx
        worksheet.write(row_excel_idx, 0, row[0], metric_format)
        worksheet.write(row_excel_idx, 1, row[1], text_format)
        worksheet.write(row_excel_idx, 2, row[2], text_format)
        worksheet.write(row_excel_idx, 3, row[3], text_format)
        
    # Column Widths
    worksheet.set_column(0, 0, 25) # Metric
    worksheet.set_column(1, 1, 35) # Formula
    worksheet.set_column(2, 2, 45) # Description
    worksheet.set_column(3, 3, 50) # Interpretation
    
    # Set Row Heights and formatting
    worksheet.set_row(5, 25) # Header
    for r_idx in range(len(help_data)):
        worksheet.set_row(6 + r_idx, 40) # Allow text wrapping space

def calculate_sector_rotation(df_nifty50_final, df_nifty500_final, canonical_dates):
    """
    Groups stock returns by sector and calculates average daily return.
    """
    # Predefined Nifty 50 Sector Mapping
    SECTOR_MAP = {
        "HDFCBANK": "Financial Services", "ICICIBANK": "Financial Services", "AXISBANK": "Financial Services", 
        "SBIN": "Financial Services", "KOTAKBANK": "Financial Services", "INDUSINDBK": "Financial Services", 
        "BAJFINANCE": "Financial Services", "BAJAJFINSV": "Financial Services", "JIOFIN": "Financial Services", 
        "SHRIRAMFIN": "Financial Services", "HDFCLIFE": "Financial Services", "SBILIFE": "Financial Services",
        "TCS": "IT", "INFY": "IT", "HCLTECH": "IT", "TECHM": "IT", "WIPRO": "IT",
        "RELIANCE": "Oil, Gas & Energy", "ONGC": "Oil, Gas & Energy", "COALINDIA": "Oil, Gas & Energy", 
        "NTPC": "Oil, Gas & Energy", "POWERGRID": "Oil, Gas & Energy",
        "M&M": "Automobile", "MARUTI": "Automobile", "BAJAJ-AUTO": "Automobile", 
        "EICHERMOT": "Automobile", "HEROMOTOCO": "Automobile", "TMPV": "Automobile", "TMCV": "Automobile",
        "ITC": "FMCG", "HINDUNILVR": "FMCG", "NESTLEIND": "FMCG", "TATACONSUM": "FMCG",
        "TATASTEEL": "Metals & Mining", "HINDALCO": "Metals & Mining",
        "SUNPHARMA": "Pharma & Healthcare", "CIPLA": "Pharma & Healthcare", 
        "DRREDDY": "Pharma & Healthcare", "APOLLOHOSP": "Pharma & Healthcare",
        "LT": "Infrastructure", "ADANIPORTS": "Infrastructure",
        "ADANIENT": "Diversified",
        "ASIANPAINT": "Consumer Discretionary", "TITAN": "Consumer Discretionary", "TRENT": "Consumer Discretionary", 
        "ULTRACEMCO": "Cement", "GRASIM": "Cement", "BEL": "Capital Goods"
    }
    
    # Filter out NIFTY index
    stocks_df = df_nifty500_final[df_nifty500_final['Stock'] != 'NIFTY'].copy()
    
    # Map sector
    stocks_df['Sector'] = stocks_df['Stock'].map(SECTOR_MAP).fillna('Other')
    
    # Group by Sector and take mean
    df_sector = stocks_df.groupby('Sector')[canonical_dates].mean()
    
    # Sort sectors alphabetically, keeping 'Other' at the bottom if present
    sectors = sorted([s for s in df_sector.index if s != 'Other'])
    if 'Other' in df_sector.index:
        sectors.append('Other')
        
    df_sector = df_sector.reindex(sectors)
    df_sector = df_sector.reset_index().rename(columns={'Sector': 'Sector'})
    
    return df_sector

def write_sector_rotation_sheet(writer, sheet_name, df_sector, title):
    workbook = writer.book
    df_sector.to_excel(writer, sheet_name=sheet_name, startrow=4, index=False)
    
    worksheet = writer.sheets[sheet_name]
    
    # Enable grid lines visible
    worksheet.hide_gridlines(2)
    
    # 1. Title Block Formatting
    title_format = workbook.add_format({
        'bold': True,
        'size': 16,
        'font_color': '#1F4E79',
        'font_name': 'Segoe UI'
    })
    subtitle_format = workbook.add_format({
        'italic': True,
        'size': 10,
        'font_color': '#595959',
        'font_name': 'Segoe UI'
    })
    
    worksheet.write('A2', title, title_format)
    worksheet.write('A3', f"Generated on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | Data Source: Nifty 500 Daily Returns grouped by Sector (Past 1 Year)", subtitle_format)
    
    # 2. Table Headers Formatting
    header_format = workbook.add_format({
        'bold': True,
        'bg_color': '#1F4E79',
        'font_color': '#FFFFFF',
        'align': 'center',
        'valign': 'vcenter',
        'border': 1,
        'font_name': 'Segoe UI',
        'size': 10
    })
    
    sector_header_format = workbook.add_format({
        'bold': True,
        'bg_color': '#1F4E79',
        'font_color': '#FFFFFF',
        'align': 'left',
        'valign': 'vcenter',
        'border': 1,
        'font_name': 'Segoe UI',
        'size': 10
    })
    
    # Apply header format
    for col_idx, col_name in enumerate(df_sector.columns):
        fmt = sector_header_format if col_idx == 0 else header_format
        worksheet.write(4, col_idx, col_name, fmt)
        
    # Freeze Panes
    worksheet.freeze_panes(5, 1)
    
    # 3. Formats for Data Cells
    sector_name_format = workbook.add_format({
        'bold': True,
        'font_name': 'Segoe UI',
        'size': 10,
        'border': 1,
        'bg_color': '#F2F4F4'
    })
    
    pct_format = workbook.add_format({
        'num_format': '+0.00%;-0.00%;0.00%',
        'font_name': 'Segoe UI',
        'size': 9,
        'border': 1,
        'align': 'right'
    })
    
    # Apply format to A column (Sector name) and re-format data cells
    num_rows = len(df_sector)
    num_cols = len(df_sector.columns)
    
    for r_idx in range(num_rows):
        worksheet.write(5 + r_idx, 0, df_sector.iloc[r_idx, 0], sector_name_format)
        
        for c_idx in range(1, num_cols):
            val = df_sector.iloc[r_idx, c_idx]
            if pd.isna(val):
                worksheet.write_string(5 + r_idx, c_idx, 'N/A', pct_format)
            else:
                worksheet.write_number(5 + r_idx, c_idx, float(val), pct_format)
                
    # 4. Column Widths
    worksheet.set_column(0, 0, 22)  # Sector column
    worksheet.set_column(1, num_cols - 1, 11)  # Date columns
    
    # Set row heights
    worksheet.set_row(4, 25)  # Header row height
    for r_idx in range(num_rows):
        worksheet.set_row(5 + r_idx, 18)  # Data row height
        
    # 5. Global 3-Color Scale Conditional Formatting
    start_cell = xlsxwriter.utility.xl_rowcol_to_cell(5, 1)
    end_cell = xlsxwriter.utility.xl_rowcol_to_cell(5 + num_rows - 1, num_cols - 1)
    
    worksheet.conditional_format(f"{start_cell}:{end_cell}", {
        'type': '3_color_scale',
        'min_value': -0.02, # -2%
        'min_type': 'num',
        'min_color': '#F5B7B1', # Soft red
        'mid_value': 0.0,
        'mid_type': 'num',
        'mid_color': '#FFFFFF', # White
        'max_value': 0.02, # +2%
        'max_type': 'num',
        'max_color': '#A9DFBF'  # Soft green
    })

def calculate_market_breadth(df_n50, df_n500, canonical_dates):
    """
    Calculates daily market breadth metrics for Nifty 50 and Nifty 500.
    Returns a DataFrame with metrics as index and dates as columns.
    """
    breadth_data = {}
    
    # 1. NIFTY Index Return
    nifty_row = df_n50[df_n50['Stock'] == 'NIFTY']
    if not nifty_row.empty:
        n_ret = nifty_row.iloc[0][canonical_dates].values
    else:
        n_ret = [0.0] * len(canonical_dates)
        
    breadth_data['NIFTY Index Return'] = n_ret
    
    # Filter out NIFTY row to get stock returns
    n50_stocks = df_n50[df_n50['Stock'] != 'NIFTY']
    n500_stocks = df_n500[df_n500['Stock'] != 'NIFTY']
    
    n50_advances = []
    n50_declines = []
    n50_adv_pct = []
    n50_ad_ratio = []
    
    n500_advances = []
    n500_declines = []
    n500_adv_pct = []
    n500_ad_ratio = []
    
    n500_strong = [] # >= +2%
    n500_weak = []   # <= -2%
    
    for date in canonical_dates:
        # Nifty 50
        n50_vals = pd.to_numeric(n50_stocks[date], errors='coerce').dropna()
        n50_adv = (n50_vals > 0.0).sum()
        n50_dec = (n50_vals < 0.0).sum()
        n50_tot = len(n50_vals)
        
        n50_advances.append(n50_adv)
        n50_declines.append(n50_dec)
        n50_adv_pct.append(n50_adv / n50_tot if n50_tot > 0 else 0.0)
        n50_ad_ratio.append(n50_adv / n50_dec if n50_dec > 0 else (float(n50_adv) if n50_adv > 0 else 1.0))
        
        # Nifty 500
        n500_vals = pd.to_numeric(n500_stocks[date], errors='coerce').dropna()
        n500_adv = (n500_vals > 0.0).sum()
        n500_dec = (n500_vals < 0.0).sum()
        n500_tot = len(n500_vals)
        
        n500_advances.append(n500_adv)
        n500_declines.append(n500_dec)
        n500_adv_pct.append(n500_adv / n500_tot if n500_tot > 0 else 0.0)
        n500_ad_ratio.append(n500_adv / n500_dec if n500_dec > 0 else (float(n500_adv) if n500_adv > 0 else 1.0))
        
        # Strong and Weak Nifty 500
        n500_strong.append((n500_vals >= 0.02).sum())
        n500_weak.append((n500_vals <= -0.02).sum())
        
    breadth_data['Nifty 50 Advances'] = n50_advances
    breadth_data['Nifty 50 Declines'] = n50_declines
    breadth_data['Nifty 50 Advances %'] = n50_adv_pct
    breadth_data['Nifty 50 A/D Ratio'] = n50_ad_ratio
    
    breadth_data['Nifty 500 Advances'] = n500_advances
    breadth_data['Nifty 500 Declines'] = n500_declines
    breadth_data['Nifty 500 Advances %'] = n500_adv_pct
    breadth_data['Nifty 500 A/D Ratio'] = n500_ad_ratio
    
    breadth_data['Nifty 500 Outperformers (>= +2%)'] = n500_strong
    breadth_data['Nifty 500 Underperformers (<= -2%)'] = n500_weak
    
    # Create DataFrame
    df_breadth = pd.DataFrame(breadth_data, index=canonical_dates).T
    df_breadth = df_breadth.reset_index().rename(columns={'index': 'Metric'})
    
    return df_breadth

def write_breadth_sheet(writer, sheet_name, df_breadth, title):
    workbook = writer.book
    df_breadth.to_excel(writer, sheet_name=sheet_name, startrow=4, index=False)
    
    worksheet = writer.sheets[sheet_name]
    
    # 1. Title Block Formatting
    title_format = workbook.add_format({
        'bold': True,
        'size': 16,
        'font_color': '#1F4E79',
        'font_name': 'Segoe UI'
    })
    subtitle_format = workbook.add_format({
        'italic': True,
        'size': 10,
        'font_color': '#595959',
        'font_name': 'Segoe UI'
    })
    
    worksheet.write('A2', title, title_format)
    worksheet.write('A3', f"Generated on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | Data Source: Nifty 50 & Nifty 500 daily stock returns", subtitle_format)
    
    # 2. Table Headers Formatting
    header_format = workbook.add_format({
        'bold': True,
        'bg_color': '#1F4E79',
        'font_color': '#FFFFFF',
        'align': 'center',
        'valign': 'vcenter',
        'border': 1,
        'font_name': 'Segoe UI',
        'size': 10
    })
    
    metric_header_format = workbook.add_format({
        'bold': True,
        'bg_color': '#1F4E79',
        'font_color': '#FFFFFF',
        'align': 'left',
        'valign': 'vcenter',
        'border': 1,
        'font_name': 'Segoe UI',
        'size': 10
    })
    
    # Apply header format
    for col_idx, col_name in enumerate(df_breadth.columns):
        fmt = metric_header_format if col_idx == 0 else header_format
        worksheet.write(4, col_idx, col_name, fmt)
        
    # Freeze Panes
    worksheet.freeze_panes(5, 1)
    
    # 3. Formats for Data Cells
    metric_name_format = workbook.add_format({
        'bold': True,
        'font_name': 'Segoe UI',
        'size': 10,
        'border': 1,
        'bg_color': '#F2F4F4'
    })
    
    pct_format = workbook.add_format({
        'num_format': '+0.00%;-0.00%;0.00%',
        'font_name': 'Segoe UI',
        'size': 9,
        'border': 1,
        'align': 'right'
    })
    
    ratio_format = workbook.add_format({
        'num_format': '0.00',
        'font_name': 'Segoe UI',
        'size': 9,
        'border': 1,
        'align': 'right'
    })
    
    int_format = workbook.add_format({
        'num_format': '#,##0',
        'font_name': 'Segoe UI',
        'size': 9,
        'border': 1,
        'align': 'right'
    })
    
    # Apply formats to Metric column and data cells
    num_rows = len(df_breadth)
    num_cols = len(df_breadth.columns)
    
    for r_idx in range(num_rows):
        metric_name = df_breadth.iloc[r_idx, 0]
        row_excel_idx = 5 + r_idx
        
        # Write Metric Column
        worksheet.write(row_excel_idx, 0, metric_name, metric_name_format)
        
        # Determine number format
        if 'Return' in metric_name or 'Advances %' in metric_name:
            cell_fmt = pct_format
        elif 'Ratio' in metric_name:
            cell_fmt = ratio_format
        else:
            cell_fmt = int_format
            
        for c_idx in range(1, num_cols):
            val = df_breadth.iloc[r_idx, c_idx]
            if pd.isna(val):
                worksheet.write_string(row_excel_idx, c_idx, 'N/A', cell_fmt)
            else:
                worksheet.write_number(row_excel_idx, c_idx, float(val), cell_fmt)
                
    # 4. Column Widths
    worksheet.set_column(0, 0, 32)  # Metric column width
    worksheet.set_column(1, num_cols - 1, 11)  # Date columns
    
    # Set row heights
    worksheet.set_row(4, 25)  # Header row height
    for r_idx in range(num_rows):
        worksheet.set_row(5 + r_idx, 18)  # Data row height
        
    # 5. Conditional Formatting
    for r_idx in range(num_rows):
        metric_name = df_breadth.iloc[r_idx, 0]
        row_excel_idx = 5 + r_idx
        start_cell = xlsxwriter.utility.xl_rowcol_to_cell(row_excel_idx, 1)
        end_cell = xlsxwriter.utility.xl_rowcol_to_cell(row_excel_idx, num_cols - 1)
        
        if 'Return' in metric_name:
            worksheet.conditional_format(f"{start_cell}:{end_cell}", {
                'type': '3_color_scale',
                'min_value': -0.03,
                'min_type': 'num',
                'min_color': '#F5B7B1',
                'mid_value': 0.0,
                'mid_type': 'num',
                'mid_color': '#FFFFFF',
                'max_value': 0.03,
                'max_type': 'num',
                'max_color': '#A9DFBF'
            })
        elif 'Advances %' in metric_name:
            worksheet.conditional_format(f"{start_cell}:{end_cell}", {
                'type': '3_color_scale',
                'min_value': 0.20,
                'min_type': 'num',
                'min_color': '#F5B7B1',
                'mid_value': 0.50,
                'mid_type': 'num',
                'mid_color': '#FFFFFF',
                'max_value': 0.80,
                'max_type': 'num',
                'max_color': '#A9DFBF'
            })
        elif 'Ratio' in metric_name:
            worksheet.conditional_format(f"{start_cell}:{end_cell}", {
                'type': '3_color_scale',
                'min_value': 0.50,
                'min_type': 'num',
                'min_color': '#F5B7B1',
                'mid_value': 1.0,
                'mid_type': 'num',
                'mid_color': '#FFFFFF',
                'max_value': 2.0,
                'max_type': 'num',
                'max_color': '#A9DFBF'
            })

def get_stock_sma_status(file_path, canonical_dates):
    """
    Calculates SMA 20, 50, 100, 200 for a stock from its full daily CSV file,
    and returns a DataFrame containing boolean indicators (1.0 or 0.0)
    reindexed to match canonical_dates.
    """
    try:
        df = pd.read_csv(file_path)
        if df.empty:
            return None
            
        # Standardize date column
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
            df['Datetime'] = pd.to_datetime(df['Datetime']).dt.normalize()
            df = df.sort_values('Datetime')
            df = df.drop_duplicates(subset=['Datetime'], keep='last')
        else:
            return None
            
        # Standardize Open/High/Low/Close columns
        df.columns = [str(c).capitalize() for c in df.columns]
        if 'Close' not in df.columns:
            return None
            
        # Calculate SMAs
        df['SMA20'] = df['Close'].rolling(window=20).mean()
        df['SMA50'] = df['Close'].rolling(window=50).mean()
        df['SMA100'] = df['Close'].rolling(window=100).mean()
        df['SMA200'] = df['Close'].rolling(window=200).mean()
        
        # Check if Close is above SMA (value 1.0 or 0.0)
        # We explicitly set NaN where SMA is NaN to avoid false comparisons
        import numpy as np
        df['above_20'] = np.where(df['SMA20'].isna(), np.nan, (df['Close'] > df['SMA20']).astype(float))
        df['above_50'] = np.where(df['SMA50'].isna(), np.nan, (df['Close'] > df['SMA50']).astype(float))
        df['above_100'] = np.where(df['SMA100'].isna(), np.nan, (df['Close'] > df['SMA100']).astype(float))
        df['above_200'] = np.where(df['SMA200'].isna(), np.nan, (df['Close'] > df['SMA200']).astype(float))
        
        df.set_index('Datetime', inplace=True)
        df.index = df.index.strftime('%Y-%m-%d')
        
        # Reindex to canonical_dates
        df_filtered = df.reindex(canonical_dates)
        return df_filtered[['above_20', 'above_50', 'above_100', 'above_200']]
    except Exception as e:
        # print(f"Error SMA processing {file_path}: {e}")
        return None

def calculate_sma_breadth(nifty50_paths, nifty500_paths, canonical_dates):
    """
    Calculates percentage of stocks above SMA 20, 50, 100, 200 for Nifty 50 and Nifty 500
    for each date in canonical_dates.
    """
    import numpy as np
    
    # Nifty 50 stocks
    n50_dfs = []
    for symbol, path in nifty50_paths:
        status_df = get_stock_sma_status(path, canonical_dates)
        if status_df is not None:
            n50_dfs.append(status_df)
            
    # Nifty 500 stocks
    n500_dfs = []
    for symbol, path in nifty500_paths:
        status_df = get_stock_sma_status(path, canonical_dates)
        if status_df is not None:
            n500_dfs.append(status_df)
            
    breadth_results = {}
    
    # Calculate daily averages for Nifty 50
    if n50_dfs:
        n50_concat = pd.concat(n50_dfs)
        n50_mean = n50_concat.groupby(level=0).mean()
        n50_mean = n50_mean.reindex(canonical_dates)
        
        breadth_results['Nifty 50 - % Above SMA 20'] = n50_mean['above_20'].values
        breadth_results['Nifty 50 - % Above SMA 50'] = n50_mean['above_50'].values
        breadth_results['Nifty 50 - % Above SMA 100'] = n50_mean['above_100'].values
        breadth_results['Nifty 50 - % Above SMA 200'] = n50_mean['above_200'].values
    else:
        for sma in [20, 50, 100, 200]:
            breadth_results[f'Nifty 50 - % Above SMA {sma}'] = [np.nan] * len(canonical_dates)
            
    # Calculate daily averages for Nifty 500
    if n500_dfs:
        n500_concat = pd.concat(n500_dfs)
        n500_mean = n500_concat.groupby(level=0).mean()
        n500_mean = n500_mean.reindex(canonical_dates)
        
        breadth_results['Nifty 500 - % Above SMA 20'] = n500_mean['above_20'].values
        breadth_results['Nifty 500 - % Above SMA 50'] = n500_mean['above_50'].values
        breadth_results['Nifty 500 - % Above SMA 100'] = n500_mean['above_100'].values
        breadth_results['Nifty 500 - % Above SMA 200'] = n500_mean['above_200'].values
    else:
        for sma in [20, 50, 100, 200]:
            breadth_results[f'Nifty 500 - % Above SMA {sma}'] = [np.nan] * len(canonical_dates)
            
    # Create DataFrame: rows are metrics, columns are dates
    df_sma = pd.DataFrame(breadth_results, index=canonical_dates).T
    df_sma = df_sma.reset_index().rename(columns={'index': 'Metric'})
    
    return df_sma

def write_sma_breadth_sheet(writer, sheet_name, df_sma, title):
    workbook = writer.book
    df_sma.to_excel(writer, sheet_name=sheet_name, startrow=4, index=False)
    
    worksheet = writer.sheets[sheet_name]
    
    # Enable grid lines visible
    worksheet.hide_gridlines(2)
    
    # 1. Title Block Formatting
    title_format = workbook.add_format({
        'bold': True,
        'size': 16,
        'font_color': '#1F4E79',
        'font_name': 'Segoe UI'
    })
    subtitle_format = workbook.add_format({
        'italic': True,
        'size': 10,
        'font_color': '#595959',
        'font_name': 'Segoe UI'
    })
    
    worksheet.write('A2', title, title_format)
    worksheet.write('A3', f"Generated on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | Data Source: Nifty 50 & 500 daily stock price vs SMAs (Past 1 Year)", subtitle_format)
    
    # 2. Table Headers Formatting
    header_format = workbook.add_format({
        'bold': True,
        'bg_color': '#1F4E79',
        'font_color': '#FFFFFF',
        'align': 'center',
        'valign': 'vcenter',
        'border': 1,
        'font_name': 'Segoe UI',
        'size': 10
    })
    
    metric_header_format = workbook.add_format({
        'bold': True,
        'bg_color': '#1F4E79',
        'font_color': '#FFFFFF',
        'align': 'left',
        'valign': 'vcenter',
        'border': 1,
        'font_name': 'Segoe UI',
        'size': 10
    })
    
    # Apply header format
    for col_idx, col_name in enumerate(df_sma.columns):
        fmt = metric_header_format if col_idx == 0 else header_format
        worksheet.write(4, col_idx, col_name, fmt)
        
    # Freeze Panes
    worksheet.freeze_panes(5, 1)
    
    # 3. Formats for Data Cells
    metric_name_format = workbook.add_format({
        'bold': True,
        'font_name': 'Segoe UI',
        'size': 10,
        'border': 1,
        'bg_color': '#F2F4F4'
    })
    
    # Format for percent breadth: 0.0%
    pct_format = workbook.add_format({
        'num_format': '0.0%',
        'font_name': 'Segoe UI',
        'size': 9,
        'border': 1,
        'align': 'right'
    })
    
    num_rows = len(df_sma)
    num_cols = len(df_sma.columns)
    
    for r_idx in range(num_rows):
        metric_name = df_sma.iloc[r_idx, 0]
        row_excel_idx = 5 + r_idx
        
        # Write Metric Column
        worksheet.write(row_excel_idx, 0, metric_name, metric_name_format)
        
        # Write Percentage Columns
        for c_idx in range(1, num_cols):
            val = df_sma.iloc[r_idx, c_idx]
            if pd.isna(val):
                worksheet.write_string(row_excel_idx, c_idx, 'N/A', pct_format)
            else:
                worksheet.write_number(row_excel_idx, c_idx, float(val), pct_format)
                
    # 4. Column Widths and Row Heights
    worksheet.set_column(0, 0, 32)  # Metric column width
    worksheet.set_column(1, num_cols - 1, 11)  # Date columns
    
    worksheet.set_row(4, 25)  # Header row height
    for r_idx in range(num_rows):
        worksheet.set_row(5 + r_idx, 18)  # Data row height
        
    # 5. 3-Color Scale Conditional Formatting
    # Apply 3-color scale to all percentage rows: Soft Red (20%), White (50%), Soft Green (80%)
    for r_idx in range(num_rows):
        row_excel_idx = 5 + r_idx
        start_cell = xlsxwriter.utility.xl_rowcol_to_cell(row_excel_idx, 1)
        end_cell = xlsxwriter.utility.xl_rowcol_to_cell(row_excel_idx, num_cols - 1)
        
        worksheet.conditional_format(f"{start_cell}:{end_cell}", {
            'type': '3_color_scale',
            'min_value': 0.20,
            'min_type': 'num',
            'min_color': '#F5B7B1', # Soft red
            'mid_value': 0.50,
            'mid_type': 'num',
            'mid_color': '#FFFFFF', # White
            'max_value': 0.80,
            'max_type': 'num',
            'max_color': '#A9DFBF'  # Soft green
        })

def main():
    print("="*60)
    print("NIFTY DAILY RETURNS HEATMAP GENERATOR")
    print("="*60)
    
    helper = None
    if get_dhan_client is not None and DhanHelper is not None:
        try:
            dhan = get_dhan_client()
            if dhan:
                helper = DhanHelper(dhan)
                print("[SUCCESS] Dhan Client authenticated successfully.")
        except Exception as e:
            print(f"[INFO] Could not connect to Dhan client: {e}. Running in local-only mode.")
            
    # Ensure Index data is present
    nifty_path = ensure_index_data("NIFTY", helper)
    if not nifty_path:
        print("[CRITICAL] Historical index data file not found and Dhan API is not available.")
        sys.exit(1)
        
    # Load NIFTY index data to compute dynamic 1-year window
    try:
        df_n_raw = pd.read_csv(nifty_path)
        found_col = None
        date_cols = ['date', 'datetime', 'unnamed: 0']
        for col in df_n_raw.columns:
            if col.strip().lower() in date_cols:
                found_col = col
                break
        if found_col is None:
            for col in df_n_raw.columns:
                if col.strip().lower() == 'timestamp':
                    found_col = col
                    break
        if found_col:
            df_n_raw.rename(columns={found_col: 'Datetime'}, inplace=True)
            
        df_n_raw['Datetime'] = pd.to_datetime(df_n_raw['Datetime']).dt.normalize()
        df_n_raw = df_n_raw.sort_values('Datetime')
        df_n_raw = df_n_raw.drop_duplicates(subset=['Datetime'], keep='last')
        latest_date = df_n_raw['Datetime'].max()
        start_date = latest_date - timedelta(days=365)
        
        print(f"Data Date Range: {start_date.strftime('%Y-%m-%d')} to {latest_date.strftime('%Y-%m-%d')} (Past 1 Year)")
        
        # Get canonical dates from NIFTY index trading dates in this 1-year window
        df_n_filtered = df_n_raw[df_n_raw['Datetime'] >= start_date]
        canonical_dates = sorted(df_n_filtered['Datetime'].dt.strftime('%Y-%m-%d').unique())
        print(f"Total Trading Days in past 1 year: {len(canonical_dates)}")
        
    except Exception as e:
        print(f"[CRITICAL] Error parsing index data: {e}")
        sys.exit(1)
        
    # Process NIFTY index returns
    nifty_returns = process_daily_returns(nifty_path, start_date)
    if nifty_returns is not None:
        nifty_returns = nifty_returns.reindex(canonical_dates)
        
    # Ensure Nifty 50 stocks
    print("\nVerifying Nifty 50 Stock Files...")
    nifty50_paths = []
    for symbol in NIFTY50_SYMBOLS:
        path = ensure_stock_data(symbol, helper, target_latest_date=latest_date.date())
        if path:
            nifty50_paths.append((symbol, path))
            
    print(f"Found {len(nifty50_paths)}/50 Nifty 50 stocks locally.")
    
    # Process Nifty 50
    print("\nProcessing returns for Nifty 50...")
    nifty50_data = {}
    if nifty_returns is not None:
        nifty50_data['NIFTY'] = nifty_returns
        
    for symbol, path in nifty50_paths:
        ret = process_daily_returns(path, start_date)
        if ret is not None:
            nifty50_data[symbol] = ret.reindex(canonical_dates)
            
    df_nifty50_pivot = pd.DataFrame(nifty50_data).T
    
    # Make sure columns are exactly the canonical dates
    df_nifty50_pivot = df_nifty50_pivot.reindex(columns=canonical_dates)
    
    # Reorder to have NIFTY at the top and others alphabetically
    if 'NIFTY' in df_nifty50_pivot.index:
        df_n50_nifty = df_nifty50_pivot.loc[['NIFTY']]
        df_n50_stocks = df_nifty50_pivot.drop(index='NIFTY').sort_index()
        df_nifty50_final = pd.concat([df_n50_nifty, df_n50_stocks])
    else:
        df_nifty50_final = df_nifty50_pivot.sort_index()
        
    df_nifty50_final = df_nifty50_final.reset_index().rename(columns={'index': 'Stock'})
    
    # Process Nifty 500
    print("\nProcessing returns for Nifty 500...")
    nifty500_data = {}
    if nifty_returns is not None:
        nifty500_data['NIFTY'] = nifty_returns
        
    all_stock_files = glob.glob("Daily_Historical_Data_Fresh/*_Daily_2Y.csv")
    print(f"Verifying and scanning {len(all_stock_files)} historical stock data files...")
    
    nifty500_symbols = []
    for path in all_stock_files:
        symbol = os.path.basename(path).split('_')[0]
        if symbol != 'NIFTY':
            nifty500_symbols.append(symbol)
            
    nifty500_paths = []
    for i, symbol in enumerate(nifty500_symbols):
        path = ensure_stock_data(symbol, helper, target_latest_date=latest_date.date())
        if path:
            nifty500_paths.append((symbol, path))
        if i % 100 == 0 and i > 0:
            print(f"Verified {i}/{len(nifty500_symbols)} stocks...")
            
    for symbol, path in nifty500_paths:
        ret = process_daily_returns(path, start_date)
        if ret is not None:
            nifty500_data[symbol] = ret.reindex(canonical_dates)
            
    df_nifty500_pivot = pd.DataFrame(nifty500_data).T
    df_nifty500_pivot = df_nifty500_pivot.reindex(columns=canonical_dates)
    
    if 'NIFTY' in df_nifty500_pivot.index:
        df_n500_nifty = df_nifty500_pivot.loc[['NIFTY']]
        df_n500_stocks = df_nifty500_pivot.drop(index='NIFTY').sort_index()
        df_nifty500_final = pd.concat([df_n500_nifty, df_n500_stocks])
    else:
        df_nifty500_final = df_nifty500_pivot.sort_index()
        
    df_nifty500_final = df_nifty500_final.reset_index().rename(columns={'index': 'Stock'})
    
    # Calculate Market Breadth
    print("\nCalculating Market Breadth & Sentiment indicators...")
    try:
        df_breadth = calculate_market_breadth(df_nifty50_final, df_nifty500_final, canonical_dates)
    except Exception as e:
        print(f"[WARNING] Failed to calculate market breadth: {e}")
        df_breadth = None
        
    # Calculate Relative Strength & Beta
    print("Calculating Relative Strength & Beta metrics...")
    try:
        df_n50_metrics = calculate_relative_strength_and_beta(df_nifty50_final, canonical_dates)
        df_n500_metrics = calculate_relative_strength_and_beta(df_nifty500_final, canonical_dates)
    except Exception as e:
        print(f"[WARNING] Failed to calculate relative strength & beta: {e}")
        df_n50_metrics = None
        df_n500_metrics = None
        
    # Calculate Sector Rotation
    print("Calculating Sector Rotation average daily returns...")
    try:
        df_sector = calculate_sector_rotation(df_nifty50_final, df_nifty500_final, canonical_dates)
    except Exception as e:
        print(f"[WARNING] Failed to calculate sector rotation: {e}")
        df_sector = None
        
    # Calculate SMA Breadth
    print("Calculating SMA Breadth indicators (Percentage above SMAs)...")
    try:
        df_sma = calculate_sma_breadth(nifty50_paths, nifty500_paths, canonical_dates)
    except Exception as e:
        print(f"[WARNING] Failed to calculate SMA Breadth: {e}")
        df_sma = None
        
    # Export to Excel
    os.makedirs("reports", exist_ok=True)
    output_xlsx = os.path.join("reports", "nifty_daily_returns_heatmap.xlsx")
    
    print(f"\nWriting heatmap report to {output_xlsx}...")
    try:
        writer = pd.ExcelWriter(output_xlsx, engine='xlsxwriter')
        
        write_help_sheet(writer, sheet_name="Help")
        
        if df_breadth is not None:
            write_breadth_sheet(
                writer,
                sheet_name="Market Breadth",
                df_breadth=df_breadth,
                title="NIFTY 50 & 500 MARKET BREADTH ANALYSIS"
            )
            
        if df_sma is not None:
            write_sma_breadth_sheet(
                writer,
                sheet_name="SMA Breadth",
                df_sma=df_sma,
                title="NIFTY 50 & 500 SMA BREADTH ANALYSIS"
            )
            
        if df_n50_metrics is not None and df_n500_metrics is not None:
            write_relative_strength_sheet(
                writer,
                sheet_name="Relative Strength & Beta",
                df_n50_metrics=df_n50_metrics,
                df_n500_metrics=df_n500_metrics,
                title="NIFTY 50 & 500 RELATIVE STRENGTH & BETA ANALYSIS"
            )
            
        if df_sector is not None:
            write_sector_rotation_sheet(
                writer,
                sheet_name="Sector Rotation",
                df_sector=df_sector,
                title="SECTOR ROTATION ANALYSIS - AVERAGE DAILY RETURNS"
            )
            
        write_heatmap_sheet(
            writer, 
            sheet_name="Nifty 50 Heatmap", 
            df_final=df_nifty50_final, 
            title="NIFTY 50 DAILY RETURNS HEATMAP (PAST 1 YEAR)"
        )
        
        write_heatmap_sheet(
            writer, 
            sheet_name="Nifty 500 Heatmap", 
            df_final=df_nifty500_final, 
            title="NIFTY 500 DAILY RETURNS HEATMAP (PAST 1 YEAR)"
        )
        
        writer.close()
        print(f"[SUCCESS] Heatmap report generated successfully at: {os.path.abspath(output_xlsx)}")
        
    except PermissionError:
        output_xlsx_backup = os.path.join("reports", "nifty_daily_returns_heatmap_backup.xlsx")
        print(f"[WARNING] {output_xlsx} is currently locked or open. Attempting to write to backup: {output_xlsx_backup}")
        try:
            writer = pd.ExcelWriter(output_xlsx_backup, engine='xlsxwriter')
            
            write_help_sheet(writer, sheet_name="Help")
            
            if df_breadth is not None:
                write_breadth_sheet(
                    writer,
                    sheet_name="Market Breadth",
                    df_breadth=df_breadth,
                    title="NIFTY 50 & 500 MARKET BREADTH ANALYSIS"
                )
                
            if df_sma is not None:
                write_sma_breadth_sheet(
                    writer,
                    sheet_name="SMA Breadth",
                    df_sma=df_sma,
                    title="NIFTY 50 & 500 SMA BREADTH ANALYSIS"
                )
                
            if df_n50_metrics is not None and df_n500_metrics is not None:
                write_relative_strength_sheet(
                    writer,
                    sheet_name="Relative Strength & Beta",
                    df_n50_metrics=df_n50_metrics,
                    df_n500_metrics=df_n500_metrics,
                    title="NIFTY 50 & 500 RELATIVE STRENGTH & BETA ANALYSIS"
                )
                
            if df_sector is not None:
                write_sector_rotation_sheet(
                    writer,
                    sheet_name="Sector Rotation",
                    df_sector=df_sector,
                    title="SECTOR ROTATION ANALYSIS - AVERAGE DAILY RETURNS"
                )
                
            write_heatmap_sheet(
                writer, 
                sheet_name="Nifty 50 Heatmap", 
                df_final=df_nifty50_final, 
                title="NIFTY 50 DAILY RETURNS HEATMAP (PAST 1 YEAR)"
            )
            write_heatmap_sheet(
                writer, 
                sheet_name="Nifty 500 Heatmap", 
                df_final=df_nifty500_final, 
                title="NIFTY 500 DAILY RETURNS HEATMAP (PAST 1 YEAR)"
            )
            writer.close()
            print(f"[SUCCESS] Heatmap report generated successfully at: {os.path.abspath(output_xlsx_backup)}")
        except Exception as ex:
            print(f"[CRITICAL] Error writing to backup Excel file: {ex}")
            sys.exit(1)
    except Exception as e:
        print(f"[CRITICAL] Error generating Excel heatmap report: {e}")
        sys.exit(1)
        
    print("="*60)

if __name__ == "__main__":
    main()
