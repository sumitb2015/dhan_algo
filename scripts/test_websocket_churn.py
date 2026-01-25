
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
        logger.error("Login failed!")
        return

    helper = DhanHelper(dhan)
    
    # 1. Start WebSocket with one instrument (e.g. Nifty 50 Index)
    # Nifty 50 is usually instrument 13 on NSE Index (IDX_I)
    nifty_id = "13" 
    exchange_segment = helper.dhan.INDEX
    
    initial_instruments = [(exchange_segment, nifty_id, 15)] # 15 = Ticker
    
    logger.info("--- TEST 1: Start WebSocket ---")
    feed = helper.start_websocket(initial_instruments)
    
    if not feed:
        logger.error("Failed to start WebSocket.")
        return

    logger.info("Waiting 5s for data...")
    time.sleep(5)
    
    if nifty_id in helper.live_data:
        logger.info(f"Received Nifty Data: {helper.live_data[nifty_id]}")
    else:
        logger.warning("No data received yet for Nifty.")

    # 2. Test Subscribe (e.g. Reliance EQ)
    logger.info("\n--- TEST 2: Subscribe New Instrument (Reliance) ---")
    # Reliance is usually around ID 1333 on NSE EQ. Let's look it up dynamically.
    rel = helper.find_equity("RELIANCE")
    if rel:
        rel_id = str(rel['SECURITY_ID'])
        rel_instruments = [(helper.dhan.NSE, rel_id, 15)]
        
        helper.subscribe_instruments(rel_instruments)
        logger.info(f"Subscribed to Reliance ({rel_id}). Waiting 5s...")
        time.sleep(5)
        
        if rel_id in helper.live_data:
            logger.info(f"Received Reliance Data: {helper.live_data[rel_id]}")
        else:
            logger.warning("No data received yet for Reliance.")
    else:
        logger.error("Could not find Reliance symbol.")

    # 3. Test Unsubscribe (Reliance)
    logger.info("\n--- TEST 3: Unsubscribe Reliance ---")
    if rel:
        helper.unsubscribe_instruments(rel_instruments)
        logger.info("Unsubscribe command sent. Waiting 5s...")
        time.sleep(5)
        
        # Check if we are still receiving updates (difficult to prove negative in 5s, but we verify no crash)
        # We can optimize by clearing the cache entry and seeing if it comes back
        # But helper doesn't clear cache automatically in unsubscribe (as per my implementation choice)
        # So we just verify the call completed.
        logger.info("Unsubscribe verification complete (check logs for errors).")

    logger.info("\nClosing connection...")
    feed.close_connection()
    logger.info("Test Complete.")

if __name__ == "__main__":
    main()
