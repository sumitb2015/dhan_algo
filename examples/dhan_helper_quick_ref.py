"""
DhanHelper - Quick Reference Card
Import: from lib.dhan_helper import DhanHelper
"""

# ============================================================================
# INITIALIZATION
# ============================================================================
from login import get_dhan_client
from lib.dhan_helper import DhanHelper

dhan = get_dhan_client()
helper = DhanHelper(dhan)

# ============================================================================
# FUND MANAGEMENT
# ============================================================================
funds = helper.get_available_funds()

# ============================================================================
# PORTFOLIO
# ============================================================================
positions = helper.get_positions()
holdings = helper.get_holdings()

# ============================================================================
# ORDER MANAGEMENT
# ============================================================================
# Place Order
order_id = helper.place_order(
    security_id='52175',
    exchange_segment=helper.NSE_FNO,
    transaction_type=helper.BUY,
    quantity=50,
    order_type=helper.MARKET,
    product_type=helper.INTRA
)

# Get Orders
all_orders = helper.get_order_list()
order = helper.get_order_by_id("123456789")
order = helper.get_order_by_correlation_id("my_corr_id")
status = helper.get_order_status("123456789")

# Modify/Cancel Orders
helper.modify_order("123456789", quantity=100, order_type=helper.LIMIT, price=1500)
helper.cancel_order("123456789")
helper.cancel_all_orders()

# ============================================================================
# TRADE BOOK
# ============================================================================
all_trades = helper.get_trade_book()
order_trades = helper.get_trade_book("123456789")
history = helper.get_trade_history("2025-01-01", "2025-01-23")

# ============================================================================
# MARKET DATA
# ============================================================================
# Single Security
ltp = helper.get_ltp("13", "IDX_I")
ohlc = helper.get_ohlc(1333, "NSE_EQ")

# Multiple Securities
ticker = helper.get_ticker_data({"NSE_EQ": [1333, 11915]})
quote = helper.get_quote_data({"NSE_EQ": [1333]})

# ============================================================================
# HISTORICAL DATA
# ============================================================================
# Daily Data
daily = helper.get_historical_daily_data(
    security_id=13,
    exchange_segment="IDX_I",
    instrument_type="INDEX",
    from_date="2025-01-01",
    to_date="2025-01-23"
)

# Intraday Data
intraday = helper.get_intraday_minute_data(
    security_id=13,
    exchange_segment="IDX_I",
    instrument_type="INDEX",
    interval="5",  # "1", "5", "15", "25", "60"
    from_date="2025-01-23",
    to_date="2025-01-23"
)

# Expired Options
expired = helper.get_expired_options_data(
    security_id=13,
    exchange_segment="NSE_FNO",
    instrument_type="INDEX",
    expiry_flag="WEEK",
    expiry_code=1,
    strike="ATM",
    drv_option_type="CALL",
    required_data=["open", "high", "low", "close", "volume", "oi"],
    from_date="2025-01-01",
    to_date="2025-01-23"
)

# ============================================================================
# OPTION CHAIN
# ============================================================================
expiries = helper.get_expiry_list(13, "IDX_I")
chain = helper.get_option_chain(13, "2025-01-30", "IDX_I")

# ============================================================================
# SECURITY LIST
# ============================================================================
securities = helper.fetch_security_list("compact")  # or "full"

# ============================================================================
# FOREVER ORDERS (GTT)
# ============================================================================
gtt_id = helper.place_forever_order(
    security_id="1333",
    exchange_segment=helper.NSE,
    transaction_type=helper.BUY,
    quantity=10,
    price=1900,
    trigger_price=1950,
    order_type=helper.LIMIT,
    product_type=helper.CNC
)

# ============================================================================
# EDIS / TPIN
# ============================================================================
helper.generate_tpin()
helper.open_browser_for_tpin(isin='INE00IN01015', qty=1, exchange='NSE')
status = helper.get_edis_status(isin='INE00IN01015')

# ============================================================================
# BULK OPERATIONS
# ============================================================================
helper.close_all_positions()
helper.cancel_all_orders()

# ============================================================================
# UTILITIES
# ============================================================================
time_str = helper.epoch_to_datetime(1706000000)

# ============================================================================
# CONSTANTS
# ============================================================================
# Exchange Segments: helper.NSE, helper.BSE, helper.NSE_FNO
# Transaction Types: helper.BUY, helper.SELL
# Order Types: helper.MARKET, helper.LIMIT
# Product Types: helper.INTRA, helper.CNC, helper.MARGIN
