import logging
import pandas as pd
from datetime import datetime, timedelta
from .kite_trade import KiteApp
import csv
import sys
from . import config  # Import the config file relative to package

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)


def fetch_instruments(kitew):
    """Fetches and saves instrument data."""
    instruments = kitew.instruments()
    if instruments:
        headers = instruments[0].keys() if instruments else []
        with open("instruments.csv", "w", newline="", encoding="utf-8") as csvfile:
            writer = csv.writer(csvfile)
            writer.writerow(headers)
            for row in instruments:
                writer.writerow(row.values())
        print("Instruments data written to instruments.csv")
    else:
        print("No instruments data to write")
    return instruments


def get_instrument_token_by_tradingsymbol(instruments, tradingsymbol):
    """Retrieves the instrument token for a given trading symbol."""
    for item in instruments:
        if item.get("tradingsymbol") == tradingsymbol:
            return item.get("instrument_token")
    return None


def get_historical_data(
    kitew, instrument_token, from_datetime, to_datetime, interval="minute"
):
    """Fetches historical data from Kite Connect."""
    try:
        historical_data = kitew.historical_data(
            instrument_token,
            from_datetime,
            to_datetime,
            interval,
            continuous=False,
            oi=True,
        )
        df = pd.DataFrame(historical_data)
        if not df.empty:
            if "volume" not in df.columns:
                # Add volume column if it doesn't exist.  Crucial for VWAP
                df["volume"] = 0
            return df
        else:
            logging.warning(
                f"No historical data found for instrument token: {instrument_token}"
            )
            return pd.DataFrame()  # return empty dataframe instead of None
    except Exception as e:
        logging.error(f"Error fetching historical data: {e}")
        return pd.DataFrame()  # return empty dataframe instead of None


def get_todays_historical_data(kitew, instrument_token, interval="minute"):
    """Fetches historical data from Kite Connect for today only."""
    now = datetime.now()
    from_datetime = datetime(now.year, now.month, now.day, 9, 15)
    to_datetime = now
    if now < from_datetime:
        logging.info(
            "Current time is earlier than 9:15AM. So VWAP cannot be calculated. Exiting."
        )
        return pd.DataFrame()
    try:
        historical_data = kitew.historical_data(
            instrument_token,
            from_datetime,
            to_datetime,
            interval,
            continuous=False,
            oi=True,
        )
        df = pd.DataFrame(historical_data)
        if not df.empty:
            df.rename(columns={"opening": "open", "closing": "close"}, inplace=True)
            if "volume" not in df.columns:
                df["volume"] = 0
            return df
        else:
            logging.warning(
                f"No historical data found for instrument token for today: {instrument_token}"
            )
            return pd.DataFrame()  # return empty dataframe instead of None
    except Exception as e:
        logging.error(f"Error fetching historical data: {e}")
        return pd.DataFrame()  # return empty dataframe instead of None


def initialize_important_levels(kitew, nifty_futures_instrument_token):
    """Calculates and stores Previous Day High, Low and Pivot levels from *yesterday's data only*."""
    global_levels = {
        "pdh": None,
        "pdl": None,
        "Pivot": None,
        "tc": None,
        "bc": None,
        "R1": None,
        "S1": None,
        "R2": None,
        "S2": None,
        "R3": None,
        "S3": None,
        "R4": None,
        "S4": None,
    }

    from_date = to_date = datetime.now() - timedelta(days=1)

    try:
        historical_data = kitew.historical_data(
            nifty_futures_instrument_token,
            from_date,
            to_date,
            "day",
            continuous=False,
            oi=False,
        )
        df = pd.DataFrame(historical_data)

        if not df.empty:
            df.rename(columns={"opening": "open", "closing": "close"}, inplace=True)
            global_levels["pdh"] = df["high"].max()
            global_levels["pdl"] = df["low"].min()

            pivot = (
                df["high"].iloc[-1] + df["low"].iloc[-1] + df["close"].iloc[-1]
            ) / 3
            bc = (df["high"].iloc[-1] + df["low"].iloc[-1]) / 2
            tc = (pivot - bc) + pivot
            r1 = (2 * pivot) - df["low"].iloc[-1]
            s1 = (2 * pivot) - df["high"].iloc[-1]
            r2 = pivot + (df["high"].iloc[-1] - df["low"].iloc[-1])
            s2 = pivot - (df["high"].iloc[-1] - df["low"].iloc[-1])
            r3 = df["high"].iloc[-1] + 2 * (pivot - df["low"].iloc[-1])
            s3 = df["low"].iloc[-1] - 2 * (df["high"].iloc[-1] - pivot)
            r4 = r3 + (r2 - r1)
            s4 = s3 - (s1 - s2)

            global_levels["Pivot"] = pivot
            global_levels["tc"] = tc
            global_levels["bc"] = bc
            global_levels["R1"] = r1
            global_levels["S1"] = s1
            global_levels["R2"] = r2
            global_levels["S2"] = s2
            global_levels["R3"] = r3
            global_levels["S3"] = s3
            global_levels["R4"] = r4
            global_levels["S4"] = s4

            logging.info(f"All Important Levels {global_levels}")
        else:
            logging.warning("No yesterday's data to calculate global levels.")
            global_levels = {k: None for k in global_levels}

    except Exception as e:
        logging.error(
            f"Error fetching historical data for calculating global levels: {e}"
        )
        global_levels = {k: None for k in global_levels}

    return global_levels
