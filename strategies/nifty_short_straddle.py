import time
import sys
import os
import logging
from datetime import datetime

# Add parent directory to path to import login and lib
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper

# Setup Logging
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
debug_dir = os.path.join(project_root, "debug")
os.makedirs(debug_dir, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(os.path.join(debug_dir, f"straddle_{datetime.now().strftime('%Y%m%d')}.log"))
    ]
)
logger = logging.getLogger(__name__)

def run_nifty_straddle_strategy(dry_run=True, num_lots=1):
    """
    Executes a Nifty Short Straddle for the current expiry.
    Stop Loss: 20% on combined premium.
    Target: 20% decay on combined premium.
    """
    
    # 1. Initialize
    logger.info(f"Starting Nifty Short Straddle Strategy (Dry Run: {dry_run})")
    dhan = get_dhan_client()
    if not dhan:
        logger.error("Failed to connect to Dhan. Exiting.")
        return
        
    helper = DhanHelper(dhan)
    
    # Start WebSocket for Nifty Spot (Essential for reliable LTP)
    logger.info("Starting WebSocket for NIFTY Index...")
    helper.start_websocket([("IDX_I", "13", 15)])
    time.sleep(2) # Wait for initial tick
    
    # Get Nifty Lot Size
    nifty_lot_size = helper.get_lot_size("NIFTY")
    total_qty = nifty_lot_size * num_lots
    logger.info(f"Nifty Lot Size: {nifty_lot_size} | Total Qty: {total_qty} ({num_lots} lots)")
    
    # Fetch and log previous day OHLC levels via library method
    _levels = helper.get_prev_day_levels("NIFTY")
    prev_day_high  = _levels["high"]  if _levels else None
    prev_day_low   = _levels["low"]   if _levels else None
    prev_day_close = _levels["close"] if _levels else None


    # Track the last ATM we traded to prevent re-entering the same strike after SL
    last_traded_atm = None

    # Continuous Trading Loop
    while True:
        # 2. Wait for market open if closed
        helper.wait_for_market_open(dry_run, eod_time="15:20")
        
        # 3. Get Nifty Spot and ATM Strike
        nifty_spot = helper.get_ltp("NIFTY", exchange="IDX_I", instrument="INDEX")
        if nifty_spot == 0:
            logger.error("Could not fetch Nifty Spot price. Retrying in 5s...")
            time.sleep(5)
            continue

        current_atm = int(round(nifty_spot / 50) * 50)
        logger.info(f"NIFTY Spot: {nifty_spot:.2f} | ATM Strike: {current_atm}")

        # RE-ENTRY CHECK: Don't trade same ATM if we just hit SL on it
        if last_traded_atm is not None and current_atm == last_traded_atm:
            logger.info(f"Current ATM ({current_atm}) is same as last traded ATM. Waiting for trend change/new ATM...")
            time.sleep(10) 
            continue
        
        logger.info(f"Found Fresh ATM: {current_atm}. Proceeding to Enter Straddle.")

        # 4. Get Option Quotes (Nearest Expiry)
        ce_quote = helper.option("NIFTY", current_atm, "CE")
        pe_quote = helper.option("NIFTY", current_atm, "PE")
        
        if not ce_quote or not pe_quote:
            logger.error("Could not fetch option quotes. Retrying...")
            time.sleep(5)
            continue
            
        # Extract contract info and prices
        ce_contract = ce_quote.get('CONTRACT_INFO', {})
        pe_contract = pe_quote.get('CONTRACT_INFO', {})
        
        ce_symbol = ce_contract.get('SYMBOL_NAME') or ce_contract.get('SYMBOL', 'UNKNOWN_CE')
        pe_symbol = pe_contract.get('SYMBOL_NAME') or pe_contract.get('SYMBOL', 'UNKNOWN_PE')
        ce_id = str(ce_contract.get('SECURITY_ID'))
        pe_id = str(pe_contract.get('SECURITY_ID'))
        expiry = ce_contract.get('SM_EXPIRY_DATE', 'UNKNOWN')
        
        ce_entry_price = ce_quote.get('last_price', 0) or ce_quote.get('LTP', 0)
        pe_entry_price = pe_quote.get('last_price', 0) or pe_quote.get('LTP', 0)
        
        if ce_entry_price == 0 or pe_entry_price == 0:
            logger.error("One of the entry prices is 0. Retrying...")
            time.sleep(5)
            continue

        combined_premium = ce_entry_price + pe_entry_price
        logger.info(f"ENTRY -> CE: {ce_symbol} ({ce_id}) @ {ce_entry_price} | PE: {pe_symbol} ({pe_id}) @ {pe_entry_price}")
        logger.info(f"Combined Premium: {combined_premium:.2f} | Total Qty: {total_qty}")

        # 5. Define SL and Target (20% logic)
        sl_points = combined_premium * 1.20
        target_points = combined_premium * 0.80
        
        logger.info(f"Target: {target_points:.2f} | SL: {sl_points:.2f}")

        # Subscribe to WebSocket for real-time updates
        logger.info(f"Subscribing to WebSocket for {ce_symbol} (ID: {ce_id}) and {pe_symbol} (ID: {pe_id})")
        try:
            helper.subscribe_instruments([
                ("NSE_FNO", str(ce_id), 15),
                ("NSE_FNO", str(pe_id), 15)
            ])
            time.sleep(2) # Wait for initial ticks to arrive in live_data
        except Exception as e:
            logger.error(f"Failed to subscribe to WebSocket: {e}")

        ce_order_id = None
        pe_order_id = None

        if not dry_run:
            logger.info(f"PLACING LIVE SELL ORDERS for {total_qty} qty...")
            ce_order_id = helper.sell(ce_id, total_qty)
            pe_order_id = helper.sell(pe_id, total_qty)
            
            if not ce_order_id or not pe_order_id:
                logger.error(f"Failed to place one or both orders. CE: {ce_order_id}, PE: {pe_order_id}")
                # In a real scenario, you might want to cancel the other leg if one fails
                if ce_order_id: helper.buy(ce_id, total_qty)
                if pe_order_id: helper.buy(pe_id, total_qty)
                time.sleep(10)
                continue
            
            logger.info(f"Orders Placed. CE ID: {ce_order_id} | PE ID: {pe_order_id}")
        else:
            logger.info("[DRY RUN] Simulating Position Entry.")

        # 6. Monitor Position
        logger.info("Monitoring Straddle for SL or Target...")
        exit_reason = None
        
        while True:
            time.sleep(5)
            
            # Fetch current prices
            ce_curr = helper.get_ltp(str(ce_id), exchange="NSE_FNO", instrument="OPTIDX")
            pe_curr = helper.get_ltp(str(pe_id), exchange="NSE_FNO", instrument="OPTIDX")
            
            if ce_curr == 0 or pe_curr == 0:
                continue
                
            curr_combined = ce_curr + pe_curr
            pnl_points = combined_premium - curr_combined
            
            if (datetime.now().second % 30) < 5: # Log every 30s roughly
                logger.info(f"Current Premium: {curr_combined:.2f} | PnL: {pnl_points:.2f} points")

            # Check SL
            if curr_combined >= sl_points:
                logger.warning(f"!!! STOP LOSS HIT !!! Combined Premium: {curr_combined:.2f}")
                exit_reason = "SL"
                break
                
            # Check Target
            if curr_combined <= target_points:
                logger.info(f"$$$ TARGET HIT $$$ Combined Premium: {curr_combined:.2f}")
                exit_reason = "TARGET"
                break
                
            # Check Time (End of Day exit)
            now = datetime.now()
            if now.hour == 15 and now.minute >= 20:
                logger.info("EOD reached (15:20). Closing positions.")
                exit_reason = "EOD"
                break

        # 7. Exit Positions
        if not dry_run:
            logger.info(f"EXITING LIVE POSITIONS (Reason: {exit_reason})...")
            if ce_id:
                try:
                    net_qty = helper.get_net_quantity(str(ce_id))
                    if net_qty < 0:
                        qty_to_buy = abs(net_qty)
                        ce_exit_id = helper.buy(str(ce_id), qty_to_buy)
                        logger.info(f"Exit CE Order ID: {ce_exit_id} for {qty_to_buy} qty")
                    else:
                        logger.info(f"CE position already flat or long (Net Qty: {net_qty}). Skipping exit order.")
                except Exception as e:
                    logger.error(f"Exit CE Error: {e}")
            if pe_id:
                try:
                    net_qty = helper.get_net_quantity(str(pe_id))
                    if net_qty < 0:
                        qty_to_buy = abs(net_qty)
                        pe_exit_id = helper.buy(str(pe_id), qty_to_buy)
                        logger.info(f"Exit PE Order ID: {pe_exit_id} for {qty_to_buy} qty")
                    else:
                        logger.info(f"PE position already flat or long (Net Qty: {net_qty}). Skipping exit order.")
                except Exception as e:
                    logger.error(f"Exit PE Error: {e}")
        else:
            logger.info(f"[DRY RUN] Simulating Position Exit (Reason: {exit_reason}).")

        # Unsubscribe from old strikes to avoid cluttering connection
        if ce_id and pe_id:
            logger.info(f"Unsubscribing from old strikes: {ce_id}, {pe_id}")
            try:
                helper.unsubscribe_instruments([
                    ("NSE_FNO", str(ce_id), 15),
                    ("NSE_FNO", str(pe_id), 15)
                ])
            except:
                pass

        if exit_reason in ["SL", "TARGET"]:
            last_traded_atm = current_atm # Mark this ATM as traded to avoid immediate re-entry
        else:
            last_traded_atm = None # Reset for next day or if exit was EOD

        logger.info("Cycle Complete. Looking for next opportunity...")
        time.sleep(5)

if __name__ == "__main__":
    # Default to dry run for safety
    # Usage: python strategies/nifty_short_straddle.py [live|dry] [num_lots]
    mode = sys.argv[1] if len(sys.argv) > 1 else "dry"
    lots = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    
    is_dry = True if mode == "dry" else False
    run_nifty_straddle_strategy(dry_run=is_dry, num_lots=lots)
