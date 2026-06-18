import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def test_nifty_index_param():
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)
    
    print("Testing get_ltp('NIFTY', exchange='INDEX', instrument='INDEX')...")
    try:
        ltp = helper.get_ltp("NIFTY", exchange="INDEX", instrument="INDEX")
        print(f"LTP: {ltp}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    test_nifty_index_param()
