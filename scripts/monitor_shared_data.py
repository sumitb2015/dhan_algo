
import sys
import os
import time
import logging
from datetime import datetime

# Ensure project root is in path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Configure Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(message)s')
logger = logging.getLogger(__name__)

def main():
    logger.info("Initializing Client...")
    dhan = get_dhan_client()
    if not dhan:
        logger.error("Login failed! Please check your credentials.")
        return

    helper = DhanHelper(dhan)
    
    # Symbols to monitor (Index and Stocks)
    base_symbols = ["NIFTY", "TCS", "SBIN"]
    
    # Resolve to Current Month Futures
    futures_to_monitor = []
    
    for sym in base_symbols:
        logger.info(f"Finding current month future for {sym}...")
        future = helper.find_current_month_future(sym)
        if future:
            # Add to list
            # Format: (Exchange, SecurityID, RequestCode=21)
            # Exchange is likely NSE_FNO (which is 'NSE_FNO' or code depending on SDK)
            # Safe bet: use helper.dhan.NSE_FNO
            
            f_sym = future['SYMBOL_NAME'] # SYMBOL_NAME is reliable in master list
            f_id = str(future['SECURITY_ID'])
            logger.info(f"-> Found: {f_sym} (ID: {f_id})")
            
            futures_to_monitor.append((helper.dhan.NSE_FNO, f_id, 21))
        else:
            logger.warning(f"-> Failed to find future for {sym}")
    
    if not futures_to_monitor:
        logger.error("No valid futures found to monitor.")
        return

    logger.info(f"Connecting WebSocket for {len(futures_to_monitor)} Futures contracts...")
    
    # Use start_websocket directly since we constructed the instrument tuples manually
    feed = helper.start_websocket(futures_to_monitor, on_message=None)
    
    if feed:
        logger.info("WebSocket Connected! Monitoring shared data store...")
        logger.info("Press Ctrl+C to stop.")
        
        try:
            while True:
                # Clear screen (optional, works in terminal)
                os.system('cls' if os.name == 'nt' else 'clear')
                
                print(f"--- Shared Data Store Monitor | {datetime.now().strftime('%H:%M:%S')} ---")
                
                if not helper.live_data:
                    print("Waiting for data...")
                else:
                    # Print table header
                    headers = ["Sec ID", "Symbol", "LTP", "Open", "High", "Low", "Vol", "OI"]
                    print(f"{headers[0]:<10} {headers[1]:<10} {headers[2]:<10} {headers[3]:<10} {headers[4]:<10} {headers[5]:<10} {headers[6]:<10} {headers[7]:<10}")
                    print("-" * 90)
                    
                    for sec_id, data in helper.live_data.items():
                        # Try to resolve symbol name back if possible, or just use ID
                        # (In a real app, you'd have a map. Here we guess based on input or just show ID)
                        
                        ltp = data.get('LTP', '-')
                        o = data.get('open', '-')
                        h = data.get('high', '-')
                        l = data.get('low', '-')
                        v = data.get('volume', '-')
                        oi = data.get('OI', '-')
                        
                        print(f"{sec_id:<10} {'?':<10} {ltp:<10} {o:<10} {h:<10} {l:<10} {v:<10} {oi:<10}")
                
                print("\n(Polling helper.live_data every 1s)")
                time.sleep(1)
                
        except KeyboardInterrupt:
            logger.info("Stopped by user.")
        finally:
            feed.close_connection()
            logger.info("Connection closed.")
    else:
        logger.error("Failed to connect.")

if __name__ == "__main__":
    main()
