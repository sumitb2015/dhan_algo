import logging
import pandas as pd
import sys
from . import config

from .data_fetcher import get_todays_historical_data

try:
    import pandas_ta as ta  # Use pandas-ta instead of talib
except ImportError:
    print("pandas_ta is not installed. Please install it using: pip install pandas-ta")
    sys.exit(1)

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)


def calculate_indicators(df, instrument_token):
    """Calculates indicators using pandas_ta."""
    try:
        df["EMA_9"] = ta.ema(df["close"], length=9)
        df["EMA_20"] = ta.ema(df["close"], length=20)
        supertrend = ta.supertrend(
            df["high"], df["low"], df["close"], period=7, multiplier=2
        )
        df["Supertrend"] = supertrend["SUPERT_7_2.0"]
        df["rsi"] = ta.rsi(df["close"], length=14)

        # MACD
        macd = ta.macd(df["close"], fast=12, slow=26, signal=9)
        df["MACD"] = macd["MACD_12_26_9"]
        df["MACD_Hist"] = macd["MACDh_12_26_9"]
        df["MACD_Signal"] = macd["MACDs_12_26_9"]

        # Stochastic RSI
        stochrsi = ta.stochrsi(df["close"], length=14, rsi_length=14, k=3, d=3)
        df["StochRSI_K"] = stochrsi["STOCHRSIk_14_14_3_3"]
        df["StochRSI_D"] = stochrsi["STOCHRSId_14_14_3_3"]

        # Additional indicators (examples - feel free to add more)
        df["ATR"] = ta.atr(df["high"], df["low"], df["close"], length=14)
        df["ADX"] = ta.adx(df["high"], df["low"], df["close"], length=14)[
            "ADX_14"
        ]  # returns a dataframe, extract 'ADX_14'

        # Calculate VWAP using today's data
        todays_data = get_todays_historical_data(
            config.kitew, instrument_token, interval=config.CANDLE_INTERVAL
        )
        if todays_data is not None and not todays_data.empty:
            df["VWAP"] = calculate_vwap(todays_data)  # Add vwap column
        else:
            logging.warning("No data for today, VWAP set to None")
            df["VWAP"] = None  # Set to None if no data is available
        return df
    except Exception as e:
        logging.error(f"Error calculating indicators: {e}")
        return None


def calculate_vwap(df):
    """Calculates VWAP using Pandas."""
    typical_price = (df["high"] + df["low"] + df["close"]) / 3
    df["typical_price"] = typical_price
    df["volume"] = df["volume"].astype(float)  # Ensure volume is numeric
    df["price_volume"] = df["typical_price"] * df["volume"]
    cumulative_price_volume = df["price_volume"].cumsum()
    cumulative_volume = df["volume"].cumsum()
    vwap = cumulative_price_volume / cumulative_volume
    return vwap.iloc[-1]
