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
MCX CRUDEOILM futures strategy requiring **dual confirmation**: it is long only while
price is above both the Supertrend and the session VWAP, short only while below both,
and flips straight from one side to the other. Unlike Renko SAR, it has daily
profit/loss caps that end the day.

**It is no longer unconditionally always-on.** A directional strategy in a range-bound
market is structurally obliged to keep picking sides, and the dual-band rule is at its
weakest exactly then: in a range the Supertrend converges onto VWAP, the hold-zone
between them collapses to a point, and every tick across it becomes a full
stop-and-reverse. A **regime gate** now decides whether the strategy may hold a
position at all — see below. Pass `--no-regime-filter --no-htf-filter
--min-band-gap-atr 0 --atr-stop-mult 0 --min-flip-atr-mult 0 --flip-cooldown 30
--max-trades-per-day 0 --loss-streak-pause 0` to get the pre-2026-08-24 behaviour back.

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
position every second. `--flip-cooldown` (default 60s) is the minimum gap between flips —
the initial entry starts the clock too. Set it to 0 only if you want every crossing acted on.

## Regime Gate (the anti-chop layer)

A new position is only opened while the market is in a **TREND** regime. Three
independent gates, each of which can be disabled:

| Gate | Rule | Flag |
|---|---|---|
| Trend strength | ADX on the signal timeframe | `--adx-enter` / `--adx-exit` |
| Range detection | Choppiness Index | `--chop-max` |
| Higher timeframe | that timeframe's Supertrend must agree with the side being opened | `--htf-interval` |
| Band separation | \|ST − VWAP\| must be at least N ATRs | `--min-band-gap-atr` |

**The regime is two-sided on purpose.** TREND is entered at `--adx-enter` (22) but only
given up below the *separate, lower* `--adx-exit` (18), and a flip must survive
`--regime-confirm-candles` (2) consecutive **confirmed candles**. A single threshold in
both directions would just move the chop out of the price rule and into the filter: a
market parked at ADX ≈ 22 would flap the regime and flatten/re-enter on every recompute.
For the same reason the regime is evaluated once per closed candle, never on a live tick.

**Turning CHOP flattens any open position** and stands aside until TREND returns.

**Band separation is the most direct expression of this strategy's own failure mode.**
When the Supertrend and VWAP sit on top of each other there is no hysteresis left, so an
entry is refused until they are `--min-band-gap-atr` ATRs apart.

Missing indicator data **fails closed** — a missing ADX/CHOP column or an unavailable
higher-timeframe Supertrend blocks new entries rather than waving them through. A filter
that silently disappears is worse than one that blocks.

## Interval Verification (startup)

Dhan does **not** reject an interval it cannot serve. Measured against CRUDEOILM on
2026-08-24: `3` works, `30` silently returns **15-minute** candles, and `60` returns
**nothing at all**. Trusting the requested number would gate the strategy on the wrong
timeframe, or leave it in SCANNING all session with nothing in the log to say why.

So at startup the strategy fetches candles at each interval and measures the actual
spacing. A mismatched `--interval` or explicit `--htf-interval` is fatal
(`ERROR_BAD_INTERVAL`). `--htf-interval auto` (the default) probes candidates above the
signal interval and takes the first Dhan really serves, disabling just the HTF filter
with a warning if none does.

## Per-Trade Stop and Trail

The signal flip is no longer the only stop. On entry the stop is placed at
`--atr-stop-mult` (1.5) ATRs from the fill. Once the trade is `--trail-trigger-atr`
(1.0) ATRs in profit the stop hands over to the Supertrend band and **ratchets only** —
`lib/trade_stops.py`'s `ratchet_stop()`, shared with the ORB strategy — so a mid-trend
pullback cannot hand back locked-in profit. The band is never adopted if it is already
on the wrong side of price, which would stop the trade out on the tick that armed it.
The stop is checked against the live LTP but **only while the position is priced**: a
`0.0` from a failed `get_ltp()` is below every long stop.

## Churn Brakes

Count- and P&L-based limits, independent of the indicators. A losing streak *is* a chop
reading, and it arrives before ADX agrees.

- `--max-trades-per-day` (6) — entries per day, reversal legs included.
- `--loss-streak-pause` (2) / `--loss-streak-pause-minutes` (30) — pause after N
  consecutive losers.
- `--cooldown-candles` (1) — confirmed candles to wait after **any** flat-going exit.
- `--flip-cooldown` (now 60s, was 30) and `--min-flip-atr-mult` (now 0.35, **was 0** —
  the guard shipped disabled).

All of these **survive a process restart**, restored from the state file alongside the
day's P&L. Restoring only the P&L would let a crash-loop reset the trade cap.

## OI Confirmation Gate (optional, off by default)

An additional gate on CE/PE open-interest buildup, ported from
`strategies/oi_directional/nifty_oi_directional.py`'s expansion check.

**It reads the CRUDEOIL chain, not CRUDEOILM.** CRUDEOILM has no options of its own;
CRUDEOIL trades the same per-barrel price, so its option chain is the only real crude
OI available. Verified live on 2026-08-24 — `helper.get_option_chain_df("CRUDEOIL",
expiry, exchange_segment="MCX_COMM")` returns real strikes and OI around CRUDEOILM's
own price level. `--oi-symbol` can point elsewhere if that ever needs to change; `--no-
oi-tracking` disables the fetch entirely.

**Expiry is resolved from this strategy's own futures contract**, not by re-resolving
CRUDEOIL from scratch: `get_expiry_list(under_security_id=int(self.security_id),
exchange_segment="MCX_COMM")`. Two things worth knowing:
- `get_expiry_list` **fails silently** (returns an empty list, no exception) if the
  security id is passed as a string instead of an `int` — measured directly, not
  inferred. `self.security_id` is stored as `str` everywhere else in this strategy for
  the order/quote calls, so the OI code casts it back explicitly.
- The resolved options expiry will normally be **earlier** than the futures contract's
  own `SM_EXPIRY_DATE` — MCX commodity options expire a few days before the future
  itself. That mismatch is logged once at INFO and is expected, not a bug to chase.

**Bias formula** (`compute_oi_bias`, a direct port): sum CE OI and PE OI over strikes
within `--oi-strike-range` (250 points) of the underlying LTP, track
`diff = CE_OI - PE_OI` across snapshots, and compare only the last two:
- CE-dominant **and still growing** away from zero → **BEARISH** (resistance building).
- PE-dominant **and still growing** away from zero → **BULLISH** (support building).
- Otherwise (shrinking, or not yet dominant) → **NEUTRAL**.

As a **confirmation** gate this is intentionally strict: `NEUTRAL` and `UNAVAILABLE`
both block, the same fail-closed stance as the higher-timeframe gate — an unconfirmed
trade is not waved through just because OI didn't actively disagree.

**Always computed, gate is opt-in.** Same convention as the regime/HTF filters:
`--require-oi-confirmation` (off by default) is what makes this a BLOCKING gate; the OI
bias is fetched every `--oi-refresh-seconds` (45) and written to the decision telemetry
regardless, so it can be reviewed before being turned on. There are only two stale days
of crude OI anywhere in this repo (`debug/crudeoil_oi_snapshots_2026-07-1[56].csv`) — not
enough to validate `--oi-strike-range` or the expansion window against, so treat this
gate the same as the regime thresholds: convention, not measurement, until the
telemetry says otherwise.

Rate limits: Dhan's option-chain endpoint enforces a ~3s minimum spacing between real
calls and a 5s response cache (both shared with `get_expiry_list`) — `--oi-refresh-
seconds` is rejected below 5 for that reason.

## Decision Telemetry

Every confirmed candle appends one JSON line to
`debug/crudeoilm_vwap_supertrend[_<instance>]_signals.jsonl`: close, ST, VWAP, ATR, ADX,
CHOP, HTF direction, band gap, regime, OI bias/diff, the **raw** signal the original rule
would have given, whether the gates passed, and what blocked it.

Every threshold above is a convention, not a measured optimum — there is no CRUDEOILM
price history in this repo and no crude backtest. This file is what lets them be retuned
from what actually happened. After a session, count how many flips the gates suppressed
and what those trades would have made; if that number is near zero the thresholds are
too loose to be doing anything.

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
5. **Per-trade stop / Supertrend trail hit** → flat (does not end the day)
6. **Regime turned CHOP** → flat, stand aside (does not end the day)
7. Signal flip → stop-and-reverse, *if the new side passes the entry gates*. If the price
   rule wants out but the gates reject the other side, the exit half still happens and the
   strategy goes flat — otherwise being in a position would bypass every filter.

Only 1–4 end the day.

## Restart Behavior
The day's realized P&L **and the churn brakes** (`trades_today`, `loss_streak`,
`paused_until`, `exit_candle_time`) are restored from the state file. Positions are NOT
recovered — on a live restart while holding a position, flatten manually first. The regime
restarts as CHOP and must re-confirm, so nothing trades until a trend is proven again.

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
--flip-cooldown INT            Minimum seconds between flips (default: 60)
--min-flip-atr-mult FLOAT      ATR multiple a flip/entry must clear both bands by (default: 0.35)
--no-reverse                   Exit to flat on a flip instead of reversing
--exit-on-close                Exit on confirmed close instead of live LTP

Regime gate
--adx-period INT               ADX length on the signal timeframe (default: 14)
--adx-enter FLOAT              ADX at/above which the regime becomes TREND (default: 22)
--adx-exit FLOAT               ADX below which TREND reverts to CHOP (default: 18; must be
                               strictly lower than --adx-enter — that gap IS the hysteresis)
--chop-length INT              Choppiness Index length (default: 14)
--chop-max FLOAT               Choppiness at/below which TREND is allowed (default: 55;
                               reverting needs this + 5)
--regime-confirm-candles INT   Confirmed candles a regime flip must survive (default: 2)
--htf-interval STR             Higher-timeframe confirmation, minutes or 'auto' (default: auto)
--htf-refresh-seconds INT      Higher-timeframe refresh cadence (default: 60)
--min-band-gap-atr FLOAT       Min ATR multiple between ST and VWAP to enter (default: 0.5)
--no-regime-filter             Disable the ADX/Choppiness gate
--no-htf-filter                Disable the higher-timeframe agreement filter

Per-trade risk
--atr-stop-mult FLOAT          Initial stop in ATRs from entry (default: 1.5; 0 disables)
--trail-trigger-atr FLOAT      ATRs of profit before the Supertrend trail arms (default: 1.0)

Churn brakes
--max-trades-per-day INT       Entries per day, reversal legs included (default: 6; 0 = off)
--cooldown-candles INT         Confirmed candles after any flat-going exit (default: 1)
--loss-streak-pause INT        Consecutive losers before entries pause (default: 2; 0 = off)
--loss-streak-pause-minutes INT  Length of that pause (default: 30)

OI confirmation (optional; always fetched for telemetry, only blocks with --require-oi-confirmation)
--oi-symbol STR                Option-chain underlying (default: CRUDEOIL — CRUDEOILM has no options)
--oi-strike-range FLOAT        Points around the underlying LTP summed for the bias (default: 250)
--oi-strike-step FLOAT         Informational strike spacing (default: 50)
--oi-expansion-window INT      Snapshots kept for the expansion check (default: 3; min 2)
--oi-refresh-seconds INT       OI chain refresh cadence (default: 45; min 5 — Dhan's chain cache is 5s)
--require-oi-confirmation      BLOCK entries unless CE/PE OI buildup agrees with the side
--no-oi-tracking                Disable the OI fetch entirely (no telemetry, no gate)
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

# Stricter regime gate for a known-choppy session
python strategies/crudeoil/crudeoilm_vwap_supertrend.py --adx-enter 28 --chop-max 45 --max-trades-per-day 3

# Turn on OI confirmation after reviewing the telemetry
python strategies/crudeoil/crudeoilm_vwap_supertrend.py --require-oi-confirmation

# Pre-2026-08-24 behaviour (every filter off) — for comparing against the telemetry
python strategies/crudeoil/crudeoilm_vwap_supertrend.py --no-regime-filter --no-htf-filter \
    --min-band-gap-atr 0 --atr-stop-mult 0 --min-flip-atr-mult 0 --flip-cooldown 30 \
    --max-trades-per-day 0 --loss-streak-pause 0
```

---

# CrudeOil Mini Opening Range Breakout + Pivot Structure Stop

`crudeoilm_orb.py` — the first consumer of [lib/pivots.py](../../lib/pivots.py).
See [docs/PIVOT_DETECTION.md](../../docs/PIVOT_DETECTION.md) for the pivot module itself.

## Overview
The opening range supplies the entry level; **pivots supply the exit**. Pivots deliberately do
not drive entry — the opening range is a time-based level and needs no swing detection. What
pivots add is a stop that follows market structure, plus a filter that rejects weak breakouts.

## Session
| Phase | Behaviour |
|---|---|
| Before `--session-start` (09:00) | Idle. |
| Range window (`--or-minutes`, default 15) | Record ORH/ORL. **No trading.** |
| After the window | Watch for a breakout; enter once per side. |
| `--eod-time` (23:30) | Hard flat. |

The range is frozen only once the clock passes the window end — acting earlier would trade a
partially-formed range. A new calendar day resets the range and the once-per-side caps.

## Signal
Evaluated on the **last closed candle** (`iloc[-2]`; `iloc[-1]` is still forming):

- **LONG** — close > ORH, and (if the filter is on) close > the last confirmed pivot high.
- **SHORT** — close < ORL, and (if the filter is on) close < the last confirmed pivot low.

Two deliberate choices:

- **Close, not touch.** A wick through the range that closes back inside is the single most
  common ORB false trigger, and `--or-minutes` does nothing to protect against it.
- **No pivot yet ⇒ filter skipped, not blocked.** Early in the session no pivot has confirmed.
  Treating that as "filter failed" would prevent the strategy from ever trading. The log line
  says which branch fired.

## The two-stage stop — read this before going live
A pivot needs `n` candles either side plus the forming-candle discard, so **the first pivot of
the session confirms after the ORB entry has already fired.** With the defaults (`n=5` on 1-min
candles) that is ~6 minutes; on 5-min candles with `n=3` it would be ~20 minutes, which is why
the pivot series defaults to a faster interval than the trading series.

1. **Stage 1 — range edge.** On entry the stop is the *opposite* edge of the opening range
   (long → ORL). This holds the position until structure exists.
2. **Stage 2 — pivot.** The moment `latest_low()` returns a pivot, the stop moves there.
3. **Ratchet.** `new_stop = max(old_stop, pivot_low)` for a long, `min(...)` for a short. Stops
   only ever tighten; a pullback pivot on the wrong side is ignored. Without this a mid-trend
   dip would hand back profit already locked in.

`stop_source` in the state file reports `RANGE` or `PIVOT` so the dashboard shows which stage is
active.

## Exit Conditions (priority order)
1. Dashboard shutdown trigger
2. EOD (`--eod-time`)
3. Daily profit target
4. Daily stop loss
5. Stop hit — range edge or trailed pivot, whichever stage is active

## Restart Behavior
`_restore_daily_state()` reloads today's P&L **and** the `taken_long` / `taken_short` caps from
the state file, so a restart cannot re-take a side already traded. `PivotTracker.prime()` absorbs
the session's existing pivots silently — a mid-session restart gets the levels without firing
entry signals for swings that formed hours earlier.

## Key CLI Flags
| Flag | Default | Meaning |
|---|---|---|
| `--live` | off | Real orders. Dry run otherwise. |
| `--lots` | 1 | Lots (10 barrels each). |
| `--interval` | `5` | Trading candle interval. |
| `--or-minutes` | 15 | Opening range width. |
| `--session-start` | `09:00` | Range start, HH:MM IST. |
| `--pivot-n` | 5 | Candles required each side of a pivot. |
| `--pivot-interval` | `1` | Candle interval for the pivot series. |
| `--no-pivot-filter` | off | Enter on the range break alone; pivots only trail. |
| `--allow-reentry` | off | Lift the one-trade-per-side-per-day cap. |
| `--target-profit` / `--stop-loss` | 3000 | Daily INR caps. |

`--interval` and `--pivot-interval` accept only `1, 5, 15, 25, 60` — Dhan's intraday endpoint
rejects anything else, and a rejected interval returns an *empty* frame rather than an error, so
the strategy would silently never see a candle. `argparse` enforces the set.

## Known limitation
ORB bleeds on gap-and-chop sessions where price pokes both sides of the range and reverses. The
pivot filter rejects the weakest of those, but it is not a cure. The real protection is the
one-trade-per-side cap (on by default) plus `--stop-loss`. Do not lift `--allow-reentry` on a
rangebound day.

## Examples
```
# Dry run (default), 1 lot, 15-min opening range
python strategies/crudeoil/crudeoilm_orb.py

# Live, 2 lots, 30-min opening range
python strategies/crudeoil/crudeoilm_orb.py --live --lots 2 --or-minutes 30

# Wider structure stop — slower to trail, fewer whipsaw exits
python strategies/crudeoil/crudeoilm_orb.py --pivot-interval 5 --pivot-n 3

# Pure ORB — pivots trail the stop but do not gate entry
python strategies/crudeoil/crudeoilm_orb.py --no-pivot-filter
```
