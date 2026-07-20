import time
from typing import Dict, List, Tuple, Optional
import logging
from datetime import datetime, timedelta
import sys

import pandas as pd

from . import option_chain
from . import indicators
from . import order_utils
from . import config
from . import data_fetcher

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)

# In config.py or similar configuration file
config.active_orders = []


def get_orders_information() -> List[Dict]:
    """
    Fetches and prints order information from Kite.
    Returns a list of pending orders.
    """
    try:
        pending_orders = []
        orders = config.kite.orders()

        if not orders:
            logging.warning("No orders found")
            return pending_orders

        for order in orders:
            if order["status"] not in ["COMPLETE", "REJECTED", "CANCELLED"]:
                order_info = {
                    "order_id": order["order_id"],
                    "tradingsymbol": order["tradingsymbol"],
                    "status": order["status"],
                    "quantity": order["quantity"],
                    "price": order.get("price", 0),
                    "trigger_price": order.get("trigger_price", 0),
                }
                pending_orders.append(order_info)
                logging.info(
                    f"Pending Order - OrderId: {order['order_id']}, "
                    f"Symbol: {order['tradingsymbol']}, "
                    f"Status: {order['status']}"
                )

        return pending_orders

    except Exception as e:
        logging.error(f"Error fetching orders information: {str(e)}", exc_info=True)
        return []


def check_sl_tp(tick_data: Dict) -> bool:
    """
    Checks if stop loss (SL) or target price (TP) has been hit for any active orders.
    If an SL or TP is triggered for an order, cancels the counterpart order and removes that order.
    Returns True if an SL or TP is triggered for any order, False otherwise.
    """
    triggered = False
    orders_to_remove = []

    # Fetch all current orders just once
    try:
        all_orders = config.kite.orders()
    except Exception as e:
        logging.error(f"Error fetching orders: {e}", exc_info=True)
        return False

    for order in config.active_orders:
        instrument_token = order["instrumentToken"]
        last_price = tick_data.get(instrument_token, {}).get("last_price")
        if last_price is None:
            logging.warning(
                f"No last_price found for instrument token: {instrument_token}"
            )
            continue

        sl_order_id = order.get("last_sl_order")
        tp_order_id = order.get("last_tp_order")

        # If one of the order IDs is missing, consider handling it separately.
        if not sl_order_id or not tp_order_id:
            logging.warning(
                f"Order for {order['tradingsymbol']} missing SL/TP order ID (SL: {sl_order_id}, TP: {tp_order_id})."
            )
            continue

        sl_order_status = next(
            (o["status"] for o in all_orders if o["order_id"] == sl_order_id), None
        )
        tp_order_status = next(
            (o["status"] for o in all_orders if o["order_id"] == tp_order_id), None
        )

        if sl_order_status is None or tp_order_status is None:
            logging.warning(
                f"Could not fetch status for orders (SL: {sl_order_id}, TP: {tp_order_id})."
            )
            continue

        if sl_order_status == "COMPLETE" and tp_order_status != "COMPLETE":
            logging.info(
                f"SL order executed for {order['tradingsymbol']} (OrderId: {sl_order_id}). Cancelling TP order {tp_order_id}."
            )
            cancel_orders(tp_order_id)
            triggered = True
            orders_to_remove.append(order)
        elif tp_order_status == "COMPLETE" and sl_order_status != "COMPLETE":
            logging.info(
                f"TP order executed for {order['tradingsymbol']} (OrderId: {tp_order_id}). Cancelling SL order {sl_order_id}."
            )
            cancel_orders(sl_order_id)
            triggered = True
            orders_to_remove.append(order)
        elif sl_order_status == "REJECTED" or tp_order_status == "REJECTED":
            logging.warning(
                f"Order rejected for {order['tradingsymbol']} (SL: {sl_order_status}, TP: {tp_order_status}). Cancelling both orders."
            )
            cancel_orders(sl_order_id)
            cancel_orders(tp_order_id)
            triggered = True
            orders_to_remove.append(order)
        else:
            logging.debug(
                f"For {order['tradingsymbol']} - SL status: {sl_order_status}, TP status: {tp_order_status}"
            )

    # Remove orders that have been triggered from active orders.
    for order in orders_to_remove:
        if order in config.active_orders:
            config.active_orders.remove(order)

    return triggered


def cancel_orders(order_id: str):
    """Cancels an order given its order ID."""
    try:
        order_utils.cancel_order(config.kite, order_id)
        logging.info(f"Cancelled order {order_id} successfully.")
    except Exception as e:
        logging.error(f"Error cancelling order {order_id}: {e}", exc_info=True)


def reset_all():
    """Resets all trading-related configurations to their initial state."""
    config.active_orders.clear()  # Clear all active orders
    config.instrument_token = {}  # Reset instrument token mapping
    logging.info("Reset all trading configurations to initial state.")


def trading_strategy(tick_data: Dict) -> None:
    """Implements the core trading strategy logic."""
    try:
        if config.nifty_futures_instrument_token not in tick_data:
            logging.warning(
                f"Nifty Futures instrument token {config.nifty_futures_instrument_token} not found in tick_data."
            )
            return

        if check_sl_tp(tick_data):
            return

        # Replace config.current_order check with len(config.active_orders)
        if not config.active_orders:
            handle_new_trade(tick_data)
        else:
            monitor_existing_trade(tick_data)
            adjust_trailing_stoploss(tick_data)

    except Exception as e:
        logging.error(f"Error in trading_strategy: {e}", exc_info=True)


def handle_new_trade(tick_data: Dict):
    """Handles the logic for identifying and initiating a new trade."""
    last_price = round(
        tick_data[config.nifty_futures_instrument_token]["last_price"], 2
    )

    futures_historical_data = get_historical_data(
        config.nifty_futures_instrument_token, interval=config.CANDLE_INTERVAL
    )
    if futures_historical_data is None or futures_historical_data.empty:
        logging.warning("No historical data, skipping trading logic")
        return

    indicators = extract_indicators(futures_historical_data)
    if indicators is None:
        return

    current_volume, ema9, ema20, supertrend, rsi, sma_20_volume, vwap = indicators

    nifty_index = tick_data[config.nifty_index_instrument]["last_price"]
    logging.info(
        f"Nifty Spot: {nifty_index}, Nifty Futures: {last_price}, EMA9: {ema9}, EMA20: {ema20}, Supertrend: {supertrend}, VWAP: {vwap}, RSI: {rsi}, SMA_20_Volume: {sma_20_volume}"
    )

    last_row = extract_last_row_data(futures_historical_data)
    if last_row is None:
        return

    is_uptrend = (
        last_price > ema9
        and ema9 > ema20
        and last_row["close"] > last_row["open"]
        and last_price > supertrend
        and last_price > vwap
        # and current_volume > 1.5 * sma_20_volume
    )  # ADDED condition to check if the candle is green
    is_downtrend = (
        last_price < ema9
        and ema9 < ema20
        and last_row["close"] < last_row["open"]
        and last_price < supertrend
        and last_price < vwap
        # and current_volume > 1.5 * sma_20_volume
    )  # ADD
    print(f"Is Uptrend: {is_uptrend}, Is Downtrend: {is_downtrend}")

    trade_attempted = False
    trade_success = False

    if is_uptrend:
        trade_attempted = True
        trade_success = handle_uptrend(
            tick_data, last_price, ema9, ema20, supertrend, vwap, rsi, nifty_index
        )
    elif is_downtrend:
        trade_attempted = True
        trade_success = handle_downtrend(
            tick_data, last_price, ema9, ema20, supertrend, vwap, rsi, nifty_index
        )

    if trade_attempted and not trade_success:
        logging.error("Failed to place trade during new trade handling.")


def monitor_existing_trade(tick_data: Dict):
    """Handles the logic for monitoring an existing trade, providing updates on key metrics."""
    for order in config.active_orders:
        instrument_token = order["instrumentToken"]
        last_price = round(tick_data[instrument_token]["last_price"], 2)

        options_data = get_historical_data(
            instrument_token, interval=config.CANDLE_INTERVAL
        )

        if options_data is None or options_data.empty:
            logging.warning("No historical data, skipping trade monitoring")
            continue

        indicators_val = extract_indicators(options_data)
        if indicators_val is None:
            continue

        current_volume, ema9, ema20, supertrend, rsi, sma_20_volume, vwap = indicators_val

        nifty_index = tick_data[config.nifty_index_instrument]["last_price"]
        logging.info(
            f"Nifty Spot: {nifty_index}, Nifty Futures: {last_price}, EMA9: {ema9}, EMA20: {ema20}, Supertrend: {supertrend}, VWAP: {vwap}, RSI: {rsi}, TradingSymbol: {order['tradingsymbol']}, Entry: {order['average_entry_price']}, SL: {order['stop_loss']}, Target: {order['target']}, Current: {tick_data[instrument_token]['last_price']}"
        )

        option_price = tick_data[instrument_token]["last_price"]

        exit_condition_met = False
        if config.strategy == "option_selling":
            # Exit condition for option selling: If the option price is above supertrend and VWAP, exit immediately
            if (
                option_price > supertrend
                and option_price > vwap
                and option_price > ema9
                and ema9 > ema20
            ):
                logging.info(
                    f"Exit condition met: Option price {option_price} is above Supertrend {supertrend} and VWAP {vwap}. Exiting trade."
                )
                exit_condition_met = True
        elif config.strategy == "option_buying":
            # Exit condition for option buying: If the option price is below supertrend and VWAP, exit immediately
            if (
                option_price < supertrend
                and option_price < vwap
                and option_price < ema9
                and ema9 < ema20
            ):
                logging.info(
                    f"Exit condition met: Option price {option_price} is below Supertrend {supertrend} and VWAP {vwap}. Exiting trade."
                )
                exit_condition_met = True

        if exit_condition_met:
            try:
                sl_order_id = order["last_sl_order"]
                success = order_utils.modify_order(
                    kite=config.kite,
                    order_id=sl_order_id,
                    quantity=config.quantity,
                    price=0,  # Market order
                    order_type="MARKET",
                    trigger_price=0,
                )
                if success:
                    logging.info(f"Cancelling the TP order: {order['last_tp_order']}")
                    cancel_orders(order["last_tp_order"])
                    config.active_orders.remove(order)
            except Exception as e:
                logging.error(f"Error modifying order: {e}", exc_info=True)


def get_historical_data(instrument_token, interval) -> Optional[pd.DataFrame]:
    """Fetches historical data, calculates indicators, and returns the DataFrame."""
    now = datetime.now()
    from_datetime = now - timedelta(days=1)

    # Find the last working day
    while from_datetime.weekday() >= 5:  # 5 = Saturday, 6 = Sunday
        from_datetime -= timedelta(days=1)

    from_datetime = datetime(
        from_datetime.year, from_datetime.month, from_datetime.day, 9, 15
    )
    to_datetime = datetime.now()

    try:
        historical_data = data_fetcher.get_historical_data(
            config.kite,
            instrument_token,
            from_datetime,
            to_datetime,
            interval=interval,
        )

        if historical_data is None or historical_data.empty:
            logging.warning(
                f"No historical data found for instrument token: {instrument_token}"
            )
            return None

        historical_data = indicators.calculate_indicators(
            historical_data, instrument_token
        )
        return historical_data
    except Exception as e:
        logging.error(
            f"Error fetching/calculating historical data for {instrument_token}: {e}",
            exc_info=True,
        )
        return None


def extract_last_row_data(df: pd.DataFrame) -> Optional[pd.Series]:
    """Extracts the last row of a DataFrame, returns None if empty."""
    if df.empty:
        logging.warning("Dataframe is empty, skipping")
        return None
    # Return the second last row to avoid any incomplete candle data
    return df.iloc[-2]


def extract_indicators(
    df: pd.DataFrame,
) -> Optional[Tuple[float, float, float, float, float, float, float]]:
    """Extracts and calculates the required indicators from the historical data."""
    last_row = extract_last_row_data(df)
    if last_row is None:
        return None

    current_volume = round(last_row.volume, 2)
    ema9 = round(last_row["EMA_9"], 2)
    ema20 = round(last_row["EMA_20"], 2)
    supertrend = round(last_row["Supertrend"], 2)
    rsi = round(last_row["rsi"], 2)

    # Calculate 20-period SMA on Volume
    df["SMA_20_Volume"] = df["volume"].shift(1).rolling(window=20).mean()
    sma_20_volume = round(df["SMA_20_Volume"].iloc[-1], 2)

    now = datetime.now()
    from_datetime = datetime(now.year, now.month, now.day, 9, 15)
    vwap = round(last_row["VWAP"], 2) if now > from_datetime else 0

    return current_volume, ema9, ema20, supertrend, rsi, sma_20_volume, vwap


def handle_uptrend(
    tick_data: Dict,
    last_price: float,
    ema9: float,
    ema20: float,
    supertrend: float,
    vwap: float,
    rsi: float,
    nifty_index: float,
 ) -> bool:
    """Handles uptrend trading logic: Buys ATM call option."""
    logging.info("Signal triggered: Uptrend")

    if not nifty_index:
        logging.warning(f"No data for nifty index instrument, tick data: {tick_data}")
        return False

    selected_strike_price = option_chain.find_atm_strike(nifty_index)
    logging.info(f"ATM Strike Prices near {nifty_index}: {selected_strike_price}")

    atm_call_options = option_chain.get_option_instruments(
        config.instruments,
        config.expiry_date,
        strike_price_min=selected_strike_price - config.offset,
        strike_price_max=selected_strike_price - config.offset,
        option_type="CE" if config.strategy == "option_buying" else "PE",
    )

    if not atm_call_options:
        logging.warning("No ATM Options available.")
        return False

    instrument = next(iter(atm_call_options.values()))
    trading_symbol = instrument["tradingsymbol"]
    instrument_token = instrument["instrument_token"]
    if instrument_token not in tick_data:
        logging.warning("No data for instrument_token")
        return False

    # Fetch option price and indicators
    option_data = get_historical_data(instrument_token, interval=config.CANDLE_INTERVAL)
    if option_data is None or option_data.empty:
        logging.warning("No historical data for option, skipping trade")
        return False

    option_indicators = extract_indicators(option_data)
    if option_indicators is None:
        return False

    option_price = tick_data[instrument_token]["last_price"]
    (
        option_current_volume,
        option_ema9,
        option_ema20,
        option_supertrend,
        option_rsi,
        option_sma_20_volume,
        option_vwap,
    ) = option_indicators
    # option_ema9, option_ema20, option_supertrend, option_vwap = option_indicators[1:5]
    logging.info(
        f"Symbol:{trading_symbol} Option Price: {option_price}, EMA9: {option_ema9}, EMA20: {option_ema20}, Supertrend: {option_supertrend}, VWAP: {option_vwap}"
    )
    # Check conditions for sell positions
    if config.strategy == "option_selling":
        if (
            option_price < option_ema9
            and option_price < option_ema20
            and option_price < option_supertrend
            and option_price < option_vwap
        ):
            result = kite_place_trade(
                trading_symbol,
                instrument_token,
                tick_data,
                direction="SELL",
                quantity=config.quantity,
                option_type="CE",
            )
        else:
            logging.info("Conditions not met for placing sell order in uptrend.")
            return False
    else:
        result = kite_place_trade(
            trading_symbol,
            instrument_token,
            tick_data,
            direction="BUY",
            quantity=config.quantity,
            option_type="CE",
        )

    if result:
        # Log details for all active orders
        for order in config.active_orders:
            logging.info(
                f"UpTrend Trade: Nifty Spot: {nifty_index}, Nifty Futures: {last_price}, EMA9: {ema9}, EMA20: {ema20}, Supertrend: {supertrend}, VWAP: {vwap}, RSI: {rsi}, PUT Entry: {order['average_entry_price']}, SL: {order['stop_loss']}, Target: {order['target']}"
            )
        return True
    else:
        return False


def handle_downtrend(
    tick_data: Dict,
    last_price: float,
    ema9: float,
    ema20: float,
    supertrend: float,
    vwap: float,
    rsi: float,
    nifty_index: float,
) -> bool:
    """Handles downtrend trading logic: Buys ATM put option."""
    logging.info("Signal triggered: Downtrend")

    if not nifty_index:
        logging.warning(f"No data for nifty index instrument, tick data: {tick_data}")
        return False

    selected_strike_price = option_chain.find_atm_strike(nifty_index)
    logging.info(f"ATM Strike Prices near {nifty_index}: {selected_strike_price}")

    atm_put_options = option_chain.get_option_instruments(
        config.instruments,
        config.expiry_date,
        strike_price_min=selected_strike_price + config.offset,
        strike_price_max=selected_strike_price + config.offset,
        option_type="PE" if config.strategy == "option_buying" else "CE",
    )

    if not atm_put_options:
        logging.warning("No ATM Put Options available.")
        return False

    instrument = next(iter(atm_put_options.values()))
    trading_symbol = instrument["tradingsymbol"]
    instrument_token = instrument["instrument_token"]

    # Fetch option price and indicators
    option_data = get_historical_data(instrument_token, interval=config.CANDLE_INTERVAL)
    if option_data is None or option_data.empty:
        logging.warning("No historical data for option, skipping trade")
        return False

    option_indicators = extract_indicators(option_data)
    if option_indicators is None:
        return False

    option_price = tick_data[instrument_token]["last_price"]
    option_ema9, option_ema20, option_supertrend, option_vwap = option_indicators[1:5]

    # Check conditions for buy positions
    if config.strategy == "option_buying":
        if (
            option_price > option_ema9
            and option_price > option_ema20
            and option_price > option_supertrend
            and option_price > option_vwap
        ):
            result = kite_place_trade(
                trading_symbol,
                instrument_token,
                tick_data,
                direction="BUY",
                quantity=config.quantity,
                option_type="PE",
            )
        else:
            logging.info("Conditions not met for placing buy order in downtrend.")
            return False
    else:
        result = kite_place_trade(
            trading_symbol,
            instrument_token,
            tick_data,
            direction="SELL",
            quantity=config.quantity,
            option_type="PE",
        )

    if result:
        # Log details for all active orders
        for order in config.active_orders:
            logging.info(
                f"Downtrend Trade: Nifty Spot: {nifty_index}, Nifty Futures: {last_price}, EMA9: {ema9}, EMA20: {ema20}, Supertrend: {supertrend}, VWAP: {vwap}, RSI: {rsi}, PUT Entry: {order['average_entry_price']}, SL: {order['stop_loss']}, Target: {order['target']}"
            )
        return True
    else:
        return False


def get_sl_trigger_price_sl(
    direction: str, option_type: str, executed_average_price: float
) -> Tuple[float, float, float]:
    """Calculates trigger, SL, and target prices based on direction, option type, and entry price."""
    sl_multiplier = config.STOP_LOSS_PERCENT
    if direction == "SELL":
        trigger_price = round(executed_average_price * (1 + sl_multiplier))
        sl_price = trigger_price + 1
        target_price = round(executed_average_price * (1 - sl_multiplier))
    elif direction == "BUY":
        trigger_price = round(executed_average_price * (1 - sl_multiplier))
        sl_price = trigger_price - 1
        target_price = round(executed_average_price * (1 + sl_multiplier))
    else:
        raise ValueError(f"Invalid direction: {direction}")

    logging.info(
        f"Trigger price: {trigger_price}, SL Price: {sl_price}, Target Price: {target_price}"
    )
    return trigger_price, sl_price, target_price


def kite_place_trade(
    trading_symbol: str,
    instrument_token: int,
    tick_data: Dict,
    direction: str,
    option_type: str,
    quantity: int = 75,
) -> Dict:
    """Places a trade and its associated SL and TP orders."""
    try:
        order_id, executed_average_price = order_utils.place_order(
            kite=config.kite,
            symbol=trading_symbol,
            transaction_type=direction,
            quantity=quantity,
        )
        if not order_id:
            logging.error("Failed to place initial order.")
            return {}

        if executed_average_price is None:
            # The entry HAS executed — order_history just hasn't shown COMPLETE
            # within the polling window. Aborting here would leave a live naked
            # position with no SL/TP and untracked in active_orders, so fall
            # back to the current tick price for SL/TP math instead.
            fallback_price = (tick_data.get(instrument_token) or {}).get("last_price")
            if fallback_price:
                logging.warning(
                    f"Avg entry price unavailable for order {order_id}; using tick last_price {fallback_price} for SL/TP."
                )
                executed_average_price = fallback_price
            else:
                logging.critical(
                    f"ENTRY {order_id} PLACED but no avg price and no tick fallback — NO SL/TP placed, MANUAL ACTION REQUIRED."
                )
                return {"order_id": order_id, "sl_order": None, "tp_order": None}

        # Merge with any existing active order for the same trading symbol
        existing_order = next(
            (o for o in config.active_orders if o["tradingsymbol"] == trading_symbol),
            None,
        )
        if existing_order:
            old_quantity = existing_order.get("quantity", 0)
            new_quantity = old_quantity + quantity
            # Calculate new average using our executed_average_price values.
            new_average_entry_price = (
                (existing_order["average_entry_price"] * old_quantity)
                + (executed_average_price * quantity)
            ) / new_quantity
            # Update the existing order with new quantity and average entry price
            existing_order["quantity"] = new_quantity
            existing_order["average_entry_price"] = new_average_entry_price
        else:
            new_average_entry_price = executed_average_price

        trigger_price, sl_price, target_price = get_sl_trigger_price_sl(
            direction, option_type, new_average_entry_price
        )

        sl_order, _ = order_utils.place_order(
            kite=config.kite,
            symbol=trading_symbol,
            transaction_type="SELL" if direction == "BUY" else "BUY",
            order_type="SL",
            trigger_price=trigger_price,
            price=sl_price,
            quantity=abs(quantity),
        )

        tp_order, _ = order_utils.place_order(
            kite=config.kite,
            symbol=trading_symbol,
            transaction_type="SELL" if direction == "BUY" else "BUY",
            order_type="LIMIT",
            price=target_price,
            quantity=abs(quantity),
        )

        if sl_order is None or tp_order is None:
            logging.warning("Failed to place SL/TP orders.")

        # If merging order, update its SL/TP orders; if new, add it to active orders
        if existing_order:
            existing_order["last_sl_order"] = sl_order
            existing_order["last_tp_order"] = tp_order
            existing_order["best_price"] = new_average_entry_price
        else:
            update_trade_database(
                trading_symbol=trading_symbol,
                instrument_token=instrument_token,
                average_entry_price=new_average_entry_price,
                stop_loss=sl_price,
                target=target_price,
                direction=direction,
                executed_average_price=executed_average_price,
                sl_order=sl_order,
                tp_order=tp_order,
                option_type=option_type,
                quantity=quantity,
            )

        logging.info("Trade placed successfully.")
        return {"order_id": order_id, "sl_order": sl_order, "tp_order": tp_order}

    except Exception as e:
        logging.error(f"Error placing trade: {e}", exc_info=True)
        return {}


def update_trade_database(
    trading_symbol: str,
    instrument_token: int,
    average_entry_price: float,
    stop_loss: float,
    target: float,
    direction: str,
    executed_average_price: float,
    sl_order: int,
    tp_order: int,
    option_type: str,
    quantity: int,
):
    """Updates the trade database with the latest trade details."""
    order_details = {
        "tradingsymbol": trading_symbol,
        "instrumentToken": instrument_token,
        "average_entry_price": average_entry_price,
        "stop_loss": stop_loss,
        "target": target,
        "direction": direction,
        "last_sl_order": sl_order,
        "last_tp_order": tp_order,
        "option_type": option_type,
        "best_price": average_entry_price,
        "quantity": quantity,
    }
    config.active_orders.append(order_details)


def adjust_trailing_stoploss(tick_data: Dict):
    """
    Adjusts the stop loss based on the current price, implementing a trailing stop loss.
    This function should be called regularly while a trade is active.
    """
    if not config.active_orders:
        return

    for order in config.active_orders:
        instrument_token = order["instrumentToken"]
        last_price = tick_data.get(instrument_token, {}).get("last_price")

        if last_price is None:
            logging.warning(
                f"No last_price found for instrument token: {instrument_token}"
            )
            continue

        direction = order["direction"]
        average_entry_price = order["average_entry_price"]
        stop_loss = order["stop_loss"]
        target_price = order["target"]

        # Initialize new_stop_loss with the current stop_loss value
        new_stop_loss = stop_loss

        # Calculate half of the target profit
        half_target_profit = (
            (target_price - average_entry_price) / 2
            if direction == "BUY"
            else (average_entry_price - target_price) / 2
        )

        # Determine the target price based on direction
        if direction == "BUY":
            # If the price has increased to 50% of the target, initialize SL to cost
            if last_price >= average_entry_price + half_target_profit:
                if last_price - order["best_price"] >= 2:
                    new_stop_loss = max(stop_loss, last_price - 3)
            else:
                if last_price - order["best_price"] >= 2:
                    new_stop_loss = max(stop_loss, stop_loss + 1)

            # Check if the new stop loss is higher than the current stop loss
            if new_stop_loss > stop_loss:
                logging.info(
                    f"Adjusting trailing stop loss. Old SL: {stop_loss}, New SL: {new_stop_loss}, Current Price: {last_price}"
                )

                # Modify the existing SL order with the adjusted stop loss price
                sl_order_id = order["last_sl_order"]
                success = order_utils.modify_order(
                    kite=config.kite,
                    order_id=sl_order_id,
                    quantity=config.quantity,
                    price=new_stop_loss - 1,  # Slight buffer, to ensure order execution
                    order_type="SL",
                    trigger_price=new_stop_loss,
                )

                if success:
                    # Update the trade database with the new stop loss
                    order["stop_loss"] = new_stop_loss
                    order["best_price"] = last_price
                    logging.info(
                        f"Trailing stop loss adjusted successfully. Modified SL order ID: {sl_order_id}"
                    )
                else:
                    logging.error("Failed to modify trailing stop loss order.")

        elif direction == "SELL":
            # If the price has decreased to 50% of the target, initialize SL to cost
            if last_price <= average_entry_price - half_target_profit:
                if order["best_price"] - last_price >= 2:
                    new_stop_loss = min(stop_loss, last_price + 3)
            else:
                # Trail the stop loss by 1 point for every 2 points decrease in price
                if order["best_price"] - last_price >= 2:
                    new_stop_loss = min(stop_loss, stop_loss - 1)

            # Check if the new stop loss is lower than the current stop loss
            if new_stop_loss < stop_loss:
                logging.info(
                    f"Adjusting trailing stop loss. Old SL: {stop_loss}, New SL: {new_stop_loss}, Current Price: {last_price}"
                )

                # Modify the existing SL order with the adjusted stop loss price
                sl_order_id = order["last_sl_order"]
                success = order_utils.modify_order(
                    kite=config.kite,
                    order_id=sl_order_id,
                    quantity=config.quantity,
                    price=new_stop_loss + 1,  # Slight buffer, to ensure order execution
                    order_type="SL",
                    trigger_price=new_stop_loss,
                )

                if success:
                    # Update the trade database with the new stop loss
                    order["stop_loss"] = new_stop_loss
                    order["best_price"] = last_price
                    logging.info(
                        f"Trailing stop loss adjusted successfully. Modified SL order ID: {sl_order_id}"
                    )
                else:
                    logging.error("Failed to modify trailing stop loss order.")
