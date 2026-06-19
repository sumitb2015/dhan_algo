import inspect
from dhanhq import dhanhq

try:
    print("Inspecting dhanhq.intraday_minute_data signature:")
    print(inspect.signature(dhanhq.intraday_minute_data))
except Exception as e:
    print(f"Error inspecting intraday_minute_data: {e}")

try:
    print("\nInspecting dhanhq.historical_daily_data signature:")
    print(inspect.signature(dhanhq.historical_daily_data))
except Exception as e:
    print(f"Error inspecting historical_daily_data: {e}")

try:
    print("\nInspecting dhanhq.ohlc_data signature:")
    # Assuming ohlc_data is a method of dhanhq class, need an instance or access class
    # Creating a mock client isn't needed if we inspect the class method
    print(inspect.signature(dhanhq.ohlc_data))
except Exception as e:
    print(f"Error inspecting ohlc_data: {e}")
