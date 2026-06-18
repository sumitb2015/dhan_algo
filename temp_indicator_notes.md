# Simplified Indicator Implementation - pandas_ta Only

## Changes to Make

### 1. Remove Fallback Code
- Remove all `HAS_TALIB` checks
- Remove all manual calculation fallbacks
- Use only `pandas_ta` for all indicators

### 2. Simplify get_indicators()
- EMA: `df.ta.ema(length=period)`
- SMA: `df.ta.sma(length=period)`
- RSI: `df.ta.rsi(length=period)`
- ATR: `df.ta.atr(length=period)`
- Supertrend: `df.ta.supertrend(length=period, multiplier=multiplier)`

### 3. Add New Indicators
- MACD: `df.ta.macd(fast=12, slow=26, signal=9)`
- Bollinger Bands: `df.ta.bbands(length=20, std=2)`

### 4. Add Helper Functions
- `get_macd()` - Returns MACD line, signal, and histogram
- `get_bollinger_bands()` - Returns upper, middle, lower bands
