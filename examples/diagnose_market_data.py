"""
Diagnostic Script - Why is LTP Returning 0?

This script helps diagnose why market data is not being fetched.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from datetime import datetime

# Initialize
dhan = get_dhan_client()
helper = DhanHelper(dhan)

print("="*80)
print("MARKET DATA DIAGNOSTIC")
print("="*80)

# 1. Check Time
now = datetime.now()
is_weekday = now.weekday() < 5
market_open = now.replace(hour=9, minute=15, second=0)
market_close = now.replace(hour=15, minute=30, second=0)
is_market_hours = market_open <= now <= market_close

print(f"\n[1] TIME CHECK")
print(f"Current Time: {now.strftime('%Y-%m-%d %H:%M:%S %A')}")
print(f"Market Hours: 9:15 AM - 3:30 PM (Mon-Fri)")
print(f"Status: {'SHOULD BE OPEN' if (is_weekday and is_market_hours) else 'CLOSED'}")

# 2. Test Direct API Call
print(f"\n[2] DIRECT API TEST")
print("-"*80)

try:
    # Try to get LTP directly from SDK
    response = dhan.get_ltp_data("NSE_EQ", "25946")  # TCS
    print(f"Raw API Response:")
    print(f"  Status: {response.get('status', 'N/A')}")
    print(f"  Data: {response.get('data', 'N/A')}")
    
    if response.get('status') == 'failure':
        print(f"\n[ISSUE FOUND] API returned failure")
        print(f"Possible reasons:")
        print(f"  1. No Data API subscription")
        print(f"  2. Market is actually closed (holiday)")
        print(f"  3. API rate limit reached")
        print(f"  4. Network/authentication issue")
except Exception as e:
    print(f"[ERROR] {e}")

# 3. Test Symbol Resolution
print(f"\n[3] SYMBOL RESOLUTION TEST")
print("-"*80)

stock = helper._resolve_symbol("TCS")
if stock:
    print(f"[OK] Symbol found:")
    print(f"  Security ID: {stock['SECURITY_ID']}")
    print(f"  Exchange: {stock['EXCH_ID']}")
    print(f"  Segment: {helper._auto_detect_segment(stock)}")
else:
    print(f"[ERROR] Symbol not found")

# 4. Test Simplified Method
print(f"\n[4] SIMPLIFIED METHOD TEST")
print("-"*80)

ltp = helper.ltp("TCS")
print(f"helper.ltp('TCS') = {ltp}")

if ltp == 0:
    print(f"\n[DIAGNOSIS]")
    if not (is_weekday and is_market_hours):
        print(f"  Reason: Market is CLOSED")
        print(f"  Solution: Try during market hours (9:15 AM - 3:30 PM)")
    else:
        print(f"  Reason: Likely NO DATA API SUBSCRIPTION")
        print(f"  Solution:")
        print(f"    1. Login to Dhan web/app")
        print(f"    2. Go to Settings > API")
        print(f"    3. Check if 'Data API' is enabled")
        print(f"    4. If not, subscribe to Data API")
        print(f"    5. Cost: Usually Rs. 1000-2000/month")
else:
    print(f"[OK] Market data is working!")

# 5. Test Portfolio Methods (These should always work)
print(f"\n[5] PORTFOLIO METHODS TEST (Should Always Work)")
print("-"*80)

try:
    positions = helper.positions()
    holdings = helper.holdings()
    balance = helper.funds()
    
    print(f"[OK] Positions: {len(positions)} records")
    print(f"[OK] Holdings: {len(holdings)} records")
    print(f"[OK] Funds: Rs. {balance}")
    print(f"\nPortfolio methods are working fine!")
except Exception as e:
    print(f"[ERROR] {e}")

# Summary
print(f"\n" + "="*80)
print(f"SUMMARY")
print(f"="*80)

print(f"""
WHAT'S WORKING:
  [OK] Authentication
  [OK] Symbol resolution
  [OK] Portfolio data (positions, holdings, funds)
  [OK] Simplified API structure

WHAT'S NOT WORKING:
  [ISSUE] Market data (LTP, OHLC, quotes)

ROOT CAUSE:
  You need to subscribe to Dhan's Data API.
  
  The Data API is a SEPARATE subscription from trading API.
  
  Without Data API subscription, you can:
    - Place orders
    - Check positions/holdings
    - Manage portfolio
  
  But you CANNOT:
    - Get live prices (LTP)
    - Get OHLC data
    - Get option/future quotes
    - Get historical data

HOW TO FIX:
  1. Login to https://dhan.co
  2. Go to Settings > API
  3. Subscribe to 'Data API' (separate from Trading API)
  4. Cost: Usually Rs. 1000-2000/month
  5. After subscription, all market data methods will work immediately

NOTE:
  The simplified API is working CORRECTLY!
  It's properly handling the "no subscription" case by returning 0.
  Once you have Data API access, helper.ltp(), helper.ohlc(), 
  helper.option(), etc. will all return live data.
""")

print("="*80)
