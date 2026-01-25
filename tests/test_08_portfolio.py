
"""
Test 08: Portfolio & Risk (Funds, Positions, Holdings)
"""
import sys
import os
import pandas as pd
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def run(helper=None):
    print("\n" + "="*60)
    print("TEST 08: PORTFOLIO & RISK")
    print("="*60)
    
    try:
        if helper is None:
            dhan = get_dhan_client()
            helper = DhanHelper(dhan)
        
        # 1. Funds
        balance = helper.funds()
        print(f"[OK] Available Funds: Rs. {balance}")
        
        # 2. Holdings
        holdings = helper.holdings()
        if isinstance(holdings, pd.DataFrame):
            count = len(holdings)
            print(f"[OK] Holdings: Found {count} stocks")
            if count > 0:
                cols = ['tradingSymbol', 'totalQty', 'avgCostPrice']
                available_cols = [c for c in cols if c in holdings.columns]
                print(holdings[available_cols].head())
        else:
            print("[FAIL] Holdings returned invalid type")
            return False
            
        # 3. Positions
        positions = helper.positions()
        if isinstance(positions, pd.DataFrame):
            count = len(positions)
            print(f"[OK] Positions: Found {count} active positions")
            if count > 0:
                cols = ['tradingSymbol', 'netQty', 'realizedProfit', 'unrealizedProfit']
                available_cols = [c for c in cols if c in positions.columns]
                print(positions[available_cols].head())
        else:
            print("[FAIL] Positions returned invalid type")
            return False
            
        return True
        
    except Exception as e:
        print(f"[ERROR] Exception during portfolio test: {e}")
        return False

if __name__ == "__main__":
    run()
