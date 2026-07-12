import sys
import os
import json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def test_resolve():
    dhan = get_dhan_client()
    if not dhan:
        print("Failed to get dhan client")
        return
    helper = DhanHelper(dhan)
    
    symbols_to_test = [
        ("NIFTY", "index", {}),
        ("NIFTY", "future", {"exchange": "NSE", "instrument": "FUTIDX"}),
        ("HDFCBANK", "equity", {}),
        ("RELIANCE", "equity", {}),
        ("ICICIBANK", "equity", {}),
        ("BHARTIARTL", "equity", {}),
        ("INFY", "equity", {}),
        ("LT", "equity", {}),
        ("ITC", "equity", {}),
        ("SBIN", "equity", {}),
        ("TCS", "equity", {}),
        ("AXISBANK", "equity", {}),
    ]
    
    print("Testing resolutions:")
    for symbol, kind, kwargs in symbols_to_test:
        if kind == "index":
            sec = helper.find_index(symbol, exchange="IDX_I")
            resolved = {
                "security_id": str(int(sec["SECURITY_ID"])) if sec else None,
                "exchange_segment": "IDX_I",
                "instrument_type": "INDEX",
            } if sec else None
        elif kind == "future":
            sec = helper.find_future(symbol, **kwargs)
            resolved = {
                "security_id": str(int(sec["SECURITY_ID"])) if sec else None,
                "exchange_segment": "NSE_FNO",
                "instrument_type": "FUTIDX",
            } if sec else None
        elif kind == "equity":
            sec = helper.find_equity(symbol, exchange="NSE")
            resolved = {
                "security_id": str(int(sec["SECURITY_ID"])) if sec else None,
                "exchange_segment": "NSE_EQ",
                "instrument_type": "EQUITY",
            } if sec else None
        
        if resolved and resolved["security_id"]:
            print(f"[OK] {symbol} ({kind}) -> ID: {resolved['security_id']}, Segment: {resolved['exchange_segment']}")
        else:
            print(f"[FAIL] {symbol} ({kind})")

if __name__ == "__main__":
    test_resolve()
