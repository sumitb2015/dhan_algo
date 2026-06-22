"""
Portfolio Risk & Correlation Screener (Report A)
Calculates portfolio-level risk metrics including weighted beta, volatility, covariance, 
Value at Risk (VaR), Maximum Drawdown, and Marginal Contribution to Risk (MCTR).
Generates a beautifully formatted Excel report.
"""

import os
import sys
import math
import glob
import time
import logging
import warnings
from datetime import datetime, timedelta
import numpy as np
import pandas as pd
import scipy.stats as stats
import xlsxwriter

# Suppress warnings
warnings.filterwarnings("ignore")

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Add project root to path so we can import login and lib.dhan_helper
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

try:
    from login import get_dhan_client
    from lib.dhan_helper import DhanHelper
except ImportError:
    get_dhan_client = None
    DhanHelper = None

# Predefined Nifty 50 & Common Stocks Sector Mapping
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

def ensure_stock_data(symbol, helper=None, target_latest_date=None):
    """
    Ensures that 2-year daily historical data for the stock is available locally.
    If not, downloads it using Dhan API if helper is connected.
    """
    os.makedirs("Daily_Historical_Data_Fresh", exist_ok=True)
    file_path = os.path.join("Daily_Historical_Data_Fresh", f"{symbol}_Daily_2Y.csv")
    
    is_fresh = False
    if os.path.exists(file_path):
        if target_latest_date is None:
            is_fresh = True
        else:
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
    logger.info(f"{action_str} data for {symbol} from Dhan API...")
    try:
        sec = helper.get_security_id(symbol=symbol, instrument="EQUITY")
        if not sec:
            logger.warning(f"Symbol {symbol} not found in Dhan Master List")
            return file_path if os.path.exists(file_path) else None
            
        security_id = int(sec['SECURITY_ID'])
        to_date = datetime.now().strftime("%Y-%m-%d")
        from_date = (datetime.now() - timedelta(days=int(2 * 365))).strftime("%Y-%m-%d")
        
        # Dynamically determine exchange segment
        exch = sec.get('EXCH_ID', 'NSE')
        inst = sec.get('INSTRUMENT', 'EQUITY')
        exch_segment = "BSE_EQ" if exch.upper() == "BSE" else "NSE_EQ"
        
        df = helper.get_historical_daily_data(
            security_id=security_id,
            exchange_segment=exch_segment,
            instrument_type=inst,
            from_date=from_date,
            to_date=to_date
        )
        if df.empty:
            return file_path if os.path.exists(file_path) else None
            
        # Format the df
        if 'timestamp' in df.columns:
            df['Datetime'] = pd.to_datetime(df['timestamp'], unit='s').dt.tz_localize('UTC').dt.tz_convert('Asia/Kolkata').dt.tz_localize(None)
            df['Datetime'] = df['Datetime'].dt.strftime("%Y-%m-%d")
            
        df.columns = [str(c).capitalize() for c in df.columns]
        cols = ['Datetime', 'Open', 'High', 'Low', 'Close', 'Volume', 'Timestamp']
        df = df[[c for c in cols if c in df.columns]]
        
        df.to_csv(file_path, index=False)
        logger.info(f"Saved {symbol} historical data to {file_path}")
        time.sleep(0.15) # rate limit friendly
        return file_path
    except Exception as e:
        logger.error(f"Error downloading/saving data for {symbol}: {e}")
        return file_path if os.path.exists(file_path) else None

def ensure_index_data(symbol="NIFTY", helper=None):
    """
    Ensures that Nifty 50 index daily historical data is available.
    """
    os.makedirs("Historical Data", exist_ok=True)
    file_path = os.path.join("Historical Data", "NIFTY_50_Daily_5Y.csv")
    if os.path.exists(file_path):
        return file_path
        
    if helper is None:
        return None
        
    logger.info(f"Downloading index data for {symbol} from Dhan API...")
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
        logger.info(f"Saved {symbol} index historical data to {file_path}")
        return file_path
    except Exception as e:
        logger.error(f"Error downloading/saving index data: {e}")
        return None

def process_daily_returns_and_prices(file_path, start_date):
    """
    Reads a daily CSV file, returns daily closing prices and daily return series aligned on dates.
    """
    try:
        df = pd.read_csv(file_path)
        if df.empty:
            return None, None
            
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
            return None, None
            
        df.columns = [str(c).capitalize() for c in df.columns]
        if 'Close' not in df.columns:
            return None, None
            
        df.set_index('Datetime', inplace=True)
        
        # Calculate daily percentage returns (as decimal fractions)
        df['Return'] = df['Close'].pct_change()
        df['Return'] = df['Return'].replace([float('inf'), float('-inf')], None)
        
        # Filter for dates >= start_date
        df_filtered = df[df.index >= start_date]
        
        if df_filtered.empty:
            return None, None
            
        price_series = df_filtered['Close']
        return_series = df_filtered['Return']
        
        # Format index as string 'YYYY-MM-DD'
        price_series.index = price_series.index.strftime('%Y-%m-%d')
        return_series.index = return_series.index.strftime('%Y-%m-%d')
        
        return price_series, return_series
    except Exception as e:
        logger.error(f"Error processing {file_path}: {e}")
        return None, None

def get_holdings_data(helper):
    """
    Fetches actual holdings or returns a robust diversified sample portfolio.
    """
    if helper:
        try:
            logger.info("Fetching holdings from Dhan...")
            holdings_df = helper.get_holdings()
            if not holdings_df.empty:
                logger.info(f"Loaded {len(holdings_df)} holdings from Dhan account.")
                # Standardize columns
                if 'lastTradedPrice' not in holdings_df.columns and 'currentMarketPrice' in holdings_df.columns:
                    holdings_df['lastTradedPrice'] = holdings_df['currentMarketPrice']
                
                # Keep active holdings (qty > 0)
                holdings_df = holdings_df[holdings_df['totalQty'] > 0]
                if not holdings_df.empty:
                    # Rename columns to standard casing
                    rename_map = {
                        'tradingSymbol': 'Symbol',
                        'totalQty': 'Quantity',
                        'avgCostPrice': 'Avg Cost',
                        'lastTradedPrice': 'Current Price'
                    }
                    holdings_df = holdings_df.rename(columns=rename_map)
                    return holdings_df[['Symbol', 'Quantity', 'Avg Cost', 'Current Price']]
        except Exception as e:
            logger.error(f"Error fetching real holdings: {e}. Falling back to sample portfolio.")
            
    logger.info("Using sample diversified portfolio for risk analysis.")
    sample_data = {
        'Symbol': ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'LT', 'ITC', 'M&M', 'SUNPHARMA', 'TITAN'],
        'Quantity': [100, 50, 250, 120, 200, 60, 300, 70, 110, 50],
        'Avg Cost': [2450.0, 3850.0, 1650.0, 1550.0, 1150.0, 3400.0, 430.0, 2800.0, 1500.0, 3200.0],
        'Current Price': [2510.50, 3915.20, 1682.30, 1588.40, 1175.90, 3475.00, 442.10, 2890.60, 1545.00, 3290.40]
    }
    return pd.DataFrame(sample_data)

def main():
    logger.info("="*60)
    logger.info("PORTFOLIO RISK & CORRELATION SCREENER")
    logger.info("="*60)
    
    # 1. Authenticate Dhan client
    helper = None
    if get_dhan_client is not None and DhanHelper is not None:
        try:
            dhan = get_dhan_client()
            if dhan:
                helper = DhanHelper(dhan)
                logger.info("[SUCCESS] Dhan Client authenticated successfully.")
        except Exception as e:
            logger.warning(f"Could not connect to Dhan: {e}. Running in offline mode.")
            
    # 2. Get holdings
    df_holdings = get_holdings_data(helper)
    if df_holdings.empty:
        logger.critical("No holdings or sample data available. Exiting.")
        sys.exit(1)
        
    # 3. Load NIFTY 50 Index as benchmark
    nifty_path = ensure_index_data("NIFTY", helper)
    if not nifty_path or not os.path.exists(nifty_path):
        logger.critical("[CRITICAL] Nifty 50 historical index data file missing.")
        sys.exit(1)
        
    # Load index data and determine dynamic 1-year window
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
    
    logger.info(f"Analysis Window: {start_date.strftime('%Y-%m-%d')} to {latest_date.strftime('%Y-%m-%d')}")
    
    # Get Nifty daily returns
    nifty_prices, nifty_returns = process_daily_returns_and_prices(nifty_path, start_date)
    if nifty_returns is None or nifty_prices is None:
        logger.critical("[CRITICAL] Failed to process Nifty 50 daily returns.")
        sys.exit(1)
        
    # Get canonical trading days in the past 1 year
    canonical_dates = sorted(nifty_returns.index.unique())
    logger.info(f"Total trading days: {len(canonical_dates)}")
    
    # Reindex Nifty returns to canonical dates
    nifty_returns = nifty_returns.reindex(canonical_dates).fillna(0.0)
    nifty_var = nifty_returns.var()
    
    # 4. Resolve Stock Files and Load Historical Returns
    stock_returns_dict = {}
    stock_prices_dict = {}
    valid_symbols = []
    
    logger.info("Resolving historical data for holdings...")
    for symbol in df_holdings['Symbol']:
        path = ensure_stock_data(symbol, helper, target_latest_date=latest_date.date())
        if path and os.path.exists(path):
            prices, returns = process_daily_returns_and_prices(path, start_date)
            if prices is not None and returns is not None:
                # Reindex to match canonical dates exactly
                stock_prices_dict[symbol] = prices.reindex(canonical_dates)
                stock_returns_dict[symbol] = returns.reindex(canonical_dates).fillna(0.0)
                valid_symbols.append(symbol)
            else:
                logger.warning(f"Could not calculate returns for {symbol} (possibly empty file).")
        else:
            logger.warning(f"Historical file not found for {symbol}.")
            
    if not valid_symbols:
        logger.critical("[CRITICAL] No historical return data could be loaded for any holdings.")
        sys.exit(1)
        
    logger.info(f"Successfully loaded return series for {len(valid_symbols)}/{len(df_holdings)} holdings.")
    
    # Clean df_holdings to keep only those with valid data
    df_holdings = df_holdings[df_holdings['Symbol'].isin(valid_symbols)].reset_index(drop=True)
    
    # Update Current Prices from latest available closing price in our historical daily files if API was offline
    for idx, row in df_holdings.iterrows():
        sym = row['Symbol']
        last_price = stock_prices_dict[sym].dropna().iloc[-1]
        df_holdings.at[idx, 'Current Price'] = last_price
        
    # 5. Calculate Stock-specific Risk & Performance Metrics
    df_holdings['Invested Value'] = df_holdings['Quantity'] * df_holdings['Avg Cost']
    df_holdings['Current Value'] = df_holdings['Quantity'] * df_holdings['Current Price']
    total_portfolio_value = df_holdings['Current Value'].sum()
    df_holdings['Weight'] = df_holdings['Current Value'] / total_portfolio_value
    
    nifty_prices_clean = nifty_prices.dropna() if nifty_prices is not None else pd.Series()
    nifty_ann_return = 0.0
    if not nifty_prices_clean.empty:
        nifty_ann_return = (nifty_prices_clean.iloc[-1] - nifty_prices_clean.iloc[0]) / nifty_prices_clean.iloc[0]
        
    stock_betas = {}
    stock_corrs = {}
    stock_vols = {}
    stock_mdds = {}
    stock_avg_rets = {}
    
    # Report B parameters
    stock_ann_returns = {}
    stock_sharpes = {}
    stock_downside_devs = {}
    stock_sortinos = {}
    stock_treynors = {}
    stock_alphas = {}
    stock_uis = {}
    
    RF = 0.065 # 6.5% Annualized Risk-Free Rate
    daily_rf = RF / 252.0
    
    for symbol in valid_symbols:
        s_returns = stock_returns_dict[symbol]
        s_prices = stock_prices_dict[symbol]
        
        # Beta
        cov = s_returns.cov(nifty_returns)
        beta = cov / nifty_var if nifty_var > 0 else 1.0
        stock_betas[symbol] = beta
        
        # Correlation
        corr = s_returns.corr(nifty_returns)
        stock_corrs[symbol] = 0.0 if pd.isna(corr) else corr
        
        # Volatility (Annualized)
        vol = s_returns.std() * math.sqrt(252)
        stock_vols[symbol] = vol
        
        # Average Daily Return
        stock_avg_rets[symbol] = s_returns.mean()
        
        # Maximum Drawdown (MDD) & Ulcer Index (UI) & Annualized Return
        prices_clean = s_prices.dropna() if s_prices is not None else pd.Series()
        if not prices_clean.empty:
            roll_max = prices_clean.cummax()
            drawdowns = (prices_clean - roll_max) / roll_max
            stock_mdds[symbol] = drawdowns.min()
            
            # Ulcer Index
            ulcer_index = math.sqrt(np.mean(drawdowns ** 2)) * 100.0
            stock_uis[symbol] = ulcer_index
            
            # Annualized Return (actual 1-year compounded return)
            ann_ret = (prices_clean.iloc[-1] - prices_clean.iloc[0]) / prices_clean.iloc[0]
            stock_ann_returns[symbol] = ann_ret
        else:
            stock_mdds[symbol] = 0.0
            stock_uis[symbol] = 0.0
            stock_ann_returns[symbol] = 0.0
            
        # Sharpe Ratio
        stock_sharpes[symbol] = (stock_ann_returns[symbol] - RF) / vol if vol > 0 else 0.0
        
        # Downside Deviation
        downside_diff = np.minimum(s_returns.values - daily_rf, 0.0)
        downside_dev = math.sqrt(np.mean(downside_diff ** 2)) * math.sqrt(252)
        stock_downside_devs[symbol] = downside_dev
        
        # Sortino Ratio
        stock_sortinos[symbol] = (stock_ann_returns[symbol] - RF) / downside_dev if downside_dev > 0 else 0.0
        
        # Treynor Ratio
        stock_treynors[symbol] = (stock_ann_returns[symbol] - RF) / beta if beta != 0 else 0.0
        
        # Jensen's Alpha
        stock_alphas[symbol] = stock_ann_returns[symbol] - (RF + beta * (nifty_ann_return - RF))
            
    df_holdings['Sector'] = df_holdings['Symbol'].map(SECTOR_MAP).fillna('Other')
    df_holdings['Beta'] = df_holdings['Symbol'].map(stock_betas)
    df_holdings['Correlation (vs Nifty)'] = df_holdings['Symbol'].map(stock_corrs)
    df_holdings['Annual Volatility'] = df_holdings['Symbol'].map(stock_vols)
    df_holdings['Avg Daily Return'] = df_holdings['Symbol'].map(stock_avg_rets)
    df_holdings['Max Drawdown'] = df_holdings['Symbol'].map(stock_mdds)
    
    # Report B columns mapping
    df_holdings['Annualized Return'] = df_holdings['Symbol'].map(stock_ann_returns)
    df_holdings['Sharpe Ratio'] = df_holdings['Symbol'].map(stock_sharpes)
    df_holdings['Downside Deviation'] = df_holdings['Symbol'].map(stock_downside_devs)
    df_holdings['Sortino Ratio'] = df_holdings['Symbol'].map(stock_sortinos)
    df_holdings['Treynor Ratio'] = df_holdings['Symbol'].map(stock_treynors)
    df_holdings['Jensens Alpha'] = df_holdings['Symbol'].map(stock_alphas)
    df_holdings['Ulcer Index'] = df_holdings['Symbol'].map(stock_uis)
    
    # 6. Portfolio-Level Covariance, Correlation, and Risk Contributions
    # Create aligned returns DataFrame for holdings
    df_returns_matrix = pd.DataFrame(stock_returns_dict)
    
    # Correlation Matrix
    correlation_matrix = df_returns_matrix.corr()
    
    # Covariance Matrix (Daily returns)
    covariance_matrix = df_returns_matrix.cov()
    
    # Weights vector
    weights = df_holdings.set_index('Symbol')['Weight'].reindex(valid_symbols).values
    
    # Portfolio Daily Volatility
    portfolio_daily_variance = np.dot(weights.T, np.dot(covariance_matrix.values, weights))
    portfolio_daily_volatility = math.sqrt(portfolio_daily_variance)
    portfolio_annualized_volatility = portfolio_daily_volatility * math.sqrt(252)
    
    # Portfolio Beta
    portfolio_beta = np.dot(weights, df_holdings.set_index('Symbol')['Beta'].reindex(valid_symbols).values)
    
    # Marginal Contribution to Risk (MCTR) and Percent Contribution to Risk (PCR)
    # MCTR = Cov(R_i, R_p) / Vol_p = (CovarianceMatrix * Weights) / Vol_p
    cov_with_portfolio = np.dot(covariance_matrix.values, weights)
    stock_mctrs = cov_with_portfolio / portfolio_daily_volatility if portfolio_daily_volatility > 0 else np.zeros_like(weights)
    stock_pcrs = (weights * stock_mctrs) / portfolio_daily_volatility if portfolio_daily_volatility > 0 else np.zeros_like(weights)
    
    mctr_dict = dict(zip(valid_symbols, stock_mctrs))
    pcr_dict = dict(zip(valid_symbols, stock_pcrs))
    
    df_holdings['MCTR (Daily)'] = df_holdings['Symbol'].map(mctr_dict)
    df_holdings['Risk Contribution %'] = df_holdings['Symbol'].map(pcr_dict)
    
    # 7. Portfolio Value at Risk (VaR)
    # Parametric VaR (1-Day, 95% confidence) -> 1.64485 standard deviations
    z_95 = 1.6448536269514722
    parametric_var_pct = z_95 * portfolio_daily_volatility
    parametric_var_value = parametric_var_pct * total_portfolio_value
    
    # Historical Simulation VaR
    # Portfolio daily returns series
    portfolio_daily_returns = df_returns_matrix.dot(weights)
    historical_var_pct = -np.percentile(portfolio_daily_returns, 5) # 5th percentile is -VaR
    historical_var_value = historical_var_pct * total_portfolio_value
    
    # Sector Allocation
    df_sector = df_holdings.groupby('Sector')['Current Value'].sum().reset_index()
    df_sector['Allocation %'] = df_sector['Current Value'] / total_portfolio_value
    df_sector = df_sector.sort_values(by='Allocation %', ascending=False).reset_index(drop=True)
    
    # Report B: Portfolio and Nifty 50 Performance calculations
    # Portfolio Annualized Return (Weighted sum of holdings returns)
    portfolio_ann_return = np.dot(weights, [stock_ann_returns[sym] for sym in valid_symbols])
    
    # Portfolio Downside Deviation
    portfolio_downside_diff = np.minimum(portfolio_daily_returns.values - daily_rf, 0.0)
    portfolio_downside_dev = math.sqrt(np.mean(portfolio_downside_diff ** 2)) * math.sqrt(252)
    
    # Portfolio ratios
    portfolio_sharpe = (portfolio_ann_return - RF) / portfolio_annualized_volatility if portfolio_annualized_volatility > 0 else 0.0
    portfolio_sortino = (portfolio_ann_return - RF) / portfolio_downside_dev if portfolio_downside_dev > 0 else 0.0
    portfolio_treynor = (portfolio_ann_return - RF) / portfolio_beta if portfolio_beta != 0 else 0.0
    portfolio_alpha = portfolio_ann_return - (RF + portfolio_beta * (nifty_ann_return - RF))
    
    # Portfolio Max Drawdown and Ulcer Index (based on actual daily holding quantities close values)
    qty_dict = df_holdings.set_index('Symbol')['Quantity'].to_dict()
    q_vector = np.array([qty_dict[sym] for sym in valid_symbols])
    df_prices_matrix = pd.DataFrame(stock_prices_dict)
    portfolio_value_series = df_prices_matrix.dot(q_vector)
    
    portfolio_value_clean = portfolio_value_series.dropna()
    if not portfolio_value_clean.empty:
        p_roll_max = portfolio_value_clean.cummax()
        p_drawdowns = (portfolio_value_clean - p_roll_max) / p_roll_max
        portfolio_mdd = p_drawdowns.min()
        portfolio_ui = math.sqrt(np.mean(p_drawdowns ** 2)) * 100.0
    else:
        portfolio_mdd = 0.0
        portfolio_ui = 0.0
        
    # Nifty 50 Benchmark Performance calculations
    nifty_v_ann = nifty_returns.std() * math.sqrt(252)
    nifty_downside_diff = np.minimum(nifty_returns.values - daily_rf, 0.0)
    nifty_downside_dev = math.sqrt(np.mean(nifty_downside_diff ** 2)) * math.sqrt(252)
    
    nifty_sharpe = (nifty_ann_return - RF) / nifty_v_ann if nifty_v_ann > 0 else 0.0
    nifty_sortino = (nifty_ann_return - RF) / nifty_downside_dev if nifty_downside_dev > 0 else 0.0
    nifty_treynor = nifty_ann_return - RF # Beta is 1.0
    nifty_alpha = 0.0
    
    if not nifty_prices_clean.empty:
        n_roll_max = nifty_prices_clean.cummax()
        n_drawdowns = (nifty_prices_clean - n_roll_max) / n_roll_max
        n_mdd = n_drawdowns.min()
        n_ui = math.sqrt(np.mean(n_drawdowns ** 2)) * 100.0
    else:
        n_mdd = 0.0
        n_ui = 0.0
        
    # Build Performance Screener DataFrame
    perf_records = []
    
    # Portfolio Row
    perf_records.append({
        'Symbol': 'Portfolio',
        'Sector': 'All',
        '1-Year Return': portfolio_ann_return,
        'Annual Volatility': portfolio_annualized_volatility,
        'Sharpe Ratio': portfolio_sharpe,
        'Downside Deviation': portfolio_downside_dev,
        'Sortino Ratio': portfolio_sortino,
        'Treynor Ratio': portfolio_treynor,
        'Jensens Alpha': portfolio_alpha,
        'Max Drawdown': portfolio_mdd,
        'Ulcer Index': portfolio_ui
    })
    
    # Nifty 50 Row
    perf_records.append({
        'Symbol': 'NIFTY 50',
        'Sector': 'Benchmark',
        '1-Year Return': nifty_ann_return,
        'Annual Volatility': nifty_v_ann,
        'Sharpe Ratio': nifty_sharpe,
        'Downside Deviation': nifty_downside_dev,
        'Sortino Ratio': nifty_sortino,
        'Treynor Ratio': nifty_treynor,
        'Jensens Alpha': nifty_alpha,
        'Max Drawdown': n_mdd,
        'Ulcer Index': n_ui
    })
    
    # Stock Rows (sorted by Sortino Ratio desc)
    df_holdings_sorted = df_holdings.sort_values(by='Sortino Ratio', ascending=False)
    for idx, row in df_holdings_sorted.iterrows():
        perf_records.append({
            'Symbol': row['Symbol'],
            'Sector': row['Sector'],
            '1-Year Return': row['Annualized Return'],
            'Annual Volatility': row['Annual Volatility'],
            'Sharpe Ratio': row['Sharpe Ratio'],
            'Downside Deviation': row['Downside Deviation'],
            'Sortino Ratio': row['Sortino Ratio'],
            'Treynor Ratio': row['Treynor Ratio'],
            'Jensens Alpha': row['Jensens Alpha'],
            'Max Drawdown': row['Max Drawdown'],
            'Ulcer Index': row['Ulcer Index']
        })
        
    df_perf = pd.DataFrame(perf_records)
    
    # Print Console Summary
    logger.info("\n" + "="*50)
    logger.info("PORTFOLIO RISK METRICS SUMMARY")
    logger.info("="*50)
    logger.info(f"Total Portfolio Value          : ₹{total_portfolio_value:,.2f}")
    logger.info(f"Portfolio Beta (vs Nifty 50)   : {portfolio_beta:.3f}")
    logger.info(f"Portfolio Daily Volatility     : {portfolio_daily_volatility*100:.3f}%")
    logger.info(f"Portfolio Annualized Volatility: {portfolio_annualized_volatility*100:.3f}%")
    logger.info(f"Parametric VaR (1-Day, 95%)    : ₹{parametric_var_value:,.2f} ({parametric_var_pct*100:.2f}%)")
    logger.info(f"Historical VaR (1-Day, 95%)    : ₹{historical_var_value:,.2f} ({historical_var_pct*100:.2f}%)")
    logger.info("="*50 + "\n")
    
    # 8. Export to Excel using xlsxwriter
    os.makedirs("portfolio", exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = os.path.join("portfolio", f"Portfolio_Risk_Report_{timestamp}.xlsx")
    latest_link_path = os.path.join("portfolio", "portfolio_risk_report.xlsx")
    
    logger.info(f"Writing Excel Risk Report to {output_path}...")
    
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
        currency_format = workbook.add_format({
            'num_format': '₹#,##0.00',
            'font_name': 'Segoe UI',
            'size': 9,
            'border': 1,
            'align': 'right'
        })
        currency_format_no_paisa = workbook.add_format({
            'num_format': '₹#,##0',
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
        num_format_3dec = workbook.add_format({
            'num_format': '0.000',
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
        card_val_format_curr = workbook.add_format({
            'bold': True,
            'size': 11,
            'font_color': '#1F4E79',
            'font_name': 'Segoe UI',
            'align': 'right',
            'bg_color': '#F8F9F9',
            'num_format': '₹#,##0.00'
        })
        card_val_format_pct = workbook.add_format({
            'bold': True,
            'size': 11,
            'font_color': '#1F4E79',
            'font_name': 'Segoe UI',
            'align': 'right',
            'bg_color': '#F8F9F9',
            'num_format': '0.00%'
        })
        card_val_format_num = workbook.add_format({
            'bold': True,
            'size': 11,
            'font_color': '#1F4E79',
            'font_name': 'Segoe UI',
            'align': 'right',
            'bg_color': '#F8F9F9',
            'num_format': '0.000'
        })
        
        # ----------------------------------------------------
        # SHEET 1: RISK DASHBOARD
        # ----------------------------------------------------
        ws_dash = workbook.add_worksheet("Risk Dashboard")
        ws_dash.hide_gridlines(2) # show grid lines
        
        # Titles
        ws_dash.write('A2', "PORTFOLIO RISK & PERFORMANCE DASHBOARD", title_format)
        ws_dash.write('A3', f"Analysis Date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | Model: Daily Close returns aligned (Past 1 Year)", subtitle_format)
        
        # Risk Summary Card Block (Rows 5 to 11)
        ws_dash.merge_range('A5:C5', "PORTFOLIO SUMMARY RISK METRICS", section_format)
        ws_dash.write('A6', "Total Portfolio Value", card_lbl_format)
        ws_dash.write('A7', "Portfolio Beta (vs Nifty 50)", card_lbl_format)
        ws_dash.write('A8', "Portfolio Daily Volatility", card_lbl_format)
        ws_dash.write('A9', "Portfolio Annualized Volatility", card_lbl_format)
        ws_dash.write('A10', "Parametric VaR (1-Day, 95%)", card_lbl_format)
        ws_dash.write('A11', "Historical VaR (1-Day, 95%)", card_lbl_format)
        
        ws_dash.write('B6', total_portfolio_value, card_val_format_curr)
        ws_dash.write('B7', portfolio_beta, card_val_format_num)
        ws_dash.write('B8', portfolio_daily_volatility, card_val_format_pct)
        ws_dash.write('B9', portfolio_annualized_volatility, card_val_format_pct)
        ws_dash.write('B10', parametric_var_value, card_val_format_curr)
        ws_dash.write('B11', historical_var_value, card_val_format_curr)
        
        ws_dash.write('C6', "", card_val_format_pct)
        ws_dash.write('C7', "Market neutral = 1.00", card_lbl_format)
        ws_dash.write('C8', "", card_val_format_pct)
        ws_dash.write('C9', "", card_val_format_pct)
        ws_dash.write('C10', parametric_var_pct, card_val_format_pct)
        ws_dash.write('C11', historical_var_pct, card_val_format_pct)
        
        # Border outline for metrics card
        border_fmt = workbook.add_format({'border': 1, 'bg_color': '#F8F9F9'})
        ws_dash.set_column('A:A', 28)
        ws_dash.set_column('B:B', 18)
        ws_dash.set_column('C:C', 18)
        
        # Sector Allocation Summary (Rows 5 to 13 on columns E-G)
        ws_dash.merge_range('E5:G5', "SECTOR EXPOSURE SUMMARY", section_format)
        ws_dash.write(5, 4, "Sector Name", header_format)
        ws_dash.write(5, 5, "Current Value", header_format)
        ws_dash.write(5, 6, "Allocation %", header_format)
        
        for r_idx, row in df_sector.iterrows():
            excel_r = 6 + r_idx
            ws_dash.write(excel_r, 4, row['Sector'], text_format)
            ws_dash.write(excel_r, 5, float(row['Current Value']), currency_format_no_paisa)
            ws_dash.write(excel_r, 6, float(row['Allocation %']), pct_format)
            
        ws_dash.set_column('E:E', 22)
        ws_dash.set_column('F:F', 15)
        ws_dash.set_column('G:G', 12)
        
        # Holdings Risk Breakdown table (Starts at row 14)
        start_row_holdings = 14
        ws_dash.merge_range(f'A{start_row_holdings+1}:J{start_row_holdings+1}', "HOLDINGS RISK & DIVERSIFICATION DETAILS", section_format)
        
        headers = [
            "Symbol", "Sector", "Quantity", "Avg Cost", "LTP", 
            "Current Value", "Weight", "Beta", "Corr (vs Nifty)", 
            "Annual Vol", "Max Drawdown", "Risk Contribution %"
        ]
        
        for col_idx, h in enumerate(headers):
            fmt = stock_header_format if col_idx in [0, 1] else header_format
            ws_dash.write(start_row_holdings + 1, col_idx, h, fmt)
            
        ws_dash.freeze_panes(start_row_holdings + 2, 0)
        
        for r_idx, row in df_holdings.iterrows():
            excel_r = start_row_holdings + 2 + r_idx
            ws_dash.write(excel_r, 0, row['Symbol'], stock_name_format)
            ws_dash.write(excel_r, 1, row['Sector'], text_format)
            ws_dash.write(excel_r, 2, int(row['Quantity']), int_format)
            ws_dash.write(excel_r, 3, float(row['Avg Cost']), currency_format)
            ws_dash.write(excel_r, 4, float(row['Current Price']), currency_format)
            ws_dash.write(excel_r, 5, float(row['Current Value']), currency_format_no_paisa)
            ws_dash.write(excel_r, 6, float(row['Weight']), pct_format)
            ws_dash.write(excel_r, 7, float(row['Beta']), num_format_3dec)
            ws_dash.write(excel_r, 8, float(row['Correlation (vs Nifty)']), num_format_2dec)
            ws_dash.write(excel_r, 9, float(row['Annual Volatility']), pct_format)
            ws_dash.write(excel_r, 10, float(row['Max Drawdown']), pct_format_signed)
            ws_dash.write(excel_r, 11, float(row['Risk Contribution %']), pct_format)
            
        # Format columns widths for holdings detail
        ws_dash.set_column('A:A', 12)
        ws_dash.set_column('B:B', 18)
        ws_dash.set_column('C:C', 10)
        ws_dash.set_column('D:E', 12, currency_format)
        ws_dash.set_column('F:F', 15, currency_format_no_paisa)
        ws_dash.set_column('G:G', 10, pct_format)
        ws_dash.set_column('H:H', 10, num_format_3dec)
        ws_dash.set_column('I:I', 15, num_format_2dec)
        ws_dash.set_column('J:L', 15, pct_format)
        
        # Color Scale Conditional formatting for Weight, Beta, Max Drawdown, Risk Contribution %
        green_format = workbook.add_format({'bg_color': '#C6EFCE', 'font_color': '#006100'})
        red_format = workbook.add_format({'bg_color': '#FFC7CE', 'font_color': '#9C0006'})
        blue_format = workbook.add_format({'bg_color': '#DDEBF7', 'font_color': '#1F497D'})
        
        # Weight coloring
        ws_dash.conditional_format(start_row_holdings+2, 6, start_row_holdings+1+len(df_holdings), 6, {
            'type': '3_color_scale',
            'min_value': 0.0,
            'min_type': 'num',
            'min_color': '#FFFFFF',
            'mid_value': 0.10,
            'mid_type': 'num',
            'mid_color': '#EBF5FB',
            'max_value': 0.30,
            'max_type': 'num',
            'max_color': '#AED6F1'
        })
        
        # Beta coloring: Defensive (<0.8) is Green, Aggressive (>1.2) is Red
        ws_dash.conditional_format(start_row_holdings+2, 7, start_row_holdings+1+len(df_holdings), 7, {
            'type': '3_color_scale',
            'min_value': 0.5,
            'min_type': 'num',
            'min_color': '#C6EFCE', # Green (defensive)
            'mid_value': 1.0,
            'mid_type': 'num',
            'mid_color': '#FFFFFF',
            'max_value': 1.5,
            'max_type': 'num',
            'max_color': '#FFC7CE'  # Red (aggressive)
        })
        
        # Max Drawdown coloring: More negative is Red
        ws_dash.conditional_format(start_row_holdings+2, 10, start_row_holdings+1+len(df_holdings), 10, {
            'type': '3_color_scale',
            'min_value': -0.40,
            'min_type': 'num',
            'min_color': '#FFC7CE', # Deep red
            'mid_value': -0.15,
            'mid_type': 'num',
            'mid_color': '#FFFFFF',
            'max_value': 0.0,
            'max_type': 'num',
            'max_color': '#C6EFCE' # Green
        })
        
        # Risk Contribution coloring
        ws_dash.conditional_format(start_row_holdings+2, 11, start_row_holdings+1+len(df_holdings), 11, {
            'type': '3_color_scale',
            'min_value': 0.0,
            'min_type': 'num',
            'min_color': '#FFFFFF',
            'mid_value': 0.10,
            'mid_type': 'num',
            'mid_color': '#FCF3CF', # soft yellow
            'max_value': 0.30,
            'max_type': 'num',
            'max_color': '#F5B7B1'  # soft red
        })
        
        # ----------------------------------------------------
        # SHEET 2: PERFORMANCE SCREENER
        # ----------------------------------------------------
        ws_perf = workbook.add_worksheet("Performance Screener")
        ws_perf.hide_gridlines(2)
        
        ws_perf.write('A2', "PORTFOLIO & STOCKS PERFORMANCE SCREENER", title_format)
        ws_perf.write('A3', f"Analysis Date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | Risk-Free Rate = {RF*100:.1f}% | Sorted by Sortino Ratio", subtitle_format)
        
        # Section Header
        ws_perf.merge_range('A5:K5', "RISK-ADJUSTED PERFORMANCE RANKING", section_format)
        
        headers_perf = [
            "Symbol", "Sector", "1-Year Return", "Annual Volatility", 
            "Sharpe Ratio", "Downside Dev", "Sortino Ratio", 
            "Treynor Ratio", "Jensen's Alpha", "Max Drawdown", "Ulcer Index"
        ]
        
        for col_idx, h in enumerate(headers_perf):
            fmt = stock_header_format if col_idx in [0, 1] else header_format
            ws_perf.write(5, col_idx, h, fmt)
            
        ws_perf.freeze_panes(6, 0)
        
        # Format rows
        portfolio_format = workbook.add_format({
            'bold': True,
            'font_name': 'Segoe UI',
            'size': 10,
            'border': 1,
            'bg_color': '#DDEBF7' # Soft blue
        })
        portfolio_format_pct = workbook.add_format({
            'bold': True,
            'font_name': 'Segoe UI',
            'size': 9,
            'border': 1,
            'align': 'right',
            'bg_color': '#DDEBF7',
            'num_format': '0.00%'
        })
        portfolio_format_pct_signed = workbook.add_format({
            'bold': True,
            'font_name': 'Segoe UI',
            'size': 9,
            'border': 1,
            'align': 'right',
            'bg_color': '#DDEBF7',
            'num_format': '+0.00%;-0.00%;0.00%'
        })
        portfolio_format_num = workbook.add_format({
            'bold': True,
            'font_name': 'Segoe UI',
            'size': 9,
            'border': 1,
            'align': 'right',
            'bg_color': '#DDEBF7',
            'num_format': '0.00'
        })
        
        nifty_format = workbook.add_format({
            'bold': True,
            'italic': True,
            'font_name': 'Segoe UI',
            'size': 10,
            'border': 1,
            'bg_color': '#F2F4F4' # Light grey
        })
        nifty_format_pct = workbook.add_format({
            'bold': True,
            'italic': True,
            'font_name': 'Segoe UI',
            'size': 9,
            'border': 1,
            'align': 'right',
            'bg_color': '#F2F4F4',
            'num_format': '0.00%'
        })
        nifty_format_pct_signed = workbook.add_format({
            'bold': True,
            'italic': True,
            'font_name': 'Segoe UI',
            'size': 9,
            'border': 1,
            'align': 'right',
            'bg_color': '#F2F4F4',
            'num_format': '+0.00%;-0.00%;0.00%'
        })
        nifty_format_num = workbook.add_format({
            'bold': True,
            'italic': True,
            'font_name': 'Segoe UI',
            'size': 9,
            'border': 1,
            'align': 'right',
            'bg_color': '#F2F4F4',
            'num_format': '0.00'
        })
        
        # Formatting cell formats
        pct_format_p = workbook.add_format({'num_format': '0.00%', 'font_name': 'Segoe UI', 'size': 9, 'border': 1, 'align': 'right'})
        pct_format_p_signed = workbook.add_format({'num_format': '+0.00%;-0.00%;0.00%', 'font_name': 'Segoe UI', 'size': 9, 'border': 1, 'align': 'right'})
        num_format_2dec_p = workbook.add_format({'num_format': '0.00', 'font_name': 'Segoe UI', 'size': 9, 'border': 1, 'align': 'right'})
        
        for r_idx, row in df_perf.iterrows():
            excel_r = 6 + r_idx
            is_portfolio = (row['Symbol'] == 'Portfolio')
            is_nifty = (row['Symbol'] == 'NIFTY 50')
            
            if is_portfolio:
                lbl_fmt = portfolio_format
                pct_fmt_c = portfolio_format_pct
                pct_signed_fmt_c = portfolio_format_pct_signed
                num_fmt_c = portfolio_format_num
            elif is_nifty:
                lbl_fmt = nifty_format
                pct_fmt_c = nifty_format_pct
                pct_signed_fmt_c = nifty_format_pct_signed
                num_fmt_c = nifty_format_num
            else:
                lbl_fmt = stock_name_format if r_idx % 2 == 0 else text_format
                pct_fmt_c = pct_format_p
                pct_signed_fmt_c = pct_format_p_signed
                num_fmt_c = num_format_2dec_p
                
            ws_perf.write(excel_r, 0, row['Symbol'], lbl_fmt)
            ws_perf.write(excel_r, 1, row['Sector'], lbl_fmt)
            ws_perf.write(excel_r, 2, float(row['1-Year Return']), pct_signed_fmt_c)
            ws_perf.write(excel_r, 3, float(row['Annual Volatility']), pct_fmt_c)
            ws_perf.write(excel_r, 4, float(row['Sharpe Ratio']), num_fmt_c)
            ws_perf.write(excel_r, 5, float(row['Downside Deviation']), pct_fmt_c)
            ws_perf.write(excel_r, 6, float(row['Sortino Ratio']), num_fmt_c)
            ws_perf.write(excel_r, 7, float(row['Treynor Ratio']), pct_signed_fmt_c)
            ws_perf.write(excel_r, 8, float(row['Jensens Alpha']), pct_signed_fmt_c)
            ws_perf.write(excel_r, 9, float(row['Max Drawdown']), pct_signed_fmt_c)
            ws_perf.write(excel_r, 10, float(row['Ulcer Index']), num_fmt_c)
            
        # Format widths
        ws_perf.set_column('A:A', 12) # Symbol
        ws_perf.set_column('B:B', 18) # Sector
        ws_perf.set_column('C:K', 14) # Metrics
        
        # Apply conditional formatting on Sharpe Ratio, Sortino Ratio, Jensen's Alpha, and Maximum Drawdown
        start_stock_row = 8 # Portfolio is 6, Nifty is 7, stocks start at index 8
        end_stock_row = 6 + len(df_perf) - 1
        
        # Sharpe Ratio (column E, idx 4)
        ws_perf.conditional_format(start_stock_row, 4, end_stock_row, 4, {
            'type': '3_color_scale',
            'min_value': 0.0, 'min_type': 'num', 'min_color': '#FFC7CE',
            'mid_value': 1.0, 'mid_type': 'num', 'mid_color': '#FFFFFF',
            'max_value': 2.5, 'max_type': 'num', 'max_color': '#C6EFCE'
        })
        
        # Sortino Ratio (column G, idx 6)
        ws_perf.conditional_format(start_stock_row, 6, end_stock_row, 6, {
            'type': '3_color_scale',
            'min_value': 0.0, 'min_type': 'num', 'min_color': '#FFC7CE',
            'mid_value': 1.5, 'mid_type': 'num', 'mid_color': '#FFFFFF',
            'max_value': 3.5, 'max_type': 'num', 'max_color': '#C6EFCE'
        })
        
        # Jensen's Alpha (column I, idx 8)
        ws_perf.conditional_format(start_stock_row, 8, end_stock_row, 8, {
            'type': '3_color_scale',
            'min_value': -0.15, 'min_type': 'num', 'min_color': '#FFC7CE',
            'mid_value': 0.0, 'mid_type': 'num', 'mid_color': '#FFFFFF',
            'max_value': 0.25, 'max_type': 'num', 'max_color': '#C6EFCE'
        })
        
        # Max Drawdown (column J, idx 9)
        ws_perf.conditional_format(start_stock_row, 9, end_stock_row, 9, {
            'type': '3_color_scale',
            'min_value': -0.40, 'min_type': 'num', 'min_color': '#FFC7CE',
            'mid_value': -0.15, 'mid_type': 'num', 'mid_color': '#FFFFFF',
            'max_value': 0.0, 'max_type': 'num', 'max_color': '#C6EFCE'
        })

        # ----------------------------------------------------
        # SHEET 3: CORRELATION MATRIX
        # ----------------------------------------------------
        ws_corr = workbook.add_worksheet("Correlation Matrix")
        ws_corr.hide_gridlines(2)
        
        ws_corr.write('A2', "PORTFOLIO HOLDINGS CORRELATION HEATMAP", title_format)
        ws_corr.write('A3', "Measures Pearson Correlation Coefficient (r) based on daily returns for the past 1 year.", subtitle_format)
        
        # Section Header
        ws_corr.merge_range(4, 0, 4, len(valid_symbols), "CROSS-CORRELATION MATRIX (DAILY RETURNS)", section_format)
        
        # Write Column Headers
        ws_corr.write(5, 0, "Stock", header_format)
        for col_idx, symbol in enumerate(valid_symbols):
            ws_corr.write(5, col_idx + 1, symbol, header_format)
            
        ws_corr.freeze_panes(6, 1)
        
        # Write rows
        for r_idx, symbol_r in enumerate(valid_symbols):
            excel_r = 6 + r_idx
            # Row Header
            ws_corr.write(excel_r, 0, symbol_r, stock_name_format)
            
            for c_idx, symbol_c in enumerate(valid_symbols):
                corr_val = correlation_matrix.at[symbol_r, symbol_c]
                # Format diagonal differently or let it blend
                ws_corr.write(excel_r, c_idx + 1, float(corr_val), num_format_2dec)
                
        # Set column widths and row heights
        ws_corr.set_column(0, 0, 15)
        ws_corr.set_column(1, len(valid_symbols), 11)
        ws_corr.set_row(5, 25)
        for r_idx in range(len(valid_symbols)):
            ws_corr.set_row(6 + r_idx, 20)
            
        # Apply matrix color scale conditional formatting (Symmetric color scale)
        # 1.0 (highly positive) = Red, 0.0 (uncorrelated) = White, -1.0 (highly negative) = Blue
        start_cell = xlsxwriter.utility.xl_rowcol_to_cell(6, 1)
        end_cell = xlsxwriter.utility.xl_rowcol_to_cell(6 + len(valid_symbols) - 1, len(valid_symbols))
        
        ws_corr.conditional_format(f"{start_cell}:{end_cell}", {
            'type': '3_color_scale',
            'min_value': 0.0,
            'min_type': 'num',
            'min_color': '#FFFFFF', # White for low/uncorrelated (since stocks are rarely negative in indices)
            'mid_value': 0.5,
            'mid_type': 'num',
            'mid_color': '#FCF3CF', # Yellow for moderate correlation
            'max_value': 1.0,
            'max_type': 'num',
            'max_color': '#F5B7B1'  # Soft Red for high correlation
        })
        
        # ----------------------------------------------------
        # SHEET 3: RISK GLOSSARY
        # ----------------------------------------------------
        ws_gloss = workbook.add_worksheet("Risk Glossary")
        ws_gloss.hide_gridlines(2)
        
        ws_gloss.write('A2', "RISK GLOSSARY & DOCUMENTATION", title_format)
        ws_gloss.write('A3', "Definitions, formulas, and interpretations of portfolio risk metrics.", subtitle_format)
        
        gloss_header_format = workbook.add_format({
            'bold': True,
            'bg_color': '#1F4E79',
            'font_color': '#FFFFFF',
            'align': 'left',
            'valign': 'vcenter',
            'border': 1,
            'font_name': 'Segoe UI',
            'size': 10
        })
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
        
        headers = ["Risk Metric", "Definition & Formula", "How to Interpret", "Target Range for Investors"]
        for col_idx, h in enumerate(headers):
            ws_gloss.write(5, col_idx, h, gloss_header_format)
            
        gloss_data = [
            (
                "Portfolio Beta",
                "Weighted average of individual stock betas relative to Nifty 50:\nBeta = Sum(Weight_i * Beta_i)",
                "Measures systematic risk (sensitivity to market moves).\nBeta = 1.0 means the portfolio moves in sync with Nifty.\nBeta > 1.0 is aggressive; Beta < 1.0 is defensive.",
                "Long-term Conservative: 0.70 - 0.90\nAggressive/Growth: 1.10 - 1.30"
            ),
            (
                "Portfolio Annualized Volatility",
                "Standard deviation of daily portfolio returns scaled to a year:\nVol_ann = Vol_daily * sqrt(252)",
                "Measures the dispersion of historical returns. High volatility means larger single-day price swings.",
                "Stable Equity Portfolio: 12.0% - 18.0%\nHigh Risk Portfolio: > 22.0%"
            ),
            (
                "Parametric Value at Risk (1D, 95% VaR)",
                "Based on the normal distribution assumption:\nVaR = 1.645 * Daily Volatility * Portfolio Value",
                "The maximum portfolio loss expected over a single day with a 95% probability. There is only a 5% chance of losing more than this amount.",
                "Typically ranges between 1.5% and 2.5% of total portfolio value."
            ),
            (
                "Historical Simulation VaR (1D, 95% VaR)",
                "Calculated by sorting historical portfolio returns and finding the 5th percentile worst return.",
                "Uses actual historical returns directly without assuming normal distribution (accounts for fat tails and extreme events).",
                "Often slightly larger than Parametric VaR, reflecting market tail risk."
            ),
            (
                "Marginal Contribution to Risk (MCTR)",
                "MCTR_i = Cov(R_i, R_p) / Vol_p\nRepresents the change in portfolio risk due to a small increase in stock weight.",
                "Identifies which stock is the primary risk driver. If a stock has an MCTR higher than portfolio volatility, adding to it increases overall risk.",
                "Should ideally be close to the overall daily volatility for optimal risk parity."
            ),
            (
                "Risk Contribution % (PCR)",
                "PCR_i = (Weight_i * MCTR_i) / Vol_p\nThe percentage of total portfolio volatility contributed by asset i.",
                "Reveals risk concentration. A stock might represent 10% of portfolio value but contribute 25% of portfolio risk due to high volatility.",
                "No single stock should ideally contribute > 25% of total portfolio risk."
            ),
            (
                "Maximum Drawdown (MDD)",
                "Max peak-to-trough decline over the 1-year historical price series.",
                "Represents the worst paper loss experienced by the stock over the past year.",
                "Lower drawdowns indicate higher stability during market corrections."
            ),
            (
                "Sharpe Ratio",
                "Sharpe = (Annualized Return - Risk-Free Rate) / Annualized Volatility",
                "Measures the excess return earned per unit of total risk (standard deviation). A higher Sharpe ratio indicates better risk-adjusted return efficiency.",
                "Good: 1.0 - 1.9\nExcellent: 2.0 - 2.9\nOutstanding: >= 3.0"
            ),
            (
                "Downside Deviation",
                "Volatility of daily returns calculated using only negative returns below the daily risk-free rate hurdle.",
                "Measures downside risk specifically, ignoring positive volatility (which is beneficial to the investor).",
                "Lower is better; directly used in calculating the Sortino ratio."
            ),
            (
                "Sortino Ratio",
                "Sortino = (Annualized Return - Risk-Free Rate) / Downside Deviation",
                "Measures the excess return earned per unit of downside risk. Superior to the Sharpe ratio for skewed returns as it doesn't penalize upside volatility.",
                "Good: 1.5 - 2.4\nExcellent: 2.5 - 3.4\nOutstanding: >= 3.5"
            ),
            (
                "Treynor Ratio",
                "Treynor = (Annualized Return - Risk-Free Rate) / Beta",
                "Measures the excess return earned per unit of systematic market risk (Beta). Suitable for well-diversified portfolios.",
                "Higher indicates better return generation per unit of systematic risk."
            ),
            (
                "Jensen's Alpha",
                "Alpha = Return_stock - [Rf + Beta * (Return_market - Rf)]",
                "The abnormal return generated above the CAPM benchmark. A positive Alpha indicates the stock beat Nifty on a beta-adjusted basis.",
                "Positive values represent value addition/outperformance (Alpha generation)."
            ),
            (
                "Ulcer Index (UI)",
                "UI = sqrt(Mean(Drawdown_t^2)) * 100",
                "Measures both the depth and duration of price drawdowns over the year. A lower index means the stock recovers quickly from shallow drawdowns.",
                "Conservative Stock: < 5.0\nHigh-Risk Growth Stock: > 15.0"
            )
        ]
        
        for r_idx, row in enumerate(gloss_data):
            excel_r = 6 + r_idx
            ws_gloss.write(excel_r, 0, row[0], gloss_metric_format)
            ws_gloss.write(excel_r, 1, row[1], gloss_text_format)
            ws_gloss.write(excel_r, 2, row[2], gloss_text_format)
            ws_gloss.write(excel_r, 3, row[3], gloss_text_format)
            
        ws_gloss.set_column('A:A', 25)
        ws_gloss.set_column('B:B', 40)
        ws_gloss.set_column('C:C', 45)
        ws_gloss.set_column('D:D', 35)
        
        ws_gloss.set_row(5, 25)
        for r_idx in range(len(gloss_data)):
            ws_gloss.set_row(6 + r_idx, 55) # height for text wrapping
            
        writer.close()
        logger.info(f"[SUCCESS] Portfolio Risk Report generated successfully at: {os.path.abspath(output_path)}")
        
        # 9. Maintain a static symbolic link / copy as 'portfolio_risk_report.xlsx'
        try:
            import shutil
            shutil.copy2(output_path, latest_link_path)
            logger.info(f"Updated latest shortcut copy at: {os.path.abspath(latest_link_path)}")
        except Exception as e:
            logger.warning(f"Could not update static shortcut copy: {e}")
            
    except PermissionError:
        logger.critical(f"[FAIL] Permission denied. Is the file {output_path} open in Excel?")
    except Exception as e:
        logger.critical(f"[FAIL] Error writing Excel report: {e}")

if __name__ == "__main__":
    main()
