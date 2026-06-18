import sys
import os
from datetime import datetime

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def inspect_oc():
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)
    
    expiry = helper.get_nearest_expiry("NIFTY")
    print(f"Nearest Expiry: {expiry}")
    
    df = helper.get_option_chain_df("NIFTY", expiry)
    if df.empty:
        print("Option Chain DF is empty.")
        return
        
    print(f"Columns: {df.columns.tolist()}")
    
    # Check for Greeks
    ce_greeks = [c for c in df.columns if 'ce_' in c and any(g in c for g in ['delta', 'theta', 'vega', 'gamma'])]
    pe_greeks = [c for c in df.columns if 'pe_' in c and any(g in c for g in ['delta', 'theta', 'vega', 'gamma'])]
    
    print(f"Found CE Greeks: {ce_greeks}")
    print(f"Found PE Greeks: {pe_greeks}")
    
    # Show first few rows of relevant columns
    cols = ['ce_last_price', 'pe_last_price'] + ce_greeks[:1] + pe_greeks[:1]
    print(df[cols].head())

if __name__ == "__main__":
    inspect_oc()
