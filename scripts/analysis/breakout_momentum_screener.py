"""
Volume-Backed Breakout & Momentum Screener (Report C)
Screens the Nifty 500 stock universe for high-volume breakouts, Bollinger Band squeezes,
and ranks stocks by a multi-timeframe composite momentum score.
"""

import os
import sys
import glob
import math
import logging
import warnings
from datetime import datetime, timedelta
import numpy as np
import pandas as pd
import xlsxwriter

# Suppress warnings
warnings.filterwarnings("ignore")

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Add project root to path so we can import login and lib.dhan_helper
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

# Predefined Sector Mapping to annotate scanned stocks
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

def calculate_rsi(series, period=14):
    """Calculates the standard RSI indicator using pandas ewm."""
    if len(series) <= period:
        return np.nan
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    
    avg_gain = gain.ewm(com=period - 1, adjust=False).mean()
    avg_loss = loss.ewm(com=period - 1, adjust=False).mean()
    
    rs = avg_gain / avg_loss.replace(0, 1e-10)
    rsi = 100 - (100 / (1 + rs))
    return rsi

def process_stock_file(file_path, canonical_dates, nifty_closes):
    """
    Reads a stock daily CSV file, aligns dates, and computes breakout/momentum indicators.
    Returns a dict with processed latest-date screener metrics.
    """
    try:
        df = pd.read_csv(file_path)
        if df.empty or len(df) < 50:
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
            
        df.columns = [str(c).capitalize() for c in df.columns]
        if 'Close' not in df.columns or 'Volume' not in df.columns:
            return None
            
        df.set_index('Datetime', inplace=True)
        df.index = df.index.strftime('%Y-%m-%d')
        
        # Reindex to canonical dates (align with Nifty index)
        # Forward fill prices to handle corporate action halts/holidays, zero fill volumes
        df_aligned = pd.DataFrame(index=canonical_dates)
        df_aligned['Close'] = df['Close'].reindex(canonical_dates).ffill().bfill()
        df_aligned['Volume'] = df['Volume'].reindex(canonical_dates).fillna(0.0)
        
        # Verify if we have enough data points
        if len(df_aligned.dropna(subset=['Close'])) < 50:
            return None
            
        closes = df_aligned['Close']
        volumes = df_aligned['Volume']
        
        # Latest values
        ltp = closes.iloc[-1]
        daily_return = closes.pct_change().iloc[-1]
        volume_today = volumes.iloc[-1]
        
        # 1. Volume Surge (Today's volume vs 20-day simple average of prior days)
        prior_vol_20d = volumes.iloc[-21:-1]
        avg_vol_20d = prior_vol_20d.mean() if len(prior_vol_20d) > 0 else 0.0
        volume_surge = volume_today / avg_vol_20d if avg_vol_20d > 0 else 0.0
        
        # 2. Breakouts (Close price vs max close price of prior N trading days)
        # 20-Day Close High Breakout
        prior_closes_20d = closes.iloc[-21:-1]
        max_close_20d = prior_closes_20d.max() if len(prior_closes_20d) > 0 else 0.0
        breakout_20d = ltp >= max_close_20d and ltp > 0
        
        # 50-Day Close High Breakout
        prior_closes_50d = closes.iloc[-51:-1]
        max_close_50d = prior_closes_50d.max() if len(prior_closes_50d) > 0 else 0.0
        breakout_50d = ltp >= max_close_50d and ltp > 0
        
        # 52-Week Close High Breakout
        prior_closes_52w = closes.iloc[-253:-1] if len(closes) >= 253 else closes.iloc[:-1]
        max_close_52w = prior_closes_52w.max() if len(prior_closes_52w) > 0 else 0.0
        breakout_52w = ltp >= max_close_52w and ltp > 0
        
        # Distance from 52W High and Low
        all_closes_52w = closes.iloc[-252:] if len(closes) >= 252 else closes
        high_52w = all_closes_52w.max()
        low_52w = all_closes_52w[all_closes_52w > 0].min() if not all_closes_52w[all_closes_52w > 0].empty else ltp
        
        dist_52w_high = (ltp - high_52w) / high_52w if high_52w > 0 else 0.0
        dist_52w_low = (ltp - low_52w) / low_52w if low_52w > 0 else 0.0
        
        # 3. Bollinger Band Squeeze
        sma_20 = closes.rolling(20).mean()
        std_20 = closes.rolling(20).std()
        upper_band = sma_20 + 2 * std_20
        lower_band = sma_20 - 2 * std_20
        band_width = (upper_band - lower_band) / sma_20
        
        # Squeeze defined as band width in the lowest 10% of past 252 trading days
        current_bw = band_width.iloc[-1]
        bw_history = band_width.iloc[-252:] if len(band_width) >= 252 else band_width
        threshold_bw_10 = bw_history.quantile(0.10)
        in_squeeze = current_bw <= threshold_bw_10 if not pd.isna(current_bw) and not pd.isna(threshold_bw_10) else False
        
        # 4. Relative Strength Trend vs Nifty 50
        rs = closes / nifty_closes
        rs_sma_20 = rs.rolling(20).mean()
        rs_sma_50 = rs.rolling(50).mean()
        rs_trend = "Bullish" if rs_sma_20.iloc[-1] > rs_sma_50.iloc[-1] else "Bearish"
        
        # 5. Composite Momentum Score
        # Returns: 1M (22 days), 3M (63 days), 6M (126 days), 12M (252 days)
        r_1m = (closes.iloc[-1] - closes.iloc[-22]) / closes.iloc[-22] if len(closes) >= 22 else 0.0
        r_3m = (closes.iloc[-1] - closes.iloc[-63]) / closes.iloc[-63] if len(closes) >= 63 else 0.0
        r_6m = (closes.iloc[-1] - closes.iloc[-126]) / closes.iloc[-126] if len(closes) >= 126 else 0.0
        r_12m = (closes.iloc[-1] - closes.iloc[-252]) / closes.iloc[-252] if len(closes) >= 252 else 0.0
        
        momentum_score = 0.4 * r_1m + 0.3 * r_3m + 0.2 * r_6m + 0.1 * r_12m
        
        # 6. RSI (14)
        rsi_series = calculate_rsi(closes, 14)
        rsi_today = rsi_series.iloc[-1] if not rsi_series.empty else np.nan
        
        # 7. EMA Trend Alignment
        ema_20 = closes.ewm(span=20, adjust=False).mean()
        ema_50 = closes.ewm(span=50, adjust=False).mean()
        ema_200 = closes.ewm(span=200, adjust=False).mean()
        
        trend_aligned = "Bullish" if (ema_20.iloc[-1] > ema_50.iloc[-1] > ema_200.iloc[-1]) else "Bearish/Neutral"
        
        # 8. Pullback Indicators (Report D)
        ema_200_val = ema_200.iloc[-1]
        ema_50_val = ema_50.iloc[-1]
        lower_band_val = lower_band.iloc[-1]
        
        dist_ema_200 = (ltp - ema_200_val) / ema_200_val if (not pd.isna(ema_200_val) and ema_200_val > 0) else 0.0
        dist_ema_50 = (ltp - ema_50_val) / ema_50_val if (not pd.isna(ema_50_val) and ema_50_val > 0) else 0.0
        dist_lower_band = (ltp - lower_band_val) / lower_band_val if (not pd.isna(lower_band_val) and lower_band_val > 0) else 0.0
        
        triggers = []
        if not pd.isna(rsi_today) and rsi_today <= 40:
            triggers.append("RSI Oversold")
        if not pd.isna(ema_50_val) and -0.020 <= dist_ema_50 <= 0.015:
            triggers.append("EMA 50 Support")
        if not pd.isna(lower_band_val) and ltp <= lower_band_val * 1.01:
            triggers.append("BB Lower Band Touch")
            
        trigger_reason = ", ".join(triggers) if triggers else "None"
        is_pullback = (len(triggers) > 0) and (not pd.isna(ema_200_val) and ltp > ema_200_val)
        
        stock_symbol = os.path.basename(file_path).split('_')[0]
        
        return {
            'Symbol': stock_symbol,
            'Sector': SECTOR_MAP.get(stock_symbol, 'Other'),
            'LTP': round(ltp, 2),
            'Daily Return': daily_return,
            'Volume Today': volume_today,
            'Volume Surge': volume_surge,
            '20D Breakout': breakout_20d,
            '50D Breakout': breakout_50d,
            '52W Breakout': breakout_52w,
            '52W High': round(high_52w, 2),
            '52W Low': round(low_52w, 2),
            '% from 52W High': dist_52w_high,
            '% from 52W Low': dist_52w_low,
            'RSI (14)': round(rsi_today, 2) if not pd.isna(rsi_today) else np.nan,
            'EMA Trend': trend_aligned,
            'RS Trend': rs_trend,
            'BB Width': current_bw,
            'BB Squeeze': in_squeeze,
            '1M Return': r_1m,
            '3M Return': r_3m,
            '6M Return': r_6m,
            '12M Return': r_12m,
            'Momentum Score': momentum_score,
            '% from EMA 200': dist_ema_200,
            '% from EMA 50': dist_ema_50,
            '% from Lower BB': dist_lower_band,
            'Trigger Reason': trigger_reason,
            'Is Pullback': is_pullback
        }
    except Exception as e:
        # Silently log parse errors for specific files to avoid clutter
        # logger.debug(f"Error parsing file {file_path}: {e}")
        return None

def main():
    logger.info("="*60)
    logger.info("VOLUME-BACKED BREAKOUT & MOMENTUM SCREENER")
    logger.info("="*60)
    
    # 1. Resolve index benchmark data
    nifty_path = os.path.join("Historical Data", "NIFTY_50_Daily_5Y.csv")
    if not os.path.exists(nifty_path):
        logger.critical("[CRITICAL] Historical Nifty 50 data missing at: Historical Data/NIFTY_50_Daily_5Y.csv")
        sys.exit(1)
        
    df_n = pd.read_csv(nifty_path)
    found_col = None
    date_cols = ['date', 'datetime', 'unnamed: 0']
    for col in df_n.columns:
        if col.strip().lower() in date_cols:
            found_col = col
            break
    if found_col is None:
        for col in df_n.columns:
            if col.strip().lower() == 'timestamp':
                found_col = col
                break
    if found_col:
        df_n.rename(columns={found_col: 'Datetime'}, inplace=True)
        
    df_n['Datetime'] = pd.to_datetime(df_n['Datetime']).dt.normalize()
    df_n = df_n.sort_values('Datetime')
    df_n = df_n.drop_duplicates(subset=['Datetime'], keep='last')
    
    latest_date = df_n['Datetime'].max()
    start_date = latest_date - timedelta(days=365)
    
    logger.info(f"Screening Window: {start_date.strftime('%Y-%m-%d')} to {latest_date.strftime('%Y-%m-%d')}")
    
    df_n_filtered = df_n[df_n['Datetime'] >= start_date]
    df_n_filtered.set_index('Datetime', inplace=True)
    df_n_filtered.index = df_n_filtered.index.strftime('%Y-%m-%d')
    
    canonical_dates = sorted(df_n_filtered.index.unique())
    nifty_closes = df_n_filtered['Close']
    
    # 2. Scan all stock data files
    all_files = glob.glob("Daily_Historical_Data_Fresh/*_Daily_2Y.csv")
    logger.info(f"Scanning {len(all_files)} stock data files under Daily_Historical_Data_Fresh/...")
    
    records = []
    for file_path in all_files:
        symbol = os.path.basename(file_path).split('_')[0]
        if symbol == 'NIFTY':
            continue
        res = process_stock_file(file_path, canonical_dates, nifty_closes)
        if res:
            records.append(res)
            
    if not records:
        logger.critical("[CRITICAL] No stock files could be successfully processed. Exiting.")
        sys.exit(1)
        
    df_all = pd.DataFrame(records)
    logger.info(f"Successfully processed and aligned {len(df_all)} stocks.")
    
    # 3. Create Screener Filters
    # Screener 1: High-Volume Breakouts
    # - Stock hits a 20D, 50D, or 52W close high today
    # - Volume Surge is >= 1.5x
    df_breakouts = df_all[
        ((df_all['20D Breakout'] == True) | 
         (df_all['50D Breakout'] == True) | 
         (df_all['52W Breakout'] == True)) &
        (df_all['Volume Surge'] >= 1.5)
    ].copy()
    # Categorize breakout level
    def get_breakout_desc(row):
        levels = []
        if row['52W Breakout']: levels.append("52-Week High")
        elif row['50D Breakout']: levels.append("50-Day High")
        elif row['20D Breakout']: levels.append("20-Day High")
        return ", ".join(levels)
        
    if not df_breakouts.empty:
        df_breakouts['Breakout Level'] = df_breakouts.apply(get_breakout_desc, axis=1)
        # Sort by volume surge descending
        df_breakouts = df_breakouts.sort_values(by='Volume Surge', ascending=False)
        
    # Screener 2: Bollinger Band Squeezes
    df_squeezes = df_all[df_all['BB Squeeze'] == True].copy()
    if not df_squeezes.empty:
        # Sort by Band Width ascending (tightest squeeze first)
        df_squeezes = df_squeezes.sort_values(by='BB Width', ascending=True)
        
    # Screener 3: Momentum Rankings
    # Rank all stocks by Momentum Score descending
    df_momentum = df_all.sort_values(by='Momentum Score', ascending=False).copy()
    
    # Screener 4: Volatility Pullbacks (Report D)
    df_pullbacks = df_all[df_all['Is Pullback'] == True].copy()
    if not df_pullbacks.empty:
        df_pullbacks = df_pullbacks.sort_values(by='RSI (14)', ascending=True)
        
    # Count stats
    count_scanned = len(df_all)
    count_breakout_20d = int(df_all['20D Breakout'].sum())
    count_breakout_50d = int(df_all['50D Breakout'].sum())
    count_breakout_52w = int(df_all['52W Breakout'].sum())
    count_squeezes = int(df_all['BB Squeeze'].sum())
    count_pullbacks = int(df_all['Is Pullback'].sum())
    
    logger.info("\n" + "="*50)
    logger.info("MOMENTUM & BREAKOUT SCREENER RESULTS SUMMARY")
    logger.info("="*50)
    logger.info(f"Total Stocks Scanned           : {count_scanned}")
    logger.info(f"20-Day High Close Breakouts    : {count_breakout_20d}")
    logger.info(f"50-Day High Close Breakouts    : {count_breakout_50d}")
    logger.info(f"52-Week High Close Breakouts   : {count_breakout_52w}")
    logger.info(f"Bollinger Band Squeezes Found  : {count_squeezes}")
    logger.info(f"Volume-backed Breakouts today  : {len(df_breakouts)}")
    logger.info(f"Volatility Pullbacks Found     : {count_pullbacks}")
    logger.info("="*50 + "\n")
    
    # 4. Export report to Excel
    os.makedirs("reports", exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = os.path.join("reports", f"Breakout_Momentum_Screener_{timestamp}.xlsx")
    shortcut_path = os.path.join("reports", "breakout_momentum_screener.xlsx")
    
    logger.info(f"Writing Excel Screener Report to {output_path}...")
    
    try:
        writer = pd.ExcelWriter(output_path, engine='xlsxwriter')
        workbook = writer.book
        
        # Setup Formats
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
        section_format = workbook.add_format({
            'bold': True,
            'size': 12,
            'font_color': '#1F4E79',
            'bg_color': '#DDEBF7',
            'font_name': 'Segoe UI',
            'border': 1
        })
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
        stock_name_format = workbook.add_format({
            'bold': True,
            'font_name': 'Segoe UI',
            'size': 10,
            'border': 1,
            'bg_color': '#F2F4F4'
        })
        text_format = workbook.add_format({
            'font_name': 'Segoe UI',
            'size': 9,
            'border': 1,
            'align': 'left'
        })
        text_format_center = workbook.add_format({
            'font_name': 'Segoe UI',
            'size': 9,
            'border': 1,
            'align': 'center'
        })
        currency_format = workbook.add_format({
            'num_format': '₹#,##0.00',
            'font_name': 'Segoe UI',
            'size': 9,
            'border': 1,
            'align': 'right'
        })
        pct_format = workbook.add_format({
            'num_format': '0.00%',
            'font_name': 'Segoe UI',
            'size': 9,
            'border': 1,
            'align': 'right'
        })
        pct_format_signed = workbook.add_format({
            'num_format': '+0.00%;-0.00%;0.00%',
            'font_name': 'Segoe UI',
            'size': 9,
            'border': 1,
            'align': 'right'
        })
        num_format_2dec = workbook.add_format({
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
        
        # Summary Card Formats
        card_lbl_format = workbook.add_format({
            'bold': True,
            'size': 9,
            'font_color': '#595959',
            'font_name': 'Segoe UI',
            'align': 'left',
            'bg_color': '#F8F9F9'
        })
        card_val_format_num = workbook.add_format({
            'bold': True,
            'size': 11,
            'font_color': '#1F4E79',
            'font_name': 'Segoe UI',
            'align': 'right',
            'bg_color': '#F8F9F9',
            'num_format': '#,##0'
        })
        
        # ----------------------------------------------------
        # SHEET 1: DASHBOARD
        # ----------------------------------------------------
        ws_dash = workbook.add_worksheet("Dashboard")
        ws_dash.hide_gridlines(2)
        
        ws_dash.write('A2', "BREAKOUT & MOMENTUM SCREENER SUMMARY", title_format)
        ws_dash.write('A3', f"Generated on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | Universal Screening (Past 1 Year)", subtitle_format)
        
        # Summary metrics block
        ws_dash.merge_range('A5:C5', "SCREENING METRICS SUMMARY", section_format)
        ws_dash.write('A6', "Total Stocks Scanned", card_lbl_format)
        ws_dash.write('A7', "20-Day Close High Breakouts", card_lbl_format)
        ws_dash.write('A8', "50-Day Close High Breakouts", card_lbl_format)
        ws_dash.write('A9', "52-Week Close High Breakouts", card_lbl_format)
        ws_dash.write('A10', "Bollinger Band Squeezes", card_lbl_format)
        ws_dash.write('A11', "Volume-Backed Breakouts Today", card_lbl_format)
        ws_dash.write('A12', "Volatility Pullbacks Today", card_lbl_format)
        
        ws_dash.write('B6', count_scanned, card_val_format_num)
        ws_dash.write('B7', count_breakout_20d, card_val_format_num)
        ws_dash.write('B8', count_breakout_50d, card_val_format_num)
        ws_dash.write('B9', count_breakout_52w, card_val_format_num)
        ws_dash.write('B10', count_squeezes, card_val_format_num)
        ws_dash.write('B11', len(df_breakouts), card_val_format_num)
        ws_dash.write('B12', count_pullbacks, card_val_format_num)
        
        ws_dash.write('C6', "", card_lbl_format)
        ws_dash.write('C7', "Excludes today from lookback max", card_lbl_format)
        ws_dash.write('C8', "", card_lbl_format)
        ws_dash.write('C9', "", card_lbl_format)
        ws_dash.write('C10', "Width in lower 10th percentile", card_lbl_format)
        ws_dash.write('C11', "Breakout with Volume Surge >= 1.5x", card_lbl_format)
        ws_dash.write('C12', "EMA 200 uptrend with RSI <= 40, near EMA 50, or lower BB touch", card_lbl_format)
        
        ws_dash.set_column('A:A', 30)
        ws_dash.set_column('B:B', 15)
        ws_dash.set_column('C:C', 35)
        
        # Glossary / Methodology (Starts at Row 13)
        ws_dash.merge_range('A13:C13', "SCREENER METHODOLOGY & INTERPRETATION", section_format)
        
        gloss_headers = ["Screener Parameter", "Calculation Logic", "Interpretation & Usage"]
        for col_idx, h in enumerate(gloss_headers):
            ws_dash.write(13, col_idx, h, header_format)
            
        gloss_data = [
            (
                "Volume Surge Multiple",
                "Volume_today / Mean(Volume of prior 20 trading days)",
                "Surge > 1.5x shows high trading interest (often institutional). Surge > 2.5x is highly significant."
            ),
            (
                "N-Day High Breakout",
                "Close_today >= Max(Close of prior N trading days)",
                "Identifies stocks breaking out of range consolidation. 52-week breakout is a strong secular trend indicator."
            ),
            (
                "Bollinger Band Squeeze",
                "Band Width <= 10th percentile of band widths over past 252 days",
                "Identifies consolidation phases with extremely low volatility. Frequently precedes massive explosive breakouts."
            ),
            (
                "Relative Strength (RS) Trend",
                "Bullish if 20-day SMA of (Stock/Nifty) > 50-day SMA",
                "Indicates whether the stock is outperforming the benchmark index over medium horizons."
            ),
            (
                "Composite Momentum Score",
                "0.4 * R_1M + 0.3 * R_3M + 0.2 * R_6M + 0.1 * R_12M",
                "Combines short-term and long-term performance. Higher scores reveal leadership, useful for trend-following strategies."
            ),
            (
                "Volatility Pullback",
                "Close > EMA 200 AND (RSI(14) <= 40 OR -2.0% <= dist_EMA_50 <= 1.5% OR Close <= Lower Band * 1.01)",
                "Identifies high-quality stocks in long-term uptrends undergoing short-term pullbacks, offering optimal entry opportunities."
            )
        ]
        
        gloss_metric_format = workbook.add_format({
            'bold': True,
            'font_name': 'Segoe UI',
            'size': 9,
            'border': 1,
            'bg_color': '#F2F4F4',
            'valign': 'top',
            'text_wrap': True
        })
        gloss_text_format = workbook.add_format({
            'font_name': 'Segoe UI',
            'size': 9,
            'border': 1,
            'align': 'left',
            'valign': 'top',
            'text_wrap': True
        })
        
        for r_idx, row in enumerate(gloss_data):
            excel_r = 14 + r_idx
            ws_dash.write(excel_r, 0, row[0], gloss_metric_format)
            ws_dash.write(excel_r, 1, row[1], gloss_text_format)
            ws_dash.write(excel_r, 2, row[2], gloss_text_format)
            ws_dash.set_row(excel_r, 45)
            
        # ----------------------------------------------------
        # SHEET 2: BREAKOUT SCREENER
        # ----------------------------------------------------
        ws_brk = workbook.add_worksheet("Volume Breakouts")
        ws_brk.hide_gridlines(2)
        
        ws_brk.write('A2', "VOLUME-CONFIRMED PRICE BREAKOUTS", title_format)
        ws_brk.write('A3', "Stocks hitting 20D, 50D, or 52W highs today with Volume Surge Multiple >= 1.5x.", subtitle_format)
        
        ws_brk.merge_range('A5:L5', "HIGH VOLUME PRICE BREAKOUTS WATCHLIST", section_format)
        
        headers_brk = [
            "Symbol", "Sector", "LTP", "Daily Return", "Volume Surge", 
            "Breakout Level", "RSI (14)", "EMA Trend", "RS Trend", 
            "% from 52W High", "% from 52W Low", "Volume Today"
        ]
        
        for col_idx, h in enumerate(headers_brk):
            fmt = stock_header_format if col_idx in [0, 1, 5] else header_format
            ws_brk.write(5, col_idx, h, fmt)
            
        ws_brk.freeze_panes(6, 0)
        
        if not df_breakouts.empty:
            for r_idx, row in df_breakouts.reset_index(drop=True).iterrows():
                excel_r = 6 + r_idx
                lbl_fmt = stock_name_format if r_idx % 2 == 0 else text_format
                
                ws_brk.write(excel_r, 0, row['Symbol'], lbl_fmt)
                ws_brk.write(excel_r, 1, row['Sector'], text_format)
                ws_brk.write(excel_r, 2, float(row['LTP']), currency_format)
                ws_brk.write(excel_r, 3, float(row['Daily Return']), pct_format_signed)
                ws_brk.write(excel_r, 4, float(row['Volume Surge']), num_format_2dec)
                ws_brk.write(excel_r, 5, row['Breakout Level'], text_format)
                
                rsi_val = row['RSI (14)']
                if pd.isna(rsi_val):
                    ws_brk.write_string(excel_r, 6, "N/A", text_format_center)
                else:
                    ws_brk.write_number(excel_r, 6, float(rsi_val), num_format_2dec)
                    
                ws_brk.write(excel_r, 7, row['EMA Trend'], text_format_center)
                ws_brk.write(excel_r, 8, row['RS Trend'], text_format_center)
                ws_brk.write(excel_r, 9, float(row['% from 52W High']), pct_format_signed)
                ws_brk.write(excel_r, 10, float(row['% from 52W Low']), pct_format_signed)
                ws_brk.write(excel_r, 11, float(row['Volume Today']), int_format)
        else:
            ws_brk.merge_range('A6:L6', "No volume-backed high breakouts found today.", text_format_center)
            
        # Column widths
        ws_brk.set_column('A:A', 12)
        ws_brk.set_column('B:B', 18)
        ws_brk.set_column('C:E', 14)
        ws_brk.set_column('F:F', 20)
        ws_brk.set_column('G:K', 14)
        ws_brk.set_column('L:L', 16)
        
        # Conditional formatting for Volume Surge (E, idx 4) and RSI (G, idx 6)
        if not df_breakouts.empty:
            start_row = 6
            end_row = 6 + len(df_breakouts) - 1
            
            ws_brk.conditional_format(start_row, 4, end_row, 4, {
                'type': '3_color_scale',
                'min_value': 1.5, 'min_type': 'num', 'min_color': '#FFFFFF',
                'mid_value': 3.0, 'mid_type': 'num', 'mid_color': '#FCF3CF',
                'max_value': 6.0, 'max_type': 'num', 'max_color': '#F5B7B1' # Red for large volume surges
            })
            
            # RSI overbought (>70) is red, oversold (<30) is green
            ws_brk.conditional_format(start_row, 6, end_row, 6, {
                'type': '3_color_scale',
                'min_value': 30.0, 'min_type': 'num', 'min_color': '#C6EFCE',
                'mid_value': 50.0, 'mid_type': 'num', 'mid_color': '#FFFFFF',
                'max_value': 70.0, 'max_type': 'num', 'max_color': '#FFC7CE'
            })
            
        # ----------------------------------------------------
        # SHEET 3: BOLLINGER BAND SQUEEZE SCREENER
        # ----------------------------------------------------
        ws_sqz = workbook.add_worksheet("Volatility Squeezes")
        ws_sqz.hide_gridlines(2)
        
        ws_sqz.write('A2', "BOLLINGER BAND VOLATILITY SQUEEZES", title_format)
        ws_sqz.write('A3', "Stocks with extremely narrow Bollinger Bands relative to past 1 year, hinting potential volatility breakouts.", subtitle_format)
        
        ws_sqz.merge_range('A5:K5', "CONSOLIDATION VOLATILITY SQUEEZE WATCHLIST", section_format)
        
        headers_sqz = [
            "Symbol", "Sector", "LTP", "Daily Return", "BB Width", 
            "Volume Surge", "RSI (14)", "EMA Trend", "RS Trend", 
            "% from 52W High", "Volume Today"
        ]
        
        for col_idx, h in enumerate(headers_sqz):
            fmt = stock_header_format if col_idx in [0, 1] else header_format
            ws_sqz.write(5, col_idx, h, fmt)
            
        ws_sqz.freeze_panes(6, 0)
        
        if not df_squeezes.empty:
            for r_idx, row in df_squeezes.reset_index(drop=True).iterrows():
                excel_r = 6 + r_idx
                lbl_fmt = stock_name_format if r_idx % 2 == 0 else text_format
                
                ws_sqz.write(excel_r, 0, row['Symbol'], lbl_fmt)
                ws_sqz.write(excel_r, 1, row['Sector'], text_format)
                ws_sqz.write(excel_r, 2, float(row['LTP']), currency_format)
                ws_sqz.write(excel_r, 3, float(row['Daily Return']), pct_format_signed)
                ws_sqz.write(excel_r, 4, float(row['BB Width']), pct_format)
                ws_sqz.write(excel_r, 5, float(row['Volume Surge']), num_format_2dec)
                
                rsi_val = row['RSI (14)']
                if pd.isna(rsi_val):
                    ws_sqz.write_string(excel_r, 6, "N/A", text_format_center)
                else:
                    ws_sqz.write_number(excel_r, 6, float(rsi_val), num_format_2dec)
                    
                ws_sqz.write(excel_r, 7, row['EMA Trend'], text_format_center)
                ws_sqz.write(excel_r, 8, row['RS Trend'], text_format_center)
                ws_sqz.write(excel_r, 9, float(row['% from 52W High']), pct_format_signed)
                ws_sqz.write(excel_r, 10, float(row['Volume Today']), int_format)
        else:
            ws_sqz.merge_range('A6:K6', "No volatility squeeze candidates found today.", text_format_center)
            
        ws_sqz.set_column('A:A', 12)
        ws_sqz.set_column('B:B', 18)
        ws_sqz.set_column('C:K', 14)
        
        # Highlight Bollinger Band Width (lower is tighter squeeze = green/blue)
        if not df_squeezes.empty:
            start_row = 6
            end_row = 6 + len(df_squeezes) - 1
            
            ws_sqz.conditional_format(start_row, 4, end_row, 4, {
                'type': '3_color_scale',
                'min_value': 0.02, 'min_type': 'num', 'min_color': '#AED6F1', # Tightest is soft blue
                'mid_value': 0.05, 'mid_type': 'num', 'mid_color': '#FFFFFF',
                'max_value': 0.12, 'max_type': 'num', 'max_color': '#FADBD8'
            })
            
        # ----------------------------------------------------
        # SHEET 4: VOLATILITY PULLBACKS SCREENER (Report D)
        # ----------------------------------------------------
        ws_plb = workbook.add_worksheet("Volatility Pullbacks")
        ws_plb.hide_gridlines(2)
        
        ws_plb.write('A2', "VOLATILITY-BASED PRICE PULLBACKS (BUY THE DIP)", title_format)
        ws_plb.write('A3', "Stocks in structural uptrends (Close > EMA 200) undergoing short-term pullbacks or consolidations.", subtitle_format)
        
        ws_plb.merge_range('A5:L5', "VOLATILITY PULLBACK WATCHLIST", section_format)
        
        headers_plb = [
            "Symbol", "Sector", "LTP", "Daily Return", "BB Width", 
            "Volume Surge", "RSI (14)", "EMA Trend", "RS Trend", 
            "% from EMA 200", "% from EMA 50", "Trigger Reason"
        ]
        
        for col_idx, h in enumerate(headers_plb):
            fmt = stock_header_format if col_idx in [0, 1, 11] else header_format
            ws_plb.write(5, col_idx, h, fmt)
            
        ws_plb.freeze_panes(6, 0)
        
        if not df_pullbacks.empty:
            for r_idx, row in df_pullbacks.reset_index(drop=True).iterrows():
                excel_r = 6 + r_idx
                lbl_fmt = stock_name_format if r_idx % 2 == 0 else text_format
                
                ws_plb.write(excel_r, 0, row['Symbol'], lbl_fmt)
                ws_plb.write(excel_r, 1, row['Sector'], text_format)
                ws_plb.write(excel_r, 2, float(row['LTP']), currency_format)
                ws_plb.write(excel_r, 3, float(row['Daily Return']), pct_format_signed)
                ws_plb.write(excel_r, 4, float(row['BB Width']), pct_format)
                ws_plb.write(excel_r, 5, float(row['Volume Surge']), num_format_2dec)
                
                rsi_val = row['RSI (14)']
                if pd.isna(rsi_val):
                    ws_plb.write_string(excel_r, 6, "N/A", text_format_center)
                else:
                    ws_plb.write_number(excel_r, 6, float(rsi_val), num_format_2dec)
                    
                ws_plb.write(excel_r, 7, row['EMA Trend'], text_format_center)
                ws_plb.write(excel_r, 8, row['RS Trend'], text_format_center)
                ws_plb.write(excel_r, 9, float(row['% from EMA 200']), pct_format_signed)
                ws_plb.write(excel_r, 10, float(row['% from EMA 50']), pct_format_signed)
                ws_plb.write(excel_r, 11, row['Trigger Reason'], text_format)
        else:
            ws_plb.merge_range('A6:L6', "No volatility pullback candidates found today.", text_format_center)
            
        ws_plb.set_column('A:A', 12)
        ws_plb.set_column('B:B', 18)
        ws_plb.set_column('C:K', 14)
        ws_plb.set_column('L:L', 30)
        
        # Highlight RSI and % from EMA 50
        if not df_pullbacks.empty:
            start_row = 6
            end_row = 6 + len(df_pullbacks) - 1
            
            ws_plb.conditional_format(start_row, 6, end_row, 6, {
                'type': '3_color_scale',
                'min_value': 30.0, 'min_type': 'num', 'min_color': '#C6EFCE',
                'mid_value': 50.0, 'mid_type': 'num', 'mid_color': '#FFFFFF',
                'max_value': 70.0, 'max_type': 'num', 'max_color': '#FFC7CE'
            })
            
            ws_plb.conditional_format(start_row, 10, end_row, 10, {
                'type': '3_color_scale',
                'min_value': -0.05, 'min_type': 'num', 'min_color': '#FADBD8',
                'mid_value': 0.00, 'mid_type': 'num', 'mid_color': '#C6EFCE',
                'max_value': 0.05, 'max_type': 'num', 'max_color': '#FFFFFF'
            })
            
        # ----------------------------------------------------
        # SHEET 5: MOMENTUM RANKINGS
        # ----------------------------------------------------
        ws_mom = workbook.add_worksheet("Momentum Rankings")
        ws_mom.hide_gridlines(2)
        
        ws_mom.write('A2', "COMPOSITE DUAL MOMENTUM RANKINGS", title_format)
        ws_mom.write('A3', "Ranked by Momentum Score: 40% (1M) + 30% (3M) + 20% (6M) + 10% (12M) returns.", subtitle_format)
        
        ws_mom.merge_range('A5:K5', "STOCKS DUAL MOMENTUM SCOREBOARD", section_format)
        
        headers_mom = [
            "Rank", "Symbol", "Sector", "Momentum Score", "LTP", 
            "1M Return", "3M Return", "6M Return", "12M Return", 
            "RSI (14)", "RS Trend"
        ]
        
        for col_idx, h in enumerate(headers_mom):
            fmt = stock_header_format if col_idx in [1, 2] else header_format
            ws_mom.write(5, col_idx, h, fmt)
            
        ws_mom.freeze_panes(6, 0)
        
        for r_idx, row in df_momentum.reset_index(drop=True).iterrows():
            excel_r = 6 + r_idx
            lbl_fmt = stock_name_format if r_idx % 2 == 0 else text_format
            
            ws_mom.write(excel_r, 0, r_idx + 1, text_format_center)
            ws_mom.write(excel_r, 1, row['Symbol'], lbl_fmt)
            ws_mom.write(excel_r, 2, row['Sector'], text_format)
            ws_mom.write(excel_r, 3, float(row['Momentum Score']), num_format_2dec)
            ws_mom.write(excel_r, 4, float(row['LTP']), currency_format)
            ws_mom.write(excel_r, 5, float(row['1M Return']), pct_format_signed)
            ws_mom.write(excel_r, 6, float(row['3M Return']), pct_format_signed)
            ws_mom.write(excel_r, 7, float(row['6M Return']), pct_format_signed)
            ws_mom.write(excel_r, 8, float(row['12M Return']), pct_format_signed)
            
            rsi_val = row['RSI (14)']
            if pd.isna(rsi_val):
                ws_mom.write_string(excel_r, 9, "N/A", text_format_center)
            else:
                ws_mom.write_number(excel_r, 9, float(rsi_val), num_format_2dec)
                
            ws_mom.write(excel_r, 10, row['RS Trend'], text_format_center)
            
        ws_mom.set_column('A:A', 8)  # Rank
        ws_mom.set_column('B:B', 12) # Symbol
        ws_mom.set_column('C:C', 18) # Sector
        ws_mom.set_column('D:J', 14) # Score and returns
        ws_mom.set_column('K:K', 12) # RS Trend
        
        # Color scale for Momentum Score (column D, idx 3)
        start_row = 6
        end_row = 6 + len(df_momentum) - 1
        
        ws_mom.conditional_format(start_row, 3, end_row, 3, {
            'type': '3_color_scale',
            'min_value': -0.20, 'min_type': 'num', 'min_color': '#F5B7B1', # Red for negative momentum
            'mid_value': 0.0, 'mid_type': 'num', 'mid_color': '#FFFFFF',
            'max_value': 0.40, 'max_type': 'num', 'max_color': '#A9DFBF'  # Green for high momentum
        })
        
        writer.close()
        logger.info(f"[SUCCESS] Breakout and Momentum Screener generated at: {os.path.abspath(output_path)}")
        
        # Update latest shortcut copy
        try:
            import shutil
            shutil.copy2(output_path, shortcut_path)
            logger.info(f"Updated latest shortcut copy at: {os.path.abspath(shortcut_path)}")
        except Exception as e:
            logger.warning(f"Could not update static shortcut copy: {e}")
            
    except PermissionError:
        logger.critical(f"[FAIL] Permission denied. Is the file {output_path} open in Excel?")
    except Exception as e:
        logger.critical(f"[FAIL] Error writing Excel report: {e}")

if __name__ == "__main__":
    main()
