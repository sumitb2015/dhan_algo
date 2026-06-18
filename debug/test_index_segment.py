import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def check_index_segment():
    dhan = get_dhan_client()
    
    print("Testing segment 'INDEX' for ID 13 (NIFTY)...")
    res = dhan.ohlc_data(securities={"INDEX": [13]})
    print(f"Response for 'INDEX': {res}")
    
    print("\nTesting segment 'IDX_I' for ID 13 (NIFTY)...")
    res_idx = dhan.ohlc_data(securities={"IDX_I": [13]})
    print(f"Response for 'IDX_I': {res_idx}")

if __name__ == "__main__":
    check_index_segment()
