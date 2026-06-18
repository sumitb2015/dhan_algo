import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client

def test_expiry_segments():
    dhan = get_dhan_client()
    
    segments = ["IDX_I", "INDEX", "NSE_IDX"]
    
    for seg in segments:
        print(f"Testing expiry_list for ID 13 (NIFTY) with segment '{seg}'...")
        res = dhan.expiry_list(under_security_id=13, under_exchange_segment=seg)
        print(f"Response: {res}")
        if res.get('status') == 'success':
            print(f"!!! SUCCESS with {seg} !!!")
        print("-" * 40)

if __name__ == "__main__":
    test_expiry_segments()
