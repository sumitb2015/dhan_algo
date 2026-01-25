"""
Complete Example: Using get_expiry_list and get_option_chain together
This demonstrates the correct usage pattern for option chain analysis
"""

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
import pandas as pd

# Initialize
dhan = get_dhan_client()
helper = DhanHelper(dhan)

print("=" * 80)
print("OPTION CHAIN ANALYSIS - Complete Workflow")
print("=" * 80)

# Step 1: Get available expiries for Nifty
print("\nStep 1: Fetching available expiries for Nifty 50...")
print("-" * 80)

expiries = helper.get_expiry_list(under_security_id=13, under_exchange_segment="IDX_I")

if expiries:
    print(f"Found {len(expiries)} expiries")
    print("\nAvailable Expiries:")
    for i, expiry in enumerate(expiries[:5], 1):  # Show first 5
        print(f"  {i}. {expiry}")
    
    # Step 2: Get option chain for nearest expiry
    print(f"\n\nStep 2: Fetching option chain for nearest expiry: {expiries[0]}")
    print("-" * 80)
    
    option_chain = helper.get_option_chain(
        under_security_id=13,
        expiry=expiries[0],
        under_exchange_segment="IDX_I"
    )
    
    if not option_chain.empty:
        print(f"Option chain loaded: {len(option_chain)} strikes")
        
        # Display sample data
        print("\nSample Option Chain Data:")
        print(option_chain.head(10))
        
        print("\nAvailable Columns:")
        print(option_chain.columns.tolist())
        
        # Step 3: Analyze specific strikes (if columns exist)
        if 'strike_price' in option_chain.columns:
            print("\n\nStep 3: Strike Analysis")
            print("-" * 80)
            
            # Get ATM strike (middle of the chain)
            mid_idx = len(option_chain) // 2
            atm_strike = option_chain.iloc[mid_idx]
            
            print(f"ATM Strike: {atm_strike.get('strike_price', 'N/A')}")
            
            # Show a few strikes around ATM
            print("\nStrikes around ATM:")
            start_idx = max(0, mid_idx - 2)
            end_idx = min(len(option_chain), mid_idx + 3)
            print(option_chain.iloc[start_idx:end_idx])
    else:
        print("No option chain data available")
        
else:
    print("No expiries found")

# Additional example: Bank Nifty
print("\n\n" + "=" * 80)
print("BANK NIFTY - Quick Example")
print("=" * 80)

banknifty_expiries = helper.get_expiry_list(under_security_id=25, under_exchange_segment="IDX_I")
if banknifty_expiries:
    print(f"Bank Nifty Expiries: {len(banknifty_expiries)}")
    print(f"Nearest: {banknifty_expiries[0]}")
    
    # Get option chain
    bn_chain = helper.get_option_chain(25, banknifty_expiries[0], "IDX_I")
    print(f"Bank Nifty Option Chain: {len(bn_chain)} strikes")

print("\n" + "=" * 80)
print("Analysis Complete!")
print("=" * 80)
