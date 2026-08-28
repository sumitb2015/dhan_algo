
"""
Strategy Template using High-Level DhanHelper Abstractions
"""
import argparse
import time
import logging
import sys
import os

# Adjust path to import from root directory
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from login import get_dhan_client
from lib.dhan_helper import DhanHelper
from lib.strategy_risk import resolve_exit_qty
from lib.execution_broker import ExecutionBroker, ExecutionBrokerError

# Configure Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def run_strategy(args):
    # 1. Initialize
    dhan = get_dhan_client()
    helper = DhanHelper(dhan)

    try:
        broker = ExecutionBroker.create(args.broker, helper, underlying="NIFTY", log=logger.info)
    except ExecutionBrokerError as e:
        logger.error(f"Could not start {args.broker} execution: {e}")
        sys.exit(1)
    
    SYMBOL = "TCS"
    QUANTITY = 10

    # This strategy's OWN position (+ long / - short). Never infer it from the broker net.
    position_qty = 0

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
            #
            # IMPORTANT: track your OWN position (position_qty below) and exit only that.
            # helper.get_net_quantity() / helper.close_position() report the ACCOUNT-WIDE
            # netted broker position — if another strategy (or another --instance-id of
            # this one) holds the same security, sizing an exit from the broker net will
            # flatten their leg too. resolve_exit_qty() exits your quantity, clamped by
            # what the broker still shows, and warns when the two disagree.
            if signal == "BUY" and position_qty <= 0:
                # Close Short if any
                if position_qty < 0:
                    qty, net = resolve_exit_qty(helper, SYMBOL, abs(position_qty), "BUY", logger)
                    if qty > 0:
                        helper.buy(SYMBOL, qty)
                        position_qty += qty

                # Enter Long
                helper.place_entry(SYMBOL, QUANTITY, "BUY")
                position_qty += QUANTITY
                # Place Stop Loss
                sl_price = close * 0.99
                helper.place_sl_market(SYMBOL, QUANTITY, sl_price, "SELL")

            elif signal == "SELL" and position_qty >= 0:
                # Close Long if any
                if position_qty > 0:
                    qty, net = resolve_exit_qty(helper, SYMBOL, position_qty, "SELL", logger)
                    if qty > 0:
                        helper.sell(SYMBOL, qty)
                        position_qty -= qty

                # Enter Short
                helper.place_entry(SYMBOL, QUANTITY, "SELL")
                position_qty -= QUANTITY
                # Place Stop Loss
                sl_price = close * 1.01
                helper.place_sl_market(SYMBOL, QUANTITY, sl_price, "BUY")
            
            time.sleep(300) # Wait for next candle
            
        except Exception as e:
            logger.error(f"Strategy Error: {e}")
            time.sleep(5)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Strategy Template")
    parser.add_argument(
        "--broker", choices=["dhan", "zerodha", "kotak"], default="dhan",
        help="Execution broker for order placement. Market data always comes from Dhan. "
             "Zerodha/Kotak stop-loss/target exits are software-managed only (no resting "
             "broker-side stop order)."
    )
    args = parser.parse_args()
    run_strategy(args)
