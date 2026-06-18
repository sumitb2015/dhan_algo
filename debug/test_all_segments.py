import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client

def test_segments():
    dhan = get_dhan_client()
    
    segments = ["IDX_I", "INDEX", "NSE_IDX", "NSE_INDEX", "IDX_NSE"]
    
    for seg in segments:
        print(f"Testing segment '{seg}' for ID 13 (NIFTY)...")
        res = dhan.ohlc_data(securities={seg: [13]})
        print(f"Response: {res}")
        if res.get('status') == 'success':
            print(f"!!! SUCCESS with {seg} !!!")
        print("-" * 40)

if __name__ == "__main__":
    test_segments()
