import sys
import os
from datetime import datetime

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def check_nifty():
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)
    
    print("Fetching NIFTY 50 LTP...")
    n50_ltp = helper.ltp("NIFTY 50")
    print(f"NIFTY 50 LTP: {n50_ltp}")
    
    print("\nFetching NIFTY Index LTP...")
    # Standard call
    ltp = helper.get_ltp("NIFTY", instrument="INDEX")
    print(f"Standard LTP: {ltp}")

if __name__ == "__main__":
    check_nifty()
