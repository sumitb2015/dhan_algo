# CrudeOil Mini Supertrend Strategy

## Overview
Directional MCX CRUDEOILM futures strategy. Buys or sells the nearest futures contract
when Supertrend confirms a trend direction. Trails stop via the Supertrend band level.

## Session
Default: 09:00–23:30 IST (covers both MCX day and evening sessions). Configurable via `--start-time` / `--eod-time`.

## Signal
- Uses pandas_ta Supertrend on configurable-interval candles (default 5m)
- Entry on confirmed closed candle (second-to-last row): STd=+1 → LONG, STd=-1 → SHORT
- ST band level becomes the initial trailing stop

## Exit Conditions (priority order)
1. UI shutdown trigger file
2. EOD time reached
3. Daily profit target hit (cumulative across positions)
4. Daily stop loss hit (cumulative across positions)
5. Trailing SL: LTP crosses Supertrend band (refreshed each new candle)

## Re-entry
After any exit, waits for one full new candle before re-evaluating signal.

## Key CLI Flags
```
--live                        Real orders (default: dry run)
--lots INT                    Position size (default: 1)
--interval STR                1/3/5/15 minutes (default: 5)
--supertrend-period INT        ATR period (default: 7)
--supertrend-multiplier FLOAT  Multiplier (default: 3.0)
--target-profit FLOAT         Daily profit cap INR (default: 3000)
--stop-loss FLOAT             Daily loss cap INR (default: 3000)
--start-time STR              Session start HH:MM (default: 09:00)
--eod-time STR                EOD HH:MM (default: 23:30)
--cooldown-candles INT        Candles to wait after exit before re-entry scan (default: 1)
--use-vwap                    Use VWAP as an additional exit signal (flag, default: off)
```

---

# CrudeOil Mini Renko Stop-and-Reverse Strategy

## Overview
Continuous stop-and-reverse (SAR) MCX CRUDEOILM futures strategy driven by Renko
bricks built from 5-minute candle closes. Always holds a position during session
hours: enters in the direction of the latest completed brick, flips only after
N consecutive opposite-colored bricks (default 3).

## Renko Brick Rules
- **Close-only**: bricks form from candle closes; highs/lows are ignored.
- **Box size**: default 5 points (`--box-size`).
- **Anchor**: first candle close of the lookback window, rounded down to a box
  multiple. The window start is pinned on the first fetch so the brick series
  is stable across polls.
- **Continuation**: a new same-color brick each full box beyond the leading edge.
- **Reversal**: requires a 2×box move from the leading edge (classic
  non-overlapping bricks).
- **Gaps**: one candle spanning N boxes emits N bricks, each counting toward
  the consecutive-opposite counter.
- Signals only fire on fully completed bricks — the in-progress 5-min candle is
  excluded.

## SAR Logic
- Initial entry (and any restart): direction of the latest completed brick
  (green → LONG, red → SHORT).
- While LONG: hold through 1–2 red bricks; 3 consecutive red bricks → exit and
  immediately enter SHORT. Symmetric for SHORT. The counter resets whenever a
  same-direction brick prints (it is the trailing same-color run).
- No daily profit/loss caps — pure SAR. Only the EOD time (default 23:30)
  flattens the position.
- If the reversal's re-entry order fails, the strategy stays flat and retries
  on the next poll (desired direction is re-derived from the brick series).

## Restart Behavior
Only the day's realized P&L is restored from the state file. Positions are NOT
recovered — on a live restart while holding a position, flatten manually first.

## Key CLI Flags
```
--live                Real orders (default: dry run)
--qty INT             Order quantity in barrels (default: 10 = 1 lot; MCX lot size is 10)
--box-size FLOAT      Renko box in points (default: 5)
--reverse-bricks INT  Consecutive opposite bricks to flip (default: 3)
--interval STR        Source candle minutes (default: 5)
--days INT            Candle lookback for the brick series (default: 5)
--poll-seconds INT    Main loop cadence (default: 15)
--start-time STR      Session start HH:MM (default: 09:00)
--eod-time STR        EOD flatten HH:MM (default: 23:30)
```

Unlike the other crudeoil strategy (which takes `--lots` and multiplies by the
lot size internally), Renko SAR takes the order quantity directly since the
dashboard exposes a "Quantity" field rather than "Lots" for this strategy. If
`--qty` isn't a multiple of the resolved MCX lot size (10), the strategy logs
a warning at startup but still proceeds — the broker will reject an invalid
order size.

## Examples
```
# Dry run (default), 1 lot (10 barrels)
python strategies/crudeoil/crudeoilm_renko_sar.py

# Live, 2 lots (20 barrels)
python strategies/crudeoil/crudeoilm_renko_sar.py --live --qty 20

# Wider bricks, faster flips
python strategies/crudeoil/crudeoilm_renko_sar.py --box-size 10 --reverse-bricks 2
```
