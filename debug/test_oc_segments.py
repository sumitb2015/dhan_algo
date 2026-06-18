import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client

def test_oc_segments():
    dhan = get_dhan_client()
    
    expiry = "2026-06-23" # Hardcoded for test
    segments = ["IDX_I", "INDEX"]
    
    for seg in segments:
        print(f"Testing option_chain for ID 13 (NIFTY) with segment '{seg}'...")
        res = dhan.option_chain(under_security_id=13, under_exchange_segment=seg, expiry=expiry)
        print(f"Response Status: {res.get('status')}")
        if res.get('status') == 'success':
            print(f"!!! SUCCESS with {seg} !!!")
        print("-" * 40)

if __name__ == "__main__":
    test_oc_segments()
