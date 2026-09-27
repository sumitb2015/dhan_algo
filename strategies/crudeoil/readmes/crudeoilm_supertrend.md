## Summary

Directional MCX CRUDEOILM futures strategy. Buys or sells the nearest futures contract when
Supertrend confirms a trend direction, trailing the stop via the Supertrend band itself.
Intraday, covering both the MCX day and evening sessions.

## Entry

- Session default **09:00–23:30 IST** (`--start-time`/`--eod-time`).
- Uses Supertrend(`--supertrend-period` 7, `--supertrend-multiplier` 3.0) on `--interval` (default **5**-min) candles, evaluated on the confirmed closed candle.
- `STd = +1` → go LONG; `STd = -1` → go SHORT.
- Optional `--use-vwap`: requires close above/below session VWAP as an additional entry filter only (never used for exits).
- `--lots`, default **1**.

## Exit

Priority order:
1. Dashboard shutdown trigger.
2. EOD time reached.
3. Daily profit target hit.
4. Daily stop loss hit.
5. Trailing SL: LTP crosses the Supertrend band (refreshed each new candle).
- After any exit, waits `--cooldown-candles` (default **1**) full candle before re-evaluating the signal.

## Target

- Daily profit cap `--target-profit`, default **₹3,000** (cumulative across positions).

## Stop Loss

- Daily stop-loss cap `--stop-loss`, default **₹3,000** (cumulative across positions).
- Per-trade trailing stop: the Supertrend band level itself, refreshed on each new candle.
