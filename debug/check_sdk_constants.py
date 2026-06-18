import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client

def check_sdk_constants():
    dhan = get_dhan_client()
    
    print(f"dhan.NSE: {getattr(dhan, 'NSE', 'N/A')}")
    print(f"dhan.BSE: {getattr(dhan, 'BSE', 'N/A')}")
    print(f"dhan.INDEX: {getattr(dhan, 'INDEX', 'N/A')}")
    print(f"dhan.FNO: {getattr(dhan, 'FNO', 'N/A')}")
    print(f"dhan.CUR: {getattr(dhan, 'CUR', 'N/A')}")
    print(f"dhan.MCX: {getattr(dhan, 'MCX', 'N/A')}")

if __name__ == "__main__":
    check_sdk_constants()
