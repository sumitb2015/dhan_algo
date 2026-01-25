
"""
Strategy Template using High-Level DhanHelper Abstractions
"""
import time
import logging
import sys
import os

# Adjust path to import from root directory
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Configure Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def run_strategy():
    # 1. Initialize
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)
    
    SYMBOL = "TCS"
    QUANTITY = 10
    
    logger.info(f"Starting Strategy for {SYMBOL}")
    
    while True:
        try:
            # 2. Check Market Status
            if not helper.is_market_open():
                logger.info("Market is closed. Waiting...")
                time.sleep(60)
                continue
                
            # 3. Fetch Data (e.g., 5-minute candles)
            df = helper.get_latest_candles(SYMBOL, interval="5", days=2)
            if df.empty:
                logger.warning("No data received.")
                time.sleep(5)
                continue
                
            # 4. Strategy Logic
            # Example: Buy if Close > Open (Green Candle)
            last_candle = df.iloc[-1]
            close = last_candle['Close']
            open_price = last_candle['Open']
            
            signal = "BUY" if close > open_price else "SELL"
            logger.info(f"Signal: {signal} | Close: {close} | Open: {open_price}")
            
            # 5. Position Management
            net_qty = helper.get_net_quantity(SYMBOL)
            
            if signal == "BUY" and net_qty <= 0:
                # Close Short if any
                if net_qty < 0:
                    helper.close_position(SYMBOL)
                    
                # Enter Long
                helper.place_entry(SYMBOL, QUANTITY, "BUY")
                # Place Stop Loss
                sl_price = close * 0.99
                helper.place_sl_market(SYMBOL, QUANTITY, sl_price, "SELL")
                
            elif signal == "SELL" and net_qty >= 0:
                # Close Long if any
                if net_qty > 0:
                    helper.close_position(SYMBOL)
                    
                # Enter Short
                helper.place_entry(SYMBOL, QUANTITY, "SELL")
                # Place Stop Loss
                sl_price = close * 1.01
                helper.place_sl_market(SYMBOL, QUANTITY, sl_price, "BUY")
            
            time.sleep(300) # Wait for next candle
            
        except Exception as e:
            logger.error(f"Strategy Error: {e}")
            time.sleep(5)

if __name__ == "__main__":
    run_strategy()
