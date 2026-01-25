"""
Simple Strategy Examples Using Simplified DhanHelper API

This file demonstrates the most common use cases with the new simplified methods.
All examples are safe to run (read-only operations, no actual orders placed).
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Initialize
dhan = get_dhan_client()
helper = DhanHelper(dhan)

print("="*80)
print("SIMPLIFIED API - PRACTICAL EXAMPLES")
print("="*80)

# ============================================================================
# EXAMPLE 1: Check Your Portfolio
# ============================================================================
print("\n[EXAMPLE 1] Check Your Portfolio")
print("-"*80)

# Get available balance
balance = helper.funds()
print(f"Available Funds: Rs. {balance:,.2f}")

# Get current positions
positions = helper.positions()
print(f"\nOpen Positions: {len(positions)}")
if not positions.empty:
    print(positions[['tradingSymbol', 'netQty', 'realizedProfit']].head())

# Get holdings
holdings = helper.holdings()
print(f"\nHoldings: {len(holdings)}")
if not holdings.empty:
    print(holdings[['tradingSymbol', 'totalQty', 'avgCostPrice']].head())


# ============================================================================
# EXAMPLE 2: Get Stock Prices
# ============================================================================
print("\n\n[EXAMPLE 2] Get Stock Prices (LTP)")
print("-"*80)

# Get LTP for multiple stocks
stocks = ["TCS", "RELIANCE", "INFY", "HDFC"]

print("Current Prices:")
for stock in stocks:
    ltp = helper.ltp(stock)
    print(f"  {stock:12} : Rs. {ltp:,.2f}")


# ============================================================================
# EXAMPLE 3: Get OHLC Data
# ============================================================================
print("\n\n[EXAMPLE 3] Get OHLC Data")
print("-"*80)

# Get OHLC for a stock
ohlc = helper.ohlc("TCS")
if ohlc:
    print("TCS OHLC:")
    print(f"  Open  : Rs. {ohlc.get('open', 0):,.2f}")
    print(f"  High  : Rs. {ohlc.get('high', 0):,.2f}")
    print(f"  Low   : Rs. {ohlc.get('low', 0):,.2f}")
    print(f"  Close : Rs. {ohlc.get('close', 0):,.2f}")
else:
    print("OHLC data not available (market closed)")


# ============================================================================
# EXAMPLE 4: Check Nifty Options
# ============================================================================
print("\n\n[EXAMPLE 4] Check Nifty Options")
print("-"*80)

# Get Nifty LTP
nifty_ltp = helper.ltp("NIFTY 50")
print(f"Nifty Spot: {nifty_ltp:,.2f}")

# Get option quotes (uses nearest expiry automatically)
if nifty_ltp > 0:
    # ATM strike (rounded to nearest 50)
    atm_strike = round(nifty_ltp / 50) * 50
    
    # Get CE and PE quotes
    ce_quote = helper.option("NIFTY", atm_strike, "CE")
    pe_quote = helper.option("NIFTY", atm_strike, "PE")
    
    if ce_quote:
        print(f"\nNifty {atm_strike} CE:")
        print(f"  Symbol: {ce_quote['CONTRACT_INFO']['SYMBOL']}")
        print(f"  LTP   : Rs. {ce_quote.get('last_price', 0):,.2f}")
        print(f"  Expiry: {ce_quote['CONTRACT_INFO']['EXPIRY']}")
    
    if pe_quote:
        print(f"\nNifty {atm_strike} PE:")
        print(f"  Symbol: {pe_quote['CONTRACT_INFO']['SYMBOL']}")
        print(f"  LTP   : Rs. {pe_quote.get('last_price', 0):,.2f}")


# ============================================================================
# EXAMPLE 5: Simple Trading Logic (DRY RUN)
# ============================================================================
print("\n\n[EXAMPLE 5] Simple Trading Logic (DRY RUN - No Actual Orders)")
print("-"*80)

# Example: Buy if price is below a threshold
TARGET_STOCK = "TCS"
BUY_BELOW = 3500
QUANTITY = 10

ltp = helper.ltp(TARGET_STOCK)
balance = helper.funds()

print(f"\nStrategy: Buy {TARGET_STOCK} if price < Rs. {BUY_BELOW}")
print(f"Current Price: Rs. {ltp:,.2f}")
print(f"Available Funds: Rs. {balance:,.2f}")

if ltp > 0 and ltp < BUY_BELOW and balance > (ltp * QUANTITY):
    print(f"\n[OK] Conditions met! Would buy {QUANTITY} shares")
    print(f"  Command: helper.buy('{TARGET_STOCK}', qty={QUANTITY})")
    print(f"  Cost: Rs. {ltp * QUANTITY:,.2f}")
    
    # Uncomment to place actual order:
    # order_id = helper.buy(TARGET_STOCK, qty=QUANTITY)
    # print(f"Order placed: {order_id}")
else:
    print("\n[SKIP] Conditions not met, no action")


# ============================================================================
# EXAMPLE 6: Option Strategy - Straddle Check
# ============================================================================
print("\n\n[EXAMPLE 6] Option Strategy - Straddle Check")
print("-"*80)

nifty_ltp = helper.ltp("NIFTY 50")
if nifty_ltp > 0:
    atm_strike = round(nifty_ltp / 50) * 50
    
    # Get both CE and PE
    ce = helper.option("NIFTY", atm_strike, "CE")
    pe = helper.option("NIFTY", atm_strike, "PE")
    
    if ce and pe:
        ce_price = ce.get('last_price', 0)
        pe_price = pe.get('last_price', 0)
        straddle_cost = ce_price + pe_price
        
        print(f"ATM Straddle at {atm_strike}:")
        print(f"  CE Premium: Rs. {ce_price:,.2f}")
        print(f"  PE Premium: Rs. {pe_price:,.2f}")
        print(f"  Total Cost: Rs. {straddle_cost:,.2f}")
        print(f"  Lot Size  : {ce['CONTRACT_INFO']['LOT_SIZE']}")
        print(f"  Total Investment: Rs. {straddle_cost * ce['CONTRACT_INFO']['LOT_SIZE']:,.2f}")


# ============================================================================
# EXAMPLE 7: Position Monitoring
# ============================================================================
print("\n\n[EXAMPLE 7] Position Monitoring")
print("-"*80)

positions = helper.positions()

if not positions.empty:
    print("Monitoring Open Positions:")
    
    total_pnl = 0
    for _, pos in positions.iterrows():
        symbol = pos['tradingSymbol']
        qty = pos['netQty']
        pnl = pos.get('realizedProfit', 0)
        total_pnl += pnl
        
        status = "PROFIT" if pnl > 0 else "LOSS" if pnl < 0 else "BREAKEVEN"
        print(f"  {symbol:20} | Qty: {qty:5} | P&L: Rs. {pnl:10,.2f} | {status}")
    
    print(f"\nTotal P&L: Rs. {total_pnl:,.2f}")
else:
    print("No open positions")


# ============================================================================
# SUMMARY
# ============================================================================
print("\n" + "="*80)
print("SUMMARY - Key Simplified Methods")
print("="*80)
print("""
Most Useful Methods for Strategies:

1. helper.ltp(symbol)              - Get current price
2. helper.ohlc(symbol)             - Get OHLC data
3. helper.option(underlying, strike, type)  - Get option quote
4. helper.buy(symbol, qty)         - Place buy order
5. helper.sell(symbol, qty)        - Place sell order
6. helper.positions()              - Check positions
7. helper.holdings()               - Check holdings
8. helper.funds()                  - Check balance

All methods use smart defaults and auto-detection!
""")

print("Examples completed successfully!")
print("="*80)
