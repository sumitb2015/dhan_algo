import pandas as pd
import os
import sys
from datetime import datetime
import logging
import math

# Add project root to path for imports
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def generate_report():
    """
    Fetches portfolio holdings and generates a formatted Excel report.
    Includes:
    1. Current Portfolio Performance
    2. Investment Plan (Lump sum target)
    3. Daily SIP Plan (₹8,000/day deployment)
    """
    INVESTIBLE_AMOUNT = 500000
    DAILY_SIP_AMOUNT = 8000
    
    logger.info("Initializing Dhan client...")
    dhan = get_dhan_client()
    if not dhan:
        logger.error("Failed to login to Dhan.")
        return

    helper = DhanHelper(dhan)
    
    logger.info("Fetching holdings...")
    holdings_df = helper.get_holdings()
    
    if holdings_df.empty:
        logger.warning("No holdings found in the account. Creating plan from scratch...")
        holdings_df = pd.DataFrame({
            'tradingSymbol': ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK'],
            'totalQty': [0, 0, 0, 0, 0],
            'avgCostPrice': [0, 0, 0, 0, 0],
            'lastTradedPrice': [0, 0, 0, 0, 0]
        })
    
    if 'lastTradedPrice' not in holdings_df.columns and 'currentMarketPrice' in holdings_df.columns:
        holdings_df['lastTradedPrice'] = holdings_df['currentMarketPrice']

    required = ['tradingSymbol', 'totalQty', 'avgCostPrice', 'lastTradedPrice']
    for col in required:
        if col not in holdings_df.columns:
            logger.error(f"Missing required column in holdings: {col}")
            return

    report_df = holdings_df.copy()
    
    # --- PERFORMANCE METRICS ---
    report_df['Invested Value'] = report_df['totalQty'] * report_df['avgCostPrice']
    report_df['Current Price'] = report_df['lastTradedPrice']
    report_df['Current Value'] = report_df['totalQty'] * report_df['Current Price']
    report_df['Unrealized P&L'] = report_df['Current Value'] - report_df['Invested Value']
    report_df['P&L %'] = (report_df['Unrealized P&L'] / report_df['Invested Value']).fillna(0)
    
    total_current_value = report_df['Current Value'].sum()
    report_df['Allocation %'] = (report_df['Current Value'] / total_current_value).fillna(0)
    
    display_df = report_df[[
        'tradingSymbol', 'totalQty', 'avgCostPrice', 'Current Price', 
        'Invested Value', 'Current Value', 'Unrealized P&L', 'P&L %', 'Allocation %'
    ]].copy()
    
    display_df.columns = [
        'Symbol', 'Quantity', 'Avg Cost', 'Current Price', 
        'Invested Value', 'Current Value', 'P&L', 'P&L %', 'Allocation %'
    ]
    
    # --- INVESTMENT PLAN LOGIC ---
    plan_df = report_df.copy()
    num_stocks = len(plan_df)
    allocation_per_stock = INVESTIBLE_AMOUNT / num_stocks
    
    plan_df['Target New Investment'] = allocation_per_stock
    plan_df['Units to Buy'] = (plan_df['Target New Investment'] / plan_df['Current Price']).apply(lambda x: int(x) if x > 0 else 0)
    plan_df['Approx Fresh Investment'] = plan_df['Units to Buy'] * plan_df['Current Price']
    plan_df['New Total Quantity'] = plan_df['totalQty'] + plan_df['Units to Buy']
    plan_df['New Estimated Value'] = plan_df['New Total Quantity'] * plan_df['Current Price']
    
    total_new_value = plan_df['New Estimated Value'].sum()
    plan_df['Target Weight %'] = (plan_df['New Estimated Value'] / total_new_value)
    
    plan_display = plan_df[[
        'tradingSymbol', 'totalQty', 'Units to Buy', 'New Total Quantity', 
        'Current Price', 'Approx Fresh Investment', 'New Estimated Value', 'Target Weight %'
    ]].copy()
    
    plan_display.columns = [
        'Symbol', 'Existing Qty', 'Suggested Buy', 'Total Qty(Post)', 
        'LTP', 'Investment Required', 'Estimated Value', 'Target Weight'
    ]
    
    # --- DAILY SIP PLAN LOGIC ---
    sip_df = plan_df.copy()
    num_stocks = len(sip_df)
    total_days = math.ceil(INVESTIBLE_AMOUNT / DAILY_SIP_AMOUNT)
    
    # Daily budget per stock (Proportional to their target fresh investment)
    sip_df['Daily Budget'] = DAILY_SIP_AMOUNT / num_stocks
    
    # Calculate Frequency, Instructions and Days to Finish
    def get_sip_details(row):
        ltp = row['Current Price']
        budget = row['Daily Budget']
        total_needed = row['Units to Buy']
        if ltp <= 0 or total_needed <= 0: return "N/A", 0
        
        daily_units = math.floor(budget / ltp)
        if daily_units >= 1:
            days = math.ceil(total_needed / daily_units)
            return f"Buy {daily_units} daily", days
        else:
            # Periodic buy: 1 unit every N days
            frequency = math.ceil(ltp / budget)
            days = total_needed * frequency
            return f"Buy 1 every {frequency} days", days

    details = sip_df.apply(get_sip_details, axis=1)
    sip_df['SIP Instruction'] = [d[0] for d in details]
    sip_df['Est. Days to Finish'] = [d[1] for d in details]
    
    sip_display = sip_df[[
        'tradingSymbol', 'Current Price', 'Daily Budget', 'SIP Instruction', 'Units to Buy', 'Est. Days to Finish'
    ]].copy()
    
    sip_display.columns = [
        'Symbol', 'LTP', 'Daily Budget(₹)', 'SIP Instruction', 'Total Units Needed', 'Est. Days to Finish'
    ]
    
    # --- EXCEL GENERATION ---
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    report_dir = os.path.join(project_root, "portfolio")
    os.makedirs(report_dir, exist_ok=True)
    report_path = os.path.join(report_dir, f"Portfolio_Report_{timestamp}.xlsx")
    
    logger.info(f"Generating Excel report at {report_path}...")
    
    with pd.ExcelWriter(report_path, engine='xlsxwriter') as writer:
        display_df.to_excel(writer, sheet_name='Current Portfolio', index=False)
        plan_display.to_excel(writer, sheet_name='Investment Plan', index=False)
        sip_display.to_excel(writer, sheet_name='Daily SIP Plan', index=False)
        
        workbook = writer.book
        
        # Formats
        header_fmt = workbook.add_format({'bold': True, 'fg_color': '#D7E4BC', 'border': 1})
        curr_fmt = workbook.add_format({'num_format': '₹#,##0.00'})
        pct_fmt = workbook.add_format({'num_format': '0.00%'})
        num_fmt = workbook.add_format({'num_format': '0.00'})
        green_fmt = workbook.add_format({'font_color': '#006100', 'bg_color': '#C6EFCE'})
        red_fmt = workbook.add_format({'font_color': '#9C0006', 'bg_color': '#FFC7CE'})
        
        # Format Sheet 1
        ws1 = writer.sheets['Current Portfolio']
        for i, col in enumerate(display_df.columns): ws1.write(0, i, col, header_fmt)
        ws1.set_column('A:A', 15); ws1.set_column('B:B', 10); ws1.set_column('C:G', 15, curr_fmt); ws1.set_column('H:I', 12, pct_fmt)
        
        # Format Sheet 2
        ws2 = writer.sheets['Investment Plan']
        for i, col in enumerate(plan_display.columns): ws2.write(0, i, col, header_fmt)
        ws2.set_column('A:A', 15); ws2.set_column('B:D', 12); ws2.set_column('E:G', 15, curr_fmt); ws2.set_column('H:H', 15, pct_fmt)
        
        # Format Sheet 3 (SIP)
        ws3 = writer.sheets['Daily SIP Plan']
        for i, col in enumerate(sip_display.columns): ws3.write(0, i, col, header_fmt)
        ws3.set_column('A:A', 15) # Symbol
        ws3.set_column('B:C', 15, curr_fmt) # LTP, Budget
        ws3.set_column('D:D', 25) # SIP Instruction
        ws3.set_column('E:F', 18) # Units Needed, Days
        
        # SIP Summary
        row = len(sip_display) + 2
        ws3.write(row, 0, "SIP Execution Summary", header_fmt)
        ws3.write(row+1, 0, "Total Target Investment"); ws3.write(row+1, 1, INVESTIBLE_AMOUNT, curr_fmt)
        ws3.write(row+2, 0, "Daily Budget Portfolio-wide"); ws3.write(row+2, 1, DAILY_SIP_AMOUNT, curr_fmt)
        ws3.write(row+3, 0, "Deployment Duration (Days)"); ws3.write(row+3, 1, total_days)
        ws3.write(row+4, 0, "Instruction Node"); ws3.write(row+4, 1, "Buy orders should be placed manually or via scheduled script")
        
    logger.info("Report generated successfully.")
    print(f"\nPortfolio report with SIP Plan generated: {report_path}")

if __name__ == "__main__":
    generate_report()
