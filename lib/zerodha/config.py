# Global Variables
kite = None
instruments = None
nifty_index_instrument = None
nifty_futures_instrument_token = None
instruments_by_strike = None
tick_data = {}
nifty_instrument_tokens = []
last_placed_order = {}  # For the last time, which order is open
current_order = False
STOP_LOSS_PERCENT = 0.3
TARGET_PERCENT = 0.3
global_levels = {}
expiry_date = None
CANDLE_INTERVAL = "minute"  # Can be "minute", "3minute", "5minute", "10minute", "15minute", "30minute", "60minute"
