
"""
Test 10: Trade Audit (Trade Book & History)
"""
import sys
import os
import pandas as pd
from datetime import datetime, timedelta
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def run(helper=None):
    print("\n" + "="*60)
    print("TEST 10: TRADE AUDIT")
    print("="*60)
    
    try:
        if helper is None:
            dhan = get_dhan_client()
            helper = DhanHelper(dhan)
        
        # 1. Fetch Today's Trade Book
        print(">>> Fetching Today's Trade Book...")
        trades = helper.get_trade_book()
        print(f"[OK] Found {len(trades)} trades today.")
        
        if len(trades) > 0:
            df = pd.DataFrame(trades)
            cols = ['orderId', 'tradingSymbol', 'tradedPrice', 'tradedQuantity', 'transactionType']
            available_cols = [c for c in cols if c in df.columns]
            print(df[available_cols].head())
            
        # 2. Fetch Trade History (Last 7 Days)
        to_date = datetime.now().strftime("%Y-%m-%d")
        from_date = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
        
        print(f"\n>>> Fetching Trade History from {from_date} to {to_date}...")
        history = helper.get_trade_history(from_date, to_date)
        
        if isinstance(history, pd.DataFrame):
            print(f"[OK] Historical Trades Found: {len(history)}")
            if not history.empty:
                print(history.head())
        else:
            print("[FAIL] Trade history did not return a DataFrame")
            return False
            
        return True
        
    except Exception as e:
        print(f"[ERROR] Exception during trade audit test: {e}")
        return False

if __name__ == "__main__":
    run()
