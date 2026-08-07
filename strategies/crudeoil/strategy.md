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
--use-vwap                    Require close above/below VWAP to allow an entry —
                              an ENTRY FILTER only, never an exit (flag, default: off)
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

---

# CrudeOil Mini VWAP + Supertrend Always-On Strategy

## Overview
Always-on MCX CRUDEOILM futures strategy requiring **dual confirmation**: it is long
only while price is above both the Supertrend and the session VWAP, short only while
below both, and flips straight from one side to the other. Unlike the Supertrend
strategy above, it does not sit flat between trades; unlike Renko SAR, it does have
daily profit/loss caps that end the day.

## Signal Rule

| State | Price vs bands | Action |
|---|---|---|
| Flat | above **both** | enter LONG |
| Flat | below **both** | enter SHORT |
| Flat | in between | stay flat |
| LONG | below **both** | exit and immediately enter SHORT |
| LONG | anything else | HOLD |
| SHORT | above **both** | exit and immediately enter LONG |
| SHORT | anything else | HOLD |

The "in between" zone (price above one band but below the other) is deliberate
hysteresis: losing a single indicator is not a signal. That is what keeps the strategy
from churning while the two bands are crossed over each other.

`--no-reverse` turns the flip into a plain exit-to-flat. A one-candle re-entry cooldown
then applies, otherwise the very next tick would re-enter the opposite side and the flag
would do nothing.

**Flip cooldown.** The Supertrend and the VWAP cross each other regularly. When they nearly
coincide the hold-zone collapses to a point, and a price ticking across it would flip a live
position every second. `--flip-cooldown` (default 30s) is the minimum gap between flips —
the initial entry starts the clock too. Set it to 0 only if you want every crossing acted on.

## Hybrid Signal Price
- **Entries** use the last CONFIRMED closed candle (`df.iloc[-2]`) — no intra-candle churn.
- **Exits/flips** use the live 1-second LTP against the latest bands, so a breach is acted
  on immediately rather than waiting out the candle. `--exit-on-close` switches exits back
  to the confirmed close.

Both bands come from a background poller thread (`--poll-seconds`, default 15) so the
1-second main loop never blocks on the candle fetch.

## Quantity vs Exposure — read before going live
Two different numbers, easy to conflate:
- `--lots` is the **order quantity sent to the broker verbatim**. Dhan takes MCX quantity
  in lots (its master list reports `LOT_SIZE=1` for MCX), so `--lots 5` places an order for 5.
- `--contract-size` (default 10) is **barrels per lot** and is used for **P&L only**:
  `pnl = (exit - entry) * lots * contract_size`.

This differs from `crudeoilm_supertrend.py`, which multiplies `--lots` by 10 before sending
it to the broker. Before the first `--live` run, place one manual 1-lot CRUDEOILM order and
confirm the broker's reported `netQty` matches `--lots 1`.

## Exit Conditions (priority order)
1. UI shutdown trigger file
2. EOD time reached (flatten and stop)
3. Daily profit target hit (cumulative, INR) — flatten and stop for the day
4. Daily stop loss hit (cumulative, INR) — flatten and stop for the day
5. Signal flip → stop-and-reverse (this does not end the day)

Only 1–4 end the always-on cycle. There is no per-trade stop: the Supertrend/VWAP flip *is*
the stop, and it puts you on the other side rather than flat.

## Restart Behavior
Only the day's realized P&L is restored from the state file. Positions are NOT recovered —
on a live restart while holding a position, flatten manually first.

## Key CLI Flags
```
--live                         Real orders (default: dry run)
--lots INT                     Broker order quantity, in lots (default: 5)
--contract-size INT            Barrels per lot, P&L only (default: 10; CRUDEOIL = 100)
--interval STR                 1/3/5/15 minutes (default: 5)
--supertrend-period INT        ATR period (default: 7)
--supertrend-multiplier FLOAT  Multiplier (default: 2.0)
--vwap-anchor STR              pandas_ta VWAP anchor (default: D)
--target-profit FLOAT          Daily profit cap INR (default: 5000)
--stop-loss FLOAT              Daily loss cap INR, positive number (default: 5000)
--start-time STR               Session start HH:MM (default: 09:00)
--eod-time STR                 EOD flatten HH:MM (default: 23:30)
--poll-seconds INT             Indicator refresh cadence (default: 15)
--days INT                     Candle lookback for the indicator fetch (default: 3)
--flip-cooldown INT            Minimum seconds between flips (default: 30)
--no-reverse                   Exit to flat on a flip instead of reversing
--exit-on-close                Exit on confirmed close instead of live LTP
```

Arguments are validated at startup and the run is refused on values that would silently
brick it: a `0` target/stop (trips on the first tick, since `0 >= 0`), `--lots 0`, and an
unpadded time like `9:00` (`"18:00" >= "9:00"` is False as a string, so the EOD flatten
would never fire).

## Quote-outage safety
`get_ltp()` returns `0.0` on any failure. While a position is open and no usable quote has
arrived, P&L is reported as 0 and **the daily target/stop checks are paused** rather than
marking the position against a price of zero — which would read as a total loss and end the
day on a transient glitch. The condition is logged every 30s.

## Examples
```
# Dry run (default), 5 lots, Supertrend(7,2) on 5-min candles
python strategies/crudeoil/crudeoilm_vwap_supertrend.py

# Live, 5 lots, +/- 10000 INR daily caps
python strategies/crudeoil/crudeoilm_vwap_supertrend.py --live --lots 5 --target-profit 10000 --stop-loss 10000

# Faster signal, exit only on confirmed closes
python strategies/crudeoil/crudeoilm_vwap_supertrend.py --interval 3 --exit-on-close
```
