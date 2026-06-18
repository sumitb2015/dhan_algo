import sys
import os
from datetime import datetime

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

def test_quotes():
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)
    
    ce_strike = 24350
    pe_strike = 23950
    
    print(f"Testing CE {ce_strike}...")
    ce_quote = helper.option("NIFTY", ce_strike, "CE")
    print(f"CE Quote: {ce_quote}")
    
    print(f"\nTesting PE {pe_strike}...")
    pe_quote = helper.option("NIFTY", pe_strike, "PE")
    print(f"PE Quote: {pe_quote}")
    
    if pe_quote:
        sec_pe = pe_quote['CONTRACT_INFO']
        sid_pe = int(sec_pe['SECURITY_ID'])
        instruments_pe = {"NSE_FNO": [sid_pe]}
        print(f"Fetching raw ohlc_data for PE {instruments_pe}...")
        res_pe = dhan.ohlc_data(securities=instruments_pe)
        print(f"Raw PE ohlc_data Response: {res_pe}")
    
    if not ce_quote:
        # Check if security even exists
        sec = helper.get_option_id("NIFTY", ce_strike, "CE", helper.get_nearest_expiry("NIFTY"))
        print(f"CE Security Lookup: {sec}")
        if sec:
            sid = int(sec['SECURITY_ID'])
            instruments = {"NSE_FNO": [sid]}
            print(f"Fetching raw ohlc_data for {instruments}...")
            res = dhan.ohlc_data(securities=instruments)
            print(f"Raw ohlc_data Response: {res}")
            
            print(f"Fetching raw quote_data for {instruments}...")
            res_quote = dhan.quote_data(securities=instruments)
            print(f"Raw quote_data Response: {res_quote}")
            
            ohlc = helper.get_ohlc(sid, exchange="NSE", instrument="OPTIDX")
            print(f"Helper.get_ohlc output: {ohlc}")

if __name__ == "__main__":
    test_quotes()
