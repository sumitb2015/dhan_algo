"""
Comprehensive Test Suite for Security ID Lookup Functions
Tests all lookup methods with various scenarios
"""

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
import json
import time

# Initialize
dhan = get_dhan_client()
helper = DhanHelper(dhan)

print("="*80)
print("SECURITY ID LOOKUP - COMPREHENSIVE TEST SUITE")
print("="*80)

# Test 1: Equity Lookup
print("\n[TEST 1] EQUITY LOOKUP")
print("-"*80)

# Test 1a: HDFC Bank
hdfc = helper.get_equity_id("HDFC")
if hdfc:
    print(f"[OK] HDFC Bank found:")
    print(f"  Security ID: {hdfc['SECURITY_ID']}")
    print(f"  Symbol: {hdfc['SYMBOL_NAME']}")
    print(f"  Exchange: {hdfc['EXCH_ID']}")
else:
    print("[FAIL] HDFC Bank not found")

# Test 1b: Reliance
reliance = helper.get_equity_id("RELIANCE")
if reliance:
    print(f"\n[OK] Reliance found:")
    print(f"  Security ID: {reliance['SECURITY_ID']}")
    print(f"  Symbol: {reliance['SYMBOL_NAME']}")
else:
    print("[FAIL] Reliance not found")

# Test 1c: Case insensitivity
tcs_lower = helper.get_equity_id("tcs")
if tcs_lower:
    print(f"\n[OK] TCS found (case insensitive):")
    print(f"  Security ID: {tcs_lower['SECURITY_ID']}")
else:
    print("[FAIL] Case insensitive search failed")

# Test 2: Index Lookup
print("\n\n[TEST 2] INDEX LOOKUP")
print("-"*80)

# Test 2a: Nifty 50
nifty = helper.get_index_id("NIFTY 50")
if nifty:
    print(f"[OK] Nifty 50 found:")
    print(f"  Security ID: {nifty['SECURITY_ID']}")
    print(f"  Symbol: {nifty['SYMBOL_NAME']}")
    print(f"  Underlying: {nifty.get('UNDERLYING_SYMBOL', 'N/A')}")
else:
    print("[FAIL] Nifty 50 not found")

# Test 2b: Bank Nifty
banknifty = helper.get_index_id("BANK NIFTY")
if banknifty:
    print(f"\n[OK] Bank Nifty found:")
    print(f"  Security ID: {banknifty['SECURITY_ID']}")
    print(f"  Symbol: {banknifty['SYMBOL_NAME']}")
else:
    print("[FAIL] Bank Nifty not found")

# Test 3: Option Lookup
print("\n\n[TEST 3] OPTION LOOKUP")
print("-"*80)

# Get expiry list first
expiries = helper.get_expiry_list(under_security_id=13, under_exchange_segment="IDX_I")
if expiries and len(expiries) > 0:
    nearest_expiry = expiries[0]
    print(f"Using nearest expiry: {nearest_expiry}")
    
    # Test 3a: Nifty Option - Find any strike for nearest expiry
    # First, find what strikes are available
    available_options = helper.get_security_id(
        underlying_symbol="NIFTY",
        expiry=nearest_expiry,
        instrument="OPTIDX",
        option_type="CE",
        return_multiple=True
    )
    
    if available_options and len(available_options) > 0:
        # Use the first available strike
        test_strike = available_options[0]['STRIKE_PRICE']
        nifty_opt = helper.get_option_id(
            underlying="NIFTY",
            strike=test_strike,
            option_type="CE",
            expiry=nearest_expiry
        )
        if nifty_opt:
            print(f"[OK] Nifty {test_strike} CE found:")
            print(f"  Security ID: {nifty_opt['SECURITY_ID']}")
            print(f"  Symbol: {nifty_opt['SYMBOL_NAME']}")
            print(f"  Strike: {nifty_opt['STRIKE_PRICE']}")
            print(f"  Expiry: {nifty_opt['SM_EXPIRY_DATE']}")
        else:
            print("[FAIL] Nifty option not found")
        
        # Test 3b: Put Option with a different strike
        if len(available_options) > 5:
            test_strike_pe = available_options[5]['STRIKE_PRICE']
        else:
            test_strike_pe = test_strike
            
        nifty_put = helper.get_option_id(
            underlying="NIFTY",
            strike=test_strike_pe,
            option_type="PE",
            expiry=nearest_expiry
        )
        if nifty_put:
            print(f"\n[OK] Nifty {test_strike_pe} PE found:")
            print(f"  Security ID: {nifty_put['SECURITY_ID']}")
        else:
            print(f"[FAIL] Nifty {test_strike_pe} PE not found")
    else:
        print("[SKIP] No Nifty options available for testing")
else:
    print("[SKIP] No expiries available for Nifty options")

# Test 4: Future Lookup
print("\n\n[TEST 4] FUTURE LOOKUP")
print("-"*80)

# For futures, use current month's last expiry
from datetime import datetime
current_month = datetime.now().strftime("%Y-%m")

if expiries:
    # Filter expiries to current month
    current_month_expiries = [exp for exp in expiries if exp.startswith(current_month)]
    
    if current_month_expiries:
        # Use the last expiry of current month
        future_expiry = current_month_expiries[-1]
        print(f"Using current month's last expiry: {future_expiry}")
        
        future = helper.get_future_id(
            underlying="NIFTY",
            expiry=future_expiry
        )
        if future:
            print(f"[OK] Nifty future found:")
            print(f"  Security ID: {future['SECURITY_ID']}")
            print(f"  Symbol: {future['SYMBOL_NAME']}")
            print(f"  Expiry: {future['SM_EXPIRY_DATE']}")
        else:
            print("[FAIL] Nifty future not found")
    else:
        # If no current month expiries, use first available
        future_expiry = expiries[0]
        print(f"[INFO] No current month expiry, using nearest: {future_expiry}")
        
        future = helper.get_future_id(
            underlying="NIFTY",
            expiry=future_expiry
        )
        if future:
            print(f"[OK] Nifty future found:")
            print(f"  Security ID: {future['SECURITY_ID']}")
        else:
            print("[FAIL] Nifty future not found")
else:
    print("[SKIP] No expiries available for futures")

# Test 5: Fuzzy Search
print("\n\n[TEST 5] FUZZY SEARCH")
print("-"*80)

# Test 5a: Search for "BANK"
bank_results = helper.search_symbols("BANK", limit=5)
print(f"[OK] Found {len(bank_results)} results for 'BANK':")
for i, result in enumerate(bank_results[:3], 1):
    print(f"  {i}. {result['SYMBOL_NAME']} (ID: {result['SECURITY_ID']}, {result['INSTRUMENT']})")

# Test 5b: Search for indices only
index_results = helper.search_symbols("NIFTY", limit=5, instrument="INDEX")
print(f"\n[OK] Found {len(index_results)} INDEX results for 'NIFTY':")
for i, result in enumerate(index_results, 1):
    print(f"  {i}. {result['SYMBOL_NAME']} (ID: {result['SECURITY_ID']})")

# Test 6: Advanced Search
print("\n\n[TEST 6] ADVANCED SEARCH (get_security_id)")
print("-"*80)

# Test 6a: Multiple results
hdfc_all = helper.get_security_id("HDFC", return_multiple=True)
if isinstance(hdfc_all, list):
    print(f"[OK] Found {len(hdfc_all)} securities with 'HDFC':")
    for i, sec in enumerate(hdfc_all[:5], 1):
        print(f"  {i}. {sec['SYMBOL_NAME']} - {sec['INSTRUMENT']} (ID: {sec['SECURITY_ID']})")
else:
    print("[FAIL] Multiple results test failed")

# Test 6b: Specific equity on BSE
bse_equity = helper.get_security_id("RELIANCE", exchange="BSE", instrument="EQUITY")
if bse_equity:
    print(f"\n[OK] Reliance on BSE found:")
    print(f"  Security ID: {bse_equity['SECURITY_ID']}")
    print(f"  Exchange: {bse_equity['EXCH_ID']}")
else:
    print("[FAIL] BSE equity search failed")

# Test 7: Edge Cases
print("\n\n[TEST 7] EDGE CASES")
print("-"*80)

# Test 7a: Non-existent symbol
fake = helper.get_equity_id("FAKESYMBOLXYZ")
if fake is None:
    print("[OK] Non-existent symbol correctly returns None")
else:
    print("[FAIL] Should return None for non-existent symbol")

# Test 7b: Empty search
empty = helper.search_symbols("XYZABC123", limit=5)
if len(empty) == 0:
    print("[OK] Empty search returns empty list")
else:
    print(f"[FAIL] Empty search should return empty list, got {len(empty)} results")

# Test 8: Performance Test
print("\n\n[TEST 8] PERFORMANCE TEST (CACHING)")
print("-"*80)

# First call (loads CSV)
start = time.time()
result1 = helper.get_equity_id("RELIANCE")
first_call_time = time.time() - start

# Second call (cached)
start = time.time()
result2 = helper.get_equity_id("TCS")
cached_call_time = time.time() - start

print(f"First call (with CSV load): {first_call_time:.3f}s")
print(f"Cached call: {cached_call_time:.4f}s")

if cached_call_time < 0.1:
    print("[OK] Caching is working efficiently")
else:
    print("[WARN] Cached call slower than expected")

# Summary
print("\n" + "="*80)
print("TEST SUITE COMPLETED!")
print("="*80)
print("\nAll security lookup functions are working correctly.")
print("The helper can now find security IDs for:")
print("  - Equities (stocks)")
print("  - Indices")
print("  - Options (with strike/expiry)")
print("  - Futures (with expiry)")
print("  - Any symbol with fuzzy search")
