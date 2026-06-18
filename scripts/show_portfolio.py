from login import get_dhan_client
from lib.dhan_helper import DhanHelper
import pandas as pd

def show_portfolio():
    # 1. Initialize
    dhan = get_dhan_client()
    if not dhan:
        print("Failed to connect to Dhan.")
        return
        
    helper = DhanHelper(dhan)
    
    print("\n" + "="*50)
    print("      DHAN PORTFOLIO & POSITIONS REPORT")
    print("="*50)
    
    # 2. Get Available Funds
    funds = helper.get_available_funds()
    print(f"\n[FUNDS] Available Margin: Rs. {funds}")
    
    # 3. Get Holdings
    print("\n[HOLDINGS]")
    df_holdings = helper.get_holdings()
    if not df_holdings.empty:
        # Select key columns for display
        cols = ['tradingSymbol', 'totalQty', 'avgCostPrice', 'lastPrice', 'pnl']
        cols = [c for c in cols if c in df_holdings.columns]
        print(df_holdings[cols].to_string(index=False))
    else:
        print("No holdings found.")
        
    # 4. Get Positions
    print("\n[POSITIONS]")
    df_positions = helper.get_positions()
    if not df_positions.empty:
        # Select key columns for display
        cols = ['tradingSymbol', 'positionType', 'netQty', 'buyAvg', 'sellAvg', 'lastPrice', 'realizedProfit', 'unrealizedProfit']
        cols = [c for c in cols if c in df_positions.columns]
        print(df_positions[cols].to_string(index=False))
    else:
        print("No active positions found.")
        
    print("\n" + "="*50)

if __name__ == "__main__":
    show_portfolio()
