import logging
from datetime import date, timedelta
from . import config  # Import the config file relative to package

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)


def find_atm_strike(index_price, step_size=50):
    """Finds the ATM strike price for Nifty 50."""
    return round(index_price / step_size) * step_size


def get_expiry_date():
    """Calculates the next Thursday's expiry date."""
    today = date.today()
    days_to_thursday = (3 - today.weekday()) % 7
    next_thursday = today + timedelta(days=days_to_thursday)
    return next_thursday


def get_next_expiry_date():
    """Calculates the expiry date for the next week's Thursday, regardless of the current day."""
    today = date.today()
    days_to_thursday = (3 - today.weekday()) % 7
    next_thursday = today + timedelta(days=days_to_thursday)

    # If the calculated date is today (Thursday), add 7 days to get next week's Thursday
    if next_thursday == today and today.weekday() == 3:
        next_thursday += timedelta(days=7)

    return next_thursday


def get_tradingsymbol(instruments, instrument_token):
    """Retrieves the trading symbol for a given instrument token."""
    for item in instruments:
        if item.get("instrument_token") == instrument_token:
            return item.get("tradingsymbol")
    return None


def get_instrument_details(instruments, instrument_token):
    """Retrieves instrument details for a given instrument token."""
    for item in instruments:
        if item.get("instrument_token") == instrument_token:
            return {
                "strike": item.get("strike"),
                "expiry": item.get("expiry"),
                "instrument_type": item.get("instrument_type"),
            }
    return None


def get_option_instruments(
    instruments, expiry_date_str, strike_price_min, strike_price_max, option_type
):
    """Returns the instruments for the option within the defined strike prices with a particular expiry date."""
    options = []
    for instrument in instruments:
        if (
            instrument["name"] == "NIFTY"
            and instrument["instrument_type"] == option_type.upper()
            and str(instrument["expiry"]).startswith(str(expiry_date_str))
            and strike_price_min <= instrument["strike"] <= strike_price_max
        ):
            options.append(instrument)

    strike_prices = sorted(list(set(inst["strike"] for inst in options)))

    instruments_by_strike = {
        strike: next(option for option in options if option["strike"] == strike)
        for strike in strike_prices
    }
    return instruments_by_strike


def subscribe_options(kite, nifty_index_instrument, instruments, expiry_date):
    """Subscribes to the ATM option strikes."""
    nifty_quote = kite.quote(nifty_index_instrument)
    if not nifty_quote:
        logging.error("Could not get quote for Nifty 50.")
        return []

    nifty_last_price = nifty_quote[str(nifty_index_instrument)]["last_price"]
    atm_strike = find_atm_strike(nifty_last_price)

    strike_prices = range(atm_strike - 500, atm_strike + 500, 50)
    strike_instruments = get_option_instruments(
        instruments, expiry_date, strike_prices[0], strike_prices[-1]
    )
    instrument_tokens = [
        strike_instruments[strike]["instrument_token"] for strike in strike_instruments
    ]
    return instrument_tokens
