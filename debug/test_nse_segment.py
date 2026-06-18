import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client

def test_nse_segment():
    dhan = get_dhan_client()
    
    print("Testing segment 'NSE' for ID 13 (NIFTY)...")
    res = dhan.ohlc_data(securities={"NSE": [13]})
    print(f"Response for 'NSE': {res}")

    print("\nTesting segment 'NSE_EQ' for ID 13 (NIFTY)...")
    res_eq = dhan.ohlc_data(securities={"NSE_EQ": [13]})
    print(f"Response for 'NSE_EQ': {res_eq}")

if __name__ == "__main__":
    test_nse_segment()
