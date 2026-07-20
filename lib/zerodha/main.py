import logging
import time
import sys
from datetime import datetime, time as dt_time
from . import authentication
from . import data_fetcher
from . import option_chain
from .trading_logicv6 import trading_strategy
from . import websocket_handler
from kiteconnect import KiteConnect
from . import config

try:
    import credDemo as cred  # Assume this exists and contains your credentials
except ImportError:
    class DummyCred:
        USER_ID = "PLACEHOLDER"
        PASSWORD = "PLACEHOLDER"
        TOTP = "PLACEHOLDER"
        API_KEY = "PLACEHOLDER"
        API_SECRET = "PLACEHOLDER"
    cred = DummyCred()

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)


def initialize_instruments(instruments):
    """Initializes instrument tokens for Nifty 50 and Nifty Futures."""
    global nifty_index_instrument, nifty_futures_instrument_token

    nifty_50_instrument = next(
        (item for item in instruments if item.get("tradingsymbol") == "NIFTY 50"), None
    )
    if nifty_50_instrument:
        config.nifty_index_instrument = nifty_50_instrument["instrument_token"]
        logging.info(f"Nifty 50 Instrument Token: {config.nifty_index_instrument}")
    else:
        logging.error("Nifty 50 instrument not found in instruments list.")
        sys.exit(1)

    nifty_futures = next(
        (item for item in instruments if item.get("tradingsymbol") == "NIFTY25FEBFUT"),
        None,
    )
    if nifty_futures:
        config.nifty_futures_instrument_token = nifty_futures["instrument_token"]
        logging.info(
            f"Nifty Futures Instrument Token: {config.nifty_futures_instrument_token}"
        )
    else:
        logging.error("Nifty Futures instrument not found in instruments list.")
        config.nifty_futures_instrument_token = None


def login_zerodha():
    """Logs into Zerodha using the official Kite Connect session."""
    kite, access_token = authentication.restore_kite_session()

    if not access_token:
        request_token = authentication.get_request_token()
        print(f"Request Token: {request_token}")
        kite, access_token = authentication.initialize_kite_session(request_token)
        authentication.save_access_token(access_token)

    if kite is None:
        kite = KiteConnect(api_key=cred.API_KEY)
        kite.set_access_token(access_token)

    profile = kite.profile()
    logging.info(f"Logged in as user: {profile['user_name']}")

    config.instruments = data_fetcher.fetch_instruments(kite)
    initialize_instruments(config.instruments)

    return (
        kite,
        config.nifty_index_instrument,
        config.nifty_futures_instrument_token,
    )


def initialize_user_inputs():
    config.strategy = "option_selling"
    config.quantity = 75
    config.offset = 200


def close_all_trades():
    """Closes all open trades."""
    try:
        positions = config.kite.positions()["net"]
        for position in positions:
            if position["quantity"] != 0:
                order_type = "SELL" if position["quantity"] > 0 else "BUY"
                config.kite.place_order(
                    tradingsymbol=position["tradingsymbol"],
                    exchange=position["exchange"],
                    transaction_type=order_type,
                    quantity=abs(position["quantity"]),
                    order_type="MARKET",
                    product=position["product"],
                    variety=config.kite.VARIETY_REGULAR,
                    market_protection=-1,
                )
                logging.info(f"Closed position for {position['tradingsymbol']}")
    except Exception as e:
        logging.error(f"Error closing trades: {e}", exc_info=True)


def main():
    """Main function to orchestrate the trading process."""

    try:
        # Wait until 9:15 AM to start the program
        while datetime.now().time() < dt_time(9, 15):
            logging.info("Waiting until 9:15 AM to start the program...")
            time.sleep(60)

        # 1. Login and Initialize
        (
            config.kite,
            config.nifty_index_instrument,
            config.nifty_futures_instrument_token,
        ) = login_zerodha()
        # 2. Initialize Important Levels
        if config.nifty_futures_instrument_token:
            config.global_levels = data_fetcher.initialize_important_levels(
                config.kite, config.nifty_futures_instrument_token
            )

        # 3. Get Expiry Date
        config.expiry_date = option_chain.get_expiry_date()
        logging.info(f"Expiry Date: {config.expiry_date}")
        expiry_date_str = config.expiry_date.strftime("%Y-%m-%d")

        # Initialize user inputs
        initialize_user_inputs()

        # 4. Fetch Option Instruments
        nifty_quote = config.kite.quote(config.nifty_index_instrument)
        if not nifty_quote:
            logging.error("Could not get quote for Nifty 50.")
            return
        nifty_last_price = nifty_quote[str(config.nifty_index_instrument)]["last_price"]
        logging.info(f"Nifty Index price : {nifty_last_price}")
        atm_strike = option_chain.find_atm_strike(nifty_last_price)
        logging.info(f"Nifty ATM Strike price : {atm_strike}")
        strike_prices = range(atm_strike - 500, atm_strike + 500, 50)
        logging.info(
            f"Generated Strike Prices from {atm_strike - 500} to {atm_strike + 500} with step 50"
        )

        ce_instruments = option_chain.get_option_instruments(
            config.instruments,
            expiry_date_str,
            min(strike_prices),
            max(strike_prices),
            "CE",
        )
        pe_instruments = option_chain.get_option_instruments(
            config.instruments,
            expiry_date_str,
            min(strike_prices),
            max(strike_prices),
            "PE",
        )

        # Combine CE and PE, using type as prefix
        config.instruments_by_strike = {}
        config.instruments_by_strike.update(
            {"CE_" + str(k): v for k, v in ce_instruments.items() if v}
        )
        config.instruments_by_strike.update(
            {"PE_" + str(k): v for k, v in pe_instruments.items() if v}
        )

        config.nifty_instrument_tokens = [
            # Ensure instrument exist
            inst["instrument_token"]
            for inst in config.instruments_by_strike.values()
            if inst
        ]
        logging.info(
            f"Option Instrument Tokens (CE & PE): {config.nifty_instrument_tokens}"
        )

        # 5. Initialize WebSocket
        kws = websocket_handler.initialize_websocket(config.kite)
        # 6. Trading Loop
        try:
            while True:
                current_time = datetime.now().time()
                if current_time >= dt_time(15, 17):
                    logging.info("Time is 3:17 PM. Exiting all trades.")
                    close_all_trades()
                    break

                time.sleep(1)
                trading_strategy(config.tick_data)
                # print(config.kite.positions()["net"])

        except Exception as e:
            logging.error(f"Error in main loop: {e}")
            raise

    except Exception as e:
        logging.error(f"An error occurred in main: {e}")
        print("Exiting gracefully due to error")
        sys.exit(1)

    finally:
        print("All trades closed. Monitoring stopped.")


if __name__ == "__main__":
    main()
