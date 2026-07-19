import logging
from kiteconnect import KiteTicker
from . import config  # Import the config file relative to package
import time

try:
    import credDemo as cred
except ImportError:
    # Fallback to allow dummy execution or placeholder
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


def on_ticks(ws, ticks):
    """Callback to receive ticks."""
    # print("Ticks: {}".format(ticks))
    for tick in ticks:
        instrument_token = tick["instrument_token"]
        if instrument_token in config.tick_data:
            config.tick_data[instrument_token]["last_price"] = tick["last_price"]
        else:
            config.tick_data[instrument_token] = {"last_price": tick["last_price"]}


def on_connect(ws, response):
    """Callback on successful connect."""
    global \
        nifty_index_instrument, \
        nifty_futures_instrument_token, \
        nifty_instrument_tokens
    logging.info("Websocket connected.")
    print("Inside on_connect function...")
    # Subscribe to Nifty 50 index
    ws.subscribe([config.nifty_index_instrument])
    ws.set_mode(ws.MODE_LTP, [config.nifty_index_instrument])

    # Subscribe to Nifty Futures
    if config.nifty_futures_instrument_token:
        ws.subscribe([config.nifty_futures_instrument_token])
        ws.set_mode(ws.MODE_LTP, [config.nifty_futures_instrument_token])

    # Subscribe to option instrument tokens (check if the list is not empty)
    if config.nifty_instrument_tokens:  # Only subscribe if the list is not empty
        ws.subscribe(config.nifty_instrument_tokens)
        ws.set_mode(ws.MODE_LTP, config.nifty_instrument_tokens)
        logging.info("Subscribed to option instrument tokens")
    else:
        logging.warning("nifty_instrument_tokens is empty. No options to subscribe to.")


def initialize_websocket(kite):
    """Initializes and connects to the Kite WebSocket using the official KiteConnect session."""
    try:
        kws = KiteTicker(
            api_key=cred.API_KEY,
            access_token=kite.access_token,
        )
        kws.on_ticks = on_ticks
        kws.on_connect = on_connect
        kws.connect(threaded=True)
        while not kws.is_connected():
            time.sleep(1)
        logging.info("Websocket connected.")
        return kws
    except Exception as e:
        logging.error(f"Error connecting to WebSocket: {e}")
        raise
