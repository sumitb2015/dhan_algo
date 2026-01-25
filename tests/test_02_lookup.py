
"""
Test 02: Symbol Lookup (Equity, Index, F&O)
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def run(helper=None):
    print("\n" + "="*60)
    print("TEST 02: SYMBOL LOOKUP")
    print("="*60)
    
    try:
        if helper is None:
            dhan = get_dhan_client()
            helper = DhanHelper(dhan)
        
        # 1. Equity
        eq = helper.find_equity("RELIANCE")
        if eq and eq['SYMBOL_NAME'].startswith('RELIANCE'):
             print(f"[OK] Found Equity: {eq['SYMBOL_NAME']} ({eq['SECURITY_ID']})")
        else:
             print("[FAIL] Could not find RELIANCE")
             return False

        # 2. Index
        idx = helper.find_index("NIFTY 50")
        if idx and idx['SYMBOL_NAME'] in ['NIFTY 50', 'NIFTY']:
             print(f"[OK] Found Index: {idx['SYMBOL_NAME']} ({idx['SECURITY_ID']})")
        else:
             print("[FAIL] Could not find NIFTY 50")
             return False
             
        # 3. Fuzzy Search
        search = helper.search_symbols("HDFCBANK", limit=1)
        if search:
            print(f"[OK] Fuzzy Search 'HDFCBANK': Found {search[0]['SYMBOL_NAME']}")
        else:
            print("[FAIL] Fuzzy search failed")
            return False
            
        return True
        
    except Exception as e:
        print(f"[ERROR] Exception during lookup test: {e}")
        return False

if __name__ == "__main__":
    run()
