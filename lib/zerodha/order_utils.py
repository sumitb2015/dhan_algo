import logging
from kiteconnect import KiteConnect
from . import config
import time

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)


def place_order(
    kite,
    symbol,
    transaction_type,
    order_type="MARKET",
    quantity=75,
    price=None,
    trigger_price=None,
):
    """Places an order for the given symbol and transaction type."""
    try:
        order_params = {
            "tradingsymbol": symbol,
            "exchange": kite.EXCHANGE_NFO,
            "transaction_type": getattr(kite, f"TRANSACTION_TYPE_{transaction_type}"),
            "quantity": quantity,
            "variety": kite.VARIETY_REGULAR,
            "order_type": getattr(kite, f"ORDER_TYPE_{order_type}"),
            "product": kite.PRODUCT_MIS,  # Intraday
            "validity": kite.VALIDITY_DAY,
        }

        if order_type == "LIMIT" and price is not None:
            order_params["price"] = price
        elif order_type == "SL" and trigger_price is not None:
            order_params["price"] = price
            order_params["trigger_price"] = trigger_price

        order_id = kite.place_order(**order_params)
        logging.info(f"The Order ID of trade placed for {symbol}: {order_id}")
        if order_type == "MARKET":
            average_entry_price = get_average_entry_price(kite, order_id)
        else:
            average_entry_price = 0
        logging.info(
            f"Order placed: {symbol}, Type: {transaction_type}, Order ID: {order_id}, Order Type: {order_type}, Quantity: {quantity}"
        )
        return order_id, average_entry_price
    except Exception as e:
        logging.error(f"Order placement failed: {e}", exc_info=True)
        return None, None


def get_average_entry_price(kite, order_id, max_retries=5, delay_sec=0.05):
    try:
        logging.info(f"Getting average entry price for order ID: {order_id}")
        for attempt in range(max_retries):
            order_history = kite.order_history(order_id)
            if order_history:
                # Find the completed order entry
                completed_order = next(
                    (
                        order
                        for order in order_history
                        if order["order_id"] == order_id and order["status"] == "COMPLETE"
                    ),
                    None,
                )

                if completed_order:
                    logging.info(
                        f"Order execution completed for order ID: {order_id} with average price: {completed_order.get('average_price')} (attempt {attempt+1})"
                    )
                    return completed_order.get('average_price')
            
            if attempt < max_retries - 1:
                time.sleep(delay_sec)

        logging.warning(f"No completed order found for order ID: {order_id} after {max_retries} attempts.")
        return None

    except Exception as e:
        logging.error(
            f"Error retrieving order history for order ID: {order_id}: {e}",
            exc_info=True,
        )
        return None


def cancel_order(kite, order_id):
    """Cancels an order using the Kite Connect API."""
    try:
        kite.cancel_order(variety=kite.VARIETY_REGULAR, order_id=order_id)
        logging.info(f"Cancelled order {order_id} successfully.")
        return True
    except Exception as e:
        logging.error(f"Error cancelling order {order_id}: {e}", exc_info=True)
        return False


def modify_order(
    kite,
    order_id,
    quantity,
    price=None,
    order_type="MARKET",
    trigger_price=None,
):
    """Modifies an existing order with the given parameters."""
    try:
        order_params = {
            "order_id": order_id,
            "quantity": quantity,
            "price": price,
            "order_type": getattr(kite, f"ORDER_TYPE_{order_type}"),
            "trigger_price": trigger_price,
            "variety": kite.VARIETY_REGULAR,
        }
        kite.modify_order(**order_params)
        logging.info(f"Modified order {order_id} successfully.")
        return True
    except Exception as e:
        logging.error(f"Error modifying order {order_id}: {e}", exc_info=True)
        return False
